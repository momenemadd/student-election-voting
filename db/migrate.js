// Applies db/schema.sql to the database in backend/.env (safe to re-run: CREATE ... IF NOT EXISTS).
// Run from backend/:  npm run migrate
const path = require('path');
const fs = require('fs');
const nm = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
nm('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const { Client } = nm('pg');

(async () => {
  const url = (process.env.DATABASE_URL || '').replace(/sslmode=require/, 'sslmode=verify-full');
  const client = new Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true } });
  await client.connect();
  await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
  );
  console.log('tables:', rows.map((r) => r.table_name).join(', '));
  await client.end();
})().catch((e) => { console.error('migrate failed:', e.message); process.exit(1); });
