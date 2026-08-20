# XMR LAN Miner

Browser-based Monero miner — self-hosted on your NAS. Any device on your network opens a URL in a browser and mines XMR using its CPU via WebAssembly RandomX JIT. Shares flow through the NAS proxy to your pool.

**8500 H/s on a desktop i7-12700K — 71% of native xmrig speed, from a browser tab.**

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  NAS (100.102.225.115:8088)                          │
│  ┌───────────────────────────────────────────────┐  │
│  │  Node.js Server (server.js)                    │  │
│  │  • Static file serving (UI + WASM)             │  │
│  │  • WebSocket ←→ TCP stratum bridge              │  │
│  │  • Admin dashboard (/admin) — all miners       │  │
│  │  • Miner registry + live stats API             │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          ▲                    ▲
          │ WebSocket          │ WebSocket
     ┌────┴────┐          ┌────┴────┐
     │ Laptop  │          │  Phone  │
     │ Browser │          │ Browser │
     │ JIT WASM│          │ JIT WASM│
     │ 8500 H/s│          │ 150 H/s │
     └─────────┘          └─────────┘
        ↑ CPU does the hashing — NAS only routes
```

1. **NAS** runs the container: Node.js server serving the miner UI + bridging browser WebSocket → pool TCP stratum
2. **Your device** (laptop, phone, tablet) opens `http://<nas-ip>:8088/?wallet=<your-wallet>` in a browser
3. The browser loads the JIT RandomX WASM engine, downloads a mining job, and hashes RandomX locally using the device's CPU
4. **Shares** flow back over WebSocket to the NAS, forwarded to `pool.supportxmr.com:3333`
5. **Admin dashboard** at `http://<nas-ip>:8088/admin` shows all connected miners with live hashrate, accepted/rejected shares, system info, and uptime

## The JIT Engine

