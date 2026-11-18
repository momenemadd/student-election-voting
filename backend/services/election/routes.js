// SERVICE 1 - Election Management (owner: Mo'men Mohamed)
// Business capability: run an election correctly from DRAFT to OPEN/CLOSED, with its positions,
// candidates, student roster and eligibility list. Rules enforced here (not only in the UI):
//   * only ADMINs manage elections; only the admin who CREATED an election may change it (ownership)
//   * title/window editable only in DRAFT or SCHEDULED; window must be >= ELECTION_MIN_MINUTES, start in future
//   * positions/candidates editable only in DRAFT; eligibility only in DRAFT or SCHEDULED
//   * an election can be SCHEDULED only when it is "ready" (positions, candidates, eligible students)
//   * status changes follow the shared state machine; OPEN/CLOSED by time happen automatically (syncStatus)
//   * every change is written to the tamper-evident audit log
const { query, withTx } = require('../../shared/db');
const { requireAuth, requireRole } = require('../../shared/auth');
const { v, pick } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const audit = require('../../shared/audit');
const { assertTransition, canEditSetup, canEditDetails, syncStatus, DUE, NEXT } = require('../../shared/electionState');

const MIN_MINUTES = Number(process.env.ELECTION_MIN_MINUTES || 60); // set to 2 for live demos
const STUDENT_NUMBER = /^[A-Za-z0-9]{4,12}$/;
const IMPORT_MAX = 500;
const admin = [requireAuth, requireRole('ADMIN')];

// ---------- helpers ---------------------------------------------------------------------------
const nf = (code, msg) => new AppError(404, code, msg);

async function getElection(id) {
  const e = await syncStatus(query, v.uuid(id, 'id')); // applies automatic OPEN/CLOSED first
  if (!e) throw nf('ELECTION_NOT_FOUND', 'Election not found');
  return e;
}

function assertOwner(e, user) {
  if (e.created_by !== user.id) {
    audit.record({ actor_id: user.id, role: user.role, action: 'ACCESS_DENIED', resource: `election:${e.election_id}:not-owner`, outcome: 'DENIED', election_id: e.election_id });
    throw new AppError(403, 'NOT_ELECTION_OWNER', 'Only the admin who created this election can change it');
  }
}

function assertSetupEditable(e) {
  if (!canEditSetup(e.status)) {
    throw new AppError(409, 'ELECTION_LOCKED', `Positions and candidates can only change while the election is DRAFT (it is ${e.status})`);
  }
}

const canEditEligibility = (status) => status === 'DRAFT' || status === 'SCHEDULED';
function assertEligibilityEditable(e) {
  if (!canEditEligibility(e.status)) {
    throw new AppError(409, 'ELECTION_LOCKED', `Eligibility can only change before voting opens (it is ${e.status})`);
  }
}

function validateWindow(start, end) {
  if (end <= start) throw new AppError(400, 'VALIDATION_ERROR', 'end_time must be after start_time', { field: 'end_time' });
  if (end - start < MIN_MINUTES * 60_000) throw new AppError(400, 'VALIDATION_ERROR', `Voting window must be at least ${MIN_MINUTES} minutes`, { field: 'end_time' });
  if (start <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'start_time must be in the future', { field: 'start_time' });
}

// A student may see an election only if they are on its eligibility list and it is not DRAFT/CANCELLED.
async function studentCanSee(e, user) {
  if (user.role !== 'STUDENT') return true;
  if (e.status === 'DRAFT' || e.status === 'CANCELLED') return false;
  const r = await query(
    `SELECT 1 FROM eligibility el JOIN students s ON s.student_id = el.student_id
      WHERE el.election_id = $1 AND s.student_number = $2`,
    [e.election_id, user.studentNumber]
  );
  return r.rowCount > 0;
}

