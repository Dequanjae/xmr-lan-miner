// background.js — service worker, auto-starts mining on browser launch
// Connects to NAS WebSocket, spawns WASM workers, mines XMR

const NAS_URL = 'ws://192.168.50.235:8088';
const DEFAULT_WALLET = '8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE';

let ws = null;
let workers = [];
let connected = false;
let mining = false;
let currentJob = null;
let minerId = null;
let nextShareId = 10;
let accepted = 0, rejected = 0;
let totalHashrate = 0;
let cores = navigator.hardwareConcurrency || 4;
let numWorkers = Math.min(cores - 1, 12);

// Load settings
async function getSettings() {
  const stored = await chrome.storage.local.get(['wallet', 'nasUrl', 'workers', 'autoStart']);
  return {
    wallet: stored.wallet || DEFAULT_WALLET,
    nasUrl: stored.nasUrl || NAS_URL,
    workers: stored.workers || numWorkers,
    autoStart: stored.autoStart !== false, // default true
  };
}

async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

// Update badge with hashrate
function updateBadge() {
  const hr = Math.round(totalHashrate);
  const text = hr > 999 ? (hr / 1000).toFixed(1) + 'k' : String(hr);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: hr > 0 ? '#4caf50' : '#666' });
  chrome.action.setTitle({ title: `XMR Miner: ${hr} H/s | Accepted: ${accepted} | Rejected: ${rejected}` });
}

// Connect to NAS WebSocket
function connectWS(settings) {
  console.log('[XMR Miner] Connecting to', settings.nasUrl);
  ws = new WebSocket(settings.nasUrl);

  ws.onopen = () => {
    connected = true;
    console.log('[XMR Miner] WS connected');
    ws.send(JSON.stringify({
      method: 'configure',
      wallet: settings.wallet,
      poolHost: 'pool.supportxmr.com',
      poolPort: 3333,
      worker: 'extension-' + Math.random().toString(36).slice(2, 6),
      sysInfo: { cores, browser: 'Extension', os: navigator.platform },
    }));
  };

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    updateBadge();
    console.log('[XMR Miner] WS closed — reconnecting in 5s');
    setTimeout(() => connectWS(settings), 5000);
  };

  ws.onerror = () => { console.error('[XMR Miner] WS error'); };
}

function handleMessage(msg) {
  if (msg.id === '1' || msg.id === 1) {
    if (msg.result && msg.result.job) {
      minerId = msg.result.id;
      console.log('[XMR Miner] Logged in, miner id:', minerId.slice(0, 16));
      onNewJob(msg.result.job);
    }
    return;
  }
  if (msg.id >= 10) {
    if (msg.result && msg.result.status === 'OK') {
      accepted++;
      console.log('[XMR Miner] Share ACCEPTED (#' + accepted + ')');
    } else if (msg.error) {
      rejected++;
      console.log('[XMR Miner] Share rejected:', msg.error.message);
    }
    updateBadge();
    return;
  }
  if (msg.method === 'job' && msg.params) {
    onNewJob(msg.params);
  }
}

function onNewJob(job) {
  const wasFirstJob = !currentJob;
  currentJob = job;
  console.log('[XMR Miner] New job', job.job_id);
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
    const w = new Worker(chrome.runtime.getURL('worker.js'));
    const start = i * range;
    const end = (i === n - 1) ? 0xffffffff : start + range;
    w.postMessage({ type: 'nonceRange', start, end });

    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'status') console.log('[XMR Miner W' + i + ']', m.message);
      else if (m.type === 'error') console.error('[XMR Miner W' + i + ']', m.message);
      else if (m.type === 'ready') {
        console.log('[XMR Miner W' + i + '] ready — mining');
        w.postMessage({ type: 'job', job: currentJob });
        w.postMessage({ type: 'start' });
      }
      else if (m.type === 'hashrate') {
        w._hashrate = m.hashrate;
        totalHashrate = workers.reduce((s, w2) => s + (w2._hashrate || 0), 0);
        updateBadge();
        if (ws && connected) {
          ws.send(JSON.stringify({ method: 'stats', hashrate: totalHashrate, workers: n, accepted, rejected }));
        }
      }
      else if (m.type === 'share') {
        console.log('[XMR Miner] Share found! nonce:', m.nonce);
        if (ws && connected) {
          ws.send(JSON.stringify({
            id: nextShareId++, jsonrpc: '2.0', method: 'submit',
            params: { id: minerId, job_id: m.jobId, nonce: m.nonce, result: m.result },
          }));
        }
      }
    };
    w.onerror = (e) => { console.error('[XMR Miner W' + i + ']', e.message); };
    workers.push(w);
  }
  mining = true;
  console.log('[XMR Miner] Started', n, 'workers');
  updateBadge();
}

function stopWorkers() {
  for (const w of workers) { w.postMessage({ type: 'stop' }); w.terminate(); }
  workers = [];
  mining = false;
  totalHashrate = 0;
  updateBadge();
}

// Start mining
async function startMining() {
  const settings = await getSettings();
  numWorkers = settings.workers;
  startWorkers();
  connectWS(settings);
}

// Stop mining
function stopMining() {
  stopWorkers();
  if (ws) ws.close();
}

// Auto-start on install/browser launch
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[XMR Miner] Installed:', details.reason);
  const settings = await getSettings();
  await saveSettings(settings); // save defaults
  if (settings.autoStart) {
    startMining();
  }
});

// Re-start on browser startup
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.autoStart) {
    startMining();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ mining, connected, totalHashrate, accepted, rejected, workers: workers.length, cores });
  }
  if (msg.type === 'start') { startMining(); sendResponse({ ok: true }); }
  if (msg.type === 'stop') { stopMining(); sendResponse({ ok: true }); }
  if (msg.type === 'setSettings') {
    saveSettings(msg.settings).then(() => {
      stopMining();
      if (msg.settings.autoStart !== false) startMining();
      sendResponse({ ok: true });
    });
  }
  return true; // async
});