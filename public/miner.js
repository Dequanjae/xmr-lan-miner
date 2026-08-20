// Main thread: manage worker pool, WS to proxy, submit shares, system info, auto-start
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
  let numWorkers = cores - 1; // default: all but one
  let backgroundMode = false;

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
    // Query param wallet overrides localStorage overrides server default
    const savedWallet = localStorage.getItem('xmr-wallet') || '';
    try {
      const r = await fetch('/config');
      const c = await r.json();
      $('walletInput').value = qp.get('wallet') || savedWallet || c.wallet || '';
      $('poolHost').value = qp.get('pool') || qp.get('poolHost') || c.poolHost || '';
      $('poolPort').value = qp.get('port') || qp.get('poolPort') || c.poolPort || 3333;
    } catch (e) {
      $('walletInput').value = qp.get('wallet') || savedWallet || '';
      $('poolHost').value = qp.get('pool') || 'pool.supportxmr.com';
      $('poolPort').value = qp.get('port') || 3333;
    }
    // Load saved preferences
    backgroundMode = localStorage.getItem('xmr-background') === '1';
    const bgCheckbox = $('backgroundMode');
    if (bgCheckbox) bgCheckbox.checked = backgroundMode;
    const savedWorkers = localStorage.getItem('xmr-workers');
    if (savedWorkers) numWorkers = parseInt(savedWorkers, 10) || numWorkers;
  }

  function renderSystemInfo() {
    const sys = getSystemInfo();
    safeSet('sysCores', sys.cores);
    safeSet('sysBrowser', sys.browser);
    safeSet('sysOS', sys.os);
    safeSet('sysMode', 'JIT');
    const slider = $('workerCount');
    if (slider) {
      slider.max = cores;
      slider.value = numWorkers;
      const disp = $('workerCountDisplay');
      if (disp) disp.textContent = numWorkers;
      const mc = $('maxCores');
      if (mc) mc.textContent = cores;
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
    currentJob = job;
    log(`New job id=${job.job_id} seed=${job.seed_hash?.slice(0, 12)}... target=${job.target}`);
    if (workers.length === 0) return;
    if (wasFirstJob) {
      for (const w of workers) w.postMessage({ type: 'init', seedHash: job.seed_hash });
    } else {
      for (const w of workers) w.postMessage({ type: 'job', job });
    }
  }

  function startWorkers() {
    const n = numWorkers;
    const range = Math.floor(0xffffffff / n);
    for (let i = 0; i < n; i++) {
      const w = new Worker('worker.js');
      const start = i * range;
      const end = (i === n - 1) ? 0xffffffff : start + range;
      w.postMessage({ type: 'nonceRange', start, end });
      w.postMessage({ type: 'background', enabled: backgroundMode });

      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') log(m.message);
        else if (m.type === 'error') log(`Worker ${i}: ${m.message}`, 'err');
        else if (m.type === 'initProgress') {
          // Track per-worker init progress
          w._initProgress = m.progress;
          // Show progress bar
          const bar = $('initProgress');
          if (bar) bar.classList.remove('hidden');
          // Aggregate: average across all workers
          const totalProgress = workers.reduce((s, w2) => s + (w2._initProgress || 0), 0) / workers.length;
          const pct = Math.round(totalProgress);
          const barEl = $('initBar');
          const pctEl = $('initPercent');
          const detailEl = $('initDetail');
          if (barEl) barEl.style.width = pct + '%';
          if (pctEl) pctEl.textContent = pct + '%';
          if (detailEl) {
            const ready = workers.filter(w2 => (w2._initProgress || 0) >= 100).length;
            detailEl.textContent = `${ready}/${workers.length} workers ready`;
          }
          if (pct >= 100) {
            setTimeout(() => { if (bar) bar.classList.add('hidden'); }, 2000);
          }
        }
        else if (m.type === 'ready') {
          log(`Worker ${i} ready (JIT) — mining!`);
          // Worker is ready and already has the job from pendingJob — just start
          w.postMessage({ type: 'start' });
        }
        else if (m.type === 'hashrate') {
          w._hashrate = m.hashrate;
          totalHashrate = workers.reduce((s, w2) => s + (w2._hashrate || 0), 0);
          safeSet('hashrate', totalHashrate + ' H/s');
          if (ws && connected) {
            ws.send(JSON.stringify({ method: 'stats', hashrate: totalHashrate, workers: n, accepted, rejected }));
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
    log(`Started ${n} JIT workers`);
  }

  window.startMining = async function () {
    const wallet = $('walletInput').value.trim();
    const poolHost = $('poolHost').value.trim();
    const poolPort = $('poolPort').value.trim();
    if (!wallet || wallet.length < 90) { alert('Invalid XMR wallet address'); return; }
    if (!poolHost) { alert('Pool host required'); return; }

    // Save wallet + prefs
    localStorage.setItem('xmr-wallet', wallet);
    localStorage.setItem('xmr-workers', numWorkers.toString());

    const slider = $('workerCount');
    if (slider) numWorkers = parseInt(slider.value, 10) || numWorkers;
    const bgCheckbox = $('backgroundMode');
    if (bgCheckbox) { backgroundMode = bgCheckbox.checked; localStorage.setItem('xmr-background', backgroundMode ? '1' : '0'); }

    // In background mode, use fewer workers to keep the system responsive
    const effectiveWorkers = numWorkers;

    $('setup').classList.add('hidden');
    $('mining').classList.remove('hidden');
    $('walletDisplay').textContent = wallet;
    log(`Initializing ${effectiveWorkers} JIT workers${backgroundMode ? ' (background mode)' : ''}...`);

    startWorkers();
    safeSet('activeThreads', effectiveWorkers);
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

  // Auto-start: if wallet is saved, start mining on page load
  function tryAutoStart() {
    const qp = new URLSearchParams(location.search);
    const wallet = qp.get('wallet') || localStorage.getItem('xmr-wallet');
    if (wallet && wallet.length >= 90) {
      log('Auto-starting with saved wallet...');
      // Small delay to let config load
      setTimeout(() => window.startMining(), 500);
    }
  }

  loadConfig();
  renderSystemInfo();
  // Auto-start after config loads
  setTimeout(tryAutoStart, 1000);
})();