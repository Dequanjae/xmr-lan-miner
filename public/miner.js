// Main thread: build shared cache once → send to all workers → manage mining
(() => {
  let ws = null;
  let workers = [];
  let connected = false;
  let currentJob = null;
  let minerId = null;
  let nextShareId = 10;
  let accepted = 0, rejected = 0;
  let totalHashrate = 0;
  let cores = navigator.hardwareConcurrency || 4;
  let numWorkers = Math.min(cores - 1, 16); // shared memory = more workers OK
  let backgroundMode = false;
  let sharedCacheReady = false;
  let pendingJobs = [];

  const $ = (id) => document.getElementById(id);
  const safeSet = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  const log = (msg, cls) => {
    const box = $('logBox');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (cls) line.className = cls;
    box.prepend(line);
    while (box.children.length > 200) box.lastChild.remove();
  };

  function getSystemInfo() {
    let browser = 'unknown';
    const ua = navigator.userAgent;
    if (ua.includes('Firefox')) browser = 'Firefox';
    else if (ua.includes('Edg')) browser = 'Edge';
    else if (ua.includes('Chrome')) browser = 'Chrome';
    else if (ua.includes('Safari')) browser = 'Safari';
    let os = 'unknown';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
    return { cores, browser, os };
  }

  async function loadConfig() {
    const qp = new URLSearchParams(location.search);
    const savedWallet = localStorage.getItem('xmr-wallet') || '';
    try {
      const r = await fetch('/config');
      const c = await r.json();
      $('walletInput').value = qp.get('wallet') || savedWallet || c.wallet || '';
      $('poolHost').value = qp.get('pool') || c.poolHost || '';
      $('poolPort').value = qp.get('port') || c.poolPort || 3333;
    } catch (e) {
      $('walletInput').value = qp.get('wallet') || savedWallet || '';
      $('poolHost').value = qp.get('pool') || 'pool.supportxmr.com';
      $('poolPort').value = qp.get('port') || 3333;
    }
    backgroundMode = localStorage.getItem('xmr-background') === '1';
    const bgCheckbox = $('backgroundMode');
    if (bgCheckbox) bgCheckbox.checked = backgroundMode;
    const savedWorkers = localStorage.getItem('xmr-workers');
    if (savedWorkers) numWorkers = Math.min(parseInt(savedWorkers, 10) || numWorkers, 16);
  }

  function renderSystemInfo() {
    const sys = getSystemInfo();
    safeSet('sysCores', sys.cores);
    safeSet('sysBrowser', sys.browser);
    safeSet('sysOS', sys.os);
    safeSet('sysMode', 'JIT');
    const slider = $('workerCount');
    if (slider) {
      slider.max = Math.min(cores, 16);
      slider.value = numWorkers;
      const disp = $('workerCountDisplay');
      if (disp) disp.textContent = numWorkers;
      const mc = $('maxCores');
      if (mc) mc.textContent = Math.min(cores, 16);
    }
    return sys;
  }

  function connectWS(cfg) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => {
      connected = true;
      safeSet('status', 'Connected');
      safeSet('miningStatus', 'connected');
      log('WS connected, configuring pool...');
      const sys = getSystemInfo();
      ws.send(JSON.stringify({
        method: 'configure',
        wallet: cfg.wallet,
        poolHost: cfg.poolHost,
        poolPort: parseInt(cfg.poolPort, 10),
        worker: cfg.worker || undefined,
        sysInfo: sys,
      }));
    };
    ws.onclose = () => { connected = false; safeSet('status', 'Disconnected'); safeSet('miningStatus', 'disconnected'); log('WS closed'); };
    ws.onerror = () => { log('WS error', 'err'); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handlePoolMessage(msg);
    };
  }

  function handlePoolMessage(msg) {
    if (msg.id === '1' || msg.id === 1) {
      if (msg.result && msg.result.job) {
        minerId = msg.result.id;
        log(`Logged in. Miner id=${minerId.slice(0, 16)}...`);
        onNewJob(msg.result.job);
      } else if (msg.error) {
        log(`Login failed: ${msg.error.message}`, 'err');
      }
      return;
    }
    if (msg.id >= 10) {
      if (msg.result && msg.result.status === 'OK') {
        accepted++; safeSet('accepted', accepted);
        log(`Share #${accepted} ACCEPTED`, 'ok');
      } else if (msg.error) {
        rejected++; safeSet('rejected', rejected);
        log(`Share rejected: ${msg.error.message}`, 'err');
      }
      return;
    }
    if (msg.method === 'job' && msg.params) {
      onNewJob(msg.params);
    }
  }

  function onNewJob(job) {
    const wasFirstJob = !currentJob;
    const seedChanged = currentJob && currentJob.seed_hash !== job.seed_hash;
    currentJob = job;
    log(`New job id=${job.job_id} seed=${job.seed_hash?.slice(0, 12)}... target=${job.target}`);

    if (wasFirstJob && !sharedCacheReady) {
      // First job — build shared cache, then start workers
      startSharedMining(job);
    } else if (seedChanged) {
      // Seed changed — rebuild cache, send new thunk to workers
      rebuildCache(job);
    } else {
      // Same seed — just send new job to workers
      for (const w of workers) w.postMessage({ type: 'job', job });
    }
  }

  async function startSharedMining(job) {
    log('Building shared JIT cache (one-time, ~3-5s)...');
    showProgress(5, 'Loading WASM modules...');

    // Load WASM files
    const baseUrl = location.origin + '/';
    const [datasetWasm, vmWasm, fmaWasm, simdWasm] = await Promise.all([
      fetch(baseUrl + 'dataset.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'vm.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'fma.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'simd.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    ]);

    showProgress(15, 'Building Argon2 cache + superscalar JIT...');

    // Build shared cache from seed hash
    const seed = hexToU8(job.seed_hash);
    const cache = await buildSharedCache(datasetWasm, vmWasm, fmaWasm, simdWasm, seed);

    showProgress(80, 'Starting workers...');

    sharedCacheReady = true;

    // Spawn workers — each gets the shared memory + thunk bytes + VM wasm
    const range = Math.floor(0xffffffff / numWorkers);
    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker('worker.js');
      const start = i * range;
      const end = (i === numWorkers - 1) ? 0xffffffff : start + range;

      w.postMessage({
        type: 'setup',
        datasetMemory: cache.datasetMemory,
        thunkBytes: cache.thunkBytes,
        vmWasmBytes: vmWasm,
        feature: cache.feature,
      });
      w.postMessage({ type: 'nonceRange', start, end });
      w.postMessage({ type: 'background', enabled: backgroundMode });
      w.postMessage({ type: 'job', job });

      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') log(m.message);
        else if (m.type === 'error') log(`Worker ${i}: ${m.message}`, 'err');
        else if (m.type === 'ready') {
          log(`Worker ${i} ready (shared JIT) — mining!`);
          w.postMessage({ type: 'start' });
        }
        else if (m.type === 'hashrate') {
          w._hashrate = m.hashrate;
          totalHashrate = workers.reduce((s, w2) => s + (w2._hashrate || 0), 0);
          safeSet('hashrate', totalHashrate + ' H/s');
          if (ws && connected) {
            ws.send(JSON.stringify({ method: 'stats', hashrate: totalHashrate, workers: numWorkers, accepted, rejected }));
          }
        }
        else if (m.type === 'share') {
          log(`Share found! nonce=${m.nonce}`);
          if (ws && connected) {
            ws.send(JSON.stringify({
              id: nextShareId++, jsonrpc: '2.0', method: 'submit',
              params: { id: minerId, job_id: m.jobId, nonce: m.nonce, result: m.result },
            }));
          }
        }
      };
      w.onerror = (e) => { log(`Worker ${i} error: ${e.message}`, 'err'); };
      workers.push(w);
    }

    showProgress(100, `${numWorkers} workers started`);
    safeSet('activeThreads', numWorkers);
    setTimeout(() => { const bar = $('initProgress'); if (bar) bar.classList.add('hidden'); }, 2000);
    log(`Started ${numWorkers} workers with shared cache`);
  }

  async function rebuildCache(job) {
    log('Seed changed — rebuilding shared cache...');
    showProgress(10, 'Rebuilding cache for new seed...');
    const baseUrl = location.origin + '/';
    const [datasetWasm, vmWasm, fmaWasm, simdWasm] = await Promise.all([
      fetch(baseUrl + 'dataset.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'vm.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'fma.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
      fetch(baseUrl + 'simd.wasm').then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    ]);
    const seed = hexToU8(job.seed_hash);
    const cache = await buildSharedCache(datasetWasm, vmWasm, fmaWasm, simdWasm, seed);
    // Send new thunk to all workers
    for (const w of workers) {
      w.postMessage({ type: 'reinitCache', datasetMemory: cache.datasetMemory, thunkBytes: cache.thunkBytes });
      w.postMessage({ type: 'job', job });
    }
    showProgress(100, 'Cache rebuilt');
    setTimeout(() => { const bar = $('initProgress'); if (bar) bar.classList.add('hidden'); }, 2000);
  }

  function showProgress(pct, detail) {
    const bar = $('initProgress');
    if (bar) bar.classList.remove('hidden');
    const barEl = $('initBar');
    const pctEl = $('initPercent');
    const detailEl = $('initDetail');
    if (barEl) barEl.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (detailEl) detailEl.textContent = detail;
    if (pct >= 100) setTimeout(() => { if (bar) bar.classList.add('hidden'); }, 2000);
  }

  function hexToU8(hex) {
    const n = hex.length / 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  window.startMining = async function () {
    const wallet = $('walletInput').value.trim();
    const poolHost = $('poolHost').value.trim();
    const poolPort = $('poolPort').value.trim();
    if (!wallet || wallet.length < 90) { alert('Invalid XMR wallet address'); return; }
    if (!poolHost) { alert('Pool host required'); return; }

    localStorage.setItem('xmr-wallet', wallet);
    const slider = $('workerCount');
    if (slider) { numWorkers = parseInt(slider.value, 10) || numWorkers; localStorage.setItem('xmr-workers', numWorkers.toString()); }
    const bgCheckbox = $('backgroundMode');
    if (bgCheckbox) { backgroundMode = bgCheckbox.checked; localStorage.setItem('xmr-background', backgroundMode ? '1' : '0'); }

    $('setup').classList.add('hidden');
    $('mining').classList.remove('hidden');
    $('walletDisplay').textContent = wallet;
    log('Connecting to pool...');

    connectWS({ wallet, poolHost, poolPort });
  };

  window.stopMining = function () {
    for (const w of workers) { w.postMessage({ type: 'stop' }); w.terminate(); }
    workers = [];
    if (ws) ws.close();
    safeSet('status', 'Stopped');
    safeSet('miningStatus', 'stopped');
    $('mining').classList.add('hidden');
    $('setup').classList.remove('hidden');
  };

  window.updateWorkerCount = function (val) {
    $('workerCountDisplay').textContent = val;
  };

  function tryAutoStart() {
    const qp = new URLSearchParams(location.search);
    const wallet = qp.get('wallet') || localStorage.getItem('xmr-wallet');
    if (wallet && wallet.length >= 90) {
      log('Auto-starting with saved wallet...');
      setTimeout(() => window.startMining(), 500);
    }
  }

  loadConfig();
  renderSystemInfo();
  setTimeout(tryAutoStart, 1000);
})();