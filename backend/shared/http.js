// Builds an Express app with the common middleware stack. Every service uses it.
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { corsOrigins } = require('./config');
const { requestLogger } = require('./logger');
const { notFound, errorHandler } = require('./errors');
const { apiLimiter } = require('./limiter');

const MAX_BODY = 100 * 1024;

// Which copy of the backend answered (Lab 8: round robin, k6 "served_by" counts).
// Workers started by infra/scale-test.sh get INSTANCE_ID (ecs-task-1, ecs-task-2 ...);
// a Lambda container gets a random id once, so each warm container has its own name.
const INSTANCE_ID = process.env.INSTANCE_ID
  || (process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda-' + crypto.randomUUID().slice(0, 6) : 'pc');

// Lab 8 security layer: security headers on EVERY answer (JSON API: nothing may be framed or run).
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Instance-Id': INSTANCE_ID,
  });
  next();
}

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
  // Behind OUR load balancer (Lab 8 scale mode) the client address comes from X-Forwarded-For,
  // which the load balancer overwrites. Otherwise the header is ignored (no rate-limit bypass).
  if (process.env.TRUST_LB === 'true') app.set('trust proxy', 'loopback');
  app.use(requestLogger(serviceName));
  app.use(securityHeaders);
  app.use(cors({
    origin: corsOrigins(),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['X-Instance-Id', 'Retry-After'],
  })); // exact origins, never '*'
  app.use(apiLimiter);
  app.use(lambdaBody);
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (req, res) => {
    // ?deep=1 also opens the database connection (used by infra/warm-up.sh before a demo)
    if (req.query.deep === '1') await require('./db').query('SELECT 1');
    res.status(200).json({
      status: 'ok',
      service: serviceName,
      runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'pc',
      instanceId: INSTANCE_ID,
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

module.exports = { createApp, finish, INSTANCE_ID };
