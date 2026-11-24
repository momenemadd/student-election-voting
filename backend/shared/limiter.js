// Lab 8 security layer: rate limiting on EVERY API request (sliding window, per client address).
// - At most N requests per client address in the last 60 seconds; request N+1 gets HTTP 429.
// - N comes from Secrets Manager (key "rateLimitMax"); RATE_LIMIT_MAX overrides it, e.g. to raise it
//   for a load test (as in Lab 8). Default 300.
// - Sliding window: old requests drop out one by one, so a bot cannot send N at 11:59:59 and N more at 12:00:00.
// - Counted in memory, so each worker / Lambda container counts separately (the Lab 8 lesson).
//   Login, registration, codes and votes ALSO have the shared DynamoDB limiter of the Voting service.
// - The client address is req.ip. X-Forwarded-For is only trusted when TRUST_LB=true (a worker behind
//   our own load balancer, which overwrites that header) - so a fake header cannot bypass the limit.
const { loadSecrets } = require('./config');
const { AppError } = require('./errors');
const { log } = require('./logger');
const audit = require('./audit');

const WINDOW_MS = 60_000;
const DEFAULT_MAX = 300;
const hits = new Map(); // address -> array of request times (ms), oldest first
const alerted = new Map(); // address -> time of the last audit record for a block

let max;
async function limitMax() {
  if (max) return max;
  let fromSecret;
  try { fromSecret = Number((await loadSecrets()).rateLimitMax); } catch { /* secrets not reachable: use default */ }
  max = Number(process.env.RATE_LIMIT_MAX) || fromSecret || DEFAULT_MAX;
  return max;
}

// Remove addresses that have been quiet for a whole window (keeps memory small).
function sweep(now) {
  if (hits.size < 5000) return;
  for (const [ip, times] of hits) {
    if (!times.length || now - times[times.length - 1] > WINDOW_MS) { hits.delete(ip); alerted.delete(ip); }
  }
}

async function apiLimiter(req, res, next) {
  if (req.method === 'OPTIONS' || req.path === '/api/health') return next(); // preflight and health checks are free
  const limit = await limitMax();
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const times = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS); // slide the window
  if (times.length >= limit) {
    hits.set(ip, times);
    res.set('Retry-After', String(Math.ceil((WINDOW_MS - (now - times[0])) / 1000)));
    log('warn', { event: 'SECURITY_ALERT', type: 'RATE_LIMIT_EXCEEDED', path: req.path, limit });
    if (now - (alerted.get(ip) || 0) >= WINDOW_MS) { // one audit record per address per window, not per request
      alerted.set(ip, now);
      audit.record({ actor_id: 'rate-limit', role: 'NONE', action: 'RATE_LIMITED', resource: 'api', outcome: 'DENIED' });
    }
    return next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests, slow down'));
  }
  times.push(now);
  hits.set(ip, times);
  sweep(now);
  next();
}

module.exports = { apiLimiter, WINDOW_MS, DEFAULT_MAX, _reset: () => { hits.clear(); alerted.clear(); max = undefined; } };
