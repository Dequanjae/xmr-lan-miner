// Worker: receives shared cache from main thread, creates own VM, mines
importScripts('randomx_fast.js');

let vmExports = null;
let scratch = null;
let jitImports = null;
let mining = false;
let currentJob = null;
let nonceStart = 0, nonceEnd = 0, nonceCur = 0;
let backgroundMode = false;
let initialized = false;
let pendingJob = null;

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

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'setup') {
      post('status', { message: 'Setting up JIT VM (shared cache)...' });
      await initWorkerVM(msg.datasetMemory, msg.thunkBytes, msg.vmWasmBytes, msg.feature);
      initialized = true;
      post('ready');
    } else if (msg.type === 'reinitCache') {
      reinitThunk(msg.datasetMemory, msg.thunkBytes);
      post('status', { message: 'Cache reinitialized for new seed' });
    } else if (msg.type === 'job') {
      if (!initialized) { pendingJob = msg.job; return; }
      currentJob = msg.job;
    } else if (msg.type === 'start') {
      if (!mining) { mining = true; mineLoop(); }
    } else if (msg.type === 'stop') {
      mining = false;
    } else if (msg.type === 'nonceRange') {
      nonceStart = msg.start;
      nonceEnd = msg.end;
      nonceCur = msg.start;
    } else if (msg.type === 'background') {
      backgroundMode = msg.enabled;
    }
  } catch (err) {
    console.error('[worker] FATAL:', err.message, err.stack);
    post('error', { message: err.message });
  }
};

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
    const BATCH = 128;

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

        const jitWm = new WebAssembly.Module(scratch.subarray(0, jitSize));
        const jitWi = new WebAssembly.Instance(jitWm, jitImports);
        jitWi.exports.d();
      }

      const hashCount = vmExports.h();
      const elapsed = (Date.now() - t0) / 1000;
      post('hashrate', { hashrate: Math.round(hashCount / Math.max(elapsed, 0.001)) });

      await new Promise(r => setTimeout(r, 0));
    }
  }
}