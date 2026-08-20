const fs = require('fs');
const { WebAssembly } = global;
const pub = '/opt/data/xmr-webminer/repo/public';

// Patch randomx_fast to expose the thunk for inspection
const code = fs.readFileSync(pub + '/randomx_fast.js', 'utf8');

// Create a test that hooks into initCache to inspect the thunk
const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
const datasetMemory = new WebAssembly.Memory({ initial: 4098, maximum: 4098 });

const dsMod = new WebAssembly.Module(fs.readFileSync(pub + '/dataset.wasm'));
const dsInst = new WebAssembly.Instance(dsMod, { env: { memory: datasetMemory } });
const vmMod = new WebAssembly.Module(fs.readFileSync(pub + '/vm.wasm'));
const vmInst = new WebAssembly.Instance(vmMod, { env: { memory: vmMemory } });

const feature = vmInst.exports.i(0);
console.log('scratch ptr:', feature);
const scratch = new Uint8Array(vmMemory.buffer, feature, 16*1024);

// Init cache
const key = new TextEncoder().encode('RandomX example key');
const jitBegin = dsInst.exports.c(4098, false);
console.log('jit begin:', jitBegin);
const keyBuf = new Uint8Array(datasetMemory.buffer, jitBegin, 60);
keyBuf.set(key);
console.log('generating JIT bytecode...');
const jitSize = dsInst.exports.K(key.length);
console.log('JIT bytecode size:', jitSize);

const jitBuffer = new Uint8Array(datasetMemory.buffer, jitBegin, jitSize);
// Inspect the JIT module
try {
  const thunkMod = new WebAssembly.Module(jitBuffer);
  console.log('thunk imports:', JSON.stringify(WebAssembly.Module.imports(thunkMod)));
  console.log('thunk exports:', JSON.stringify(WebAssembly.Module.exports(thunkMod)));
} catch (e) {
  console.error('thunk module error:', e.message);
  // Dump first 50 bytes of bytecode
  console.log('first 50 bytes:', Array.from(jitBuffer.slice(0, 50)).map(b => b.toString(16).padStart(2,'0')).join(' '));
}