// RandomX JIT mining worker — non-shared, per-worker cache + module caching
importScripts('randomx_fast.js');

let M = null;
let vmExports = null;
let scratch = null;
let jitImports = null;
let mining = false;
let currentJob = null;
let initialized = false;
let pendingJob = null;
let nonceStart = 0, nonceEnd = 0, nonceCur = 0;
let backgroundMode = false;

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

function hex2target(hex) {
  const bin = hexToU8(hex);
  if (bin.length === 4) {
    const buf = new ArrayBuffer(4);
    new Uint8Array(buf).set(bin);
    const u32 = new Uint32Array(buf)[0];
    return 0xFFFFFFFFFFFFFFFFn / (0xFFFFFFFFn / BigInt(u32));
  } else if (bin.length === 8) {
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf).set(bin);
    return new BigUint64Array(buf)[0];
  }
  return 0n;
}

async function initEngine(seedHashHex) {
  post('status', { message: 'Loading JIT RandomX engine...' });
  const baseUrl = self.location.href.replace(/worker\.js.*$/, '').replace(/\?.*$/, '');
  M = await createRandomXFast((f) => baseUrl + f);
  vmExports = M._vmExports;
  scratch = M._scratch;
  jitImports = M._jitImports;
  post('status', { message: 'JIT engine loaded, building cache (Argon2)...' });
  post('initProgress', { phase: 'cache', progress: 10 });
  const seed = hexToU8(seedHashHex);
  M.initCache(seed);
  jitImports = M._jitImports;
  post('initProgress', { phase: 'done', progress: 100 });
  post('status', { message: 'Cache ready (JIT mining mode + module cache)' });
}

async function mineLoop() {
  while (mining) {
    if (!currentJob || !initialized || !vmExports) {
      await new Promise(r => setTimeout(r, 100));
      continue;
    }

    const job = currentJob;
    const blob = hexToU8(job.blob);
    const targetBigInt = hex2target(job.target);

    scratch.set(blob);
    vmExports.B(blob.length, targetBigInt, nonceStart, nonceEnd);

    const t0 = Date.now();
    const BATCH = 32; // small batches = frequent GC = executable memory freed faster

    while (mining && currentJob === job) {
      for (let iter = 0; iter < BATCH; iter++) {
        const jitSize = vmExports.Rm();

        if (jitSize === 0) {
          vmExports.B(blob.length, targetBigInt, nonceStart, nonceEnd);
          continue;
        }

        if (jitSize === 1) {
          const nonce = Number(vmExports.n());
          const hash = new Uint8Array(scratch.slice(0, 32));
          post('share', {
            jobId: job.job_id,
            nonce: nonce.toString(16).padStart(8, '0'),
            result: bufToHex(hash),
          });
          vmExports.B(blob.length, targetBigInt, nonceStart, nonceEnd);
          continue;
        }

        // Use cached module compilation — skips recompilation for repeated programs
        M.executeJitProgram(jitSize);
      }

      const hashCount = vmExports.h();
      const elapsed = (Date.now() - t0) / 1000;
      post('hashrate', { hashrate: Math.round(hashCount / Math.max(elapsed, 0.001)) });

      await new Promise(r => setTimeout(r, 0));
    }
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await initEngine(msg.seedHash);
      initialized = true;
      post('ready');
      if (pendingJob) { currentJob = pendingJob; pendingJob = null; }
    } else if (msg.type === 'job') {
      if (!initialized) { pendingJob = msg.job; return; }
      const oldSeed = currentJob ? currentJob.seed_hash : null;
      currentJob = msg.job;
      if (oldSeed !== msg.job.seed_hash && oldSeed !== null) {
        const seed = hexToU8(msg.job.seed_hash);
        M.initCache(seed);
        jitImports = M._jitImports;
        post('status', { message: 'Cache reinitialized for new seed' });
      }
    } else if (msg.type === 'start') {
      if (!mining) { mining = true; mineLoop(); }
    } else if (msg.type === 'stop') {
      mining = false;
    } else if (msg.type === 'nonceRange') {
      nonceStart = msg.start; nonceEnd = msg.end; nonceCur = msg.start;
    } else if (msg.type === 'background') {
      backgroundMode = msg.enabled;
    }
  } catch (err) {
    console.error('[worker] FATAL:', err.message, err.stack);
    post('error', { message: err.message });
  }
};