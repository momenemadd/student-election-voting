// SERVICE 3 - Results & Audit (owner: Mohamed Khaled)
const { query, withTx } = require('../../shared/db');
const { requireAuth, requireRole } = require('../../shared/auth');
const { v } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const { syncStatus, assertTransition } = require('../../shared/electionState');
const audit = require('../../shared/audit');
const { canonicalStringify, sha256, buildResult } = require('./tally');
const snapshots = require('./snapshots');

const SECURITY_ACTIONS = ['LOGIN_FAILED', 'LOGIN_LOCKED', 'ACCESS_DENIED', 'RATE_LIMITED', 'EMAIL_CODE_FAILED'];
const COUNTED = ['TALLIED', 'PUBLISHED'];

const notFound = () => new AppError(404, 'ELECTION_NOT_FOUND', 'Election not found');

async function getElection(rawId) {
  const id = v.uuid(rawId, 'id');
  const election = await syncStatus(query, id);
  if (!election) throw notFound();
  return election;
}

// Count per candidate (LEFT JOIN so 0-vote candidates appear). Only totals are read: never who voted for what.
async function computeResult(election, talliedAt) {
  const id = election.election_id;
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
  return buildResult(election, turnout, rows, talliedAt);
}

async function loadSnapshot(electionId, status) {
  const { rows } = await query(
    `SELECT result_json, sha256, tallied_at, published_at FROM result_snapshots WHERE election_id = $1`,
    [electionId]
  );
  if (!rows[0]) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
  const s = rows[0];
  return { status, sha256: s.sha256, tallied_at: s.tallied_at, published_at: s.published_at, result: s.result_json };
}

