const { parentPort } = require('worker_threads');
const fs = require('fs');

// Pre-load JIT chunk for testing
const jitBytes = fs.readFileSync('/opt/data/xmr-webminer/repo/jit_chunk.wasm');

const moduleCache = new Map();

parentPort.on('message', (msg) => {
  if (msg.type === 'compile') {
    const t0 = performance.now();
    // In real use, msg.bytecode would be the JIT bytecode
    // For testing we use the pre-loaded chunk
    const bytes = msg.bytecode || jitBytes;
    const key = msg.key || 'default';
    
    if (moduleCache.has(key)) {
      parentPort.postMessage({ type: 'compiled', key, module: moduleCache.get(key), cached: true, compileTime: 0 });
    } else {
      const mod = new WebAssembly.Module(bytes);
      moduleCache.set(key, mod);
      parentPort.postMessage({ type: 'compiled', key, module: mod, cached: false, compileTime: performance.now() - t0 });
    }
  } else if (msg.type === 'getStats') {
    parentPort.postMessage({ type: 'stats', size: moduleCache.size });
  }
});
