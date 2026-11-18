// Creates the first ADMIN and AUDITOR accounts (they can never self-register).
// Passwords come from environment variables - nothing is hard-coded or committed.
//   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_AUDITOR_EMAIL, SEED_AUDITOR_PASSWORD  (>= 12 chars)
// Run from backend/:  npm run seed
const path = require('path');
require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { Client } = require(path.join(__dirname, '..', 'backend', 'node_modules', 'pg'));
const bcrypt = require(path.join(__dirname, '..', 'backend', 'node_modules', 'bcryptjs'));

async function main() {
  const accounts = [
    ['ADMIN', process.env.SEED_ADMIN_EMAIL, process.env.SEED_ADMIN_PASSWORD],
    ['AUDITOR', process.env.SEED_AUDITOR_EMAIL, process.env.SEED_AUDITOR_PASSWORD],
  ];
  for (const [, email, pw] of accounts) {
    if (!email || !pw || pw.length < 12) throw new Error('Set SEED_* email and password (>= 12 chars) in backend/.env');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: true } });
  await client.connect();
  for (const [role, email, pw] of accounts) {
    const hash = await bcrypt.hash(pw, 12);
    await client.query(
      `INSERT INTO users(email, password_hash, role, email_verified) VALUES($1,$2,$3,true)
       ON CONFLICT (email) DO NOTHING`,
      [email.toLowerCase(), hash, role]
    );
    console.log(`seeded ${role}: ${email}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
