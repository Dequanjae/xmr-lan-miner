// popup.js — toolbar popup UI
const $ = (id) => document.getElementById(id);

// Load saved settings
chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
  if (status) {
    $('hashrate').textContent = status.totalHashrate + ' H/s';
    $('threads').textContent = status.workers;
    $('accepted').textContent = status.accepted;
    $('rejected').textContent = status.rejected;
    updateStatus(status.mining, status.connected);
  }
});

// Load settings from storage
chrome.storage.local.get(['wallet', 'nasUrl', 'workers', 'autoStart'], (data) => {
  if (data.nasUrl) $('nasUrl').value = data.nasUrl;
  if (data.wallet) $('wallet').value = data.wallet;
  if (data.workers) { $('workerSlider').value = data.workers; $('workerDisplay').textContent = data.workers; }
  $('autoStart').checked = data.autoStart !== false;
});

// Poll for status updates
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (status) {
      $('hashrate').textContent = status.totalHashrate + ' H/s';
      $('threads').textContent = status.workers;
      $('accepted').textContent = status.accepted;
      $('rejected').textContent = status.rejected;
      updateStatus(status.mining, status.connected);
    }
  });
}, 2000);

function updateStatus(mining, connected) {
  const dot = $('statusDot');
  const text = $('statusText');
  if (mining && connected) { dot.className = 'status-dot dot-green'; text.textContent = 'Mining'; }
  else if (mining && !connected) { dot.className = 'status-dot dot-gray'; text.textContent = 'Connecting...'; }
  else { dot.className = 'status-dot dot-gray'; text.textContent = 'Idle'; }
}

// Start button
$('startBtn').onclick = () => {
  saveSettings();
  chrome.runtime.sendMessage({ type: 'start' });
};

// Stop button
$('stopBtn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'stop' });
};

// Worker slider
$('workerSlider').oninput = (e) => {
  $('workerDisplay').textContent = e.target.value;
};

function saveSettings() {
  const settings = {
    nasUrl: $('nasUrl').value,
    wallet: $('wallet').value,
    workers: parseInt($('workerSlider').value) || 8,
    autoStart: $('autoStart').checked,
  };
  chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: 'setSettings', settings });
}