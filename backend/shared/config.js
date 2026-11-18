// Loads configuration. Secrets come from (1) environment variables, then (2) AWS Secrets Manager
// when SECRETS_ID is set (Floci / real AWS). Nothing sensitive is ever hard-coded here.
require('dotenv').config();

const KEYS = ['DATABASE_URL', 'JWT_SECRET', 'TURNSTILE_SECRET_KEY', 'MAIL_API_KEY', 'MAIL_FROM'];
let cache = null;

async function loadSecrets() {
  if (cache) return cache;
  const values = {};
  for (const k of KEYS) if (process.env[k]) values[k] = process.env[k];

  if (process.env.SECRETS_ID) {
    // SDK picks up AWS_ENDPOINT_URL (Floci) and the Lambda execution role automatically.
    const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const out = await client.send(new GetSecretValueCommand({ SecretId: process.env.SECRETS_ID }));
    Object.assign(values, JSON.parse(out.SecretString));
  }

  if (!values.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!values.JWT_SECRET || values.JWT_SECRET.length < 32) throw new Error('JWT_SECRET missing or shorter than 32 chars');
  cache = values;
  return cache;
}

const corsOrigins = () =>
  (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = { loadSecrets, corsOrigins };
