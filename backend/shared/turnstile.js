// Cloudflare Turnstile server-side verification (external API #1).
// A widget alone proves nothing: the backend must call siteverify and reject failures.
const { loadSecrets } = require('./config');
const { AppError } = require('./errors');

async function verifyTurnstile(token, remoteIp) {
  // Local tests only. Never set TURNSTILE_BYPASS in a deployed environment.
  if (process.env.TURNSTILE_BYPASS === 'true' && process.env.NODE_ENV !== 'production') return;

  const { TURNSTILE_SECRET_KEY } = await loadSecrets();
  if (!TURNSTILE_SECRET_KEY) throw new AppError(500, 'INTERNAL_ERROR', 'Bot check is not configured');
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
    throw new AppError(403, 'BOT_CHECK_FAILED', 'Bot check failed');
  }

  const body = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  let result;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    result = await res.json();
  } catch {
    throw new AppError(503, 'BOT_CHECK_UNAVAILABLE', 'Bot check service unavailable');
  }
  if (!result.success) throw new AppError(403, 'BOT_CHECK_FAILED', 'Bot check failed');
}

module.exports = { verifyTurnstile };
