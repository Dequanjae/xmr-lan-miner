// RandomX JIT mining worker — uses l1mey112 mining VM (B/Rm/n/h exports)
// The nonce loop runs INSIDE the WASM — much faster than JS-level iteration
importScripts('randomx_fast.js');

let M = null;
let mining = false;
let currentJob = null;
let initDone = false;
let pendingJob = null;
let nonceStart = 0;
let nonceEnd = 0;
let nonceCur = 0;
let backgroundMode = false;

// Access to the raw VM exports from the JIT engine
let vmExports = null;
let scratch = null;
let jitImports = null;

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

async function initEngine(seedHashHex) {
  post('status', { message: 'Loading JIT RandomX engine...' });
  const baseUrl = self.location.href.replace(/worker\.js.*$/, '');
  M = await createRandomXFast((f) => baseUrl + f);
  
  // Access the internal VM exports that randomx_fast.js set up
  vmExports = M._vmExports;
  scratch = M._scratch;
  jitImports = M._jitImports;
  
  post('status', { message: 'JIT engine loaded, building cache (Argon2)...' });
  post('initProgress', { phase: 'cache', progress: 10 });
  
  const seed = hexToU8(seedHashHex);
  M.initCache(seed);
  
  // After initCache, jitImports is updated with the new thunk
  jitImports = M._jitImports;
  
  post('initProgress', { phase: 'done', progress: 100 });
  post('status', { message: 'Cache ready (JIT mining mode)' });
}

async function mineLoop() {
  while (mining) {
    if (!currentJob || !M || !vmExports) { 
      await new Promise(r => setTimeout(r, 100)); 
      continue; 
    }
    
    const job = currentJob;
    
    // Use the mining VM: B() sets up blob + target + nonce range
    // Then Rm() runs the internal loop, returning 1 when share found, 0 when exhausted
    scratch.set(hexToU8(job.blob));
    
    // B(blob_length, target, nonce_start, nonce_end) — target as BigInt
    const target = BigInt('0x' + job.target.split('').reverse().join('')) || 0n;
    // Actually target is hex string, need to parse properly
    const targetHex = job.target;
    let targetBigInt = 0n;
    // Pool target is 4-byte LE hex — convert to 64-bit
    const t = hexToU8(targetHex);
    if (t.length === 4) {
      const t32 = (t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0;
      targetBigInt = BigInt(t32);
    } else if (t.length === 8) {
      for (let i = 7; i >= 0; i--) targetBigInt = (targetBigInt << 8n) | BigInt(t[i]);
    } else {
      targetBigInt = 0xffffffffn;
    }
    
    vmExports.B(job.blob.length, targetBigInt, nonceStart, nonceEnd);
    
    post('status', { message: `Mining job ${job.job_id} nonce [${nonceStart}, ${nonceEnd})` });
    
    let lastHashCount = 0;
    const t0 = Date.now();
    
    // Mining loop — Rm() returns 0 (exhausted) or 1 (share found)
    while (mining && currentJob === job) {
      const result = vmExports.Rm();
      
      if (result === 1) {
        // Share found! Get nonce and hash
        const nonce = vmExports.n();
        const hash = scratch.slice(0, 32);
        post('share', {
          jobId: job.job_id,
          nonce: nonce.toString(16).padStart(8, '0'),
          result: bufToHex(hash),
        });
        // Continue mining — VM auto-advances to next nonce
      } else if (result === 0) {
        // Nonce space exhausted — wrap around
        vmExports.B(job.blob.length, targetBigInt, nonceStart, nonceEnd);
      }
      
      // Report hashrate periodically
      const hashCount = vmExports.h();
      if (hashCount - lastHashCount >= 10) {
        const elapsed = (Date.now() - t0) / 1000;
        const hashrate = Math.round(hashCount / Math.max(elapsed, 0.001));
        post('hashrate', { hashrate });
        lastHashCount = hashCount;
      }
      
      // Yield occasionally
      if (backgroundMode) {
        await new Promise(r => setTimeout(r, 50));
      } else {
        // Tiny yield every 512 iterations to keep event loop alive
        if (hashCount % 512 === 0 && hashCount > 0) {
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }
    
    const elapsed = (Date.now() - t0) / 1000;
    const finalHashCount = vmExports.h();
    if (finalHashCount > 0) {
      post('hashrate', { hashrate: Math.round(finalHashCount / Math.max(elapsed, 0.001)) });
    }
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
        jitImports = M._jitImports;
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
    } else if (msg.type === 'background') {
      backgroundMode = msg.enabled;
    }
  } catch (err) {
    console.error('[worker JIT miner] FATAL:', err.message, err.stack);
    post('error', { message: err.message });
  }
};