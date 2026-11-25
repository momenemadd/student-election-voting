// Applies db/schema.sql, then every file in db/migrations/ in name order (001_, 002_, ...), to the
// database in backend/.env. Safe to re-run: all statements use CREATE/ADD ... IF NOT EXISTS.
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
  const dir = path.join(__dirname, 'migrations');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log('applied migration', f);
  }
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
  );
  console.log('tables:', rows.map((r) => r.table_name).join(', '));
  await client.end();
})().catch((e) => { console.error('migrate failed:', e.message); process.exit(1); });
