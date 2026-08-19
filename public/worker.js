// RandomX WASM worker — hashes blobs from the job and reports shares
importScripts('randomx.js');

let M = null;           // Emscripten module
let mining = false;
let currentJob = null;
let inPtr = 0, outPtr = 0;
const IN_MAX = 256;

function post(type, extra = {}) { postMessage({ type, ...extra }); }

async function initModule() {
  post('status', { message: 'Loading RandomX WASM...' });
  M = await createRandomX();
  M._rx_init_flags();
  if (!M._rx_alloc_cache()) throw new Error('cache alloc failed');
  inPtr = M._rx_malloc(IN_MAX);
  outPtr = M._rx_malloc(32);
  post('status', { message: 'WASM loaded' });
}

async function ensureVM(seedHashHex) {
  // RandomX needs one cache+VM per seed; reinit when seed changes
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

// Compare hash against target — RandomX job target is 8-byte LE
function meetsTarget(hashBuf, targetHex) {
  const t = hexToU8(targetHex);
  // For 4-byte compact target, convert to 8-byte LE difficulty
  let target64;
  if (t.length === 4) {
    const t32 = t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24 >>> 0);
    const full = 0xffffffffn / BigInt(t32 >>> 0);
    target64 = full * 0x100000000n; // scale back up to 64-bit space
  } else if (t.length === 8) {
    target64 = 0n;
    for (let i = 7; i >= 0; i--) target64 = (target64 << 8n) | BigInt(t[i]);
  } else if (t.length === 32) {
    // 256-bit LE — high 32 bytes; the effective target is the last 8 bytes
    target64 = 0n;
    for (let i = 31; i >= 24; i--) target64 = (target64 << 8n) | BigInt(t[i]);
  } else {
    return false;
  }
  // Read hash as little-endian 64-bit (last 8 bytes of the 32-byte hash)
  let hash64 = 0n;
  for (let i = 31; i >= 24; i--) hash64 = (hash64 << 8n) | BigInt(hashBuf[i]);
  return hash64 <= target64;
}

async function mineLoop() {
  while (mining) {
    if (!currentJob) { await new Promise(r => setTimeout(r, 100)); continue; }
    const job = currentJob;
    const blob = hexToU8(job.blob);
    if (blob.length > IN_MAX) { post('error', { message: 'blob too large' }); mining = false; break; }

    const t0 = Date.now();
    let hashes = 0;
    let nonce = (Math.random() * 0xffffffff) >>> 0;

    // Hash for ~500ms per batch, then yield
    while (Date.now() - t0 < 500 && mining && currentJob === job) {
      // Write nonce into blob at offset 39 (standard CN/RX nonce offset)
      blob[39] = nonce & 0xff;
      blob[40] = (nonce >>> 8) & 0xff;
      blob[41] = (nonce >>> 16) & 0xff;
      blob[42] = (nonce >>> 24) & 0xff;

      M.HEAPU8.set(blob, inPtr);
      M._rx_calculate_hash(inPtr, blob.length, outPtr);
      hashes++;

      const hash = M.HEAPU8.slice(outPtr, outPtr + 32);
      if (meetsTarget(hash, job.target)) {
        post('share', {
          jobId: job.job_id,
          nonce: nonce.toString(16).padStart(8, '0'),
          result: bufToHex(hash),
        });
      }
      nonce = (nonce + 1) >>> 0;
    }

    const elapsed = (Date.now() - t0) / 1000;
    post('hashrate', { hashrate: Math.round(hashes / Math.max(elapsed, 0.001)) });
    await new Promise(r => setTimeout(r, 0)); // yield
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      if (!M) await initModule();
      await ensureVM(msg.seedHash);
      post('ready');
    } else if (msg.type === 'job') {
      if (!M) return; // not initialized yet, wait for init message
      // If seed changed, re-init
      if (!currentJob || currentJob.seed_hash !== msg.job.seed_hash) {
        currentJob = msg.job;
        await ensureVM(msg.job.seed_hash);
      } else {
        currentJob = msg.job;
      }
      post('status', { message: `Job ${msg.job.job_id} received` });
    } else if (msg.type === 'start') {
      if (!mining) { mining = true; mineLoop(); }
    } else if (msg.type === 'stop') {
      mining = false;
    }
  } catch (err) {
    post('error', { message: err.message });
  }
};
