// Benchmark the C build's superscalar hash primitive and compare with Rust.
const fs = require('fs');
const { WebAssembly } = global;
const pub = '/opt/data/xmr-webminer/repo/public';

const vmMemory = new WebAssembly.Memory({ initial: 33, maximum: 33 });
const datasetMemory = new WebAssembly.Memory({ initial: 4098, maximum: 4098 });

const dsMod = new WebAssembly.Module(fs.readFileSync(pub + '/dataset.wasm'));
const dsInst = new WebAssembly.Instance(dsMod, { env: { memory: datasetMemory } });
const vmMod = new WebAssembly.Module(fs.readFileSync(pub + '/vm.wasm'));
const vmInst = new WebAssembly.Instance(vmMod, { env: { memory: vmMemory } });

vmInst.exports.i(0); // baseline feature

const key = new TextEncoder().encode('RandomX example key');
const jitBegin = dsInst.exports.c(4098, false);
const keyBuf = new Uint8Array(datasetMemory.buffer, jitBegin, 60);
keyBuf.set(key);
const jitSize = dsInst.exports.K(key.length);
console.log('JIT superscalar thunk size:', jitSize, 'bytes');

const jitBuffer = new Uint8Array(datasetMemory.buffer, jitBegin, jitSize);
const thunkMod = new WebAssembly.Module(jitBuffer);
const thunkInst = new WebAssembly.Instance(thunkMod, { e: { m: datasetMemory } });
const superscalarHash = thunkInst.exports.d;

// Warm up
for (let i = 0; i < 1000; i++) superscalarHash(0n);

// Benchmark superscalar hash (the JIT-compiled version from C build)
const N = 100000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  superscalarHash(0n);
}
const elapsedNs = Number(process.hrtime.bigint() - t0);
const perOpNs = elapsedNs / N;
console.log(`C/JIT superscalarHash:    ${N} iters  ${perOpNs.toFixed(0)} ns/op  ${(1e9/perOpNs).toFixed(0)} op/s  (${(elapsedNs/1e9).toFixed(3)}s total)`);

// Verify result
const result = superscalarHash(0n);
console.log('superscalar hash result (first 2):', result[0], result[1]);

// Also benchmark blake2b512 equivalent in JS for reference
// (The C build uses its own blake2 in dataset.wasm; we can't isolate it easily,
//  so we just report the superscalar hash which is the dominant primitive.)

console.log('\n--- File sizes ---');
['randomx.wasm', 'vm.wasm', 'dataset.wasm', 'fma.wasm', 'simd.wasm'].forEach(f => {
  try {
    const sz = fs.statSync(pub + '/' + f).size;
    console.log(`  ${f}: ${sz} bytes (${(sz/1024).toFixed(1)} KB)`);
  } catch (e) {}
});
const total = ['randomx.wasm', 'vm.wasm', 'dataset.wasm', 'fma.wasm', 'simd.wasm']
  .map(f => { try { return fs.statSync(pub + '/' + f).size; } catch(e) { return 0; } })
  .reduce((a, b) => a + b, 0);
console.log(`  total C build: ${total} bytes (${(total/1024).toFixed(1)} KB)`);