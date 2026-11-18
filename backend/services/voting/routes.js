// SERVICE 2 - Voter Access & Voting (owner: Mohamed Osama)
// Reference endpoint: POST /api/auth/login (lockout, generic errors, Turnstile, audit). Rest is TODO.
const { query } = require('../../shared/db');
const { requireAuth, requireRole, verifyPassword, dummyCompare, signToken } = require('../../shared/auth');
const { v, pick } = require('../../shared/validate');
const { AppError } = require('../../shared/errors');
const { verifyTurnstile } = require('../../shared/turnstile');
const audit = require('../../shared/audit');

module.exports = function register(app) {
  app.post('/api/auth/login', async (req, res) => {
    const b = pick(req.body, ['email', 'password', 'turnstileToken']);
    const email = v.email(b.email);
    const password = v.string(b.password, 'password', { min: 1, max: 200 });
    await verifyTurnstile(b.turnstileToken, req.ip);

    const { rows } = await query(
      'SELECT user_id, role, password_hash, token_version, email_verified, locked_until FROM users WHERE email = $1',
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

    await query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [user.user_id]);
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

  // ---------------------------------------------------------------------------------------
  // TODO (Osama) - see FINAL_PHASE_PLAN.md section 5.2:
  //  POST /api/auth/register     roster check (student_number+email exist in students), password >= 12 chars,
  //                              Turnstile, send e-mail OTP (external email API), hash with hashPassword
  //  POST /api/auth/verify-email OTP 6 digits, 10 min expiry, max 5 tries
  //  GET  /api/me/elections      only elections I am eligible for + hasVoted flag (JOIN via req.user.studentNumber)
  //  GET  /api/elections/:id/ballot   STUDENT, eligible, status OPEN (syncStatus first), not voted yet
  //  POST /api/elections/:id/votes    THE critical one. Inside withTx(client => ...):
  //       1 re-check OPEN + eligible  2 validate each selection (candidate belongs to the position, <= max_selections)
  //       3 INSERT vote_receipts(election_id, student_id)  -> unique violation => 409 ALREADY_VOTED
  //       4 INSERT ballots (no student!) + ballot_selections   5 COMMIT, then audit VOTE_CAST (no choices!) + receipt e-mail
  //       student identity comes from req.user ONLY - never from the request body.
  //  GET  /api/elections/:id/receipt  own receipt only (ownership check)
  //  Optional: login rate limit per IP in DynamoDB table RATE_TABLE (TTL) -> 429
};
