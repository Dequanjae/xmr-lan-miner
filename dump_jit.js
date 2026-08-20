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
const bytes = scratch.subarray(0, size);

function readLEB(data, p) {
  let r = 0, s = 0;
  do { r |= (data[p] & 0x7f) << s; s += 7; } while (data[p++] & 0x80);
  return [r, p];
}

let p = 8;
while (p < bytes.length) {
  const sid = bytes[p]; p++;
  const [sz, np] = readLEB(bytes, p); p = np;
  const secStart = p;
  const secEnd = p + sz;
  if (sid === 4) {
    const [cnt, cp] = readLEB(bytes, p); p = cp;
    console.log(`Table section: ${cnt} tables`);
    for (let i = 0; i < cnt; i++) {
      const et = bytes[p]; p++;
      const lf = bytes[p]; p++;
      if (lf & 1) {
        const [mn, mp] = readLEB(bytes, p); p = mp;
        const [mx, xp] = readLEB(bytes, p); p = xp;
        console.log(`  table ${i}: type=0x${et.toString(16)} min=${mn} max=${mx}`);
      } else {
        const [mn, mp] = readLEB(bytes, p); p = mp;
        console.log(`  table ${i}: type=0x${et.toString(16)} min=${mn} no_max`);
      }
    }
  }
  if (sid === 9) {
    const [cnt, cp] = readLEB(bytes, p); p = cp;
    console.log(`Elem section: ${cnt} segments`);
    for (let i = 0; i < cnt; i++) {
      const flags = bytes[p]; p++;
      const [ti, tp] = readLEB(bytes, p); p = tp;
      if (flags === 0) {
        const [off, op] = readLEB(bytes, p); p = op;
        const [ncnt, ncp] = readLEB(bytes, p); p = ncp;
        console.log(`  elem ${i}: table=${ti} offset=${off} count=${ncnt}`);
      } else if (flags === 1) {
        const [ncnt, ncp] = readLEB(bytes, p); p = ncp;
        console.log(`  elem ${i}: passive count=${ncnt}`);
      } else {
        console.log(`  elem ${i}: flags=${flags} (complex)`);
      }
    }
  }
  p = secEnd;
}
// Also save the chunk for browser testing
fs.writeFileSync('/opt/data/xmr-webminer/repo/jit_chunk.wasm', bytes);
console.log('Saved JIT chunk to jit_chunk.wasm (' + bytes.length + ' bytes)');