async function readiness(electionId) {
  // one round trip: positions with candidate counts + number of eligible students
  const { rows: [r] } = await query(
    `SELECT (SELECT count(*)::int FROM eligibility WHERE election_id = $1) AS eligible,
            COALESCE((SELECT json_agg(x ORDER BY x.title) FROM (
               SELECT p.title, p.max_selections, count(c.candidate_id)::int AS candidates
                 FROM positions p LEFT JOIN candidates c ON c.position_id = p.position_id
                WHERE p.election_id = $1 GROUP BY p.position_id) x), '[]'::json) AS positions`,
    [electionId]
  );
  const { positions, eligible } = r;
  const short = positions.filter((p) => p.candidates < Math.max(2, p.max_selections + 1));
  const checks = [
    { check: 'Has at least one position', ok: positions.length > 0, detail: `${positions.length} position(s)` },
    { check: 'Every position has enough candidates (at least 2, and more than its winners)', ok: positions.length > 0 && short.length === 0, detail: positions.length === 0 ? 'No positions yet' : short.length ? `Needs more candidates: ${short.map((p) => p.title).join(', ')}` : 'OK' },
    { check: 'At least one student can vote', ok: eligible > 0, detail: `${eligible} student(s) can vote` },
  ];
  return { ready: checks.every((c) => c.ok), checks };
}

async function getPosition(id) {
  const { rows } = await query('SELECT * FROM positions WHERE position_id = $1', [v.uuid(id, 'id')]);
  if (!rows[0]) throw nf('POSITION_NOT_FOUND', 'Position not found');
  return { position: rows[0], election: await getElection(rows[0].election_id) };
}

async function getCandidate(id) {
  const { rows } = await query(
    'SELECT c.*, p.election_id FROM candidates c JOIN positions p ON p.position_id = c.position_id WHERE c.candidate_id = $1',
    [v.uuid(id, 'id')]
  );
  if (!rows[0]) throw nf('CANDIDATE_NOT_FOUND', 'Candidate not found');
  return { candidate: rows[0], election: await getElection(rows[0].election_id) };
}

function validateStudent(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.student_number !== undefined) {
    const sn = v.string(b.student_number, 'student_number', { min: 4, max: 12 });
    if (!STUDENT_NUMBER.test(sn)) throw new AppError(400, 'VALIDATION_ERROR', 'student_number must be 4-12 letters/digits', { field: 'student_number' });
    out.student_number = sn;
  }
  if (!partial || b.full_name !== undefined) out.full_name = v.string(b.full_name, 'full_name', { min: 2, max: 100 });
  if (!partial || b.email !== undefined) out.email = v.email(b.email);
  if (b.faculty !== undefined && b.faculty !== null && b.faculty !== '') out.faculty = v.string(b.faculty, 'faculty', { min: 1, max: 80 });
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', 'active must be true or false', { field: 'active' });
    out.active = b.active;
  }
  return out;
}