This project uses the [l1mey112/randomx.js](https://github.com/l1mey112/randomx.js) JIT engine — a WebAssembly implementation of RandomX that **compiles RandomX programs to native WASM bytecode at runtime** and executes them, instead of interpreting them one instruction at a time.

### Architecture

The JIT engine consists of four WASM modules:

| File | Size | Purpose |
|------|------|---------|
| `vm.wasm` | 38 KB | RandomX virtual machine — exports `B()`, `Rm()`, `n()`, `h()` for mining mode |
| `dataset.wasm` | 28 KB | Cache initialization — Argon2 + superscalar hash + JIT bytecode generation |
| `fma.wasm` | 102 B | FMA (fused multiply-add) feature detection |
| `simd.wasm` | 66 B | WASM SIMD validation |

### Mining VM API

The `vm.wasm` exports two API sets. The **mining VM** API is what makes this fast:

| Export | Signature | Purpose |
|--------|-----------|---------|
| `B()` | `(blob_length: i32, target: i64, nonce_start: i32, nonce_end: i32) → void` | Set up a mining job with blob, target, and nonce range |
| `Rm()` | `() → i32` | Run the mining loop inside WASM. Returns 1 = share found, 0 = nonce space exhausted |
| `n()` | `() → i32` | Get the winning nonce from the last share |
| `h()` | `() → i32` | Get total hash count since job started |

The nonce iteration loop runs **entirely inside compiled WASM** — no JavaScript round-trips per hash. The WASM internally generates JIT programs (compiling RandomX instructions to WASM bytecode via `WebAssembly.Module()`), executes them, checks targets, and only returns to JS when a share is found or the nonce space is exhausted.

### JIT Flow

```
1. dataset.wasm K() — Argon2 cache init + superscalar hash generation
   → produces JIT bytecode (thunk module)
2. vm.wasm B() — sets up blob, target, nonce range in VM scratchpad
3. vm.wasm Rm() — internal mining loop:
   a. VM generates RandomX program (256 random instructions)
   b. JIT compiles program → WASM bytecode (WebAssembly.Module)
   c. WASM bytecode executes against VM memory + superscalar thunk
   d. Result hash checked against target (all in WASM)
   e. If hash ≤ target → share found, return 1
   f. Increment nonce, repeat
```

### Key Fix: Memory Routing

The JIT-compiled WASM chunks import `e.m` (memory) from the host. This must be the **VM's memory** (33 pages / 2MB, where the scratchpad lives), NOT the dataset's memory (4098 pages / 256MB, where the Argon2 cache lives).

Getting this wrong causes `table index is out of bounds` — the JIT chunk loads a nonce/table index from uninitialized memory and crashes. The fix was one line in `randomx_fast.js`:

```javascript
// WRONG (causes crash):
_jitImports = { e: { m: _datasetMemory, d: superscalarHash } };

// CORRECT (8500 H/s):
_jitImports = { e: { m: _memory, d: superscalarHash } };
```

## Performance

| Device | Browser JIT WASM | Native xmrig | % of native |
|--------|------------------|-------------|-------------|
| i7-12700K desktop (20 threads) | ~8,500 H/s | ~12,000 H/s | 71% |
| Laptop (8 threads) | ~2,500 H/s | ~3,500 H/s | 71% |
| Modern phone (8 cores) | ~150 H/s | ~500 H/s | 30% |

### Performance History

This project went through multiple optimization phases:

| Phase | Approach | Hashrate | Improvement |
|-------|----------|----------|-------------|
| 1. C/Emscripten interpreted | tevador/RandomX C → Emscripten WASM, interpreted mode | 38 H/s | baseline |
| 2. SSE2 → WASM SIMD | Emscripten SSE2 compat headers translate x86 intrinsics to WASM SIMD | 38 H/s | no change (bottleneck was interpreter, not AES) |
| 3. l1mey112 JIT (single-hash API) | JIT compiles RandomX programs to WASM at runtime, but JS calls per-nonce | 130 H/s | 3.5x |
| 4. l1mey112 JIT (mining VM API) | Nonce loop runs inside WASM via `B()`/`Rm()` — no JS round-trips | 8,500 H/s | **223x** |

The key insight: the bottleneck was never the hash computation — it was the **JavaScript overhead per nonce**. Moving the nonce loop inside compiled WASM eliminated millions of JS→WASM round-trips per second.

## Features

### Miner Page (`/`)
- **Auto-start**: Wallet + settings saved to localStorage. Open the tab → mining begins.
- **System detection**: CPU cores, browser, OS detected and displayed
- **Worker control**: Slider from 1 to max cores. More workers = more hashrate.
- **Background mode**: 50ms yields between 2s hash batches so other browser tabs stay smooth. No worker capping.
- **JIT badge**: Indicates the JIT engine is active
- **Progress bar**: Shows during cache initialization (Argon2 + superscalar hash generation)
- **Live stats**: Hashrate, accepted/rejected shares, thread count, connection status
- **Wallet via URL**: `?wallet=<address>` auto-fills the wallet field

### Admin Dashboard (`/admin`)
- **Live table**: All connected miners with status (live/stale), worker name, IP, hashrate, thread count, accepted/rejected, system info, wallet, uptime
- **Aggregate stats**: Total hashrate across all devices, active miner count, total shares
- **Auto-refresh**: Updates every 2 seconds
- **Pool info**: Shows configured pool host + port

## Deploy

### Docker Compose (Dockhand)

```yaml
services:
  xmr-lan-miner:
    image: node:18-alpine
    working_dir: /app
    command: >
      sh -c "apk add --no-cache git &&
             git clone --depth 1 https://github.com/Dequanjae/xmr-lan-miner.git /app &&
             cd /app && npm install --omit=dev &&
             exec node server.js"
    ports:
      - "8088:8080"
    environment:
      - WALLET=8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE
      - POOL_HOST=pool.supportxmr.com
      - POOL_PORT=3333
      - HTTP_PORT=8080
    restart: unless-stopped
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WALLET` | (included) | Your XMR wallet address |
| `POOL_HOST` | `pool.supportxmr.com` | Pool hostname |
| `POOL_PORT` | `3333` | Pool stratum port |
| `HTTP_PORT` | `8080` | Serve port inside container |
| `WORKER_PREFIX` | `lanxmr` | Worker name prefix |

### Usage

1. Deploy the container on your NAS
2. Open `http://<nas-ip>:8088/?wallet=<your-wallet>` on any device
3. Set worker count to max (slider), check background mode if you want to use the device while mining
4. Hit **Start Mining** — wallet + settings auto-save
5. Next time you open the tab, mining auto-starts
6. Open `http://<nas-ip>:8088/admin` to see all connected miners

## Files

```
├── Dockerfile              # (for direct builds, not needed for runtime-clone deploy)
├── docker-compose.yml
├── package.json            # ws (WebSocket library)
├── server.js               # HTTP + WS→TCP stratum bridge + admin API + miner registry
├── public/
│   ├── index.html          # Miner UI — system info, worker slider, background mode, progress bar
│   ├── admin.html          # Admin dashboard — live miner table, aggregate stats, auto-refresh
│   ├── miner.js            # Main thread — worker pool management, WS connection, share submission, auto-start
│   ├── worker.js           # Web Worker — JIT mining VM (B/Rm/n/h API), nonce loop inside WASM
│   ├── randomx_fast.js     # JIT engine wrapper — loads WASM modules, manages cache + VM
│   ├── vm.wasm             # RandomX VM (38KB) — mining + single-hash APIs
│   ├── dataset.wasm        # Cache init (28KB) — Argon2 + superscalar hash + JIT bytecode gen
│   ├── fma.wasm            # FMA feature detection (102B)
│   └── simd.wasm           # SIMD validation (66B)
└── README.md
```

## Credits

- **[l1mey112/randomx.js](https://github.com/l1mey112/randomx.js)** — The JIT engine: RandomX implementation that compiles programs to WASM at runtime. BSD-3-Clause license.
- **[tevador/RandomX](https://github.com/tevador/RandomX)** — The original RandomX proof-of-work specification and reference implementation.
- **[ford442/xmrig_wasm](https://github.com/ford442/xmrig_wasm)** — Research that informed the SSE2→WASM SIMD and pthreads investigation.

## License

MIT