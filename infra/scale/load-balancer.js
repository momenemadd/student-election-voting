// Lab 8: a small local load balancer that plays the role of the ALB (Application Load Balancer).
//   node infra/scale/load-balancer.js <listenPort> <targetPort> [<targetPort> ...]
// - Round robin: each request goes to the next HEALTHY target (1, 2, 3, 1, 2, 3 ...).
// - Health check: GET /api/health on every target every 3 seconds; a target that fails is skipped
//   until it answers again (failover).
// - If a target refuses the connection, the request is retried once on the next healthy target.
// - It overwrites X-Forwarded-For with the real client address, so clients cannot fake it.
// - Requests that are not /api/... get the website files (frontend/), so http://localhost:<port>
//   shows the app talking to this load balancer (same origin).
const http = require('http');
const fs = require('fs');
const path = require('path');

const [listenPort, ...targetPorts] = process.argv.slice(2).map(Number);
if (!listenPort || targetPorts.length === 0) {
  console.error('usage: node infra/scale/load-balancer.js <listenPort> <targetPort> [...]');
  process.exit(2);
}
const targets = targetPorts.map((port) => ({ port, url: `http://localhost:${port}/`, healthy: true }));
const FRONTEND = path.resolve(__dirname, '..', '..', 'frontend');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
let next = 0;

const stamp = () => new Date().toISOString();
const logLine = (msg) => console.log(`${stamp()} [lb] ${msg}`);

function pickTarget(exclude) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[(next + i) % targets.length];
    if (t.healthy && t !== exclude) {
      next = (targets.indexOf(t) + 1) % targets.length;
      return t;
    }
  }
  return null;
}

function healthCheck() {
  for (const t of targets) {
    const req = http.get({ host: 'localhost', port: t.port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      const ok = res.statusCode === 200;
      if (ok !== t.healthy) logLine(`target ${t.url} is now ${ok ? 'HEALTHY' : 'UNHEALTHY'}`);
      t.healthy = ok;
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => {
      if (t.healthy) logLine(`target ${t.url} is now UNHEALTHY (health check failed)`);
      t.healthy = false;
    });
  }
}
setInterval(healthCheck, 3000);

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/js/config.js') { // the page talks to this load balancer (same origin)
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end("const API_BASE = ''; // served by the Lab 8 load balancer\n");
  }
  const file = path.normalize(path.join(FRONTEND, rel));
  if (!file.startsWith(FRONTEND)) { res.writeHead(403); return res.end(); } // no ../ tricks
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function forward(req, res, body, target, retried) {
  const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, host: `localhost:${target.port}` };
  const up = http.request({ host: 'localhost', port: target.port, method: req.method, path: req.url, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (err) => {
    logLine(`upstream ${target.url} failed: ${err.code || err.message}`);
    target.healthy = false; // stop sending traffic there until the health check says it is back
    const other = !retried && err.code === 'ECONNREFUSED' ? pickTarget(target) : null;
    if (other) return forward(req, res, body, other, true); // connection never opened: safe to retry
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'No healthy server answered' } }));
  });
  up.end(body);
}

http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) return serveStatic(req, res);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const target = pickTarget(null);
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'NO_HEALTHY_TARGET', message: 'No healthy server available' } }));
    }
    forward(req, res, Buffer.concat(chunks), target, false);
  });
}).listen(listenPort, () => logLine(`listening on :${listenPort}, targets ${targetPorts.join(', ')}`));