const likeTerm = (s) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`; // escape LIKE wildcards
const log = (req, action, resource, election_id) => audit.record({ actor_id: req.user.id, role: req.user.role, action, resource, election_id });

module.exports = function register(app) {
  // =========================== ELECTIONS ======================================================
  // POST /api/elections - create (Admin). Status always starts as DRAFT; created_by comes from the token.
  app.post('/api/elections', ...admin, async (req, res) => {
    const b = pick(req.body, ['title', 'description', 'start_time', 'end_time']); // whitelist (mass assignment)
    const title = v.string(b.title, 'title', { min: 3, max: 120 });
    const description = b.description === undefined ? '' : v.string(b.description, 'description', { min: 0, max: 1000 });
    const start = v.date(b.start_time, 'start_time');
    const end = v.date(b.end_time, 'end_time');
    validateWindow(start, end);
    const { rows } = await query(
      `INSERT INTO elections(title, description, start_time, end_time, status, created_by)
       VALUES($1,$2,$3,$4,'DRAFT',$5) RETURNING *`,
      [title, description, start.toISOString(), end.toISOString(), req.user.id]
    );
    log(req, 'ELECTION_CREATED', `election:${rows[0].election_id}`, rows[0].election_id);
    res.status(201).json(rows[0]);
  });

  // GET /api/elections?status=&search= - Admin/Auditor see all; Student only eligible, non-draft.
  app.get('/api/elections', requireAuth, async (req, res) => {
    const status = req.query.status ? v.oneOf(String(req.query.status), 'status', ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'TALLIED', 'PUBLISHED', 'CANCELLED']) : null;
    const search = req.query.search ? v.string(String(req.query.search), 'search', { max: 50 }) : null;
    // ONE round trip: apply due time-based changes to all elections and list them in the same statement
    const ST = 'COALESCE(u.status, e.status)';
    const head = `WITH u AS (UPDATE elections SET status = ${NEXT}, updated_at = now() WHERE ${DUE} RETURNING election_id, status) `;
    let sql;
    const params = [];
    if (req.user.role === 'STUDENT') {
      params.push(req.user.studentNumber);
      sql = head + `SELECT e.election_id, e.title, e.description, e.start_time, e.end_time, ${ST} AS status
               FROM elections e LEFT JOIN u ON u.election_id = e.election_id
               JOIN eligibility el ON el.election_id = e.election_id
               JOIN students s ON s.student_id = el.student_id
              WHERE s.student_number = $1 AND ${ST} NOT IN ('DRAFT','CANCELLED')`;
    } else {
      params.push(req.user.id);
      sql = head + `SELECT e.election_id, e.title, e.description, e.start_time, e.end_time, ${ST} AS status,
                    e.created_by, e.created_at, e.updated_at, (e.created_by = $1) AS is_mine
               FROM elections e LEFT JOIN u ON u.election_id = e.election_id WHERE 1=1`;
    }
    if (status) { params.push(status); sql += ` AND ${ST} = $${params.length}`; }
    if (search) { params.push(likeTerm(search)); sql += ` AND e.title ILIKE $${params.length}`; }
    sql += ' ORDER BY e.start_time DESC LIMIT 100';
    const { rows } = await query(sql, params);
    res.status(200).json(rows);
  });

  // GET /api/elections/:id - details (+ readiness for admins). Students get 404 unless eligible (no info leak).
  app.get('/api/elections/:id', requireAuth, async (req, res) => {
    const e = await getElection(req.params.id);
    if (!(await studentCanSee(e, req.user))) throw nf('ELECTION_NOT_FOUND', 'Election not found');
    if (req.user.role === 'STUDENT') {
      const { election_id, title, description, start_time, end_time, status } = e;
      return res.status(200).json({ election_id, title, description, start_time, end_time, status });
    }
    res.status(200).json({ ...e, is_mine: e.created_by === req.user.id });
  });

  // PATCH /api/elections/:id - edit title/description/window (creator, DRAFT or SCHEDULED only).
  app.patch('/api/elections/:id', ...admin, async (req, res) => {
    const b = pick(req.body, ['title', 'description', 'start_time', 'end_time']);
    if (Object.keys(b).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
    const e = await getElection(req.params.id);
    assertOwner(e, req.user);
    if (!canEditDetails(e.status)) throw new AppError(409, 'ELECTION_LOCKED', `Election details cannot change once it is ${e.status}`);
    const title = b.title === undefined ? e.title : v.string(b.title, 'title', { min: 3, max: 120 });
    const description = b.description === undefined ? e.description : v.string(b.description, 'description', { min: 0, max: 1000 });
    const start = b.start_time === undefined ? new Date(e.start_time) : v.date(b.start_time, 'start_time');
    const end = b.end_time === undefined ? new Date(e.end_time) : v.date(b.end_time, 'end_time');
    validateWindow(start, end);
    const { rows } = await query(
      `UPDATE elections SET title=$2, description=$3, start_time=$4, end_time=$5, updated_at=now()
        WHERE election_id=$1 AND status IN ('DRAFT','SCHEDULED') RETURNING *`,
      [e.election_id, title, description, start.toISOString(), end.toISOString()]
    );
    if (!rows[0]) throw new AppError(409, 'ELECTION_LOCKED', 'Election changed state, reload and try again');
    log(req, 'ELECTION_UPDATED', `election:${e.election_id}:${Object.keys(b).join(',')}`, e.election_id);
    res.status(200).json(rows[0]);
  });

  // DELETE /api/elections/:id - only DRAFT or CANCELLED (never one that opened). Creator only.
  app.delete('/api/elections/:id', ...admin, async (req, res) => {
    const e = await getElection(req.params.id);
    assertOwner(e, req.user);
    if (e.status !== 'DRAFT' && e.status !== 'CANCELLED') throw new AppError(409, 'ELECTION_LOCKED', `Only DRAFT or CANCELLED elections can be deleted (it is ${e.status})`);
    await query("DELETE FROM elections WHERE election_id=$1 AND status IN ('DRAFT','CANCELLED')", [e.election_id]);
    log(req, 'ELECTION_DELETED', `election:${e.election_id}`, e.election_id);
    res.status(204).end();
  });

  // POST /api/elections/:id/transition {to, reason} - SCHEDULED (needs readiness) | CANCELLED | CLOSED (early, needs reason)
  app.post('/api/elections/:id/transition', ...admin, async (req, res) => {
    const b = pick(req.body, ['to', 'reason']);
    const to = v.oneOf(b.to, 'to', ['SCHEDULED', 'CANCELLED', 'CLOSED']);
    const e = await getElection(req.params.id);
    assertOwner(e, req.user);
    assertTransition(e.status, to); // 409 INVALID_TRANSITION for anything the state machine forbids
    let reason = '';
    if (to === 'CLOSED') reason = v.string(b.reason, 'reason', { min: 10, max: 300 }); // early close must be justified
    if (to === 'CANCELLED' && b.reason !== undefined) reason = v.string(b.reason, 'reason', { min: 0, max: 300 });
    if (to === 'SCHEDULED') {
      const r = await readiness(e.election_id);
      if (!r.ready) throw new AppError(409, 'NOT_READY', 'Election is not ready to be scheduled', r.checks.filter((c) => !c.ok));
      if (new Date(e.start_time) <= new Date()) throw new AppError(409, 'START_IN_PAST', 'start_time has passed; edit the voting window first');
    }
    const extra = to === 'CLOSED' ? ', end_time = now()' : '';
    const { rows } = await query(
      `UPDATE elections SET status=$2, updated_at=now()${extra} WHERE election_id=$1 AND status=$3 RETURNING *`,
      [e.election_id, to, e.status] // optimistic check: fails if someone changed it meanwhile
    );
    if (!rows[0]) throw new AppError(409, 'CONCURRENT_CHANGE', 'Election changed state, reload and try again');
    await audit.recordStrict({ actor_id: req.user.id, role: req.user.role, action: 'ELECTION_TRANSITION', resource: `election:${e.election_id}:${e.status}->${to}${reason ? ':reason-given' : ''}`, election_id: e.election_id });
    res.status(200).json(rows[0]);
  });

  // GET /api/elections/:id/readiness - checklist shown in the admin page before scheduling
  app.get('/api/elections/:id/readiness', ...admin, async (req, res) => {
    const e = await getElection(req.params.id);
    res.status(200).json({ election_id: e.election_id, status: e.status, ...(await readiness(e.election_id)) });
  });

  // =========================== POSITIONS & CANDIDATES =========================================
  // GET /api/elections/:id/positions - positions with their candidates (students: only if eligible)
  app.get('/api/elections/:id/positions', requireAuth, async (req, res) => {
    const e = await getElection(req.params.id);
    if (!(await studentCanSee(e, req.user))) throw nf('ELECTION_NOT_FOUND', 'Election not found');
    // one round trip: each position with its candidates as a JSON array
    const { rows } = await query(
      `SELECT p.*, COALESCE(json_agg(c ORDER BY c.name) FILTER (WHERE c.candidate_id IS NOT NULL), '[]'::json) AS candidates
         FROM positions p LEFT JOIN candidates c ON c.position_id = p.position_id
        WHERE p.election_id = $1 GROUP BY p.position_id ORDER BY p.title`,
      [e.election_id]
    );
    res.status(200).json(rows);
  });

  // POST /api/elections/:id/positions {title, max_selections}
  app.post('/api/elections/:id/positions', ...admin, async (req, res) => {
    const b = pick(req.body, ['title', 'max_selections']);
    const e = await getElection(req.params.id);
    assertOwner(e, req.user);
    assertSetupEditable(e);
    const title = v.string(b.title, 'title', { min: 2, max: 80 });
    const max = b.max_selections === undefined ? 1 : v.int(b.max_selections, 'max_selections', { min: 1, max: 10 });
    const { rows } = await query('INSERT INTO positions(election_id, title, max_selections) VALUES($1,$2,$3) RETURNING *', [e.election_id, title, max]);
    log(req, 'POSITION_CREATED', `position:${rows[0].position_id}`, e.election_id);
    res.status(201).json({ ...rows[0], candidates: [] });
  });

  // PATCH /api/positions/:id {title?, max_selections?}
  app.patch('/api/positions/:id', ...admin, async (req, res) => {
    const b = pick(req.body, ['title', 'max_selections']);
    if (Object.keys(b).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
    const { position, election } = await getPosition(req.params.id);
    assertOwner(election, req.user);
    assertSetupEditable(election);
    const title = b.title === undefined ? position.title : v.string(b.title, 'title', { min: 2, max: 80 });
    const max = b.max_selections === undefined ? position.max_selections : v.int(b.max_selections, 'max_selections', { min: 1, max: 10 });
    const { rows } = await query('UPDATE positions SET title=$2, max_selections=$3 WHERE position_id=$1 RETURNING *', [position.position_id, title, max]);
    log(req, 'POSITION_UPDATED', `position:${position.position_id}`, election.election_id);
    res.status(200).json(rows[0]);
  });

  // DELETE /api/positions/:id (also removes its candidates; DRAFT only)
  app.delete('/api/positions/:id', ...admin, async (req, res) => {
    const { position, election } = await getPosition(req.params.id);
    assertOwner(election, req.user);
    assertSetupEditable(election);
    await query('DELETE FROM positions WHERE position_id=$1', [position.position_id]);
    log(req, 'POSITION_DELETED', `position:${position.position_id}`, election.election_id);
    res.status(204).end();
  });

  // POST /api/positions/:id/candidates {name, manifesto}
  app.post('/api/positions/:id/candidates', ...admin, async (req, res) => {
    const b = pick(req.body, ['name', 'manifesto']);
    const { position, election } = await getPosition(req.params.id);
    assertOwner(election, req.user);
    assertSetupEditable(election);
    const name = v.string(b.name, 'name', { min: 2, max: 80 });
    const manifesto = b.manifesto === undefined ? '' : v.string(b.manifesto, 'manifesto', { min: 0, max: 1000 });
    const { rows } = await query('INSERT INTO candidates(position_id, name, manifesto) VALUES($1,$2,$3) RETURNING *', [position.position_id, name, manifesto]);
    log(req, 'CANDIDATE_CREATED', `candidate:${rows[0].candidate_id}`, election.election_id);
    res.status(201).json(rows[0]);
  });

  // PATCH /api/candidates/:id {name?, manifesto?}
  app.patch('/api/candidates/:id', ...admin, async (req, res) => {
    const b = pick(req.body, ['name', 'manifesto']);
    if (Object.keys(b).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
    const { candidate, election } = await getCandidate(req.params.id);
    assertOwner(election, req.user);
    assertSetupEditable(election);
    const name = b.name === undefined ? candidate.name : v.string(b.name, 'name', { min: 2, max: 80 });
    const manifesto = b.manifesto === undefined ? candidate.manifesto : v.string(b.manifesto, 'manifesto', { min: 0, max: 1000 });
    const { rows } = await query('UPDATE candidates SET name=$2, manifesto=$3 WHERE candidate_id=$1 RETURNING *', [candidate.candidate_id, name, manifesto]);
    log(req, 'CANDIDATE_UPDATED', `candidate:${candidate.candidate_id}`, election.election_id);
    res.status(200).json(rows[0]);
  });

  // DELETE /api/candidates/:id - blocked once the election left DRAFT or if any ballot chose this candidate
  app.delete('/api/candidates/:id', ...admin, async (req, res) => {
    const { candidate, election } = await getCandidate(req.params.id);
    assertOwner(election, req.user);
    assertSetupEditable(election);
    const used = await query('SELECT 1 FROM ballot_selections WHERE candidate_id=$1 LIMIT 1', [candidate.candidate_id]);
    if (used.rowCount) throw new AppError(409, 'CANDIDATE_HAS_VOTES', 'Candidate already received votes and cannot be deleted');
    await query('DELETE FROM candidates WHERE candidate_id=$1', [candidate.candidate_id]);
    log(req, 'CANDIDATE_DELETED', `candidate:${candidate.candidate_id}`, election.election_id);
    res.status(204).end();
  });

  // =========================== STUDENT ROSTER =================================================
  // POST /api/students {student_number, full_name, email, faculty?}
  app.post('/api/students', ...admin, async (req, res) => {
    const s = validateStudent(pick(req.body, ['student_number', 'full_name', 'email', 'faculty']));
    const { rows } = await query(
      'INSERT INTO students(student_number, full_name, email, faculty) VALUES($1,$2,$3,$4) RETURNING *',
      [s.student_number, s.full_name, s.email, s.faculty || null]
    ); // duplicate number/email -> 409 via the shared error handler
    log(req, 'STUDENT_CREATED', `student:${rows[0].student_id}`);
    res.status(201).json(rows[0]);
  });

  // POST /api/students/import {students:[{student_number, full_name, email, faculty?}, ...]} (max 500)
  // 201 all imported · 207 some rows skipped/invalid · 400 nothing imported. Per-row report returned.
  app.post('/api/students/import', ...admin, async (req, res) => {
    const { students } = pick(req.body, ['students']);
    if (!Array.isArray(students) || students.length === 0 || students.length > IMPORT_MAX) {
      throw new AppError(400, 'VALIDATION_ERROR', `students must be an array of 1-${IMPORT_MAX} rows`, { field: 'students' });
    }
    const report = { created: 0, duplicates: [], errors: [] };
    await withTx(async (client) => {
      for (let i = 0; i < students.length; i++) {
        let s;
        try {
          s = validateStudent(pick(students[i], ['student_number', 'full_name', 'email', 'faculty']));
        } catch (err) {
          report.errors.push({ row: i + 1, message: err.message });
          continue;
        }
        const r = await client.query(
          'INSERT INTO students(student_number, full_name, email, faculty) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [s.student_number, s.full_name, s.email, s.faculty || null]
        );
        if (r.rowCount) report.created++;
        else report.duplicates.push({ row: i + 1, student_number: s.student_number });
      }
    });
    log(req, 'ROSTER_IMPORT', `students:created=${report.created}:skipped=${report.duplicates.length + report.errors.length}`);
    const status = report.created === 0 ? 400 : report.created === students.length ? 201 : 207;
    res.status(status).json(report);
  });

  // GET /api/students?search=&active=&limit=&offset=
  app.get('/api/students', ...admin, async (req, res) => {
    const search = req.query.search ? v.string(String(req.query.search), 'search', { max: 50 }) : null;
    const limit = req.query.limit ? v.int(Number(req.query.limit), 'limit', { min: 1, max: 200 }) : 50;
    const offset = req.query.offset ? v.int(Number(req.query.offset), 'offset', { min: 0, max: 100000 }) : 0;
    const params = [];
    let where = 'WHERE 1=1';
    if (search) { params.push(likeTerm(search)); where += ` AND (student_number ILIKE $1 OR full_name ILIKE $1 OR email ILIKE $1)`; }
    if (req.query.active === 'true' || req.query.active === 'false') { params.push(req.query.active === 'true'); where += ` AND active = $${params.length}`; }
    const total = (await query(`SELECT count(*)::int AS n FROM students ${where}`, params)).rows[0].n;
    params.push(limit, offset);
    const { rows } = await query(`SELECT * FROM students ${where} ORDER BY student_number LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.status(200).json({ total, items: rows });
  });

  // PATCH /api/students/:id {full_name?, email?, faculty?, active?}  (student_number is permanent)
  app.patch('/api/students/:id', ...admin, async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const b = pick(req.body, ['full_name', 'email', 'faculty', 'active']);
    if (Object.keys(b).length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
    const s = validateStudent(b, { partial: true });
    const { rows } = await query(
      `UPDATE students SET full_name = COALESCE($2, full_name), email = COALESCE($3, email),
              faculty = CASE WHEN $4::boolean THEN $5 ELSE faculty END, active = COALESCE($6, active)
        WHERE student_id = $1 RETURNING *`,
      [id, s.full_name ?? null, s.email ?? null, 'faculty' in b, s.faculty ?? null, s.active ?? null]
    );
    if (!rows[0]) throw nf('STUDENT_NOT_FOUND', 'Student not found');
    log(req, 'STUDENT_UPDATED', `student:${id}:${Object.keys(b).join(',')}`);
    res.status(200).json(rows[0]);
  });

  // DELETE /api/students/:id - refused if the student voted, has an account, or is listed in a non-DRAFT election
  app.delete('/api/students/:id', ...admin, async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const { rows } = await query('SELECT * FROM students WHERE student_id=$1', [id]);
    const s = rows[0];
    if (!s) throw nf('STUDENT_NOT_FOUND', 'Student not found');
    if ((await query('SELECT 1 FROM vote_receipts WHERE student_id=$1 LIMIT 1', [id])).rowCount) throw new AppError(409, 'STUDENT_HAS_VOTED', 'Student has voted; set active=false instead');
    if ((await query('SELECT 1 FROM users WHERE student_number=$1', [s.student_number])).rowCount) throw new AppError(409, 'STUDENT_HAS_ACCOUNT', 'Student has an account; set active=false instead');
    if ((await query(`SELECT 1 FROM eligibility el JOIN elections e ON e.election_id=el.election_id WHERE el.student_id=$1 AND e.status <> 'DRAFT' LIMIT 1`, [id])).rowCount) {
      throw new AppError(409, 'STUDENT_IN_ACTIVE_ELECTION', 'Student is on the list of a scheduled/open election');
    }
    await withTx(async (c) => {
      await c.query('DELETE FROM eligibility WHERE student_id=$1', [id]);
      await c.query('DELETE FROM students WHERE student_id=$1', [id]);
    });
    log(req, 'STUDENT_DELETED', `student:${id}`);
    res.status(204).end();
  });

  // =========================== ELIGIBILITY ====================================================
  // GET /api/elections/:id/eligible-students?search=
  app.get('/api/elections/:id/eligible-students', ...admin, async (req, res) => {
    const e = await getElection(req.params.id);
    const search = req.query.search ? v.string(String(req.query.search), 'search', { max: 50 }) : null;
    const params = [e.election_id];
    let sql = `SELECT s.student_id, s.student_number, s.full_name, s.email, s.faculty, s.active
                 FROM eligibility el JOIN students s ON s.student_id = el.student_id WHERE el.election_id = $1`;
    if (search) { params.push(likeTerm(search)); sql += ' AND (s.student_number ILIKE $2 OR s.full_name ILIKE $2)'; }
    const { rows } = await query(sql + ' ORDER BY s.student_number LIMIT 500', params);
    res.status(200).json({ total: rows.length, items: rows });
  });

  // POST /api/elections/:id/eligible-students {student_ids:[...]} or {all_active:true, faculty?} - bulk add
  app.post('/api/elections/:id/eligible-students', ...admin, async (req, res) => {
    const b = pick(req.body, ['student_ids', 'all_active', 'faculty']);
    const e = await getElection(req.params.id);
    assertOwner(e, req.user);
    assertEligibilityEditable(e);
    let result;
    if (b.all_active === true) {
      const faculty = b.faculty === undefined ? null : v.string(b.faculty, 'faculty', { min: 1, max: 80 });
      result = await query(
        `INSERT INTO eligibility(election_id, student_id)
         SELECT $1, student_id FROM students WHERE active AND ($2::text IS NULL OR faculty = $2)
         ON CONFLICT DO NOTHING`,
        [e.election_id, faculty]
      );
    } else {
      if (!Array.isArray(b.student_ids) || b.student_ids.length === 0 || b.student_ids.length > IMPORT_MAX) {
        throw new AppError(400, 'VALIDATION_ERROR', `Send student_ids (1-${IMPORT_MAX}) or all_active:true`, { field: 'student_ids' });
      }
      const ids = b.student_ids.map((x, i) => v.uuid(x, `student_ids[${i}]`));
      result = await query(
        `INSERT INTO eligibility(election_id, student_id)
         SELECT $1, student_id FROM students WHERE active AND student_id = ANY($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [e.election_id, ids]
      );
    }
    log(req, 'ELIGIBILITY_BULK_ADD', `election:${e.election_id}:added=${result.rowCount}`, e.election_id);
    res.status(200).json({ added: result.rowCount });
  });

  // PUT /api/elections/:id/eligible-students/:studentId - add one (201 new, 200 already listed)
  app.put('/api/elections/:id/eligible-students/:studentId', ...admin, async (req, res) => {
    const e = await getElection(req.params.id);
    const studentId = v.uuid(req.params.studentId, 'studentId');
    assertOwner(e, req.user);
    assertEligibilityEditable(e);
    const { rows } = await query('SELECT active FROM students WHERE student_id=$1', [studentId]);
    if (!rows[0]) throw nf('STUDENT_NOT_FOUND', 'Student not found');
    if (!rows[0].active) throw new AppError(409, 'STUDENT_INACTIVE', 'Inactive students cannot be made eligible');
    const r = await query('INSERT INTO eligibility(election_id, student_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [e.election_id, studentId]);
    if (r.rowCount) log(req, 'ELIGIBILITY_ADDED', `student:${studentId}`, e.election_id);
    res.status(r.rowCount ? 201 : 200).json({ election_id: e.election_id, student_id: studentId, eligible: true });
  });

  // DELETE /api/elections/:id/eligible-students/:studentId
  app.delete('/api/elections/:id/eligible-students/:studentId', ...admin, async (req, res) => {
    const e = await getElection(req.params.id);
    const studentId = v.uuid(req.params.studentId, 'studentId');
    assertOwner(e, req.user);
    assertEligibilityEditable(e);
    const r = await query('DELETE FROM eligibility WHERE election_id=$1 AND student_id=$2', [e.election_id, studentId]);
    if (!r.rowCount) throw nf('NOT_ELIGIBLE', 'Student is not on this election\'s list');
    log(req, 'ELIGIBILITY_REMOVED', `student:${studentId}`, e.election_id);
    res.status(204).end();
  });
};
