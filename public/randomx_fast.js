// randomx_fast.js — JIT RandomX engine (non-shared, per-worker)
// Based on l1mey112/randomx.js architecture, pure JS (no TS/bun/bundler)

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

let _vmExports = null;
let _scratch = null;
let _jitImports = null;
let _memory = null;
let _datasetMemory = null;

async function initRandomX(datasetWasmBytes, vmWasmBytes, fmaWasmBytes, simdWasmBytes) {
  await detectFeature(fmaWasmBytes, simdWasmBytes);

  const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
  const datasetMemory = new WebAssembly.Memory({ initial: WASM_PAGES, maximum: WASM_PAGES });

  const datasetModule = new WebAssembly.Module(datasetWasmBytes);
  const datasetInstance = new WebAssembly.Instance(datasetModule, { env: { memory: datasetMemory } });
  const datasetExports = datasetInstance.exports;

  const vmModule = new WebAssembly.Module(vmWasmBytes);
  const vmInstance = new WebAssembly.Instance(vmModule, { env: { memory: vmMemory } });
  _vmExports = vmInstance.exports;

  const scratchPtr = _vmExports.i(_feature);
  _scratch = new Uint8Array(vmMemory.buffer, scratchPtr, SCRATCH_SIZE);
  _memory = vmMemory;
  _datasetMemory = datasetMemory;
}

function initCache(keyBytes) {
  if (keyBytes.length > 60) throw new Error('Key too long (max 60 bytes)');
  const jitBegin = _datasetExports ? _datasetExports.c(WASM_PAGES, false) : null;
  if (jitBegin === null || jitBegin === undefined) return;
  const keyBuf = new Uint8Array(_datasetMemory.buffer, jitBegin, 60);
  keyBuf.set(keyBytes);
  const jitSize = _datasetExports.K(keyBytes.length);
  const jitBuffer = new Uint8Array(_datasetMemory.buffer, jitBegin, jitSize);

  const thunkModule = new WebAssembly.Module(jitBuffer);
  const thunkInstance = new WebAssembly.Instance(thunkModule, { e: { m: _datasetMemory } });
  const superscalarHash = thunkInstance.exports.d;

  _jitImports = { e: { m: _memory, d: superscalarHash } };
}

let _datasetExports = null;

async function initRandomXFull(datasetWasmBytes, vmWasmBytes, fmaWasmBytes, simdWasmBytes) {
  await detectFeature(fmaWasmBytes, simdWasmBytes);

  const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
  const datasetMemory = new WebAssembly.Memory({ initial: WASM_PAGES, maximum: WASM_PAGES });

  const datasetModule = new WebAssembly.Module(datasetWasmBytes);
  const datasetInstance = new WebAssembly.Instance(datasetModule, { env: { memory: datasetMemory } });
  _datasetExports = datasetInstance.exports;

  const vmModule = new WebAssembly.Module(vmWasmBytes);
  const vmInstance = new WebAssembly.Instance(vmModule, { env: { memory: vmMemory } });
  _vmExports = vmInstance.exports;

  const scratchPtr = _vmExports.i(_feature);
  _scratch = new Uint8Array(vmMemory.buffer, scratchPtr, SCRATCH_SIZE);
  _memory = vmMemory;
  _datasetMemory = datasetMemory;
}

async function createRandomXFast(locateFile) {
  const [datasetWasm, vmWasm, fmaWasm, simdWasm] = await Promise.all([
    fetch(locateFile('dataset.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('vm.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('fma.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('simd.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
  ]);

  await initRandomXFull(datasetWasm, vmWasm, fmaWasm, simdWasm);

  return {
    initCache,
    feature: _feature,
    get _vmExports() { return _vmExports; },
    get _scratch() { return _scratch; },
    get _jitImports() { return _jitImports; },
  };
}

if (typeof module !== 'undefined') module.exports = { createRandomXFast };
if (typeof self !== 'undefined') self.createRandomXFast = createRandomXFast;