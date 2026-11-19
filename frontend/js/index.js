// Login page logic. Redirects by role after login (the pages themselves still depend on backend checks).
const HOME = { ADMIN: 'admin/index.html', STUDENT: 'student/index.html', AUDITOR: 'auditor/index.html' };

api('/api/health')
  .then((h) => { document.getElementById('api-status').textContent = `API online: ${h.runtime}`; })
  .catch(() => { document.getElementById('api-status').textContent = 'API not reachable'; });

// The Turnstile widget puts its one-time token into a hidden input of the form.
const turnstileValue = () => (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '';
const resetTurnstile = () => { if (window.turnstile) window.turnstile.reset(); }; // a token works only once

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('message');
  msg.textContent = '';
  const email = document.getElementById('email').value;
  try {
    const out = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: document.getElementById('password').value, turnstileToken: turnstileValue() },
    });
    Auth.set(out.token, out.user);
    location.href = HOME[out.user.role] || 'index.html';
  } catch (err) {
    resetTurnstile();
    if (err.data && err.data.error && err.data.error.code === 'EMAIL_NOT_VERIFIED') {
      location.href = 'register.html?verify=' + encodeURIComponent(email);
      return;
    }
    msg.textContent = err.message; // textContent: safe against injection
  }
});
