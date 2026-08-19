// Main thread: manage worker pool, WS to proxy, submit shares, system info
(() => {
  let ws = null;
  let workers = [];
  let connected = false;
  let currentJob = null;
  let minerId = null;
  let nextShareId = 10;
  let accepted = 0, rejected = 0;
  let totalHashrate = 0;
  let numWorkers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

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
    const cores = navigator.hardwareConcurrency || 1;
    const ram = navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'unknown';
    const ua = navigator.userAgent;
    let browser = 'unknown';
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
    return { cores, ram, browser, os, ua: ua.slice(0, 80) };
  }

  async function loadConfig() {
    const qp = new URLSearchParams(location.search);
    try {
      const r = await fetch('/config');
      const c = await r.json();
      $('walletInput').value = qp.get('wallet') || c.wallet || '';
      $('poolHost').value = qp.get('pool') || qp.get('poolHost') || c.poolHost || '';
      $('poolPort').value = qp.get('port') || qp.get('poolPort') || c.poolPort || 3333;
    } catch (e) {
      $('walletInput').value = qp.get('wallet') || '';
      $('poolHost').value = qp.get('pool') || 'pool.supportxmr.com';
      $('poolPort').value = qp.get('port') || 3333;
    }
  }

  function renderSystemInfo() {
    const sys = getSystemInfo();
    safeSet('sysCores', sys.cores);
    safeSet('sysRam', sys.ram);
    safeSet('sysBrowser', sys.browser);
    safeSet('sysOS', sys.os);
    const slider = $('workerCount');
    if (slider) {
      slider.max = sys.cores;
      slider.value = numWorkers;
      const disp = $('workerCountDisplay');
      if (disp) disp.textContent = numWorkers;
      const mc = $('maxCores');
      if (mc) mc.textContent = sys.cores;
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
      // Send system info for admin dashboard
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
      // Init all workers with this seed
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

      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'status') log(m.message);
        else if (m.type === 'error') log(`Worker ${i}: ${m.message}`, 'err');
        else if (m.type === 'ready') {
          log(`Worker ${i} ready`);
          w.postMessage({ type: 'job', job: currentJob });
          w.postMessage({ type: 'start' });
        }
        else if (m.type === 'hashrate') {
          // Aggregate hashrate across all workers
          w._hashrate = m.hashrate;
          totalHashrate = workers.reduce((s, w2) => s + (w2._hashrate || 0), 0);
          safeSet('hashrate', totalHashrate + ' H/s');
          // Report to server for admin dashboard
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
    log(`Started ${n} workers`);
  }

  window.startMining = async function () {
    const wallet = $('walletInput').value.trim();
    const poolHost = $('poolHost').value.trim();
    const poolPort = $('poolPort').value.trim();
    if (!wallet || wallet.length < 90) { alert('Invalid XMR wallet address'); return; }
    if (!poolHost) { alert('Pool host required'); return; }

    // Read worker count from slider
    const slider = $('workerCount');
    if (slider) numWorkers = parseInt(slider.value, 10) || numWorkers;

    $('setup').classList.add('hidden');
    $('mining').classList.remove('hidden');
    $('walletDisplay').textContent = wallet;
    log(`Initializing ${numWorkers} RandomX workers (may take 30-60s)...`);

    startWorkers();
    safeSet('activeThreads', numWorkers);
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

  loadConfig();
  renderSystemInfo();
})();