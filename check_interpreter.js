const fs = require('fs');
const { WebAssembly } = global;

// Test: Run the VM in interpreter mode (I(true) vs I(false))
// If I(false) = no JIT, the VM should interpret programs directly

const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
const datasetMemory = new WebAssembly.Memory({ initial: 4098, maximum: 4098 });

const dsInst = new WebAssembly.Instance(
  new WebAssembly.Module(fs.readFileSync('/opt/data/xmr-webminer/repo/public/dataset.wasm')),
  { env: { memory: datasetMemory } }
);
const vmInst = new WebAssembly.Instance(
  new WebAssembly.Module(fs.readFileSync('/opt/data/xmr-webminer/repo/public/vm.wasm')),
  { env: { memory: vmMemory } }
);

const scratchPtr = vmInst.exports.i(0); // baseline feature
const scratch = new Uint8Array(vmMemory.buffer, scratchPtr, 16 * 1024);

// Init cache
const key = new TextEncoder().encode('RandomX example key');
const jitBegin = dsInst.exports.c(4098, false);
new Uint8Array(datasetMemory.buffer, jitBegin, 60).set(key);
const jitSize = dsInst.exports.K(key.length);
const thunkMod = new WebAssembly.Module(new Uint8Array(datasetMemory.buffer, jitBegin, jitSize));
const thunkInst = new WebAssembly.Instance(thunkMod, { e: { m: datasetMemory } });

// Test with JIT mode (I(false))
console.log('=== Test: I(false) - JIT mode ===');
vmInst.exports.I(false);
const input = new TextEncoder().encode('RandomX example input');
scratch.set(input);
vmInst.exports.H(input.length);

let jitCalls = 0;
let stepResult;
const t0 = performance.now();
do {
  stepResult = vmInst.exports.Rm();
  if (stepResult > 1) {
    jitCalls++;
    // Would compile and execute JIT program here
    // For now, just count how many JIT compilations are needed
  }
} while (stepResult !== 0 && stepResult !== 1 && performance.now() - t0 < 5000);
const jitModeMs = performance.now() - t0;
console.log('  JIT compilations needed:', jitCalls);
console.log('  Time in VM loop:', jitModeMs.toFixed(1), 'ms');
console.log('  (excluding compilation time)');

// Test with I(true) - maybe interpreter mode?
console.log('');
console.log('=== Test: I(true) - possibly interpreter mode ===');
try {
  vmInst.exports.I(true);
  scratch.set(input);
  vmInst.exports.H(input.length);
  
  let jitCalls2 = 0;
  let stepResult2;
  const t1 = performance.now();
  do {
    stepResult2 = vmInst.exports.Rm();
    if (stepResult2 > 1) jitCalls2++;
  } while (stepResult2 !== 0 && stepResult2 !== 1 && performance.now() - t1 < 10000);
  const interpModeMs = performance.now() - t1;
  console.log('  JIT compilations needed:', jitCalls2);
  console.log('  Time in VM loop:', interpModeMs.toFixed(1), 'ms');
  if (jitCalls2 === 0) {
    console.log('  >> INTERPRETER MODE! No JIT compilation needed!');
    console.log('  >> This avoids the 40ms compile cost entirely!');
  }
} catch(e) {
  console.log('  Error:', e.message);
}
