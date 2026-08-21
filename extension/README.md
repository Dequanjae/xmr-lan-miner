# XMR LAN Miner — Browser Extension

Auto-mines XMR using your CPU when the browser is running. No URL to visit — installs once, mines automatically.

## Install (Firefox)

1. Open `http://192.168.50.235:8088/extension/` in Firefox
2. Download the extension zip
3. Unzip
4. Go to `about:debugging` → This Firefox → Load Temporary Add-on
5. Select `manifest.json`
6. Mining starts automatically

## Install (Chrome)

1. Open `http://192.168.50.235:8088/extension/` in Chrome
2. Download the extension zip
3. Unzip
4. Go to `chrome://extensions/` → Enable Developer Mode → Load Unpacked
5. Select the extension folder
6. Mining starts automatically

## How It Works

```
Browser opens
  ↓
Extension service worker starts
  ↓
Loads WASM JIT engine (bundled, no download)
  ↓
Connects to NAS WebSocket (ws://192.168.50.235:8088)
  ↓
Gets mining job from pool via NAS
  ↓
CPU mines RandomX via WASM JIT
  ↓
Shares → NAS → pool.supportxmr.com
  ↓
Badge shows live hashrate
```

The extension runs in the background — you can close all tabs and it keeps mining. Open the toolbar popup to see stats or change settings.

## Settings

- **NAS URL**: Your NAS WebSocket address (default: `ws://192.168.50.235:8088`)
- **Wallet**: Your XMR wallet address
- **Worker threads**: 1-12 (more = faster but more CPU usage)
- **Auto-start**: Mine automatically when browser opens

## Files

```
├── manifest.json     → Extension manifest (MV3)
├── background.js      → Service worker — auto-starts, manages workers, WS connection
├── popup.html         → Toolbar popup UI
├── popup.js           → Popup logic
├── icon.png           → Extension icon
├── worker.js          → Web Worker — JIT mining loop
├── randomx_fast.js    → JIT RandomX engine
├── vm.wasm            → RandomX VM (38KB)
├── dataset.wasm       → Cache init (28KB)
├── fma.wasm           → FMA detection
└── simd.wasm          → SIMD validation
```