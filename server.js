// Stratum TCP bridge + static file server + admin dashboard for LAN XMR mining
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WALLET = process.env.WALLET || '8ApdEka2j6CUaaNKp12H1VBi1bziZB2T9Dhju1fPzgiTC8KBLWEEddVeZnpZjg7Ni4KCENsPLfSDfh2nbMhbFqngM5wKwHE';
const POOL_HOST = process.env.POOL_HOST || 'pool.supportxmr.com';
const POOL_PORT = parseInt(process.env.POOL_PORT || '3333', 10);
// Generate self-signed cert for HTTPS (required for SharedArrayBuffer in Firefox)
function generateSelfSignedCert() {
  const { generateKeyPairSync, createSign } = crypto;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  
  // Build a self-signed X.509 cert manually
  // This is a minimal cert — browsers will show a warning but it works for LAN
  const cert = crypto.createPrivateKey({
    key: privateKey.export({ type: 'pkcs1', format: 'pem' }),
  });
  
  // Use Node's built-in self-signed cert generation via X509Certificate
  try {
    const { X509Certificate } = crypto;
    // Can't easily create X509 in Node — use forge-style approach
    // Instead, shell out to openssl if available, or use a pre-generated cert
    return null;
  } catch (e) {
    return null;
  }
}

// Try to use openssl to generate cert, fall back to HTTP-only
function getHttpsOptions() {
  const certPath = '/tmp/xmr-miner-cert.pem';
  const keyPath = '/tmp/xmr-miner-key.pem';
  
  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      const { execSync } = require('child_process');
      execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/CN=xmr-lan-miner" 2>/dev/null`);
    }
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  } catch (e) {
    console.log('HTTPS: openssl not available, using HTTP only (SharedArrayBuffer will not work)');
    return null;
  }
}

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const WORKER_PREFIX = process.env.WORKER_PREFIX || 'lanxmr';

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.css': 'text/css', '.json': 'application/json',
};

// Active miner registry for admin dashboard
const miners = new Map(); // tag -> { tag, ip, wallet, worker, sysInfo, hashrate, workers, accepted, rejected, connectedAt, lastSeen }

const server = http.createServer((req, res) => {
  // Cross-origin isolation — require-corp + CORP on all resources = SharedArrayBuffer enabled
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-cache');

  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  if (p === '/favicon.ico') {
    // 1x1 transparent PNG — required for COEP compliance (404 without CORP breaks isolation)
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
  }
  if (p === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      wallet: WALLET, poolHost: POOL_HOST, poolPort: POOL_PORT, workerPrefix: WORKER_PREFIX,
    }));
  }
  if (p === '/api/miners') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(Array.from(miners.values())));
  }
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ 
  server,
  // Override the upgrade handler to add COEP headers
  handleProtocols: (protocols) => protocols[0] || false,
});

const hexToBuf = (h) => Buffer.from(h, 'hex');

wss.on('connection', (ws, req) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const tag = `miner-${Math.random().toString(36).slice(2, 6)}`;
  console.log(`[${tag}] connected from ${clientIp}`);

  // Register in admin registry
  const minerRecord = {
    tag, ip: clientIp, wallet: WALLET, worker: `${WORKER_PREFIX}-${tag}`,
    sysInfo: null, hashrate: 0, workers: 0, accepted: 0, rejected: 0,
    connectedAt: Date.now(), lastSeen: Date.now(),
  };
  miners.set(tag, minerRecord);

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
  const safeSend = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) {} };

  const connectPool = () => {
    if (pool && !pool.destroyed) try { pool.destroy(); } catch (e) {}
    pool = new net.Socket();
    poolBuf = '';
    pool.connect(poolPort, poolHost, () => {
      console.log(`[${tag}] pool connected ${poolHost}:${poolPort}`);
      poolReady = true;
      sendPool({
        id: 1, jsonrpc: '2.0', method: 'login',
        params: { login: wallet, pass: workerName, agent: 'xmr-lan-miner/1.0', algo: ['rx/0'] },
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
            console.log(`[${tag}] job id=${job.job_id} target=${job.target}`);
          }
          if (msg.result && msg.result.status === 'OK') {
            console.log(`[${tag}] share accepted`);
            minerRecord.accepted++;
          }
          if (msg.error) {
            console.log(`[${tag}] pool error: ${msg.error.message} (code ${msg.error.code})`);
            minerRecord.rejected++;
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    minerRecord.lastSeen = Date.now();

    if (msg.method === 'configure') {
      if (msg.wallet && /^[1-9A-HJ-NP-Za-km-z]{95}$|^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(msg.wallet)) wallet = msg.wallet;
      if (msg.poolHost) poolHost = String(msg.poolHost);
      if (msg.poolPort) poolPort = parseInt(msg.poolPort, 10) || poolPort;
      if (msg.worker) workerName = String(msg.worker).slice(0, 64);
      minerRecord.wallet = wallet;
      minerRecord.worker = workerName;
      minerRecord.sysInfo = msg.sysInfo || null;
      connectPool();
      return;
    }

    if (msg.method === 'stats') {
      minerRecord.hashrate = msg.hashrate || 0;
      minerRecord.workers = msg.workers || 0;
      return;
    }

    if (msg.method === 'submit') {
      sendPool({ id: msg.id || 2, jsonrpc: '2.0', method: 'submit', params: msg.params });
      return;
    }

    if (msg.method === 'keepalived') {
      sendPool({ id: msg.id || 99, jsonrpc: '2.0', method: 'keepalived', params: msg.params || {} });
      return;
    }
  });

  ws.on('close', () => {
    console.log(`[${tag}] client disconnected`);
    miners.delete(tag);
    if (pool && !pool.destroyed) try { pool.destroy(); } catch (e) {}
  });

  // Heartbeat — detect stale connections
  ws.on('pong', () => { minerRecord.lastSeen = Date.now(); });

  // Check for stale miners every 30s and clean up
  // (prevents admin dashboard from showing dead connections)
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`XMR LAN miner listening on http://0.0.0.0:${HTTP_PORT}`);
  console.log(`Pool: ${POOL_HOST}:${POOL_PORT}  Wallet: ${WALLET.slice(0, 12)}...${WALLET.slice(-6)}`);
  console.log(`Admin dashboard: http://0.0.0.0:${HTTP_PORT}/admin`);
});

// Start HTTPS server (required for SharedArrayBuffer in Firefox)
const httpsOpts = getHttpsOptions();
if (httpsOpts) {
  const httpsServer = https.createServer(httpsOpts, (req, res) => {
    // Re-use the same handler — set COEP headers
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    server.emit('request', req, res);
  });
  // Attach WS server to HTTPS too
  new WebSocketServer({ server: httpsServer });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`HTTPS: https://0.0.0.0:${HTTPS_PORT} (SharedArrayBuffer enabled)`);
    console.log(`HTTPS Admin: https://0.0.0.0:${HTTPS_PORT}/admin`);
  });
}

// Stale miner cleanup — remove miners not seen in 60s
setInterval(() => {
  const now = Date.now();
  for (const [tag, miner] of miners) {
    if (now - (miner.lastSeen || 0) > 60000) {
      console.log(`[${tag}] stale — removing`);
      miners.delete(tag);
    }
  }
}, 30000);