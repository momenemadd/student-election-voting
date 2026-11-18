// Structured JSON logs. Goes to stdout locally and to CloudWatch Logs on Lambda.
// NEVER log request bodies, tokens, passwords or candidate choices.
const crypto = require('crypto');

const userHash = (id) => (id ? crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12) : null);

function log(level, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, ...fields }));
}

function requestLogger(service) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      log(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', {
        service,
        event: 'http_request',
        method: req.method,
        path: req.path, // path only: no query string (may contain search terms)
        status: res.statusCode,
        ms: Date.now() - start,
        user: userHash(req.user && req.user.id),
      });
    });
    next();
  };
}

module.exports = { log, requestLogger, userHash };
