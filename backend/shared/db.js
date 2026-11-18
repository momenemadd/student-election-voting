// Neon Postgres access. Use the POOLED connection string (host contains "-pooler") for the app.
// Always use parameters ($1, $2...) - never build SQL from user input.
const { Pool } = require('pg');
const { loadSecrets } = require('./config');

let pool;
async function getPool() {
  if (!pool) {
    // sslmode=require already means full certificate checks in node-postgres; say so explicitly
    // (verify-full) so the driver does not print a warning into every CloudWatch log stream.
    const DATABASE_URL = (await loadSecrets()).DATABASE_URL.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full');
    const onLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || (onLambda ? 1 : 5)), // one connection per Lambda container
      idleTimeoutMillis: 10_000,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: true },
    });
  }
  return pool;
}

async function query(text, params) {
  return (await getPool()).query(text, params);
}

// Run several statements atomically. Inside fn use ONLY the client passed in (client.query).
async function withTx(fn) {
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTx };
