// Small hand-written validators (same style as Lab 4). They throw 400 VALIDATION_ERROR.
const { AppError } = require('./errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const bad = (message, field) => new AppError(400, 'VALIDATION_ERROR', message, { field });

const v = {
  uuid(x, name) {
    if (typeof x !== 'string' || !UUID.test(x)) throw bad(`${name} must be a valid UUID`, name);
    return x;
  },
  string(x, name, { min = 1, max = 255 } = {}) {
    if (typeof x !== 'string') throw bad(`${name} must be a string`, name);
    const t = x.trim();
    if (t.length < min || t.length > max) throw bad(`${name} must be ${min}-${max} characters`, name);
    return t;
  },
  email(x, name = 'email') {
    const t = v.string(x, name, { min: 5, max: 254 }).toLowerCase();
    if (!EMAIL.test(t)) throw bad(`${name} is not a valid email`, name);
    return t;
  },
  int(x, name, { min = 0, max = 1_000_000 } = {}) {
    if (!Number.isInteger(x) || x < min || x > max) throw bad(`${name} must be an integer ${min}-${max}`, name);
    return x;
  },
  date(x, name) {
    const d = new Date(x);
    if (typeof x !== 'string' || Number.isNaN(d.getTime())) throw bad(`${name} must be an ISO date-time`, name);
    return d;
  },
  oneOf(x, name, allowed) {
    if (!allowed.includes(x)) throw bad(`${name} must be one of: ${allowed.join(', ')}`, name);
    return x;
  },
};

// Whitelist fields so clients cannot set role, created_by, status, ids... (mass assignment).
function pick(obj, allowed) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw bad('Request body must be a JSON object', 'body');
  return Object.fromEntries(allowed.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

module.exports = { v, pick, UUID };
