// Login page logic. Redirects by role after login (the pages themselves still depend on backend checks).
const HOME = { ADMIN: 'admin/index.html', STUDENT: 'student/index.html', AUDITOR: 'auditor/index.html' };

api('/api/health')
  .then((h) => { document.getElementById('api-status').textContent = `API online: ${h.runtime}`; })
  .catch(() => { document.getElementById('api-status').textContent = 'API not reachable'; });

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('message');
  msg.textContent = '';
  try {
    const out = await api('/api/auth/login', {
      method: 'POST',
      body: { email: document.getElementById('email').value, password: document.getElementById('password').value, turnstileToken: window.turnstileToken || 'XXXX.DUMMY.TOKEN' },
    });
    Auth.set(out.token, out.user);
    location.href = HOME[out.user.role] || 'index.html';
  } catch (err) {
    msg.textContent = err.message; // textContent: safe against injection
  }
});
