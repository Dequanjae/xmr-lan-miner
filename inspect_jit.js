const fs = require('fs');
const { WebAssembly } = global;
const pub = '/opt/data/xmr-webminer/repo/public';
const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
const datasetMemory = new WebAssembly.Memory({ initial: 4098, maximum: 4098 });
const dsInst = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(pub + '/dataset.wasm')), { env: { memory: datasetMemory } });
const vmInst = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(pub + '/vm.wasm')), { env: { memory: vmMemory } });
const scratchPtr = vmInst.exports.i(0);
const scratch = new Uint8Array(vmMemory.buffer, scratchPtr, 16 * 1024);
const key = new TextEncoder().encode('RandomX example key');
const jitBegin = dsInst.exports.c(4098, false);
new Uint8Array(datasetMemory.buffer, jitBegin, 60).set(key);
const jitSize = dsInst.exports.K(key.length);
const thunkMod = new WebAssembly.Module(new Uint8Array(datasetMemory.buffer, jitBegin, jitSize));
const thunkInst = new WebAssembly.Instance(thunkMod, { e: { m: datasetMemory } });
// Run VM to get first JIT chunk
const input = new TextEncoder().encode('RandomX example input');
vmInst.exports.I(false);
scratch.set(input);
vmInst.exports.H(input.length);
const size = vmInst.exports.Rs();
console.log('JIT chunk size:', size);
const chunk = scratch.subarray(0, size);
// Inspect the JIT chunk module
const jMod = new WebAssembly.Module(chunk);
console.log('JIT chunk imports:', JSON.stringify(WebAssembly.Module.imports(jMod)));
console.log('JIT chunk exports:', JSON.stringify(WebAssembly.Module.exports(jMod)));