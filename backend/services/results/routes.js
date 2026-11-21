// SERVICE 3 - Results & Audit (owner: Mohamed Khaled)
const { query, withTx } = require('../../shared/db');
const { requireAuth, requireRole } = require('../../shared/auth');
const { v } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const { syncStatus } = require('../../shared/electionState');
const audit = require('../../shared/audit');
const { canonicalStringify, sha256, buildResult } = require('./tally');

module.exports = function register(app) {

    // Read the saved result (used by tally and, later, by the results endpoint).
  async function loadSnapshot(electionId, status) {
    const { rows } = await query(
      `SELECT result_json, sha256, tallied_at, published_at FROM result_snapshots WHERE election_id = $1`,
      [electionId]
    );
    if (!rows[0]) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
    const s = rows[0];
    return { status, sha256: s.sha256, tallied_at: s.tallied_at, published_at: s.published_at, result: s.result_json };
  }

  // R1 - Count votes. ADMIN only; election must be CLOSED; safe to call twice (returns saved result).
  app.post('/api/elections/:id/tally', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const election = await syncStatus(query, id);
    if (!election) throw new AppError(404, 'ELECTION_NOT_FOUND', 'Election not found');
    if (election.status === 'TALLIED' || election.status === 'PUBLISHED') {
      return res.status(200).json(await loadSnapshot(id, election.status));
    }
    if (election.status !== 'CLOSED') {
      throw new AppError(409, 'NOT_CLOSED', 'Voting must be closed before counting');
    }

    // Integrity check: every vote receipt must have exactly one ballot.
    const { rows: [chk] } = await query(
      `SELECT (SELECT count(*) FROM ballots WHERE election_id = $1)::int AS ballots,
              (SELECT count(*) FROM vote_receipts WHERE election_id = $1)::int AS receipts`,
      [id]
    );
    if (chk.ballots !== chk.receipts) {
      await audit.recordStrict({
        actor_id: req.user.id, role: req.user.role, action: 'INTEGRITY_MISMATCH',
        resource: `election:${id}:ballots=${chk.ballots}:receipts=${chk.receipts}`,
        outcome: 'FAILURE', election_id: id,
      });
      throw new AppError(409, 'INTEGRITY_MISMATCH', 'Number of ballots does not match number of vote receipts');
    }

    // Count per candidate (LEFT JOIN so candidates with 0 votes appear). Only totals are read.
    const { rows } = await query(
      `SELECT p.position_id, p.title AS position_title, p.max_selections,
              c.candidate_id, c.name, count(bs.ballot_id)::int AS votes
         FROM candidates c
         JOIN positions p ON p.position_id = c.position_id
         LEFT JOIN ballot_selections bs ON bs.candidate_id = c.candidate_id
        WHERE p.election_id = $1
        GROUP BY p.position_id, p.title, p.max_selections, c.candidate_id, c.name
        ORDER BY p.title, c.name`,
      [id]
    );
    const { rows: [turnout] } = await query(
      `SELECT (SELECT count(*) FROM eligibility WHERE election_id = $1)::int AS eligible,
              (SELECT count(*) FROM vote_receipts WHERE election_id = $1)::int AS voted`,
      [id]
    );

    const result = buildResult(election, turnout, rows, new Date());
    const text = canonicalStringify(result);
    const hash = sha256(text);

    await withTx(async (client) => {
      await client.query(
        `INSERT INTO result_snapshots (election_id, result_json, sha256)
         VALUES ($1, $2::jsonb, $3) ON CONFLICT DO NOTHING`,
        [id, text, hash]
      );
      const upd = await client.query(
        `UPDATE elections SET status = 'TALLIED', updated_at = now()
          WHERE election_id = $1 AND status = 'CLOSED'`,
        [id]
      );
      if (upd.rowCount === 0) throw new AppError(409, 'INVALID_TRANSITION', 'Election is no longer CLOSED');
    });

    // TODO step 4: upload `text` to S3 (snapshots/<id>.json) when RESULTS_BUCKET is set.

    await audit.recordStrict({
      actor_id: req.user.id, role: req.user.role, action: 'RESULTS_TALLIED',
      resource: `election:${id}:sha256=${hash.slice(0, 12)}`,
      outcome: 'SUCCESS', election_id: id,
    });
    res.status(200).json(await loadSnapshot(id, 'TALLIED'));
  });

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
