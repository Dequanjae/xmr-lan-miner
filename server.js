// Stratum TCP bridge + static file server for LAN XMR mining
// Any device on the network hits http://NAS:8080, browser hashes RandomX, shares flow through here.
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { WebSocketServer } = require('ws');

const WALLET = process.env.WALLET || '8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE';
const POOL_HOST = process.env.POOL_HOST || 'pool.supportxmr.com';
const POOL_PORT = parseInt(process.env.POOL_PORT || '3333', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
const WORKER_PREFIX = process.env.WORKER_PREFIX || 'lanxmr';

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      wallet: WALLET, poolHost: POOL_HOST, poolPort: POOL_PORT, workerPrefix: WORKER_PREFIX,
    }));
  }
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// Hex helpers
const hexToBuf = (h) => Buffer.from(h, 'hex');
const bufToHex = (b) => Buffer.from(b).toString('hex');

// Stratum target → 256-bit integer difficulty for compare
// Pool sends target as hex string; usually 8-byte LE (CryptoNote style) or 4-byte compact
function targetToBigInt(targetHex) {
  const buf = hexToBuf(targetHex);
  if (buf.length === 4) {
    // 4-byte compact: diff1 base is 0xffff*2^208 style
    const t = buf.readUInt32LE(0);
    if (t === 0) return 0n;
    // diff = (2^64 - 1) / ((2^32 - 1) / t) — from your original code, kept compatible
    return 0xffffffffffffffffn / (0xffffffffn / BigInt(t));
  } else if (buf.length === 8) {
    return buf.readBigUInt64LE(0);
  } else if (buf.length === 32) {
    // 256-bit target LE — read the last 8 bytes as the effective target per RandomX convention
    return buf.readBigUInt64LE(24);
  }
  return 0n;
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  const tag = `client-${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[${tag}] connected from ${clientIp}`);

  let pool = null;
  let poolBuf = '';
  let poolReady = false;
  let pending = [];
  let wallet = WALLET;
  let poolHost = POOL_HOST;
  let poolPort = POOL_PORT;
  let workerName = `${WORKER_PREFIX}-${tag}`;

  const sendPool = (msg) => {
    const line = JSON.stringify(msg) + '\n';
    if (poolReady && pool && !pool.destroyed) pool.write(line);
    else pending.push(line);
  };

  const safeSend = (obj) => {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  };

  const connectPool = () => {
    if (pool && !pool.destroyed) try { pool.destroy(); } catch (e) {}
    pool = new net.Socket();
    poolBuf = '';
    pool.connect(poolPort, poolHost, () => {
      console.log(`[${tag}] pool connected ${poolHost}:${poolPort}`);
      poolReady = true;
      // send login
      sendPool({
        id: 1, jsonrpc: '2.0', method: 'login',
        params: {
          login: wallet,
          pass: workerName,
          agent: 'xmr-lan-miner/1.0',
          algo: ['rx/0'],
        },
      });
      for (const l of pending) pool.write(l);
      pending = [];
    });
    pool.on('data', (data) => {
      poolBuf += data.toString();
      const lines = poolBuf.split('\n');
      poolBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'job' || (msg.result && msg.result.job)) {
            const job = msg.result?.job || msg.params;
            console.log(`[${tag}] job id=${job.job_id} target=${job.target} seedHash=${job.seed_hash?.slice(0, 8)}...`);
          }
          if (msg.result && msg.result.status === 'OK') {
            console.log(`[${tag}] share accepted`);
          }
          if (msg.error) {
            console.log(`[${tag}] pool error: ${msg.error.message} (code ${msg.error.code})`);
          }
          safeSend(msg);
        } catch (e) {
          console.error(`[${tag}] bad pool line: ${line.slice(0, 100)}`);
        }
      }
    });
    pool.on('error', (e) => {
      console.error(`[${tag}] pool error: ${e.message}`);
      safeSend({ error: `pool: ${e.message}` });
      poolReady = false;
    });
    pool.on('close', () => {
      console.log(`[${tag}] pool closed`);
      safeSend({ error: 'pool disconnected' });
      poolReady = false;
    });
  };

  connectPool();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.method === 'configure') {
      if (msg.wallet && /^[1-9A-HJ-NP-Za-km-z]{95}$|^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(msg.wallet)) wallet = msg.wallet;
      if (msg.poolHost) poolHost = String(msg.poolHost);
      if (msg.poolPort) poolPort = parseInt(msg.poolPort, 10) || poolPort;
      if (msg.worker) workerName = String(msg.worker).slice(0, 64);
      connectPool();
      return;
    }

    if (msg.method === 'submit') {
      // Forward share to pool verbatim
      sendPool({
        id: msg.id || 2, jsonrpc: '2.0', method: 'submit',
        params: msg.params,
      });
      return;
    }

    if (msg.method === 'keepalived') {
      sendPool({ id: msg.id || 99, jsonrpc: '2.0', method: 'keepalived', params: msg.params || {} });
      return;
    }
  });

  ws.on('close', () => {
    console.log(`[${tag}] client disconnected`);
    if (pool && !pool.destroyed) try { pool.destroy(); } catch (e) {}
  });
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`XMR LAN miner listening on 0.0.0.0:${HTTP_PORT}`);
  console.log(`Pool: ${POOL_HOST}:${POOL_PORT}  Wallet: ${WALLET.slice(0, 12)}...${WALLET.slice(-6)}`);
});
