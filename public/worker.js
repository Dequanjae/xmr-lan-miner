// RandomX WASM worker — hashes a nonce range, reports to main thread
importScripts('randomx.js');

let M = null;
let mining = false;
let currentJob = null;
let inPtr = 0, outPtr = 0;
const IN_MAX = 256;
let nonceStart = 0;
let nonceEnd = 0;
let nonceCur = 0;
let initDone = false;
let pendingJob = null;

function post(type, extra = {}) { postMessage({ type, ...extra }); }

async function initModule() {
  post('status', { message: 'Loading RandomX WASM...' });
  const baseUrl = self.location.href.replace(/worker\.js.*$/, '');
  M = await createRandomX({
    locateFile: (f) => baseUrl + f,
  });
  if (!M || !M._rx_init_flags) throw new Error('WASM loaded but exports missing');
  M._rx_init_flags();
  if (!M._rx_alloc_cache()) throw new Error('cache alloc failed');
  inPtr = M._rx_malloc(IN_MAX);
  outPtr = M._rx_malloc(32);
  post('status', { message: 'WASM loaded, allocating VM...' });
}

async function ensureVM(seedHashHex) {
  const seedBin = hexToU8(seedHashHex);
  const seedPtr = M._rx_malloc(seedBin.length);
  M.HEAPU8.set(seedBin, seedPtr);
  M._rx_init_cache(seedPtr, seedBin.length);
  M._rx_free(seedPtr);
  if (!M._rx_create_vm()) throw new Error('vm create failed');
}

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

async function mineLoop() {
  while (mining) {
    if (!currentJob || !M) { await new Promise(r => setTimeout(r, 100)); continue; }
    const job = currentJob;
    const blob = hexToU8(job.blob);
    if (blob.length > IN_MAX) { post('error', { message: 'blob too large' }); mining = false; break; }

    const t0 = Date.now();
    let hashes = 0;

    while (Date.now() - t0 < 500 && mining && currentJob === job) {
      if (nonceCur >= nonceEnd) nonceCur = nonceStart;
      blob[39] = nonceCur & 0xff;
      blob[40] = (nonceCur >>> 8) & 0xff;
      blob[41] = (nonceCur >>> 16) & 0xff;
      blob[42] = (nonceCur >>> 24) & 0xff;

      M.HEAPU8.set(blob, inPtr);
      M._rx_calculate_hash(inPtr, blob.length, outPtr);
      hashes++;

      const hash = M.HEAPU8.slice(outPtr, outPtr + 32);
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
      if (!M) await initModule();
      await ensureVM(msg.seedHash);
      initDone = true;
      post('ready');
      if (pendingJob) {
        currentJob = pendingJob;
        pendingJob = null;
        post('status', { message: 'Job ' + currentJob.job_id + ' received' });
      }
    } else if (msg.type === 'job') {
      if (!initDone) {
        pendingJob = msg.job;
        return;
      }
      if (!currentJob || currentJob.seed_hash !== msg.job.seed_hash) {
        currentJob = msg.job;
        await ensureVM(msg.job.seed_hash);
      } else {
        currentJob = msg.job;
      }
      post('status', { message: 'Job ' + msg.job.job_id + ' received' });
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
    console.error('[worker] FATAL:', err.message, err.stack);
    post('error', { message: err.message });
  }
};