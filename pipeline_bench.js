
const { Worker, MessageChannel } = require('worker_threads');
const fs = require('fs');

const COMPILE_WORKER_CODE = `
const { parentPort } = require('worker_threads');
let miningPort = null;
const cache = new Map();

parentPort.on('message', (msg) => {
  if (msg.type === 'port') {
    miningPort = msg.port;
    miningPort.on('message', (m) => {
      if (m.type === 'compile') {
        if (cache.has(m.key)) {
          miningPort.postMessage({ type: 'moduleReady', key: m.key, module: cache.get(m.key), cached: true });
          return;
        }
        WebAssembly.compile(m.bytecode).then(mod => {
          cache.set(m.key, mod);
          if (cache.size > 300) { const k = cache.keys().next().value; cache.delete(k); }
          miningPort.postMessage({ type: 'moduleReady', key: m.key, module: mod, cached: false });
        }).catch(e => {
          miningPort.postMessage({ type: 'compileError', key: m.key, error: e.message });
        });
      }
    });
  }
});
`;

const MINING_WORKER_CODE = `
const { parentPort } = require('worker_threads');
const pending = new Map();
let compilePort = null;

parentPort.on('message', (msg) => {
  if (msg.type === 'setCompilePort') {
    compilePort = msg.port;
    compilePort.on('message', (m) => {
      if (m.type === 'moduleReady') {
        const p = pending.get(m.key);
        if (p) { pending.delete(m.key); p.resolve(m.module); }
      }
    });
  } else if (msg.type === 'mine') {
    runMining(msg).catch(e => parentPort.postMessage({ type: 'error', error: e.message }));
  }
});

function requestModule(key, bytecode) {
  return new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject });
    compilePort.postMessage({ type: 'compile', key, bytecode });
  });
}

async function runMining(config) {
  const { bytes, iterations } = config;
  const imports = { e: { m: new WebAssembly.Memory({initial: 1}), d: () => {} } };
  let hashCount = 0;
  const t0 = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    const key = 'prog_' + i;
    const mod = await requestModule(key, bytes);
    const inst = new WebAssembly.Instance(mod, imports);
    hashCount++;
  }
  
  const elapsed = performance.now() - t0;
  parentPort.postMessage({ type: 'done', hashCount, elapsedMs: elapsed });
}
`;

async function main() {
  const bytes = fs.readFileSync('/opt/data/xmr-webminer/repo/jit_chunk.wasm');
  const N = 100;
  
  console.log('=== Pipeline Compilation Worker Benchmark ===');
  console.log('');
  
  const compileWorker = new Worker(COMPILE_WORKER_CODE, { eval: true });
  const miningWorker = new Worker(MINING_WORKER_CODE, { eval: true });
  const { port1, port2 } = new MessageChannel();
  
  miningWorker.postMessage({ type: 'setCompilePort', port: port1 }, [port1]);
  compileWorker.postMessage({ type: 'port', port: port2 }, [port2]);
  
  await new Promise(r => setTimeout(r, 200));
  
  const result = await new Promise((resolve) => {
    miningWorker.on('message', (msg) => {
      if (msg.type === 'done') resolve(msg);
    });
    miningWorker.postMessage({ type: 'mine', bytes, iterations: N });
  });
  
  console.log('Pipeline (dedicated compile worker):');
  console.log('  ' + result.hashCount + ' programs in ' + result.elapsedMs.toFixed(1) + 'ms');
  console.log('  ' + (result.elapsedMs / result.hashCount).toFixed(2) + 'ms per program (compile + transfer + instantiate)');
  
  const imports2 = { e: { m: new WebAssembly.Memory({initial: 1}), d: () => {} } };
  for (let i = 0; i < 5; i++) { const m = new WebAssembly.Module(bytes); new WebAssembly.Instance(m, imports2); }
  const t1 = performance.now();
  for (let i = 0; i < N; i++) { const m = new WebAssembly.Module(bytes); new WebAssembly.Instance(m, imports2); }
  const directMs = performance.now() - t1;
  
  console.log('');
  console.log('Direct (sync on same thread):');
  console.log('  ' + N + ' programs in ' + directMs.toFixed(1) + 'ms');
  console.log('  ' + (directMs / N).toFixed(2) + 'ms per program');
  
  console.log('');
  console.log('=== Browser Impact (estimated, 40ms compile) ===');
  console.log('Direct: 40ms blocked per cache miss');
  console.log('Pipeline: 40ms runs off-thread, ~2-5ms transfer overhead');
  console.log('Net: mining thread never stalls on compilation');
  
  compileWorker.terminate();
  miningWorker.terminate();
  process.exit(0);
}

main().catch(console.error);
