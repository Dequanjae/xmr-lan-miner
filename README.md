# XMR LAN Miner

Browser-based Monero miner, self-hosted. Any device on your network opens the URL in a browser and mines XMR using its CPU via WebAssembly RandomX. Shares flow through this server to your pool.

## Deploy

```bash
docker compose up -d
```

Then visit `http://<nas-ip>:8080` from any device on your network.

## How it works

1. **NAS** runs this container: a Node.js server serving the UI + bridging browser WebSocket → pool TCP stratum.
2. **Your device** (laptop, phone, tablet) opens the URL. The browser loads `randomx.wasm`, downloads a job, hashes RandomX locally.
3. **Shares** flow back over WebSocket to the NAS, forwarded to `pool.supportxmr.com:3333`.
4. **Hashrate** of each device is limited by its own CPU + browser WASM (~30-50% of native speed). The NAS CPU is NOT used for hashing — it only routes.

## Config

Environment variables (set in `docker-compose.yml` or `.env` next to compose file):

- `WALLET` — your XMR address (default included, replace with yours)
- `POOL_HOST` — pool hostname (default `pool.supportxmr.com`)
- `POOL_PORT` — pool stratum port (default `3333`)
- `HTTP_PORT` — serve port inside container (default `8080`)

## Why this exists

Prior version cloned a repo at runtime + downloaded a RandomX WASM from a dead GitHub URL → crash loop. This version commits a **locally-built RandomX WASM** (compiled from [tevador/RandomX](https://github.com/tevador/RandomX) master with Emscripten) directly into the image. No runtime downloads, no external dependencies.

## Files

```
├── Dockerfile              # node:18-alpine + npm install + copy
├── docker-compose.yml
├── package.json            # ws (real npm dep)
├── server.js               # HTTP + WS→TCP stratum bridge
└── public/
    ├── index.html
    ├── miner.js            # main thread WS + share submit
    ├── worker.js           # RandomX WASM hashing worker
    ├── randomx.js          # Emscripten glue (compiled)
    └── randomx.wasm        # RandomX engine (compiled, 83KB)
```
