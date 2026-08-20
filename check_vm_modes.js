const fs = require('fs');
const { WebAssembly } = global;

// Load VM
const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
const vmMod = new WebAssembly.Module(fs.readFileSync('/opt/data/xmr-webminer/repo/public/vm.wasm'));
const vmInst = new WebAssembly.Instance(vmMod, { env: { memory: vmMemory } });

// Check what vm.I() does (likely "init" / "set JIT mode")
// Looking at worker.js: vmExports.I(false) is called
// The false parameter might mean "no JIT" = interpreter mode!

console.log('VM exports and their behavior:');
console.log('  i(feature) - init with feature level, returns scratch ptr');
console.log('  I(useJIT?) - initialize VM, possibly toggle JIT/interpreter mode');
console.log('  H(len)     - hash input');
console.log('  Rs()       - get JIT size (program ready?)');
console.log('  Rm()       - mining loop step (returns 0=continue, 1=found, >1=JIT size)');
console.log('  B(...)     - setup blob/target/nonce range');
console.log('  n()        - get nonce');
console.log('  h()        - get hash count');
console.log('');

// Test: what happens if we call I(true) vs I(false)?
// I(false) might mean "use interpreter, no JIT"
// Let's check the source

// The dataset.wasm also has JIT bytecode generation
// If we skip JIT and use interpreter, we avoid compilation entirely

// Check if vm.wasm has interpreter built in by looking at function count
const vmBytes = fs.readFileSync('/opt/data/xmr-webminer/repo/public/vm.wasm');

// Parse sections to count functions
function readLEB(data, p) {
  let r = 0, s = 0;
  do { r |= (data[p] & 0x7f) << s; s += 7; } while (data[p++] & 0x80);
  return [r, p];
}

let p = 8;
while (p < vmBytes.length) {
  const sid = vmBytes[p]; p++;
  const [sz, np] = readLEB(vmBytes, p); p = np;
  if (sid === 10) { // Code section
    let cp = p;
    const [nfunc, cnp] = readLEB(vmBytes, cp); cp = cnp;
    console.log('vm.wasm has ' + nfunc + ' functions');
  }
  p += sz;
}
console.log('vm.wasm size: ' + vmBytes.length + ' bytes');
