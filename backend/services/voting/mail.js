// E-mail sender (external API #2: Brevo transactional e-mail).
// Used for the verification code and the vote receipt. The key and sender come from
// loadSecrets() (backend/.env locally, Secrets Manager on Floci). The message text is NEVER logged.
const { loadSecrets } = require('../../shared/config');
const { AppError } = require('../../shared/errors');
const { log } = require('../../shared/logger');

async function sendMail(to, subject, text) {
  const { MAIL_API_KEY, MAIL_FROM } = await loadSecrets();
  // Local tests without a Brevo account: skip sending (never in production).
  if (process.env.MAIL_DISABLED === 'true' && process.env.NODE_ENV !== 'production') return;
  if (!MAIL_API_KEY || !MAIL_FROM) throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Email service is not configured');

  let res;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': MAIL_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    log('error', { event: 'email_failed', reason: e.name }); // no address, no body, no code
    throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Email service unavailable, try again later');
  }
  if (!res.ok) {
    log('error', { event: 'email_failed', status: res.status });
    throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Email service unavailable, try again later');
  }
}

module.exports = { sendMail };
