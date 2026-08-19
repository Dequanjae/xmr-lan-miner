// Main thread: WS to proxy, manage worker pool, submit shares
(() => {
  let ws = null;
  let worker = null;
  let connected = false;
  let currentJob = null;
  let minerId = null;
  let nextShareId = 10;
  let accepted = 0, rejected = 0;

  const $ = (id) => document.getElementById(id);
  const log = (msg, cls) => {
    const box = $('logBox');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (cls) line.className = cls;
    box.prepend(line);
    while (box.children.length > 200) box.lastChild.remove();
  };
  const setStatus = (s) => { $('status').textContent = s; };
  const setHashrate = (h) => { $('hashrate').textContent = h + ' H/s'; };
  const setAccepted = (n) => { $('accepted').textContent = n; };
  const setRejected = (n) => { $('rejected').textContent = n; };

  async function loadConfig() {
    // Query params override server defaults — lets you bake wallet into a shareable URL
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

  function connectWS(cfg) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => {
      connected = true;
      setStatus('Connected');
      log('WS connected, configuring pool...');
      ws.send(JSON.stringify({
        method: 'configure',
        wallet: cfg.wallet,
        poolHost: cfg.poolHost,
        poolPort: parseInt(cfg.poolPort, 10),
        worker: cfg.worker || undefined,
      }));
    };
    ws.onclose = () => { connected = false; setStatus('Disconnected'); log('WS closed'); };
    ws.onerror = (e) => { log('WS error', 'err'); };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handlePoolMessage(msg);
    };
  }

  function handlePoolMessage(msg) {
    // Login response
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
    // Share response
    if (msg.id >= 10) {
      if (msg.result && msg.result.status === 'OK') {
        accepted++; setAccepted(accepted);
        log(`Share #${accepted} ACCEPTED`, 'ok');
      } else if (msg.error) {
        rejected++; setRejected(rejected);
        log(`Share rejected: ${msg.error.message}`, 'err');
      }
      return;
    }
    // Job broadcast
    if (msg.method === 'job' && msg.params) {
      onNewJob(msg.params);
    }
  }

  function onNewJob(job) {
    currentJob = job;
    log(`New job id=${job.job_id} seed=${job.seed_hash?.slice(0, 12)}... target=${job.target}`);
    if (worker) {
      worker.postMessage({ type: 'job', job });
    }
  }

  window.startMining = async function () {
    const wallet = $('walletInput').value.trim();
    const poolHost = $('poolHost').value.trim();
    const poolPort = $('poolPort').value.trim();
    if (!wallet || wallet.length < 90) { alert('Invalid XMR wallet address'); return; }
    if (!poolHost) { alert('Pool host required'); return; }

    $('setup').classList.add('hidden');
    $('mining').classList.remove('hidden');
    $('walletDisplay').textContent = wallet;
    log('Initializing RandomX WASM (may take 30-60s first time)...');

    // Spawn worker
    worker = new Worker('worker.js');
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') log(m.message);
      else if (m.type === 'error') log('Worker: ' + m.message, 'err');
      else if (m.type === 'ready') {
        log('RandomX ready');
        if (currentJob) worker.postMessage({ type: 'job', job: currentJob });
        worker.postMessage({ type: 'start' });
      }
      else if (m.type === 'hashrate') setHashrate(m.hashrate);
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
    worker.onerror = (e) => { log(`Worker error: ${e.message}`, 'err'); };

    connectWS({ wallet, poolHost, poolPort });
  };

  window.stopMining = function () {
    if (worker) worker.postMessage({ type: 'stop' });
    if (ws) ws.close();
    setStatus('Stopped');
    $('mining').classList.add('hidden');
    $('setup').classList.remove('hidden');
  };

  loadConfig();
})();
