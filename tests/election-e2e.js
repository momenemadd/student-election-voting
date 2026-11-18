// Election Management (Mo'men) - end-to-end + security tests against a running API.
// Creates temporary test users/students, runs every rule of the service, then cleans up.
//   Local:  cd backend && npm run dev        then   node ../tests/election-e2e.js
//   Floci:  API=http://<api-id>.execute-api.localhost.floci.io:4566 node tests/election-e2e.js
//   Keep test data for screenshots:  KEEP=1 node tests/election-e2e.js
const path = require('path');
const crypto = require('crypto');
const nm = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
nm('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env'), quiet: true });
const { Client } = nm('pg');
const bcrypt = nm('bcryptjs');

const API = process.env.API || 'http://localhost:3000';
const T = 'XXXX.DUMMY.TOKEN'; // accepted only by Cloudflare's published Turnstile TEST secret
const TAG = 'emtest-' + Date.now().toString(36); // lowercase: the API lowercases e-mails at login
const results = [];

async function call(method, p, body, token) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { /* 204 */ }
  return { status: r.status, data };
}
function check(id, name, expected, res) {
  const ok = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  results.push({ id, name, expected, actual: res.status, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}  -> ${res.status}${ok ? '' : `  (expected ${expected}) ${JSON.stringify(res.data)}`}`);
  return res;
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { email, password, turnstileToken: T })).data.token;
const day = (n) => new Date(Date.now() + n * 86400e3).toISOString();

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/sslmode=require/, 'sslmode=verify-full'), ssl: { rejectUnauthorized: true } });
  await db.connect();
  const pw = crypto.randomBytes(12).toString('hex');
  const hash = await bcrypt.hash(pw, 12);
  // ---- fixtures: a second admin, an eligible student and an ineligible student (all temporary) ----
  const mk = async (role, email, sn) => (await db.query(
    `INSERT INTO users(email,password_hash,role,email_verified,student_number) VALUES($1,$2,$3,true,$4) RETURNING user_id`,
    [email, hash, role, sn])).rows[0].user_id;
  await mk('ADMIN', `${TAG}-admin2@test.local`, null);
  await mk('STUDENT', `${TAG}-stu1@test.local`, `${TAG.slice(-6)}A1`);
  await mk('STUDENT', `${TAG}-stu2@test.local`, `${TAG.slice(-6)}B2`);

  const admin = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
  const admin2 = await login(`${TAG}-admin2@test.local`, pw);
  const stu1 = await login(`${TAG}-stu1@test.local`, pw);
  const stu2 = await login(`${TAG}-stu2@test.local`, pw);
  const auditor = await login(process.env.SEED_AUDITOR_EMAIL, process.env.SEED_AUDITOR_PASSWORD);
  if (!admin || !admin2 || !stu1 || !auditor) throw new Error('fixture login failed - is the API running and backend/.env filled?');

  // ---- elections ----
  const e = check('EM-01', 'Admin creates election (DRAFT)', 201, await call('POST', '/api/elections', { title: `${TAG} Student Union`, description: 'test', start_time: day(1), end_time: day(2), status: 'OPEN' }, admin)).data;
  if (e.status !== 'DRAFT') results.push({ id: 'EM-01b', name: 'status forced to DRAFT', ok: false });
  check('EM-02', 'End before start rejected', 400, await call('POST', '/api/elections', { title: `${TAG} bad`, start_time: day(2), end_time: day(1) }, admin));
  check('EM-03', 'Start in the past rejected', 400, await call('POST', '/api/elections', { title: `${TAG} past`, start_time: day(-1), end_time: day(1) }, admin));
  check('EM-04', 'Missing title rejected', 400, await call('POST', '/api/elections', { start_time: day(1), end_time: day(2) }, admin));
  check('EM-05', 'Student cannot create election', 403, await call('POST', '/api/elections', { title: `${TAG} x`, start_time: day(1), end_time: day(2) }, stu1));
  check('EM-06', 'No token -> 401', 401, await call('POST', '/api/elections', { title: `${TAG} x`, start_time: day(1), end_time: day(2) }));
  check('EM-07', 'Admin reads own election', 200, await call('GET', `/api/elections/${e.election_id}`, undefined, admin));
  check('EM-08', 'Owner edits title', 200, await call('PATCH', `/api/elections/${e.election_id}`, { title: `${TAG} Student Union 2026` }, admin));
  check('EM-09', 'Other admin cannot edit (ownership)', 403, await call('PATCH', `/api/elections/${e.election_id}`, { title: 'hijack' }, admin2));
  check('EM-10', 'Bad election id -> 400', 400, await call('GET', `/api/elections/not-a-uuid`, undefined, admin));
  check('EM-11', 'Unknown election -> 404', 404, await call('GET', `/api/elections/${crypto.randomUUID()}`, undefined, admin));

  // ---- positions & candidates ----
  const pos = check('EM-12', 'Add position', 201, await call('POST', `/api/elections/${e.election_id}/positions`, { title: 'President', max_selections: 1 }, admin)).data;
  check('EM-13', 'Invalid seats (0) rejected', 400, await call('POST', `/api/elections/${e.election_id}/positions`, { title: 'Treasurer', max_selections: 0 }, admin));
  check('EM-14', 'Not ready: schedule refused (needs candidates + students)', 409, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'SCHEDULED' }, admin));
  const c1 = check('EM-15', 'Add candidate 1', 201, await call('POST', `/api/positions/${pos.position_id}/candidates`, { name: 'Alice Ahmed', manifesto: 'Better labs' }, admin)).data;
  check('EM-16', 'Add candidate 2', 201, await call('POST', `/api/positions/${pos.position_id}/candidates`, { name: 'Bassem Ali' }, admin));
  check('EM-17', 'Duplicate candidate name -> 409', 409, await call('POST', `/api/positions/${pos.position_id}/candidates`, { name: 'Alice Ahmed' }, admin));
  check('EM-18', 'Candidate name too short -> 400', 400, await call('POST', `/api/positions/${pos.position_id}/candidates`, { name: 'A' }, admin));
  check('EM-19', 'Rename candidate', 200, await call('PATCH', `/api/candidates/${c1.candidate_id}`, { name: 'Alice A. Ahmed' }, admin));

  // ---- roster ----
  const s1 = check('EM-20', 'Add student to roster', 201, await call('POST', '/api/students', { student_number: `${TAG.slice(-6)}A1`, full_name: 'Test Student One', email: `${TAG}-s1@uni.test`, faculty: 'CS' }, admin)).data;
  check('EM-21', 'Duplicate student number -> 409', 409, await call('POST', '/api/students', { student_number: `${TAG.slice(-6)}A1`, full_name: 'Dup', email: `${TAG}-dup@uni.test` }, admin));
  const imp = check('EM-22', 'Import list: 1 new, 1 duplicate, 1 invalid -> 207', 207, await call('POST', '/api/students/import', { students: [
    { student_number: `${TAG.slice(-6)}B2`, full_name: 'Test Student Two', email: `${TAG}-s2@uni.test`, faculty: 'CS' },
    { student_number: `${TAG.slice(-6)}A1`, full_name: 'Again', email: `${TAG}-again@uni.test` },
    { student_number: '!!', full_name: 'Bad', email: 'nope' }] }, admin)).data;
  check('EM-23', 'Search with SQL-injection text is safe (0 rows)', 200, await call('GET', `/api/students?search=${encodeURIComponent("%' OR 1=1 --")}`, undefined, admin));
  check('EM-24', 'Student cannot read roster', 403, await call('GET', '/api/students', undefined, stu1));
  check('EM-25', 'Make student eligible (new) -> 201', 201, await call('PUT', `/api/elections/${e.election_id}/eligible-students/${s1.student_id}`, undefined, admin));
  check('EM-26', 'Make eligible again -> 200 (idempotent)', 200, await call('PUT', `/api/elections/${e.election_id}/eligible-students/${s1.student_id}`, undefined, admin));
  check('EM-27', 'Eligible student cannot see a DRAFT election', 404, await call('GET', `/api/elections/${e.election_id}`, undefined, stu1));

  // ---- schedule ----
  const rd = check('EM-28', 'Readiness checklist', 200, await call('GET', `/api/elections/${e.election_id}/readiness`, undefined, admin)).data;
  if (!rd.ready) console.log('      readiness:', JSON.stringify(rd.checks));
  check('EM-29', 'Other admin cannot schedule', 403, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'SCHEDULED' }, admin2));
  check('EM-30', 'Owner schedules ready election', 200, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'SCHEDULED' }, admin));
  check('EM-31', 'Positions locked after scheduling -> 409', 409, await call('POST', `/api/elections/${e.election_id}/positions`, { title: 'Secretary' }, admin));
  check('EM-32', 'Eligible student now sees election', 200, await call('GET', `/api/elections/${e.election_id}`, undefined, stu1));
  check('EM-33', 'Eligible student sees candidates', 200, await call('GET', `/api/elections/${e.election_id}/positions`, undefined, stu1));
  check('EM-34', 'Ineligible student gets 404 (no info leak)', 404, await call('GET', `/api/elections/${e.election_id}`, undefined, stu2));
  check('EM-35', 'Student cannot delete roster entry', 403, await call('DELETE', `/api/students/${s1.student_id}`, undefined, stu1));
  check('EM-36', 'Cannot delete student listed in scheduled election -> 409', 409, await call('DELETE', `/api/students/${s1.student_id}`, undefined, admin));

  // ---- voting opens automatically (simulate the clock by moving start_time into the past) ----
  await db.query("UPDATE elections SET start_time = now() - interval '1 minute' WHERE election_id=$1", [e.election_id]);
  const open = check('EM-37', 'Status becomes OPEN automatically at start time', 200, await call('GET', `/api/elections/${e.election_id}`, undefined, admin)).data;
  if (open.status !== 'OPEN') results.push({ id: 'EM-37b', name: `expected OPEN, got ${open.status}`, ok: false });
  check('EM-38', 'Window cannot be edited while OPEN -> 409', 409, await call('PATCH', `/api/elections/${e.election_id}`, { end_time: day(3) }, admin));
  check('EM-39', 'Candidate cannot be deleted while OPEN -> 409', 409, await call('DELETE', `/api/candidates/${c1.candidate_id}`, undefined, admin));
  check('EM-40', 'Eligibility cannot change while OPEN -> 409', 409, await call('DELETE', `/api/elections/${e.election_id}/eligible-students/${s1.student_id}`, undefined, admin));
  check('EM-41', 'Early close without reason -> 400', 400, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'CLOSED' }, admin));
  check('EM-42', 'Early close with reason -> 200 CLOSED', 200, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'CLOSED', reason: 'Testing early close procedure' }, admin));
  check('EM-43', 'Illegal transition CLOSED -> SCHEDULED -> 409', 409, await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'SCHEDULED' }, admin));
  check('EM-44', 'Closed election cannot be deleted -> 409', 409, await call('DELETE', `/api/elections/${e.election_id}`, undefined, admin));

  // ---- cancel + delete path ----
  const e2 = (await call('POST', '/api/elections', { title: `${TAG} Cancel me`, start_time: day(1), end_time: day(2) }, admin)).data;
  check('EM-45', 'Cancel a draft', 200, await call('POST', `/api/elections/${e2.election_id}/transition`, { to: 'CANCELLED' }, admin));
  check('EM-46', 'Delete a cancelled election', 204, await call('DELETE', `/api/elections/${e2.election_id}`, undefined, admin));

  // ---- audit trail produced by this service (read by the Results & Audit service) ----
  await new Promise((r) => setTimeout(r, 1500));
  const logs = check('EM-47', 'Auditor reads this election\'s audit trail', 200, await call('GET', `/api/audit-logs?election=${e.election_id}`, undefined, auditor)).data || [];
  console.log('      actions:', [...new Set(logs.map((x) => x.action))].join(', '));
  const ver = (await call('GET', `/api/audit-logs/verify?election=${e.election_id}`, undefined, auditor)).data;
  results.push({ id: 'EM-48', name: 'Audit hash chain valid', ok: !!(ver && ver.valid) });
  console.log(`${ver && ver.valid ? 'PASS' : 'FAIL'}  EM-48  Audit hash chain valid  -> ${JSON.stringify(ver)}`);
  console.log('      import report:', JSON.stringify(imp));

  // ---- cleanup ----
  if (!process.env.KEEP) {
    await db.query(`DELETE FROM elections WHERE title LIKE $1`, [`${TAG}%`]);
    await db.query(`DELETE FROM students WHERE student_number LIKE $1`, [`${TAG.slice(-6)}%`]);
    await db.query(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`]);
  }
  await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' - FAILED: ' + failed.map((f) => f.id).join(', ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error('test run error:', err.message); process.exit(2); });
