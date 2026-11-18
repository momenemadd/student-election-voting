// SERVICE 3 - Results & Audit (owner: Mohamed Khaled)
// Reference endpoints: turnout (counts only) and audit log read (AUDITOR only). Rest is TODO.
const { query } = require('../../shared/db');
const { requireAuth, requireRole } = require('../../shared/auth');
const { v } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const { syncStatus } = require('../../shared/electionState');
const audit = require('../../shared/audit');

module.exports = function register(app) {
  // Turnout = how many voted, NOT who they voted for. Allowed while the election is open.
  app.get('/api/elections/:id/turnout', requireAuth, requireRole('ADMIN', 'AUDITOR'), async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const election = await syncStatus(query, id);
    if (!election) throw new AppError(404, 'ELECTION_NOT_FOUND', 'Election not found');
    const { rows } = await query(
      `SELECT (SELECT count(*) FROM eligibility WHERE election_id = $1)::int AS eligible,
              (SELECT count(*) FROM vote_receipts WHERE election_id = $1)::int AS voted`,
      [id]
    );
    res.status(200).json({ election_id: id, status: election.status, ...rows[0] });
  });

  // Audit logs: AUDITOR only (admins are denied on purpose: separation of duties).
  app.get('/api/audit-logs', requireAuth, requireRole('AUDITOR'), async (req, res) => {
    const pk = req.query.election ? v.uuid(String(req.query.election), 'election') : 'GLOBAL';
    const limit = req.query.limit ? v.int(Number(req.query.limit), 'limit', { min: 1, max: 200 }) : 100;
    res.status(200).json(await audit.list(pk, limit));
  });

  // Recompute the hash chain: proves nothing was edited or deleted.
  app.get('/api/audit-logs/verify', requireAuth, requireRole('AUDITOR'), async (req, res) => {
    const pk = req.query.election ? v.uuid(String(req.query.election), 'election') : 'GLOBAL';
    res.status(200).json(await audit.verifyChain(pk));
  });

  // ---------------------------------------------------------------------------------------
  // TODO (Khaled) - see FINAL_PHASE_PLAN.md section 5.3:
  //  POST /api/elections/:id/tally           status must be CLOSED (409 otherwise); idempotent; GROUP BY on
  //                                          ballot_selections; store result_snapshots (+ sha256, optional S3 upload);
  //                                          move CLOSED -> TALLIED with assertTransition
  //  GET  /api/elections/:id/results         ADMIN/AUDITOR from TALLIED; STUDENT only when PUBLISHED (else 403/409)
  //  POST /api/elections/:id/results/publish ADMIN, TALLIED -> PUBLISHED, audit.recordStrict(...)
  //  GET  /api/elections/:id/results/export  snapshot + hash
  //  GET  /api/monitoring/security-summary   AUDITOR: counts of LOGIN_FAILED / ACCESS_DENIED in the last 24 h
  //  CloudWatch: metric filter on '{ $.status = 403 }' and 'FailedLogins' alarm (infra/setup-all.sh)
};
