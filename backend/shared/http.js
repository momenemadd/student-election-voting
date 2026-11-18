// Builds an Express app with the common middleware stack. Every service uses it.
const express = require('express');
const cors = require('cors');
const { corsOrigins } = require('./config');
const { requestLogger } = require('./logger');
const { notFound, errorHandler } = require('./errors');

const MAX_BODY = 100 * 1024;

// On Lambda, serverless-http hands Express the request body as a raw Buffer, and Express 5's
// JSON parser then skips it. Parse it here with the same limits and error types as express.json.
function lambdaBody(req, res, next) {
  if (!Buffer.isBuffer(req.body)) return next();
  const raw = req.body;
  req.body = undefined;
  if (raw.length === 0 || !req.is('application/json')) return next();
  if (raw.length > MAX_BODY) return next(Object.assign(new Error('too large'), { type: 'entity.too.large' }));
  try {
    req.body = JSON.parse(raw.toString('utf8'));
  } catch {
    return next(Object.assign(new Error('bad json'), { type: 'entity.parse.failed' }));
  }
  next();
}

function createApp(serviceName) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(serviceName));
  app.use(cors({ origin: corsOrigins(), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] })); // exact origins, never '*'
  app.use(lambdaBody);
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (req, res) => {
    // ?deep=1 also opens the database connection (used by infra/warm-up.sh before a demo)
    if (req.query.deep === '1') await require('./db').query('SELECT 1');
    res.status(200).json({
      status: 'ok',
      service: serviceName,
      runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc',
      environment: process.env.NODE_ENV || 'development',
    });
  });
  return app;
}

// Call LAST, after routes are registered.
function finish(app) {
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, finish };
