// SERVICE 2 - Voter Access & Voting (owner: Mohamed Osama)
// Business capability: a student on the roster registers, proves their e-mail, signs in, sees the
// elections they may vote in, votes ONCE and SECRETLY, and gets a receipt.
// Rules enforced here (not only in the UI):
//   * only students on the roster (number + matching roster e-mail, active) can register
//   * e-mail ownership is proved with a 6-digit code (10 min, max 5 tries, only its SHA-256 is stored)
//   * login/register/code/vote requests are rate limited (DynamoDB RateLimits on Floci)
//   * the student's identity comes ONLY from the token (req.user.studentNumber), never from the body
//   * a vote is accepted only while the election is OPEN, from an eligible student, once (primary key)
//   * vote_receipts (WHO voted) and ballots/ballot_selections (WHAT was chosen) are never linked
const crypto = require('crypto');
const { query, withTx } = require('../../shared/db');
const { requireAuth, requireRole, hashPassword, verifyPassword, dummyCompare, signToken } = require('../../shared/auth');
const { v, pick } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const { verifyTurnstile } = require('../../shared/turnstile');
const { syncStatus, DUE, NEXT } = require('../../shared/electionState');
const audit = require('../../shared/audit');
const { log } = require('../../shared/logger');
const { limit } = require('./rateLimit');
const { sendMail } = require('./mail');

const STUDENT_NUMBER = /^[A-Za-z0-9]{4,12}$/;
const OTP_MINUTES = 10;
const OTP_MAX_TRIES = 5;
const student = [requireAuth, requireRole('STUDENT')];

// ---------- helpers ---------------------------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // 000000-999999, crypto RNG
const sameHash = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const codeMail = (code) =>
  `Your Student Election verification code is: ${code}\n\nIt expires in ${OTP_MINUTES} minutes. If you did not create an account, ignore this e-mail.`;

// The student row behind the logged-in user (identity from the token only).
async function me(req) {
  const { rows } = await query('SELECT student_id FROM students WHERE student_number = $1 AND active', [req.user.studentNumber]);
  if (!rows[0]) throw new AppError(403, 'NOT_ON_ROSTER', 'Your student record is not active');
  return rows[0].student_id;
}

// Eligibility + "already voted?" in one query. Students never see DRAFT/CANCELLED elections.
async function myStatusIn(election, studentNumber) {
  if (!election || election.status === 'DRAFT' || election.status === 'CANCELLED') return null;
  const { rows } = await query(
    `SELECT s.student_id,
            EXISTS (SELECT 1 FROM vote_receipts r WHERE r.election_id = el.election_id AND r.student_id = s.student_id) AS has_voted
       FROM eligibility el JOIN students s ON s.student_id = el.student_id
      WHERE el.election_id = $1 AND s.student_number = $2`,
    [election.election_id, studentNumber]
  );
  return rows[0] || null;
}

const notFound = () => new AppError(404, 'ELECTION_NOT_FOUND', 'Election not found');
const notOpen = (status) => new AppError(409, 'ELECTION_NOT_OPEN', `Voting is not open for this election (it is ${status})`);
const alreadyVoted = () => new AppError(409, 'ALREADY_VOTED', 'You have already voted in this election');

