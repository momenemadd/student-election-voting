// Register + verify email.  API: POST /api/auth/register, /api/auth/verify-email, /api/auth/resend-code
// The backend checks everything again (roster, password length, Turnstile); these checks only help the user.
const $ = (id) => document.getElementById(id);
// Like act() from ui.js, but a 401 here means "wrong code", not "session expired": show it, do not redirect.
async function run(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } catch (err) { flash(err.message); return undefined; } finally { if (button) button.disabled = false; }
}
const turnstileValue = () => (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '';

function showVerify(email) {
  $('register-form').hidden = true;
  $('verify-form').hidden = false;
  $('v-email').value = email;
  $('v-code').focus();
}

// Coming from the login page with an unverified account: go straight to the code box.
if (qs('verify')) showVerify(qs('verify'));

$('register-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if ($('r-password').value !== $('r-password2').value) return flash('The two passwords are different');
  const email = $('r-email').value.trim();
  const out = await run(ev.submitter, () => api('/api/auth/register', {
    method: 'POST',
    body: { student_number: $('r-number').value.trim(), email, password: $('r-password').value, turnstileToken: turnstileValue() },
  }));
  if (window.turnstile) window.turnstile.reset(); // tokens are single-use
  if (!out) return;
  flash(out.message, 'ok');
  showVerify(email);
});

$('verify-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const out = await run(ev.submitter, () => api('/api/auth/verify-email', {
    method: 'POST',
    body: { email: $('v-email').value.trim(), code: $('v-code').value.trim() },
  }));
  if (!out) return;
  flash(out.message, 'ok');
  $('verify-form').hidden = true;
  $('done').hidden = false;
});

$('resend').addEventListener('click', async (ev) => {
  const email = $('v-email').value.trim();
  if (!email) return flash('Enter your email first');
  const out = await run(ev.target, () => api('/api/auth/resend-code', { method: 'POST', body: { email } }));
  if (out) flash(out.message, 'ok');
});
