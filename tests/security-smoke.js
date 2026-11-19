// Shared security smoke test (16 checks): login rules, roles, validation, SQL injection, audit access,
// hash chain and logout. Uses only the seed admin/auditor accounts from backend/.env.
//   Local:  node tests/security-smoke.js          Floci:  API=http://<api-id>.execute-api.localhost.floci.io:4566 node tests/security-smoke.js
const path = require('path');
require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', 'backend', '.env'), quiet: true });
const API = process.env.API || 'http://localhost:3000', T = 'XXXX.DUMMY.TOKEN';
const call = async (m, p, body, tok) => { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return [r.status, j]; };
const show = (name, exp, [s, j]) => console.log(`${s === exp ? 'PASS' : 'FAIL'}  ${name}: ${s}${s !== exp ? ' expected ' + exp + ' ' + JSON.stringify(j) : ''}`);
(async () => {
  const e = process.env;
  const [s1, a] = await call('POST', '/api/auth/login', { email: e.SEED_ADMIN_EMAIL, password: e.SEED_ADMIN_PASSWORD, turnstileToken: T }); show('admin login (Turnstile test key + bcrypt)', 200, [s1, a]);
  const [, au] = await call('POST', '/api/auth/login', { email: e.SEED_AUDITOR_EMAIL, password: e.SEED_AUDITOR_PASSWORD, turnstileToken: T });
  show('wrong password -> 401 generic', 401, await call('POST', '/api/auth/login', { email: e.SEED_AUDITOR_EMAIL, password: 'wrong-password-xyz', turnstileToken: T }));
  show('unknown email -> same 401', 401, await call('POST', '/api/auth/login', { email: 'nobody@example.edu', password: 'whatever-123', turnstileToken: T }));
  show('missing turnstile -> 403', 403, await call('POST', '/api/auth/login', { email: e.SEED_ADMIN_EMAIL, password: e.SEED_ADMIN_PASSWORD }));
  const start = new Date(Date.now() + 86400e3).toISOString(), end = new Date(Date.now() + 2 * 86400e3).toISOString();
  const [s2, el] = await call('POST', '/api/elections', { title: 'E2E test ' + Date.now(), start_time: start, end_time: end, status: 'OPEN' }, a.token); show('admin creates election', 201, [s2, el]);
  console.log('      status forced to:', el && el.status, '(mass assignment ignored if DRAFT)');
  show('end before start -> 400', 400, await call('POST', '/api/elections', { title: 'Bad', start_time: end, end_time: start }, a.token));
  show('auditor creates election -> 403', 403, await call('POST', '/api/elections', { title: 'Nope', start_time: start, end_time: end }, au.token));
  show('no token -> 401', 401, await call('GET', '/api/elections'));
  show('tampered token -> 401', 401, await call('GET', '/api/me', null, a.token.slice(0, -3) + 'abc'));
  show('turnout (admin)', 200, await call('GET', `/api/elections/${el.election_id}/turnout`, null, a.token));
  show('SQLi id -> 400', 400, await call('GET', `/api/elections/1'%20OR%20'1'='1/turnout`, null, a.token));
  show('admin reads audit -> 403', 403, await call('GET', '/api/audit-logs', null, a.token));
  await new Promise((r) => setTimeout(r, 1500));
  const [s3, logs] = await call('GET', '/api/audit-logs', null, au.token); show('auditor reads audit', 200, [s3, logs]);
  console.log('      GLOBAL audit actions:', (logs || []).map((x) => x.action).join(', '));
  const [, v] = await call('GET', '/api/audit-logs/verify', null, au.token); console.log((v && v.valid ? 'PASS' : 'FAIL') + '  hash chain verify:', JSON.stringify(v));
  await call('DELETE', `/api/elections/${el.election_id}`, null, a.token); // clean up: remove the test election (DRAFT)
  show('logout', 204, await call('POST', '/api/auth/logout', null, a.token));
  show('token after logout -> 401', 401, await call('GET', '/api/me', null, a.token));
})();
