// SERVICE 1 - Election Management (owner: Mo'men Mohamed)
// Reference endpoints are implemented so you can copy the pattern. Everything marked TODO is yours.
const { query } = require('../../shared/db');
const { requireAuth, requireRole } = require('../../shared/auth');
const { v, pick } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const audit = require('../../shared/audit');

const MIN_DURATION_MS = 60 * 60 * 1000; // 1 hour

module.exports = function register(app) {
  // POST /api/elections  - Admin only. Business rules: end > start, start in the future, >= 1 hour.
  app.post('/api/elections', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const b = pick(req.body, ['title', 'description', 'start_time', 'end_time']); // whitelist
    const title = v.string(b.title, 'title', { min: 3, max: 120 });
    const description = b.description === undefined ? '' : v.string(b.description, 'description', { min: 0, max: 1000 });
    const start = v.date(b.start_time, 'start_time');
    const end = v.date(b.end_time, 'end_time');
    if (end <= start) throw new AppError(400, 'VALIDATION_ERROR', 'end_time must be after start_time');
    if (end - start < MIN_DURATION_MS) throw new AppError(400, 'VALIDATION_ERROR', 'Voting window must be at least 1 hour');
    if (start <= new Date()) throw new AppError(400, 'VALIDATION_ERROR', 'start_time must be in the future');

    const { rows } = await query(
      `INSERT INTO elections(title, description, start_time, end_time, status, created_by)
       VALUES($1,$2,$3,$4,'DRAFT',$5) RETURNING *`,
      [title, description, start.toISOString(), end.toISOString(), req.user.id] // created_by from token, never from body
    );
    audit.record({ actor_id: req.user.id, role: req.user.role, action: 'ELECTION_CREATED', resource: `election:${rows[0].election_id}`, election_id: rows[0].election_id });
    res.status(201).json(rows[0]);
  });

  // GET /api/elections - Admin/Auditor see all; Student sees only elections they are eligible for.
  app.get('/api/elections', requireAuth, async (req, res) => {
    const status = req.query.status ? v.string(String(req.query.status), 'status', { max: 20 }) : null;
    let sql, params;
    if (req.user.role === 'STUDENT') {
      sql = `SELECT e.election_id, e.title, e.description, e.start_time, e.end_time, e.status
               FROM elections e
               JOIN eligibility el ON el.election_id = e.election_id
               JOIN students s ON s.student_id = el.student_id
              WHERE s.student_number = $1 AND e.status <> 'DRAFT' AND e.status <> 'CANCELLED'`;
      params = [req.user.studentNumber];
    } else {
      sql = 'SELECT * FROM elections e WHERE 1=1';
      params = [];
    }
    if (status) { params.push(status); sql += ` AND e.status = $${params.length}`; }
    sql += ' ORDER BY e.start_time DESC LIMIT 100';
    const { rows } = await query(sql, params);
    res.status(200).json(rows);
  });

  // ---------------------------------------------------------------------------------------
  // TODO (Mo'men) - see FINAL_PHASE_PLAN.md section 5.1 for the full table (validation + status codes):
  //  GET    /api/elections/:id                      (call syncStatus from shared/electionState first)
  //  PATCH  /api/elections/:id                      creator only, canEditDetails(status) else 409
  //  DELETE /api/elections/:id                      DRAFT only
  //  POST   /api/elections/:id/transition           {to, reason}: schedule | cancel | close-early; use assertTransition + readiness
  //  GET    /api/elections/:id/readiness            >=1 position, each position >=2 candidates, >=1 eligible student
  //  POST/GET /api/elections/:id/positions ; PATCH/DELETE /api/positions/:id     (canEditSetup)
  //  POST   /api/positions/:id/candidates ; PATCH/DELETE /api/candidates/:id     409 if not DRAFT or ballots exist
  //  POST   /api/students ; POST /api/students/import ; GET /api/students?search= ; PATCH/DELETE /api/students/:id
  //  PUT/DELETE /api/elections/:id/eligible-students/:studentId ; GET .../eligible-students
  // Every state-changing route: requireAuth + requireRole('ADMIN') + ownership (created_by) + audit.record(...)
};
