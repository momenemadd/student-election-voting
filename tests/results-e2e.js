// Results & Audit end-to-end tests RS-01..RS-21 (owner: Mohamed Khaled).
// Run from backend/ with the server running:  node ../tests/results-e2e.js
const path = require('path');
const crypto = require('crypto');
const backend = path.join(__dirname, '..', 'backend');
require(path.join(backend, 'node_modules', 'dotenv')).config({ path: path.join(backend, '.env'), quiet: true });
const { query } = require(path.join(backend, 'shared', 'db'));
let bcrypt;
try { bcrypt = require(path.join(backend, 'node_modules', 'bcryptjs')); } catch { bcrypt = require(path.join(backend, 'node_modules', 'bcrypt')); }

const API = process.env.API || 'http://localhost:3000';
const TS = 'XXXX.DUMMY.TOKEN', PW = 'RsTest-Pass-12345', stamp = Date.now();
const made = { elections: [], users: [] };
let failed = 0;
const check = (id, name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok ? '' : ' -> ' + extra}`); };
const code = (r) => r.json && r.json.error && r.json.error.code;

const call = async (method, p, { body, token } = {}) => {
  const r = await fetch(API + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};

async function makeStudent(tag) {
  const { rows: [s] } = await query(
    `INSERT INTO students(student_number, full_name, email) VALUES ($1, $2, $3) RETURNING student_id, student_number`,
    [`RS${stamp}${tag}`, `RS Student ${tag}`, `rs${stamp}${tag}@example.edu`]);
  return s;
}

async function makeUser(role, studentNumber) {
  const email = `rsu${stamp}${made.users.length}@example.edu`;
  const hash = await bcrypt.hash(PW, 10);
  const { rows: [u] } = await query(
    `INSERT INTO users(student_number, email, password_hash, role, email_verified) VALUES ($1, $2, $3, $4, true) RETURNING user_id`,
    [studentNumber || null, email, hash, role]);
  made.users.push(u.user_id);
  return email;
}

const login = async (email, password) => {
  const r = await call('POST', '/api/auth/login', { body: { email, password, turnstileToken: TS } });
  return r.json && r.json.token;
};

// voters: who each voter picked. open: voting still open. skipBallots: receipts without ballots (integrity test).
async function makeElection(label, { open = false, voters = [], extraEligible = 0, skipBallots = false, cands = ['Ali', 'Sara', 'Omar'] } = {}) {
  const { rows: [admin] } = await query('SELECT user_id FROM users WHERE email = $1', [process.env.SEED_ADMIN_EMAIL]);
  const end = open ? `now() + interval '1 day'` : `now() - interval '1 minute'`;
  const { rows: [el] } = await query(
    `INSERT INTO elections(title, start_time, end_time, status, created_by)
     VALUES ($1, now() - interval '2 hours', ${end}, 'OPEN', $2) RETURNING election_id`,
    [`RS e2e ${label} ${stamp}`, admin.user_id]);
  const id = el.election_id;
  made.elections.push(id);
  const { rows: [pos] } = await query(
    `INSERT INTO positions(election_id, title, max_selections) VALUES ($1, 'President', 1) RETURNING position_id`, [id]);
  const cand = {};
  for (const n of cands) {
    const { rows: [c] } = await query(`INSERT INTO candidates(position_id, name) VALUES ($1, $2) RETURNING candidate_id`, [pos.position_id, n]);
    cand[n] = c.candidate_id;
  }
  const students = [];
  for (let i = 0; i < voters.length + extraEligible; i++) {
    const s = await makeStudent(`${label}${i}`);
    students.push(s);
    await query('INSERT INTO eligibility(election_id, student_id) VALUES ($1, $2)', [id, s.student_id]);
  }
  for (let i = 0; i < voters.length; i++) {
    await query(`INSERT INTO vote_receipts(election_id, student_id, receipt_hash) VALUES ($1, $2, 'test')`, [id, students[i].student_id]);
    if (skipBallots) continue;
    const { rows: [b] } = await query('INSERT INTO ballots(election_id) VALUES ($1) RETURNING ballot_id', [id]);
    await query('INSERT INTO ballot_selections(ballot_id, position_id, candidate_id) VALUES ($1, $2, $3)',
      [b.ballot_id, pos.position_id, cand[voters[i]]]);
  }
  return { id, posId: pos.position_id, cand, students };
}

async function cleanup() {
  for (const id of made.elections) {
    await query('DELETE FROM result_snapshots WHERE election_id = $1', [id]);
    await query('DELETE FROM ballot_selections WHERE ballot_id IN (SELECT ballot_id FROM ballots WHERE election_id = $1)', [id]);
    await query('DELETE FROM ballots WHERE election_id = $1', [id]);
    await query('DELETE FROM vote_receipts WHERE election_id = $1', [id]);
    await query('DELETE FROM eligibility WHERE election_id = $1', [id]);
    await query('DELETE FROM candidates WHERE position_id IN (SELECT position_id FROM positions WHERE election_id = $1)', [id]);
    await query('DELETE FROM positions WHERE election_id = $1', [id]);
    if (!process.env.AUDIT_TABLE) await query('DELETE FROM audit_log WHERE pk = $1', [id]);
    await query('DELETE FROM elections WHERE election_id = $1', [id]);
  }
  await query('DELETE FROM students WHERE student_number LIKE $1', [`RS${stamp}%`]);
  for (const u of made.users) await query('DELETE FROM users WHERE user_id = $1', [u]);
}

(async () => {
  try {
    // ---------- setup ----------
    const A = await makeElection('A', { voters: ['Ali', 'Ali', 'Ali', 'Sara'], extraEligible: 1 }); // closed, 5 eligible, 4 voted
    const B = await makeElection('B', { open: true, extraEligible: 1 });                          // still open
    const C = await makeElection('C', { voters: ['Ali', 'Ali', 'Sara', 'Sara'], cands: ['Ali', 'Sara'] }); // tie
    const D = await makeElection('D', { voters: ['Ali'], skipBallots: true });                    // receipts without ballots
    const outsider = await makeStudent('out');
    const studentInEmail = await makeUser('STUDENT', A.students[4].student_number);
    const studentOutEmail = await makeUser('STUDENT', outsider.student_number);
    const admin = await login(process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD);
    const auditor = await login(process.env.SEED_AUDITOR_EMAIL, process.env.SEED_AUDITOR_PASSWORD);
    const studentIn = await login(studentInEmail, PW);
    const studentOut = await login(studentOutEmail, PW);
    if (!admin || !auditor || !studentIn || !studentOut) throw new Error('login failed for a test user (check .env passwords / bcrypt)');

    // ---------- counting ----------
    let r = await call('POST', `/api/elections/${B.id}/tally`, { token: admin });
    check('RS-01', 'count while voting is open -> 409 NOT_CLOSED', r.status === 409 && code(r) === 'NOT_CLOSED', r.text);

    r = await call('POST', `/api/elections/${A.id}/tally`, { token: admin });
    const votes = r.json && r.json.result && r.json.result.positions[0].candidates.map((c) => c.name + ':' + c.votes).join(',');
    check('RS-02', 'count after closing -> correct numbers incl. 0-vote candidate',
      r.status === 200 && r.json.status === 'TALLIED' && votes === 'Ali:3,Sara:1,Omar:0' && r.json.result.turnout.percent === 80, r.text);
    const hashA = r.json && r.json.sha256;

    r = await call('POST', `/api/elections/${A.id}/tally`, { token: admin });
    check('RS-03', 'count again -> 200, same sha256', r.status === 200 && r.json.sha256 === hashA, r.text);

    r = await call('POST', `/api/elections/${C.id}/tally`, { token: admin });
    check('RS-04', 'equal votes at last winning place -> tie: true',
      r.status === 200 && r.json.result.positions[0].tie === true && r.json.result.positions[0].winners.length === 2, r.text);

    r = await call('POST', `/api/elections/${D.id}/tally`, { token: admin });
    check('RS-05', 'ballots != receipts -> 409 INTEGRITY_MISMATCH', r.status === 409 && code(r) === 'INTEGRITY_MISMATCH', r.text);

    // ---------- viewing + publishing ----------
    r = await call('GET', `/api/elections/${A.id}/results`, { token: studentIn });
    check('RS-06', 'student reads before publishing -> 403 RESULTS_NOT_PUBLISHED', r.status === 403 && code(r) === 'RESULTS_NOT_PUBLISHED', r.text);

    r = await call('GET', `/api/elections/${D.id}/results`, { token: admin });
    check('RS-08', 'admin reads before counting -> 409 NOT_COUNTED', r.status === 409 && code(r) === 'NOT_COUNTED', r.text);

    r = await call('POST', `/api/elections/${A.id}/results/publish`, { token: auditor });
    check('RS-09', 'auditor tries to publish -> 403', r.status === 403, r.text);

    r = await call('POST', `/api/elections/${A.id}/results/publish`, { token: admin });
    check('RS-10', 'admin publishes -> 200 PUBLISHED', r.status === 200 && r.json.status === 'PUBLISHED' && !!r.json.published_at, r.text);

    r = await call('POST', `/api/elections/${A.id}/results/publish`, { token: admin });
    check('RS-11', 'publish again -> 409', r.status === 409, r.text);

    r = await call('GET', `/api/elections/${A.id}/results`, { token: studentOut });
    check('RS-07', 'student not on the list -> 404', r.status === 404, r.text);

    r = await call('GET', `/api/elections/${A.id}/results`, { token: studentIn });
    check('RS-12', 'student reads after publishing -> 200', r.status === 200 && r.json.status === 'PUBLISHED', r.text);

    // ---------- export + recount ----------
    r = await call('GET', `/api/elections/${A.id}/results/export`, { token: auditor });
    const disp = r.headers.get('content-disposition') || '';
    check('RS-13', 'download: hash matches -> 200 + attachment',
      r.status === 200 && disp.includes('attachment') && crypto.createHash('sha256').update(r.text).digest('hex') === hashA, r.text);

    r = await call('GET', `/api/elections/${A.id}/results/verify`, { token: auditor });
    check('RS-20', 'recount matches the stored hash', r.status === 200 && r.json.match === true && r.json.snapshot_intact === true, r.text);

    // a ballot added after counting must be detected by the recount
    const { rows: [xb] } = await query('INSERT INTO ballots(election_id) VALUES ($1) RETURNING ballot_id', [A.id]);
    await query('INSERT INTO ballot_selections(ballot_id, position_id, candidate_id) VALUES ($1, $2, $3)', [xb.ballot_id, A.posId, A.cand.Omar]);
    r = await call('GET', `/api/elections/${A.id}/results/verify`, { token: admin });
    check('RS-21', 'ballot added after counting -> recount match: false', r.status === 200 && r.json.match === false, r.text);

    if (!process.env.RESULTS_BUCKET) {
      await query(`UPDATE result_snapshots SET result_json = jsonb_set(result_json, '{positions,0,candidates,0,votes}', '99'::jsonb) WHERE election_id = $1`, [A.id]);
      r = await call('GET', `/api/elections/${A.id}/results/export`, { token: admin });
      check('RS-14', 'download after changing the saved copy -> 500 SNAPSHOT_TAMPERED', r.status === 500 && code(r) === 'SNAPSHOT_TAMPERED', r.text);
    } else console.log('SKIP  RS-14 (RESULTS_BUCKET is set: change the S3 file by hand instead)');

    // ---------- audit ----------
    r = await call('GET', '/api/audit-logs', { token: admin });
    check('RS-15', 'admin reads the audit log -> 403', r.status === 403, r.text);

    r = await call('GET', '/api/audit-logs?from=not-a-date', { token: auditor });
    check('RS-16', 'audit filter with a wrong date -> 400', r.status === 400, r.text);

    if (!process.env.AUDIT_TABLE) {
      await query(`UPDATE audit_log SET resource = 'tampered' WHERE pk = $1 AND seq = (SELECT min(seq) FROM audit_log WHERE pk = $1)`, [A.id]);
      r = await call('GET', `/api/audit-logs/verify?election=${A.id}`, { token: auditor });
      check('RS-17', 'change one audit row, then verify -> valid: false', r.status === 200 && r.json.valid === false, r.text);
    } else console.log('SKIP  RS-17 (audit log is in DynamoDB)');

    // ---------- security summary ----------
    for (let i = 0; i < 3; i++) {
      await call('POST', '/api/auth/login', { body: { email: `nobody-rs-${stamp}@example.edu`, password: 'wrong-password-xyz', turnstileToken: TS } });
    }
    await new Promise((ok) => setTimeout(ok, 800));
    const sum = await call('GET', '/api/monitoring/security-summary?hours=24', { token: auditor });
    const list = await call('GET', '/api/audit-logs?limit=500', { token: auditor });
    const since = Date.now() - 24 * 3600e3;
    let same = sum.status === 200 && sum.json.counts.LOGIN_FAILED >= 3;
    for (const a of ['LOGIN_FAILED', 'LOGIN_LOCKED', 'ACCESS_DENIED', 'RATE_LIMITED', 'EMAIL_CODE_FAILED']) {
      const expected = list.json.filter((x) => x.action === a && new Date(x.ts).getTime() >= since).length;
      if (sum.json.counts[a] !== expected) same = false;
    }
    check('RS-18', 'security summary counts match the audit log', same, sum.text);

    // ---------- no token ----------
    const eps = [
      ['POST', `/api/elections/${A.id}/tally`], ['GET', `/api/elections/${A.id}/results`],
      ['POST', `/api/elections/${A.id}/results/publish`], ['GET', `/api/elections/${A.id}/results/export`],
      ['GET', `/api/elections/${A.id}/results/verify`], ['GET', `/api/elections/${A.id}/turnout`],
      ['GET', '/api/monitoring/security-summary'], ['GET', '/api/audit-logs'], ['GET', '/api/audit-logs/verify'],
    ];
    let all401 = true;
    for (const [m, p] of eps) { const x = await call(m, p); if (x.status !== 401) { all401 = false; console.log('   not 401:', m, p, x.status); } }
    check('RS-19', 'no token on every endpoint -> 401', all401);
  } catch (e) {
    failed++;
    console.error('TEST ERROR:', e);
  } finally {
    await cleanup().catch((e) => console.error('CLEANUP ERROR:', e));
    console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
    process.exit(failed ? 1 : 0);
  }
})();