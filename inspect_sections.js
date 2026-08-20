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
const superscalarHash = thunkInst.exports.d;

const input = new TextEncoder().encode('RandomX example input');
vmInst.exports.I(false);
scratch.set(input);
vmInst.exports.H(input.length);
const size = vmInst.exports.Rs();
const chunk = scratch.subarray(0, size);
const jMod = new WebAssembly.Module(chunk);
console.log('JIT chunk imports:', JSON.stringify(WebAssembly.Module.imports(jMod)));

// Check if the chunk has a table section by examining the binary
// A table section is type 0x04 in the WASM binary
const bytes = chunk;
let p = 8; // skip magic + version
function readLEB(p) { let r = 0, s = 0; do { r |= (bytes[p] & 0x7f) << s; s += 7; } while (bytes[p++] & 0x80); return [r, p]; }
// section ID 4 = table
while (p < bytes.length) {
  const id = bytes[p]; p++;
  const [sz, np] = readLEB(p); p = np;
  if (id === 4) {
    console.log('Found table section at offset', p, 'size', sz);
    // count of tables
    const [count, cp] = readLEB(p);
    console.log('  table count:', count);
  }
  if (id === 9) {
    console.log('Found element section at offset', p, 'size', sz);
    const [count, cp] = readLEB(p);
    console.log('  element segments:', count);
  }
  p += sz;
}