module.exports = function register(app) {
  // Turnout = how many voted, NOT who they voted for. Allowed while the election is open.
  app.get('/api/elections/:id/turnout', requireAuth, requireRole('ADMIN', 'AUDITOR'), async (req, res) => {
    const election = await getElection(req.params.id);
    const { rows } = await query(
      `SELECT (SELECT count(*) FROM eligibility WHERE election_id = $1)::int AS eligible,
              (SELECT count(*) FROM vote_receipts WHERE election_id = $1)::int AS voted`,
      [election.election_id]
    );
    res.status(200).json({ election_id: election.election_id, status: election.status, ...rows[0] });
  });

  // R6 - Audit logs: AUDITOR only (admins are denied on purpose: separation of duties). Optional filters.
  app.get('/api/audit-logs', requireAuth, requireRole('AUDITOR'), async (req, res) => {
    const pk = req.query.election ? v.uuid(String(req.query.election), 'election') : 'GLOBAL';
    const limit = req.query.limit ? v.int(Number(req.query.limit), 'limit', { min: 1, max: 500 }) : 100;
    const action = req.query.action ? v.string(String(req.query.action), 'action', { min: 1, max: 40 }) : null;
    const from = req.query.from ? v.date(String(req.query.from), 'from') : null;
    const to = req.query.to ? v.date(String(req.query.to), 'to') : null;
    const filtered = !!(action || from || to);
    let items = await audit.list(pk, filtered ? 500 : limit);
    if (action) items = items.filter((r) => r.action === action);
    if (from) items = items.filter((r) => new Date(r.ts) >= from);
    if (to) items = items.filter((r) => new Date(r.ts) <= to);
    res.status(200).json(items.slice(0, limit));
  });

  // Recompute the hash chain: proves nothing was edited or deleted.
  app.get('/api/audit-logs/verify', requireAuth, requireRole('AUDITOR'), async (req, res) => {
    const pk = req.query.election ? v.uuid(String(req.query.election), 'election') : 'GLOBAL';
    res.status(200).json(await audit.verifyChain(pk));
  });

  // R1 - Count votes. ADMIN only; election must be CLOSED; safe to call twice (returns the saved result).
  app.post('/api/elections/:id/tally', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const election = await getElection(req.params.id);
    const id = election.election_id;
    if (COUNTED.includes(election.status)) return res.status(200).json(await loadSnapshot(id, election.status));
    if (election.status !== 'CLOSED') throw new AppError(409, 'NOT_CLOSED', 'Voting must be closed before counting');

    // Integrity check: every vote receipt must have exactly one ballot.
    const { rows: [chk] } = await query(
      `SELECT (SELECT count(*) FROM ballots WHERE election_id = $1)::int AS ballots,
              (SELECT count(*) FROM vote_receipts WHERE election_id = $1)::int AS receipts`,
      [id]
    );
    if (chk.ballots !== chk.receipts) {
      await audit.recordStrict({
        actor_id: req.user.id, role: req.user.role, action: 'INTEGRITY_MISMATCH',
        resource: `election:${id}:ballots=${chk.ballots}:receipts=${chk.receipts}`, outcome: 'FAILED', election_id: id,
      });
      throw new AppError(409, 'INTEGRITY_MISMATCH', 'Number of ballots does not match number of vote receipts');
    }

    const result = await computeResult(election, new Date());
    const text = canonicalStringify(result);
    const hash = sha256(text);

    await withTx(async (client) => {
      await client.query(
        `INSERT INTO result_snapshots (election_id, result_json, sha256) VALUES ($1, $2::jsonb, $3) ON CONFLICT DO NOTHING`,
        [id, text, hash]
      );
      const upd = await client.query(
        `UPDATE elections SET status = 'TALLIED', updated_at = now() WHERE election_id = $1 AND status = 'CLOSED'`, [id]
      );
      if (upd.rowCount === 0) throw new AppError(409, 'INVALID_TRANSITION', 'Election is no longer CLOSED');
    });

    if (snapshots.enabled()) await snapshots.put(id, text);   // second copy in S3 (snapshots/<id>.json)

    await audit.recordStrict({
      actor_id: req.user.id, role: req.user.role, action: 'RESULTS_TALLIED',
      resource: `election:${id}:sha256=${hash.slice(0, 12)}`, outcome: 'OK', election_id: id,
    });
    res.status(200).json(await loadSnapshot(id, 'TALLIED'));
  });

  // R2 - Show results. ADMIN/AUDITOR once counted; STUDENT only if on the list AND published.
  app.get('/api/elections/:id/results', requireAuth, requireRole('ADMIN', 'AUDITOR', 'STUDENT'), async (req, res) => {
    const election = await getElection(req.params.id);
    const id = election.election_id;
    if (req.user.role === 'STUDENT') {
      const { rowCount } = await query(
        `SELECT 1 FROM eligibility e JOIN students s ON s.student_id = e.student_id
          WHERE e.election_id = $1 AND s.student_number = $2`,
        [id, req.user.studentNumber]
      );
      if (!rowCount) throw notFound();   // not on the list: do not reveal that the election exists
      if (election.status !== 'PUBLISHED') {
        audit.record({ actor_id: req.user.id, role: req.user.role, action: 'ACCESS_DENIED',
          resource: `election:${id}:results-not-published`, outcome: 'DENIED', election_id: id });
        throw new AppError(403, 'RESULTS_NOT_PUBLISHED', 'Results have not been published yet');
      }
    } else if (!COUNTED.includes(election.status)) {
      throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
    }
    res.status(200).json(await loadSnapshot(id, election.status));
  });

  // R3 - Publish. ADMIN only, TALLIED -> PUBLISHED, one transaction, strict audit.
  app.post('/api/elections/:id/results/publish', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const election = await getElection(req.params.id);
    const id = election.election_id;
    assertTransition(election.status, 'PUBLISHED');
    await withTx(async (client) => {
      const upd = await client.query(
        `UPDATE elections SET status = 'PUBLISHED', updated_at = now() WHERE election_id = $1 AND status = 'TALLIED'`, [id]
      );
      if (upd.rowCount === 0) throw new AppError(409, 'INVALID_TRANSITION', 'Election is not TALLIED');
      await client.query(
        `UPDATE result_snapshots SET published_at = now(), published_by = $2 WHERE election_id = $1`, [id, req.user.id]
      );
    });
    await audit.recordStrict({
      actor_id: req.user.id, role: req.user.role, action: 'RESULTS_PUBLISHED',
      resource: `election:${id}`, outcome: 'OK', election_id: id,
    });
    res.status(200).json(await loadSnapshot(id, 'PUBLISHED'));
  });

  // R4 - Download + hash check. Reads S3 (or the database copy locally), re-calculates SHA-256, compares.
  app.get('/api/elections/:id/results/export', requireAuth, requireRole('ADMIN', 'AUDITOR'), async (req, res) => {
    const election = await getElection(req.params.id);
    const id = election.election_id;
    if (!COUNTED.includes(election.status)) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
    const { rows: [snap] } = await query(`SELECT result_json, sha256 FROM result_snapshots WHERE election_id = $1`, [id]);
    if (!snap) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');

    const text = snapshots.enabled() ? await snapshots.get(id) : canonicalStringify(snap.result_json);
    if (sha256(text) !== snap.sha256) {
      await audit.recordStrict({
        actor_id: req.user.id, role: req.user.role, action: 'SNAPSHOT_TAMPERED',
        resource: `election:${id}:stored=${snap.sha256.slice(0, 12)}`, outcome: 'FAILED', election_id: id,
      });
      throw new AppError(500, 'SNAPSHOT_TAMPERED', 'Saved results do not match their hash');
    }
    await audit.recordStrict({
      actor_id: req.user.id, role: req.user.role, action: 'RESULTS_EXPORTED',
      resource: `election:${id}:sha256=${snap.sha256.slice(0, 12)}`, outcome: 'OK', election_id: id,
    });
    res.status(200);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="results-${id}.json"`);
    res.send(text);
  });

  // R7 (extra) - Recount: recompute the tally from the ballots and compare with the stored hash.
  app.get('/api/elections/:id/results/verify', requireAuth, requireRole('ADMIN', 'AUDITOR'), async (req, res) => {
    const election = await getElection(req.params.id);
    const id = election.election_id;
    if (!COUNTED.includes(election.status)) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
    const { rows: [snap] } = await query(`SELECT result_json, sha256 FROM result_snapshots WHERE election_id = $1`, [id]);
    if (!snap) throw new AppError(409, 'NOT_COUNTED', 'Votes have not been counted yet');
    const stored = snap.result_json;
    const recomputed = await computeResult({ election_id: id, title: stored.title }, new Date(stored.tallied_at));
    const recomputedHash = sha256(canonicalStringify(recomputed));
    const match = recomputedHash === snap.sha256;
    if (!match) {
      await audit.recordStrict({
        actor_id: req.user.id, role: req.user.role, action: 'INTEGRITY_MISMATCH',
        resource: `election:${id}:recount-differs`, outcome: 'FAILED', election_id: id,
      });
    }
    res.status(200).json({
      match, stored_sha256: snap.sha256, recomputed_sha256: recomputedHash,
      snapshot_intact: sha256(canonicalStringify(stored)) === snap.sha256,
    });
  });

  // R5 - Security summary for the auditor (suspicious activity in the last N hours).
  app.get('/api/monitoring/security-summary', requireAuth, requireRole('AUDITOR'), async (req, res) => {
    const hours = req.query.hours ? v.int(Number(req.query.hours), 'hours', { min: 1, max: 168 }) : 24;
    const since = Date.now() - hours * 3600e3;
    const items = (await audit.list('GLOBAL', 500)).filter((r) => new Date(r.ts).getTime() >= since);
    const counts = Object.fromEntries(SECURITY_ACTIONS.map((a) => [a, 0]));
    const denied = new Map();
    for (const r of items) {
      if (r.action in counts) counts[r.action] += 1;
      if (r.action === 'ACCESS_DENIED') denied.set(r.resource, (denied.get(r.resource) || 0) + 1);
    }
    const top_denied = [...denied.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([resource, count]) => ({ resource, count }));
    res.status(200).json({ hours, counts, top_denied });
  });
};