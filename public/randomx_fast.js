// randomx_fast.js — JIT RandomX engine with shared memory support
// Main thread: builds cache + thunk (one-time, shared across all workers)
// Workers: receive shared memory + thunk, create own VM, mine

const WASM_PAGES = 4098; // dataset memory pages
const SCRATCH_SIZE = 16 * 1024;

const JIT_BASELINE = 0;
const JIT_RELAXED_SIMD = 1;
const JIT_FMA = 2;

let _feature = JIT_BASELINE;

async function detectFeature(fmaWasmBytes, simdWasmBytes) {
  try { WebAssembly.validate(simdWasmBytes); } catch (e) { throw new Error('WASM SIMD not supported'); }
  try {
    const wm = new WebAssembly.Module(fmaWasmBytes);
    const wi = new WebAssembly.Instance(wm);
    _feature = wi.exports.d()() ? (JIT_FMA | JIT_RELAXED_SIMD) : JIT_RELAXED_SIMD;
  } catch (e) { _feature = JIT_BASELINE; }
  return _feature;
}

// ---- Main thread: build shared cache ----
// Returns { sharedMemory, thunkModule, feature } to be sent to workers

async function buildSharedCache(datasetWasmBytes, vmWasmBytes, fmaWasmBytes, simdWasmBytes, keyBytes) {
  await detectFeature(fmaWasmBytes, simdWasmBytes);

  // Create SHARED dataset memory — can be transferred to workers via postMessage
  const datasetMemory = new WebAssembly.Memory({ 
    initial: WASM_PAGES, maximum: WASM_PAGES, shared: true 
  });

  // Instantiate dataset.wasm with shared memory
  const datasetModule = new WebAssembly.Module(datasetWasmBytes);
  const datasetInstance = new WebAssembly.Instance(datasetModule, {
    env: { memory: datasetMemory },
  });
  const datasetExports = datasetInstance.exports;

  // Init cache with key
  if (keyBytes.length > 60) throw new Error('Key too long (max 60 bytes)');
  const jitBegin = datasetExports.c(WASM_PAGES, true); // shared=true
  const keyBuf = new Uint8Array(datasetMemory.buffer, jitBegin, 60);
  keyBuf.set(keyBytes);
  const jitSize = datasetExports.K(keyBytes.length);
  const jitBuffer = new Uint8Array(datasetMemory.buffer, jitBegin, jitSize);

  // Create thunk module from JIT bytecode
  const thunkModule = new WebAssembly.Module(jitBuffer);
  const thunkInstance = new WebAssembly.Instance(thunkModule, {
    e: { m: datasetMemory },
  });
  const superscalarHash = thunkInstance.exports.d;

  // Serialize thunk module to bytes so it can be sent to workers
  // WebAssembly.Module can't be postMessage'd directly, but we can recompile from bytes
  // Actually — we need to send the thunk bytes, not the module
  // Workers will recompile it themselves

  return {
    datasetMemory,      // SharedArrayBuffer-backed — transferable
    thunkBytes: jitBuffer.slice(0), // copy of JIT bytecode
    feature: _feature,
    datasetExports,     // only used by main thread for re-init
    superscalarHash,     // only used by reference, workers make their own
  };
}

// ---- Worker: create VM and mine ----
// Workers receive: { datasetMemory, thunkBytes, vmWasmBytes, feature, seedHash }

let _vmExports = null;
let _scratch = null;
let _jitImports = null;
let _vmMemory = null;
let _datasetMemory = null;

async function initWorkerVM(datasetMemory, thunkBytes, vmWasmBytes, feature) {
  _datasetMemory = datasetMemory;

  // Create per-worker VM memory (non-shared, 33 pages)
  _vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });

  // Instantiate VM
  const vmModule = new WebAssembly.Module(vmWasmBytes);
  const vmInstance = new WebAssembly.Instance(vmModule, {
    env: { memory: _vmMemory },
  });
  _vmExports = vmInstance.exports;

  // Get scratch buffer
  const scratchPtr = _vmExports.i(feature);
  _scratch = new Uint8Array(_vmMemory.buffer, scratchPtr, SCRATCH_SIZE);

  // Create thunk instance (worker's own, using shared dataset memory)
  const thunkModule = new WebAssembly.Module(thunkBytes);
  const thunkInstance = new WebAssembly.Instance(thunkModule, {
    e: { m: _datasetMemory },
  });
  const superscalarHash = thunkInstance.exports.d;

  // JIT imports — VM memory (per-worker) + superscalar hash (shared thunk)
  _jitImports = {
    e: {
      m: _vmMemory,
      d: superscalarHash,
    },
  };
}

// Reinit thunk for new seed — keeps VM memory, just updates the superscalar hash
function reinitThunk(datasetMemory, thunkBytes) {
  const thunkModule = new WebAssembly.Module(thunkBytes);
  const thunkInstance = new WebAssembly.Instance(thunkModule, {
    e: { m: datasetMemory },
  });
  if (_jitImports) {
    _jitImports.e.d = thunkInstance.exports.d;
  }
}

// Export for both CommonJS and browser
if (typeof module !== 'undefined') module.exports = { buildSharedCache, initWorkerVM, detectFeature };
if (typeof self !== 'undefined') {
  self.buildSharedCache = buildSharedCache;
  self.initWorkerVM = initWorkerVM;
  self.detectFeature = detectFeature;
}