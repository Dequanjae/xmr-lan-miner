// randomx_fast.js — standalone JIT-accelerated RandomX for browser workers
// Based on l1mey112/randomx.js architecture, rewritten as pure JS (no TS/bun/bundler)

const WASM_PAGES = 4098; // from configuration.toml / vm.wasm import
const SCRATCH_SIZE = 16 * 1024;

// JIT feature detection
const JIT_BASELINE = 0;
const JIT_RELAXED_SIMD = 1;
const JIT_FMA = 2;

let _feature = JIT_BASELINE;

async function detectFeature(fmaWasmBytes, simdWasmBytes) {
  // Validate SIMD baseline
  try {
    WebAssembly.validate(simdWasmBytes);
  } catch (e) {
    throw new Error('WASM SIMD not supported');
  }
  try {
    const wm = new WebAssembly.Module(fmaWasmBytes);
    const wi = new WebAssembly.Instance(wm);
    if (wi.exports.d()()) {
      _feature = JIT_FMA | JIT_RELAXED_SIMD;
    } else {
      _feature = JIT_RELAXED_SIMD;
    }
  } catch (e) {
    _feature = JIT_BASELINE;
  }
  return _feature;
}

// Module state
let _memory = null;
let _datasetExports = null;  // dataset.wasm: c(), K()
let _vmExports = null;        // vm.wasm: i(), I(), H(), Rs(), Rm()
let _scratch = null;          // Uint8Array view into scratch buffer
let _jitImports = null;       // imports for JIT modules: { e: { m: memory, d: superscalarhash } }

async function initRandomX(datasetWasmBytes, vmWasmBytes, fmaWasmBytes, simdWasmBytes) {
  // 1. Detect JIT features
  await detectFeature(fmaWasmBytes, simdWasmBytes);

  // 2. Create separate memories — vm.wasm needs 33 pages, dataset.wasm needs 4098
  const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
  const datasetMemory = new WebAssembly.Memory({ initial: 4098, maximum: 4098 });

  // 3. Instantiate dataset.wasm with dataset memory
  const datasetModule = new WebAssembly.Module(datasetWasmBytes);
  const datasetInstance = new WebAssembly.Instance(datasetModule, {
    env: { memory: datasetMemory },
  });
  _datasetExports = datasetInstance.exports;

  // 4. Instantiate vm.wasm with vm memory
  const vmModule = new WebAssembly.Module(vmWasmBytes);
  const vmInstance = new WebAssembly.Instance(vmModule, {
    env: { memory: vmMemory },
  });
  _vmExports = vmInstance.exports;

  // 5. Get scratch buffer pointer from VM init
  const scratchPtr = _vmExports.i(_feature);
  _scratch = new Uint8Array(vmMemory.buffer, scratchPtr, SCRATCH_SIZE);
  _memory = vmMemory; // store VM memory for reference
  _datasetMemory = datasetMemory; // store dataset memory
}

function initCache(keyBytes) {
  if (keyBytes.length > 60) throw new Error('Key too long (max 60 bytes)');

  // Allocate JIT code buffer in dataset memory
  // is_shared=false for non-shared build (pkg-randomx.js, not pkg-randomx.js-shared)
  const jitBegin = _datasetExports.c(4098, false);

  // Write key
  const keyBuf = new Uint8Array(_datasetMemory.buffer, jitBegin, 60);
  keyBuf.set(keyBytes);

  // Generate JIT bytecode (long blocking call — Argon2 + superscalar)
  const jitSize = _datasetExports.K(keyBytes.length);
  const jitBuffer = new Uint8Array(_datasetMemory.buffer, jitBegin, jitSize);

  // Create the superscalar hash thunk module from JIT bytecode
  const thunkModule = new WebAssembly.Module(jitBuffer);
  const thunkInstance = new WebAssembly.Instance(thunkModule, {
    e: { m: _datasetMemory },
  });
  const superscalarHash = thunkInstance.exports.d;

  // Set up JIT imports for VM-generated JIT modules
  // JIT modules import e.m (memory) and e.d (superscalar hash)
  // e.m must be the VM's memory (where the scratchpad lives), NOT the dataset memory
  _jitImports = {
    e: {
      m: _memory,
      d: superscalarHash,
    },
  };
}

function calculateHash(input) {
  if (typeof input === 'string') {
    input = new TextEncoder().encode(input);
  }

  // Install input
  _vmExports.I(false);
  if (input.length <= SCRATCH_SIZE) {
    _scratch.set(input);
    _vmExports.H(input.length);
  } else {
    let p = 0;
    while (p < input.length) {
      const chunk = input.subarray(p, p + SCRATCH_SIZE);
      p += SCRATCH_SIZE;
      _scratch.set(chunk);
      _vmExports.H(chunk.length);
    }
  }

  // Run VM — it generates JIT WASM programs and we compile+execute them
  while (true) {
    const jitSize = _vmExports.Rs();
    if (jitSize === 0) break;

    const jitWm = new WebAssembly.Module(_scratch.subarray(0, jitSize));
    const jitWi = new WebAssembly.Instance(jitWm, _jitImports);
    jitWi.exports.d();
  }

  // Read 32-byte hash from scratch
  return new Uint8Array(_scratch.subarray(0, 32));
}

function calculateHexHash(input) {
  if (typeof input === 'string') {
    input = new TextEncoder().encode(input);
  }

  _vmExports.I(true);
  if (input.length <= SCRATCH_SIZE) {
    _scratch.set(input);
    _vmExports.H(input.length);
  } else {
    let p = 0;
    while (p < input.length) {
      const chunk = input.subarray(p, p + SCRATCH_SIZE);
      p += SCRATCH_SIZE;
      _scratch.set(chunk);
      _vmExports.H(chunk.length);
    }
  }

  while (true) {
    const jitSize = _vmExports.Rs();
    if (jitSize === 0) break;
    const jitWm = new WebAssembly.Module(_scratch.subarray(0, jitSize));
    const jitWi = new WebAssembly.Instance(jitWm, _jitImports);
    jitWi.exports.d();
  }

  return new TextDecoder().decode(_scratch.subarray(0, 64));
}

// Export for both CommonJS and browser
if (typeof module !== 'undefined') module.exports = { createRandomXFast };
if (typeof self !== 'undefined') self.createRandomXFast = createRandomXFast;

async function createRandomXFast(locateFile) {
  const [datasetWasm, vmWasm, fmaWasm, simdWasm] = await Promise.all([
    fetch(locateFile('dataset.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('vm.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('fma.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(locateFile('simd.wasm')).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
  ]);

  await initRandomX(datasetWasm, vmWasm, fmaWasm, simdWasm);

  return {
    initCache,
    calculateHash,
    calculateHexHash,
    feature: _feature,
  };
}