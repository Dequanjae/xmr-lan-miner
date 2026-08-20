// randomx_fast.js — JIT RandomX with shared memory support
// Main thread: buildSharedCache() creates one SharedArrayBuffer-backed cache
// Workers: initWorkerVM() creates per-worker VM (2MB) using shared cache

const WASM_PAGES = 4098;
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

// ---- Main thread: build shared cache (one-time) ----
async function buildSharedCache(datasetWasmBytes, vmWasmBytes, fmaWasmBytes, simdWasmBytes, keyBytes) {
  await detectFeature(fmaWasmBytes, simdWasmBytes);

  // Shared dataset memory — SharedArrayBuffer-backed, transferable to workers
  const datasetMemory = new WebAssembly.Memory({
    initial: WASM_PAGES, maximum: WASM_PAGES, shared: true
  });

  const datasetModule = new WebAssembly.Module(datasetWasmBytes);
  const datasetInstance = new WebAssembly.Instance(datasetModule, { env: { memory: datasetMemory } });
  const datasetExports = datasetInstance.exports;

  // Init cache
  if (keyBytes.length > 60) throw new Error('Key too long (max 60 bytes)');
  const jitBegin = datasetExports.c(WASM_PAGES, true);
  const keyBuf = new Uint8Array(datasetMemory.buffer, jitBegin, 60);
  keyBuf.set(keyBytes);
  const jitSize = datasetExports.K(keyBytes.length);
  const jitBuffer = new Uint8Array(datasetMemory.buffer, jitBegin, jitSize);

  return {
    datasetMemory,
    thunkBytes: jitBuffer.slice(0),
    feature: _feature,
  };
}

// ---- Worker: create per-worker VM using shared cache ----
let _vmExports = null;
let _scratch = null;
let _jitImports = null;
let _vmMemory = null;
let _datasetMemory = null;

async function initWorkerVM(datasetMemory, thunkBytes, vmWasmBytes, feature) {
  _datasetMemory = datasetMemory;

  // Per-worker VM memory (non-shared, 2MB)
  _vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });

  const vmModule = new WebAssembly.Module(vmWasmBytes);
  const vmInstance = new WebAssembly.Instance(vmModule, { env: { memory: _vmMemory } });
  _vmExports = vmInstance.exports;

  const scratchPtr = _vmExports.i(feature);
  _scratch = new Uint8Array(_vmMemory.buffer, scratchPtr, SCRATCH_SIZE);

  // Create thunk instance using shared dataset memory
  const thunkModule = new WebAssembly.Module(thunkBytes);
  const thunkInstance = new WebAssembly.Instance(thunkModule, { e: { m: _datasetMemory } });
  const superscalarHash = thunkInstance.exports.d;

  // JIT imports: VM memory (per-worker) + superscalar hash (shared)
  _jitImports = { e: { m: _vmMemory, d: superscalarHash } };
}

function reinitThunk(datasetMemory, thunkBytes) {
  const thunkModule = new WebAssembly.Module(thunkBytes);
  const thunkInstance = new WebAssembly.Instance(thunkModule, { e: { m: datasetMemory } });
  if (_jitImports) _jitImports.e.d = thunkInstance.exports.d;
}

if (typeof module !== 'undefined') module.exports = { buildSharedCache, initWorkerVM, reinitThunk, detectFeature };
if (typeof self !== 'undefined') {
  self.buildSharedCache = buildSharedCache;
  self.initWorkerVM = initWorkerVM;
  self.reinitThunk = reinitThunk;
  self.detectFeature = detectFeature;
}