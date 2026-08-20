// RandomX JIT worker — uses l1mey112 JIT engine for 3-5x faster hashing
importScripts('randomx_fast.js');

let M = null;
let mining = false;
let currentJob = null;
let initDone = false;
let pendingJob = null;
let nonceStart = 0;
let nonceEnd = 0;
let nonceCur = 0;

function post(type, extra = {}) { postMessage({ type, ...extra }); }

function hexToU8(hex) {
  const n = hex.length / 2;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bufToHex(u8) {
  return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
}

function meetsTarget(hashBuf, targetHex) {
  const t = hexToU8(targetHex);
  let target64;
  if (t.length === 4) {
    const t32 = (t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0;
    const d = 0xffffffffffffffffn / (0xffffffffn / BigInt(t32));
    target64 = 0xffffffffffffffffn / d;
  } else if (t.length === 8) {
    target64 = 0n;
    for (let i = 7; i >= 0; i--) target64 = (target64 << 8n) | BigInt(t[i]);
  } else if (t.length === 32) {
    target64 = 0n;
    for (let i = 31; i >= 24; i--) target64 = (target64 << 8n) | BigInt(t[i]);
  } else {
    return false;
  }
  let hash64 = 0n;
  for (let i = 31; i >= 24; i--) hash64 = (hash64 << 8n) | BigInt(hashBuf[i]);
  return hash64 <= target64;
}

async function initEngine(seedHashHex) {
  post('status', { message: 'Loading JIT RandomX engine...' });
  const baseUrl = self.location.href.replace(/worker\.js.*$/, '');
  M = await createRandomXFast((f) => baseUrl + f);
  post('status', { message: 'JIT engine loaded, initializing cache...' });
  // Init cache with the seed hash
  const seed = hexToU8(seedHashHex);
  M.initCache(seed);
  post('status', { message: 'Cache ready (JIT mode)' });
}

async function mineLoop() {
  while (mining) {
    if (!currentJob || !M) { await new Promise(r => setTimeout(r, 100)); continue; }
    const job = currentJob;
    const blob = hexToU8(job.blob);

    const t0 = Date.now();
    let hashes = 0;
    const batchMs = 2000;

    while (Date.now() - t0 < batchMs && mining && currentJob === job) {
      if (nonceCur >= nonceEnd) nonceCur = nonceStart;
      // Write nonce into blob at offset 39
      blob[39] = nonceCur & 0xff;
      blob[40] = (nonceCur >>> 8) & 0xff;
      blob[41] = (nonceCur >>> 16) & 0xff;
      blob[42] = (nonceCur >>> 24) & 0xff;

      const hash = M.calculateHash(blob);
      hashes++;

      if (meetsTarget(hash, job.target)) {
        post('share', {
          jobId: job.job_id,
          nonce: nonceCur.toString(16).padStart(8, '0'),
          result: bufToHex(hash),
        });
      }
      nonceCur = (nonceCur + 1) >>> 0;
    }

    const elapsed = (Date.now() - t0) / 1000;
    post('hashrate', { hashrate: Math.round(hashes / Math.max(elapsed, 0.001)) });
    await new Promise(r => setTimeout(r, 0));
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await initEngine(msg.seedHash);
      initDone = true;
      post('ready');
      if (pendingJob) {
        currentJob = pendingJob;
        pendingJob = null;
      }
    } else if (msg.type === 'job') {
      if (!initDone) {
        pendingJob = msg.job;
        return;
      }
      // Check if seed changed — need to re-init cache
      if (!currentJob || currentJob.seed_hash !== msg.job.seed_hash) {
        currentJob = msg.job;
        const seed = hexToU8(msg.job.seed_hash);
        M.initCache(seed);
        post('status', { message: 'Cache reinitialized for new seed' });
      } else {
        currentJob = msg.job;
      }
    } else if (msg.type === 'start') {
      if (!mining) { mining = true; mineLoop(); }
    } else if (msg.type === 'stop') {
      mining = false;
    } else if (msg.type === 'nonceRange') {
      nonceStart = msg.start;
      nonceEnd = msg.end;
      nonceCur = msg.start;
    }
  } catch (err) {
    console.error('[worker JIT] FATAL:', err.message, err.stack);
    post('error', { message: err.message });
  }
};