module.exports = function register(app) {
  // =========================== ACCOUNT ========================================================
  app.post('/api/auth/login', async (req, res) => {
    const b = pick(req.body, ['email', 'password', 'turnstileToken']);
    const email = v.email(b.email);
    // Counted per address AND e-mail: on Floci every request arrives from 127.0.0.1, so a per-address
    // limit alone would block everyone at once. Per account the lockout below still applies.
    await limit('login', `${req.ip}:${email}`);
    const password = v.string(b.password, 'password', { min: 1, max: 200 });
    await verifyTurnstile(b.turnstileToken, req.ip);

    const { rows } = await query(
      'SELECT user_id, role, password_hash, token_version, email_verified, failed_logins, locked_until FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    const fail = (action) => audit.record({ actor_id: user ? user.user_id : 'unknown', role: user ? user.role : 'NONE', action, resource: 'auth:login', outcome: 'FAILED' });

    if (user && user.locked_until && user.locked_until > new Date()) {
      fail('LOGIN_LOCKED');
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    const ok = user ? await verifyPassword(password, user.password_hash) : (await dummyCompare(password), false);
    if (!ok) {
      if (user) {
        // 5th failure locks for 15 minutes and resets the counter.
        await query(
          `UPDATE users SET
             failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END,
             locked_until  = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE user_id = $1`,
          [user.user_id]
        );
      }
      fail('LOGIN_FAILED');
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'); // same message for unknown user / wrong password
    }
    if (!user.email_verified) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email first');

    if (user.failed_logins > 0 || user.locked_until) { // skip the extra database trip when nothing to reset
      await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [user.user_id]);
    }
    audit.record({ actor_id: user.user_id, role: user.role, action: 'LOGIN_OK', resource: 'auth:login' });
    res.status(200).json({ token: await signToken(user), user: { id: user.user_id, role: user.role } });
  });

  app.get('/api/me', requireAuth, (req, res) => res.status(200).json({ id: req.user.id, role: req.user.role }));

  // Logout = bump token_version: every token issued before now stops working.
  app.post('/api/auth/logout', requireAuth, async (req, res) => {
    await query('UPDATE users SET token_version = token_version + 1 WHERE user_id = $1', [req.user.id]);
    audit.record({ actor_id: req.user.id, role: req.user.role, action: 'LOGOUT', resource: 'auth:logout' });
    res.status(204).end();
  });

  // V1 POST /api/auth/register - only students on the roster, with their roster e-mail.
  // Role is always STUDENT (never from the body); the account stays unverified until the code is entered.
  app.post('/api/auth/register', async (req, res) => {
    await limit('register', req.ip);
    const b = pick(req.body, ['student_number', 'email', 'password', 'turnstileToken']); // whitelist (no role!)
    const studentNumber = v.string(b.student_number, 'student_number', { min: 4, max: 12 });
    if (!STUDENT_NUMBER.test(studentNumber)) throw new AppError(400, 'VALIDATION_ERROR', 'student_number must be 4-12 letters/digits', { field: 'student_number' });
    const email = v.email(b.email);
    const password = v.string(b.password, 'password', { min: 12, max: 200 });
    await verifyTurnstile(b.turnstileToken, req.ip);

    const { rows: [onRoster] } = await query('SELECT email FROM students WHERE student_number = $1 AND active', [studentNumber]);
    if (!onRoster || onRoster.email.toLowerCase() !== email) {
      audit.record({ actor_id: 'unknown', role: 'NONE', action: 'REGISTER', resource: 'auth:register:not-on-roster', outcome: 'DENIED' });
      // same answer for "unknown number" and "wrong e-mail": does not reveal which numbers exist
      throw new AppError(403, 'NOT_ON_ROSTER', 'Student number and email do not match the student list');
    }

    const taken = await query('SELECT 1 FROM users WHERE email = $1 OR student_number = $2', [email, studentNumber]);
    if (taken.rowCount) throw new AppError(409, 'ALREADY_REGISTERED', 'An account already exists for this student');

    const code = newCode();
    const passwordHash = await hashPassword(password);
    const { rows: [user] } = await query(
      `INSERT INTO users(student_number, email, password_hash, role, email_verified, otp_hash, otp_expires_at, otp_tries)
       VALUES($1, $2, $3, 'STUDENT', false, $4, now() + make_interval(mins => $5), 0)
       RETURNING user_id`,
      [studentNumber, email, passwordHash, sha256(code), OTP_MINUTES]
    ).catch((e) => {
      // two registrations at the same moment: the UNIQUE constraints decide, the loser gets 409
      if (e.code === '23505') throw new AppError(409, 'ALREADY_REGISTERED', 'An account already exists for this student');
      throw e;
    });
    audit.record({ actor_id: user.user_id, role: 'STUDENT', action: 'REGISTER', resource: 'auth:register' });

    await sendMail(email, 'Your verification code', codeMail(code)); // 503 if the mail service is down -> use resend
    res.status(201).json({ message: 'Account created. We sent a 6-digit code to your email.', email });
  });

  // V2 POST /api/auth/verify-email - 6-digit code, 10 minutes, at most 5 tries.
  app.post('/api/auth/verify-email', async (req, res) => {
    const b = pick(req.body, ['email', 'code']);
    const email = v.email(b.email);
    if (typeof b.code !== 'string' || !/^\d{6}$/.test(b.code)) throw new AppError(400, 'VALIDATION_ERROR', 'code must be exactly 6 digits', { field: 'code' });

    // Count the try FIRST and atomically: parallel guesses cannot get more than 5 tries in total.
    const { rows: [u] } = await query(
      `UPDATE users SET otp_tries = otp_tries + 1
        WHERE email = $1 AND NOT email_verified AND otp_hash IS NOT NULL AND otp_tries < $2
        RETURNING user_id, otp_hash, otp_expires_at < now() AS expired`,
      [email, OTP_MAX_TRIES]
    );
    if (!u) {
      const { rows: [x] } = await query('SELECT otp_tries FROM users WHERE email = $1 AND NOT email_verified AND otp_hash IS NOT NULL', [email]);
      if (x) throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many wrong codes. Ask for a new code.');
      throw new AppError(401, 'INVALID_CODE', 'The code is not correct'); // unknown or already verified: same answer
    }
    const fail = (resource) => audit.record({ actor_id: u.user_id, role: 'STUDENT', action: 'EMAIL_CODE_FAILED', resource, outcome: 'FAILED' });
    if (u.expired) {
      fail('auth:verify-email:expired');
      throw new AppError(401, 'CODE_EXPIRED', 'The code has expired. Ask for a new code.');
    }
    if (!sameHash(sha256(b.code), u.otp_hash)) {
      fail('auth:verify-email');
      throw new AppError(401, 'INVALID_CODE', 'The code is not correct');
    }
    await query(
      'UPDATE users SET email_verified = true, otp_hash = NULL, otp_expires_at = NULL, otp_tries = 0 WHERE user_id = $1',
      [u.user_id]
    );
    audit.record({ actor_id: u.user_id, role: 'STUDENT', action: 'EMAIL_VERIFIED', resource: 'auth:verify-email' });
    res.status(200).json({ message: 'Email verified. You can sign in now.' });
  });

  // V3 POST /api/auth/resend-code - always 200, so it does not reveal which e-mails have accounts.
  app.post('/api/auth/resend-code', async (req, res) => {
    const b = pick(req.body, ['email']);
    const email = v.email(b.email);
    await limit('otp', email);
    const code = newCode();
    const { rowCount } = await query(
      `UPDATE users SET otp_hash = $2, otp_expires_at = now() + make_interval(mins => $3), otp_tries = 0
        WHERE email = $1 AND NOT email_verified`,
      [email, sha256(code), OTP_MINUTES]
    );
    if (rowCount) {
      await sendMail(email, 'Your new verification code', codeMail(code))
        .catch((e) => log('error', { event: 'resend_code_failed', code: e.code })); // still 200 (no account enumeration)
    }
    res.status(200).json({ message: 'If an unverified account exists for this email, a new code was sent.' });
  });

  // =========================== VOTING =========================================================
  // V4 GET /api/me/elections - only elections I am eligible for (not DRAFT/CANCELLED) + has_voted.
  // ONE round trip: time-based OPEN/CLOSED changes are applied in the same statement (like syncStatus).
  app.get('/api/me/elections', ...student, async (req, res) => {
    const { rows } = await query(
      `WITH mine AS (
         SELECT el.election_id, s.student_id FROM eligibility el JOIN students s ON s.student_id = el.student_id
          WHERE s.student_number = $1),
       u AS (
         UPDATE elections SET status = ${NEXT}, updated_at = now()
          WHERE ${DUE} AND election_id IN (SELECT election_id FROM mine)
          RETURNING election_id, status)
       SELECT e.election_id, e.title, e.description, e.start_time, e.end_time,
              COALESCE(u.status, e.status) AS status,
              EXISTS (SELECT 1 FROM vote_receipts r WHERE r.election_id = e.election_id AND r.student_id = m.student_id) AS has_voted
         FROM mine m JOIN elections e ON e.election_id = m.election_id
         LEFT JOIN u ON u.election_id = e.election_id
        WHERE COALESCE(u.status, e.status) NOT IN ('DRAFT', 'CANCELLED')
        ORDER BY e.start_time DESC`,
      [req.user.studentNumber]
    );
    res.status(200).json(rows);
  });

  // V5 GET /api/elections/:id/ballot - positions + candidates of an OPEN election I may vote in. No counts.
  app.get('/api/elections/:id/ballot', ...student, async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const election = await syncStatus(query, id);
    const mine = await myStatusIn(election, req.user.studentNumber);
    if (!mine) throw notFound(); // not on my list: same answer as "does not exist" (no information leak)
    if (election.status !== 'OPEN') throw notOpen(election.status);
    if (mine.has_voted) throw alreadyVoted();

    const { rows: positions } = await query(
      `SELECT p.position_id, p.title, p.max_selections,
              COALESCE(json_agg(json_build_object('candidate_id', c.candidate_id, 'name', c.name, 'manifesto', c.manifesto)
                                ORDER BY c.name) FILTER (WHERE c.candidate_id IS NOT NULL), '[]'::json) AS candidates
         FROM positions p LEFT JOIN candidates c ON c.position_id = p.position_id
        WHERE p.election_id = $1
        GROUP BY p.position_id ORDER BY p.title`,
      [id]
    );
    const { election_id, title, description, end_time } = election;
    res.status(200).json({ election_id, title, description, end_time, positions });
  });

  // V6 POST /api/elections/:id/votes - THE critical endpoint.
  app.post('/api/elections/:id/votes', ...student, async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    await limit('vote', req.user.id);
    const b = pick(req.body, ['selections', 'turnstileToken']);
    await verifyTurnstile(b.turnstileToken, req.ip);

    const reject = (reason, err) => {
      audit.record({ actor_id: req.user.id, role: req.user.role, action: 'VOTE_REJECTED', resource: `vote:${reason}`, outcome: 'DENIED', election_id: id });
      return err;
    };
    const bad = (message) => reject('invalid-ballot', new AppError(400, 'VALIDATION_ERROR', message, { field: 'selections' }));

    // 1) shape of the ballot
    if (!Array.isArray(b.selections) || b.selections.length < 1 || b.selections.length > 100) throw bad('selections must be a non-empty list');
    const selections = b.selections.map((s) => {
      const x = pick(s, ['position_id', 'candidate_id']);
      return { position_id: v.uuid(x.position_id, 'position_id'), candidate_id: v.uuid(x.candidate_id, 'candidate_id') };
    });

    // 2) who am I (from the token ONLY) and may I vote here?
    const studentId = await me(req);
    const election = await syncStatus(query, id); // applies automatic OPEN/CLOSED first
    const mine = await myStatusIn(election, req.user.studentNumber);
    if (!mine) throw reject('not-eligible', notFound());
    if (election.status !== 'OPEN') throw reject('not-open', notOpen(election.status));
    if (mine.has_voted) throw reject('already-voted', alreadyVoted());

    // 3) ballot content against THIS election's positions and candidates
    const { rows: positions } = await query(
      `SELECT p.position_id, p.title, p.max_selections, array_remove(array_agg(c.candidate_id), NULL) AS candidates
         FROM positions p LEFT JOIN candidates c ON c.position_id = p.position_id
        WHERE p.election_id = $1 GROUP BY p.position_id`,
      [id]
    );
    const byPosition = new Map(positions.map((p) => [p.position_id, { ...p, chosen: 0 }]));
    const seen = new Set();
    for (const s of selections) {
      const p = byPosition.get(s.position_id);
      if (!p) throw bad('A selection is for a position that is not in this election');
      if (!p.candidates.includes(s.candidate_id)) throw bad(`A candidate does not belong to the position "${p.title}"`);
      if (seen.has(s.candidate_id)) throw bad('The same candidate was chosen twice');
      seen.add(s.candidate_id);
      p.chosen += 1;
    }
    for (const p of byPosition.values()) {
      if (p.chosen < 1) throw bad(`Choose at least one candidate for "${p.title}"`);
      if (p.chosen > p.max_selections) throw bad(`Choose at most ${p.max_selections} for "${p.title}"`);
    }

    // 4) one transaction: re-check, receipt (WHO), ballot (WHAT) - all or nothing
    const receiptCode = crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{4}/g).join('-'); // e.g. 9F2C-...
    await withTx(async (client) => {
      // FOR SHARE: an admin closing the election at this moment waits until this vote has committed
      const open = await client.query(
        `SELECT 1 FROM elections WHERE election_id = $1 AND status = 'OPEN' AND now() >= start_time AND now() < end_time FOR SHARE`,
        [id]
      );
      if (!open.rowCount) throw reject('not-open', notOpen('not open'));
      const eligible = await client.query('SELECT 1 FROM eligibility WHERE election_id = $1 AND student_id = $2', [id, studentId]);
      if (!eligible.rowCount) throw reject('not-eligible', notFound());

      // The primary key (election_id, student_id) makes a second vote impossible - even 20 at the same moment.
      await client.query(
        'INSERT INTO vote_receipts(election_id, student_id, receipt_hash) VALUES($1, $2, $3)',
        [id, studentId, sha256(receiptCode)]
      ).catch((e) => {
        if (e.code === '23505') throw reject('already-voted', alreadyVoted());
        throw e;
      });

      // The ballot has NO student and NO time: nothing links it to the receipt above.
      const { rows: [ballot] } = await client.query('INSERT INTO ballots(election_id) VALUES($1) RETURNING ballot_id', [id]);
      for (const s of selections) {
        await client.query(
          'INSERT INTO ballot_selections(ballot_id, position_id, candidate_id) VALUES($1, $2, $3)',
          [ballot.ballot_id, s.position_id, s.candidate_id]
        );
      }
    });

    // 5) after COMMIT: audit (no choices!) and receipt e-mail (no choices!)
    audit.record({ actor_id: req.user.id, role: req.user.role, action: 'VOTE_CAST', resource: `election:${id}`, election_id: id });
    const { rows: [u] } = await query('SELECT email FROM users WHERE user_id = $1', [req.user.id]);
    await sendMail(
      u.email,
      `Vote receipt: ${election.title}`,
      `Your vote in "${election.title}" was recorded.\n\nReceipt code: ${receiptCode}\n\nKeep this code. It proves your vote was counted; it does not show who you voted for.`
    ).catch((e) => log('error', { event: 'receipt_email_failed', code: e.code })); // the vote is already safely stored

    res.status(201).json({ receipt_code: receiptCode });
  });

  // V7 GET /api/elections/:id/receipt - my own receipt only (ownership from the token).
  app.get('/api/elections/:id/receipt', ...student, async (req, res) => {
    const id = v.uuid(req.params.id, 'id');
    const { rows } = await query(
      `SELECT r.election_id, e.title, r.voted_on::text AS voted_on, left(r.receipt_hash, 8) AS receipt_ref
         FROM vote_receipts r
         JOIN students s ON s.student_id = r.student_id
         JOIN elections e ON e.election_id = r.election_id
        WHERE r.election_id = $1 AND s.student_number = $2`,
      [id, req.user.studentNumber]
    );
    if (!rows[0]) throw new AppError(404, 'RECEIPT_NOT_FOUND', 'No vote receipt found for this election');
    res.status(200).json(rows[0]);
  });
};
