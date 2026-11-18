// Authentication + role authorization shared by all three services.
// JWT: HS256 (algorithm pinned), 30 min expiry, secret from Secrets Manager/env.
// Passwords: bcryptjs cost 12. Logout/compromise: bump users.token_version -> old tokens rejected.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { loadSecrets } = require('./config');
const { query } = require('./db');
const { AppError } = require('./errors');
const audit = require('./audit');

const BCRYPT_COST = 12;
const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Compared against when the e-mail is unknown, so response time does not reveal valid accounts.
let dummyHash;
async function dummyCompare(plain) {
  dummyHash = dummyHash || (await bcrypt.hash(crypto.randomUUID(), BCRYPT_COST));
  await bcrypt.compare(plain, dummyHash);
}

async function signToken(user) {
  const { JWT_SECRET } = await loadSecrets();
  return jwt.sign({ role: user.role, tv: user.token_version }, JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.user_id,
    expiresIn: '30m',
    jwtid: crypto.randomUUID(),
  });
}

async function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');

  let payload;
  try {
    const { JWT_SECRET } = await loadSecrets();
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); // rejects alg:none, expired, tampered
  } catch {
    throw new AppError(401, 'AUTH_INVALID', 'Invalid or expired token');
  }

  // Role and token version come from the database, not only from the token.
  const { rows } = await query(
    'SELECT user_id, role, student_number, token_version, email_verified FROM users WHERE user_id = $1',
    [payload.sub]
  );
  const user = rows[0];
  if (!user || user.token_version !== payload.tv) throw new AppError(401, 'AUTH_INVALID', 'Invalid or expired token');

  req.user = { id: user.user_id, role: user.role, studentNumber: user.student_number };
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    audit.record({
      actor_id: req.user && req.user.id,
      role: req.user && req.user.role,
      action: 'ACCESS_DENIED',
      resource: `${req.method} ${req.path}`,
      outcome: 'DENIED',
    });
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
  }
  next();
};

module.exports = { hashPassword, verifyPassword, dummyCompare, signToken, requireAuth, requireRole };
