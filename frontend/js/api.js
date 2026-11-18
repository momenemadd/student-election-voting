// Shared by every page: one place that talks to the API and attaches the token.
// Role-based menus are a convenience only - the backend enforces permissions.
const Auth = {
  get token() { try { return sessionStorage.getItem('token'); } catch { return null; } },
  set(token, user) { sessionStorage.setItem('token', token); sessionStorage.setItem('user', JSON.stringify(user)); },
  get user() { try { return JSON.parse(sessionStorage.getItem('user')); } catch { return null; } },
  clear() { sessionStorage.removeItem('token'); sessionStorage.removeItem('user'); },
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(Auth.token ? { Authorization: `Bearer ${Auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) Auth.clear();
    const err = new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data; // full response body (e.g. an import report sent with a 400)
    throw err;
  }
  return data;
}
// XSS rule: show server data with textContent, never innerHTML.
