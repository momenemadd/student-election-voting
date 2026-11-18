// One error format for every service: { error: { code, message, details? } }
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// Express 5 forwards rejected promises from async handlers here automatically.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
  if (err.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
  if (err.code === '23503') return res.status(409).json({ error: { code: 'CONFLICT', message: 'Referenced resource is missing or in use' } });
  // Never leak internals (stack, SQL, hostnames) to the client.
  console.error(JSON.stringify({ level: 'error', msg: err.message, code: err.code }));
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
}

module.exports = { AppError, notFound, errorHandler };
