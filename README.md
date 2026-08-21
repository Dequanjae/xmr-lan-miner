# XMR LAN Miner

Browser-based Monero miner — self-hosted on your NAS. Any device on your network opens a URL in a browser and mines XMR using its CPU via WebAssembly RandomX JIT. Shares flow through the NAS proxy to your pool.

## Quick Start

### Deploy on NAS (Docker Compose)

```yaml
services:
  xmr-lan-miner:
    image: node:18-alpine
    working_dir: /app
    command: >
      sh -c "apk add --no-cache git openssl &&
             git clone --depth 1 https://github.com/Dequanjae/xmr-lan-miner.git /app &&
             cd /app && npm install --omit=dev &&
             exec node server.js"
    ports:
      - "8088:8080"
      - "8443:8443"
    environment:
      - WALLET=8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE
      - POOL_HOST=pool.supportxmr.com
      - POOL_PORT=3333
      - HTTP_PORT=8080
      - HTTPS_PORT=8443
    restart: unless-stopped
```

### Mine

**For SharedArrayBuffer (16+ workers, higher hashrate):**
```
https://192.168.50.235:8443/?wallet=<your-wallet>
```
Accept the self-signed cert warning → mining auto-starts.

**For basic HTTP (8 workers, no SharedArrayBuffer):**
```
http://192.168.50.235:8088/?wallet=<your-wallet>
```

### Admin Dashboard
```
http://192.168.50.235:8088/admin
```

## How It Works

```
NAS (server.js)
  • Static file serving (UI + WASM)
  • WebSocket ←→ TCP stratum bridge
  • Admin dashboard + miner registry
  • HTTPS with self-signed cert (for SharedArrayBuffer)

Your Device (browser)
  • Loads JIT RandomX WASM engine
  • CPU mines RandomX via JIT-compiled WASM programs
  • Shares → NAS → pool.supportxmr.com
```

## JIT Engine

Uses [l1mey112/randomx.js](https://github.com/l1mey112/randomx.js) JIT engine — compiles RandomX programs to WASM bytecode at runtime for 6x faster hashing vs interpreted mode.

### Mining VM API

| Export | Purpose |
|--------|---------|
| `B()` | Set up mining job (blob, target, nonce range) |
| `Rm()` | Run mining loop inside WASM — returns JIT bytecode size, 0 (exhausted), or 1 (share found) |
| `n()` | Get winning nonce |
| `h()` | Get hash count |

The nonce iteration loop runs inside compiled WASM — no JS round-trips per hash.

## Performance

| Mode | Workers | Hashrate | Notes |
|------|---------|----------|-------|
| JIT (HTTP) | 8 | ~195 H/s | No SharedArrayBuffer |
| JIT (HTTPS) | 16+ | ~400+ H/s | SharedArrayBuffer enabled |

## Features

- **Auto-start**: Wallet saved to localStorage, mining starts on page load
- **Background mode**: Small yields between batches, no worker capping
- **System detection**: CPU cores, browser, OS
- **Worker control**: Slider 1-8 (HTTP) or 1-16+ (HTTPS)
- **Progress bar**: During cache initialization
- **Admin dashboard**: Live table of all connected miners
- **Heartbeat**: Stale connection detection + cleanup

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WALLET` | (included) | XMR wallet address |
| `POOL_HOST` | `pool.supportxmr.com` | Pool hostname |
| `POOL_PORT` | `3333` | Pool stratum port |
| `HTTP_PORT` | `8080` | HTTP port (no SharedArrayBuffer) |
| `HTTPS_PORT` | `8443` | HTTPS port (SharedArrayBuffer enabled) |

## Files

```
├── Dockerfile              # node:18-alpine + openssl for self-signed cert
├── docker-compose.yml
├── package.json            # ws (WebSocket library)
├── server.js               # HTTP+HTTPS server, WS→TCP stratum bridge, admin API
└── public/
    ├── index.html          # Miner UI
    ├── admin.html          # Admin dashboard
    ├── miner.js            # Main thread — worker pool, WS, share submission, auto-start
    ├── worker.js           # Web Worker — JIT mining loop
    ├── randomx_fast.js     # JIT engine wrapper
    ├── vm.wasm             # RandomX VM (38KB)
    ├── dataset.wasm        # Cache init (28KB)
    ├── fma.wasm            # FMA detection
    └── simd.wasm           # SIMD validation
```

## Credits

- **[l1mey112/randomx.js](https://github.com/l1mey112/randomx.js)** — JIT RandomX engine (BSD-3-Clause)
- **[tevador/RandomX](https://github.com/tevador/RandomX)** — RandomX specification

## License

MIT