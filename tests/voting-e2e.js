// Voting service (Mohamed Osama) - end-to-end + security tests against a running API.
// Creates temporary students, elections and accounts, runs every rule of the service, then cleans up.
//   Local:  cd backend && npm run dev        then   node ../tests/voting-e2e.js
//   Floci:  API=http://<api-id>.execute-api.localhost.floci.io:4566 node tests/voting-e2e.js
//   Keep test data for screenshots:  KEEP=1 node tests/voting-e2e.js
// Real e-mails are not needed: the test writes a known code hash straight into the database.
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const nm = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
nm('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env'), quiet: true });
const { Client } = nm('pg');

const API = process.env.API || 'http://localhost:3000';
const T = 'XXXX.DUMMY.TOKEN'; // accepted only by Cloudflare's published Turnstile TEST secret
const TAG = 'vttest-' + Date.now().toString(36);
const SN = TAG.slice(-6);
const PW = 'Correct-Horse-' + crypto.randomBytes(4).toString('hex');
const results = [];

async function call(method, p, body, token) {
  const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { /* 204 */ }
  return { status: r.status, data };
}
function check(id, name, expected, res, code) {
  const okStatus = Array.isArray(expected) ? expected.includes(res.status) : res.status === expected;
  const okCode = !code || (res.data && res.data.error && res.data.error.code === code);
  const ok = okStatus && okCode;
  results.push({ id, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}  -> ${res.status}${code && res.data && res.data.error ? ' ' + res.data.error.code : ''}${ok ? '' : `  (expected ${expected}${code ? ' ' + code : ''}) ${JSON.stringify(res.data)}`}`);
  return res;
}
function assert(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  ' + detail : ''}`);
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { email, password, turnstileToken: T })).data?.token;
const day = (n) => new Date(Date.now() + n * 86400e3).toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const url = process.env.DATABASE_URL;
  const local = /localhost|127\.0\.0\.1/.test(url);
  const db = new Client({ connectionString: local ? url : url.replace(/sslmode=require/, 'sslmode=verify-full'), ssl: local ? false : { rejectUnauthorized: true } });
  await db.connect();
  const setCode = (email, code) => db.query(
    "UPDATE users SET otp_hash=$2, otp_expires_at=now()+interval '10 minutes', otp_tries=0 WHERE email=$1", [email, sha(code)]);

  const admin = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
  const auditor = await login(process.env.SEED_AUDITOR_EMAIL, process.env.SEED_AUDITOR_PASSWORD);
  if (!admin || !auditor) throw new Error('seed admin/auditor login failed - is the API running and backend/.env filled?');

  // ---- fixtures: roster entries (made by the admin through Mo'men's API) ----
  const emailA = `${TAG}-a@uni.test`, emailB = `${TAG}-b@uni.test`;
  const stA = (await call('POST', '/api/students', { student_number: `${SN}A1`, full_name: 'Voter Alpha', email: emailA, faculty: 'CS' }, admin)).data;
  const stB = (await call('POST', '/api/students', { student_number: `${SN}B2`, full_name: 'Voter Beta', email: emailB, faculty: 'CS' }, admin)).data;

  // ---- register / verify (V1, V2, V3) ----
  check('VT-01', 'Register with a number not on the list', 403, await call('POST', '/api/auth/register', { student_number: `${SN}ZZ`, email: `${TAG}-z@uni.test`, password: PW, turnstileToken: T }), 'NOT_ON_ROSTER');
  check('VT-02', 'Real number, different email', 403, await call('POST', '/api/auth/register', { student_number: `${SN}A1`, email: `${TAG}-other@uni.test`, password: PW, turnstileToken: T }), 'NOT_ON_ROSTER');
  check('VT-03', 'Short password (11 chars)', 400, await call('POST', '/api/auth/register', { student_number: `${SN}A1`, email: emailA, password: 'short-pw-11', turnstileToken: T }), 'VALIDATION_ERROR');
  const reg = check('VT-03b', 'Register correctly (role in body ignored)', 201, await call('POST', '/api/auth/register', { student_number: `${SN}A1`, email: emailA, password: PW, turnstileToken: T, role: 'ADMIN' }));
  assert('VT-03c', 'Code is never in the response', !/\b\d{6}\b/.test(JSON.stringify(reg.data)));
  const roleRow = (await db.query('SELECT role, email_verified, otp_hash FROM users WHERE email=$1', [emailA])).rows[0];
  assert('VT-03d', 'Stored as unverified STUDENT with a SHA-256 code hash', roleRow && roleRow.role === 'STUDENT' && !roleRow.email_verified && /^[0-9a-f]{64}$/.test(roleRow.otp_hash));
  check('VT-04', 'Register twice', 409, await call('POST', '/api/auth/register', { student_number: `${SN}A1`, email: emailA, password: PW, turnstileToken: T }), 'ALREADY_REGISTERED');
  check('VT-06', 'Login before verifying', 403, await call('POST', '/api/auth/login', { email: emailA, password: PW, turnstileToken: T }), 'EMAIL_NOT_VERIFIED');

  check('VT-04b', 'Register student B', 201, await call('POST', '/api/auth/register', { student_number: `${SN}B2`, email: emailB, password: PW, turnstileToken: T }));
  check('VT-05a', 'Code with letters -> 400', 400, await call('POST', '/api/auth/verify-email', { email: emailB, code: '12a456' }));
  await setCode(emailB, '123456');
  let five = true;
  for (let i = 0; i < 5; i++) { const r = await call('POST', '/api/auth/verify-email', { email: emailB, code: '654321' }); if (r.status !== 401 || r.data.error.code !== 'INVALID_CODE') five = false; }
  assert('VT-05', 'Wrong code 5 times -> 401 INVALID_CODE each time', five);
  check('VT-05b', '6th try (even the right code) -> 429', 429, await call('POST', '/api/auth/verify-email', { email: emailB, code: '123456' }), 'TOO_MANY_REQUESTS');
  check('VT-05c', 'Resend code -> 200', 200, await call('POST', '/api/auth/resend-code', { email: emailB }));
  check('VT-05d', 'Resend for unknown email -> same 200', 200, await call('POST', '/api/auth/resend-code', { email: `${TAG}-nobody@uni.test` }));
  await setCode(emailB, '111111');
  await db.query("UPDATE users SET otp_expires_at = now() - interval '1 second' WHERE email=$1", [emailB]);
  check('VT-05e', 'Expired code', 401, await call('POST', '/api/auth/verify-email', { email: emailB, code: '111111' }), 'CODE_EXPIRED');
  await setCode(emailB, '222222');
  check('VT-05f', 'Correct code verifies student B', 200, await call('POST', '/api/auth/verify-email', { email: emailB, code: '222222' }));
  await setCode(emailA, '333333');
  check('VT-05g', 'Correct code verifies student A', 200, await call('POST', '/api/auth/verify-email', { email: emailA, code: '333333' }));
  const cleared = (await db.query('SELECT email_verified, otp_hash FROM users WHERE email=$1', [emailA])).rows[0];
  assert('VT-05h', 'After verification the code hash is cleared', cleared.email_verified && cleared.otp_hash === null);

  const stuA = await login(emailA, PW);
  const stuB = await login(emailB, PW);
  assert('VT-06b', 'Verified students can log in', stuA && stuB);

  // ---- elections (made by the admin through Mo'men's API) ----
  async function makeElection(name, voters, withCouncil = true) {
    const e = (await call('POST', '/api/elections', { title: `${TAG} ${name}`, start_time: day(1), end_time: day(2) }, admin)).data;
    const pres = (await call('POST', `/api/elections/${e.election_id}/positions`, { title: 'President', max_selections: 1 }, admin)).data;
    const c = {};
    for (const n of ['Alice Ahmed', 'Bassem Ali']) c[n] = (await call('POST', `/api/positions/${pres.position_id}/candidates`, { name: n }, admin)).data.candidate_id;
    let coun = {};
    if (withCouncil) {
      coun = (await call('POST', `/api/elections/${e.election_id}/positions`, { title: 'Council', max_selections: 2 }, admin)).data;
      for (const n of ['Carol Nabil', 'Dina Samir', 'Eman Tarek']) c[n] = (await call('POST', `/api/positions/${coun.position_id}/candidates`, { name: n }, admin)).data.candidate_id;
    }
    for (const s of voters) await call('PUT', `/api/elections/${e.election_id}/eligible-students/${s.student_id}`, undefined, admin);
    const sch = await call('POST', `/api/elections/${e.election_id}/transition`, { to: 'SCHEDULED' }, admin);
    if (sch.status !== 200) throw new Error('could not schedule test election: ' + JSON.stringify(sch.data));
    return { id: e.election_id, pres: pres.position_id, coun: coun.position_id, c };
  }
  const open = (id) => db.query("UPDATE elections SET start_time = now() - interval '1 minute' WHERE election_id=$1", [id]);
  const E1 = await makeElection('Union', [stA]);
  const E2 = await makeElection('Faculty', [stB], false); // one position only: what tests/race-test.js sends
  const goodVote = (E) => ({ selections: [{ position_id: E.pres, candidate_id: E.c['Alice Ahmed'] }, { position_id: E.coun, candidate_id: E.c['Carol Nabil'] }, { position_id: E.coun, candidate_id: E.c['Dina Samir'] }], turnstileToken: T });

  const list = check('VT-07', 'My elections shows only mine', 200, await call('GET', '/api/me/elections', undefined, stuA)).data || [];
  assert('VT-07b', 'List contains E1, not E2, has_voted=false', list.some((x) => x.election_id === E1.id && x.has_voted === false) && !list.some((x) => x.election_id === E2.id));
  check('VT-07c', 'Admin cannot use My elections', 403, await call('GET', '/api/me/elections', undefined, admin));
  check('VT-08', 'Ballot before opening', 409, await call('GET', `/api/elections/${E1.id}/ballot`, undefined, stuA), 'ELECTION_NOT_OPEN');
  check('VT-08b', 'Vote before opening', 409, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), stuA), 'ELECTION_NOT_OPEN');
  check('VT-09', 'Ballot for an election I am not on', 404, await call('GET', `/api/elections/${E1.id}/ballot`, undefined, stuB), 'ELECTION_NOT_FOUND');
  check('VT-09b', 'Ballot with a bad id', 400, await call('GET', '/api/elections/not-a-uuid/ballot', undefined, stuA));

  await open(E1.id);
  const ballot = check('VT-09c', 'Ballot of an open election', 200, await call('GET', `/api/elections/${E1.id}/ballot`, undefined, stuA)).data;
  assert('VT-09d', 'Ballot has 2 positions, 5 candidates, no vote counts', ballot && ballot.positions.length === 2 && ballot.positions.reduce((n, p) => n + p.candidates.length, 0) === 5 && !/count|votes/i.test(JSON.stringify(ballot.positions)));
  check('VT-09e', 'Not eligible student cannot vote', 404, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), stuB), 'ELECTION_NOT_FOUND');

  check('VT-10', 'Candidate from another position', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: [{ position_id: E1.pres, candidate_id: E1.c['Carol Nabil'] }, { position_id: E1.coun, candidate_id: E1.c['Dina Samir'] }], turnstileToken: T }, stuA));
  check('VT-10b', 'Candidate of another election', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: [{ position_id: E1.pres, candidate_id: E2.c['Alice Ahmed'] }, { position_id: E1.coun, candidate_id: E1.c['Dina Samir'] }], turnstileToken: T }, stuA));
  check('VT-11', 'A position missing', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: [{ position_id: E1.pres, candidate_id: E1.c['Alice Ahmed'] }], turnstileToken: T }, stuA));
  check('VT-11b', 'Too many choices for a position (3 > 2)', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: [{ position_id: E1.pres, candidate_id: E1.c['Alice Ahmed'] }, { position_id: E1.coun, candidate_id: E1.c['Carol Nabil'] }, { position_id: E1.coun, candidate_id: E1.c['Dina Samir'] }, { position_id: E1.coun, candidate_id: E1.c['Eman Tarek'] }], turnstileToken: T }, stuA));
  check('VT-11c', 'Same candidate twice', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: [{ position_id: E1.pres, candidate_id: E1.c['Alice Ahmed'] }, { position_id: E1.coun, candidate_id: E1.c['Carol Nabil'] }, { position_id: E1.coun, candidate_id: E1.c['Carol Nabil'] }], turnstileToken: T }, stuA));
  check('VT-11d', 'Selections not a list', 400, await call('POST', `/api/elections/${E1.id}/votes`, { selections: 'Alice', turnstileToken: T }, stuA));
  if (process.env.TURNSTILE_BYPASS === 'true') console.log('SKIP  VT-19  No Turnstile token (TURNSTILE_BYPASS=true in this shell - run it with the test secret key)');
  else check('VT-19', 'No Turnstile token', 403, await call('POST', `/api/elections/${E1.id}/votes`, { selections: goodVote(E1).selections }, stuA), 'BOT_CHECK_FAILED');
  check('VT-16', 'Admin tries to vote', 403, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), admin), 'FORBIDDEN');
  check('VT-16b', 'Auditor tries to vote', 403, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), auditor), 'FORBIDDEN');
  check('VT-17', 'No token', 401, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1)), 'AUTH_REQUIRED');
  check('VT-18a', 'Receipt before voting', 404, await call('GET', `/api/elections/${E1.id}/receipt`, undefined, stuA), 'RECEIPT_NOT_FOUND');
  assert('VT-11e', 'Rejected votes stored nothing', (await db.query('SELECT count(*)::int n FROM ballots WHERE election_id=$1', [E1.id])).rows[0].n === 0);

  const voted = check('VT-12', 'Correct vote -> 201 + receipt code', 201, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), stuA)).data || {};
  assert('VT-12b', 'Receipt code returned', typeof voted.receipt_code === 'string' && voted.receipt_code.length >= 16);
  check('VT-13', 'Vote again', 409, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), stuA), 'ALREADY_VOTED');
  check('VT-13b', 'Ballot after voting', 409, await call('GET', `/api/elections/${E1.id}/ballot`, undefined, stuA), 'ALREADY_VOTED');
  const rc = check('VT-18', 'Receipt returns my own', 200, await call('GET', `/api/elections/${E1.id}/receipt`, undefined, stuA)).data || {};
  assert('VT-18b', 'receipt_ref = first 8 chars of SHA-256(receipt code)', rc.receipt_ref === sha(voted.receipt_code || '').slice(0, 8));
  check('VT-18c', 'Another student gets 404 for that receipt', 404, await call('GET', `/api/elections/${E1.id}/receipt`, undefined, stuB), 'RECEIPT_NOT_FOUND');
  const after = (await call('GET', '/api/me/elections', undefined, stuA)).data || [];
  assert('VT-07d', 'My elections now shows has_voted=true', after.some((x) => x.election_id === E1.id && x.has_voted === true));
  const stored = (await db.query(
    `SELECT (SELECT count(*)::int FROM ballots WHERE election_id=$1) b, (SELECT count(*)::int FROM ballot_selections s JOIN ballots x USING (ballot_id) WHERE x.election_id=$1) s,
            (SELECT count(*)::int FROM vote_receipts WHERE election_id=$1) r`, [E1.id])).rows[0];
  assert('VT-12c', 'Database: 1 receipt, 1 ballot, 3 selections', stored.r === 1 && stored.b === 1 && stored.s === 3, JSON.stringify(stored));

  // ---- 20 votes at the same moment from the same student (tests/race-test.js) ----
  await open(E2.id);
  const race = await new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, 'race-test.js')], {
    env: { ...process.env, API, STUDENT_TOKEN: stuB, ELECTION_ID: E2.id, POSITION_ID: E2.pres, CANDIDATE_ID: E2.c['Bassem Ali'] },
  }, (err, out) => resolve(out || '')));
  const r2 = (await db.query('SELECT (SELECT count(*)::int FROM vote_receipts WHERE election_id=$1) r, (SELECT count(*)::int FROM ballots WHERE election_id=$1) b', [E2.id])).rows[0];
  assert('VT-14', '20 votes at the same time -> exactly one 201', /PASS/.test(race) && r2.r === 1 && r2.b === 1, race.trim().replace(/\n/g, ' | ') + ' stored ' + JSON.stringify(r2));

  // ---- vote after closing ----
  await db.query("UPDATE elections SET start_time = now() - interval '2 minutes', end_time = now() - interval '1 minute' WHERE election_id=$1", [E1.id]);
  check('VT-15', 'Vote after closing', 409, await call('POST', `/api/elections/${E1.id}/votes`, goodVote(E1), stuA), 'ELECTION_NOT_OPEN');
  const closed = (await call('GET', '/api/me/elections', undefined, stuA)).data || [];
  assert('VT-15b', 'Election shows as CLOSED in My elections', closed.some((x) => x.election_id === E1.id && x.status === 'CLOSED'));

  // ---- secrecy: nothing links WHO (vote_receipts) and WHAT (ballots, ballot_selections) ----
  const cols = (await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('ballots','ballot_selections','vote_receipts') ORDER BY 1, ordinal_position`)).rows;
  const colsOf = (t) => cols.filter((c) => c.table_name === t).map((c) => c.column_name);
  const linkCols = ['student_id', 'user_id', 'student_number', 'email', 'receipt_hash', 'created_at', 'ts', 'voted_at'];
  assert('VT-20', 'No column links vote_receipts and ballots', !colsOf('ballots').concat(colsOf('ballot_selections')).some((c) => linkCols.includes(c)) && !colsOf('vote_receipts').includes('ballot_id'),
    `ballots(${colsOf('ballots')}) ballot_selections(${colsOf('ballot_selections')}) vote_receipts(${colsOf('vote_receipts')})`);
  await new Promise((r) => setTimeout(r, 1500));
  const logs = (await call('GET', `/api/audit-logs?election=${E1.id}`, undefined, auditor)).data || [];
  const voteLogs = logs.filter((x) => x.action.startsWith('VOTE_'));
  const acts = new Set(voteLogs.map((x) => x.action));
  assert('VT-21', 'Audit has VOTE_CAST + VOTE_REJECTED, and they hold no candidate ids', acts.has('VOTE_CAST') && acts.has('VOTE_REJECTED') && !Object.values(E1.c).some((cid) => JSON.stringify(voteLogs).includes(cid)), [...acts].join(', '));
  const ver = (await call('GET', `/api/audit-logs/verify?election=${E1.id}`, undefined, auditor)).data;
  assert('VT-22', 'Audit hash chain still valid', ver && ver.valid, JSON.stringify(ver));

  // ---- cleanup ----
  if (!process.env.KEEP) {
    const ids = [E1.id, E2.id];
    await db.query('DELETE FROM ballot_selections WHERE ballot_id IN (SELECT ballot_id FROM ballots WHERE election_id = ANY($1))', [ids]);
    await db.query('DELETE FROM ballots WHERE election_id = ANY($1)', [ids]);
    await db.query('DELETE FROM vote_receipts WHERE election_id = ANY($1)', [ids]);
    await db.query('DELETE FROM elections WHERE election_id = ANY($1)', [ids]);
    await db.query('DELETE FROM students WHERE student_number LIKE $1', [`${SN}%`]);
    await db.query('DELETE FROM users WHERE email LIKE $1', [`${TAG}%`]);
  }
  await db.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' - FAILED: ' + failed.map((f) => f.id).join(', ') : ''}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error('test run error:', err.message); process.exit(2); });
