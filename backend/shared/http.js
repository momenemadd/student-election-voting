// Builds an Express app with the common middleware stack. Every service uses it.
const express = require('express');
const cors = require('cors');
const { corsOrigins } = require('./config');
const { requestLogger } = require('./logger');
const { notFound, errorHandler } = require('./errors');

function createApp(serviceName) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(serviceName));
  app.use(cors({ origin: corsOrigins(), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] })); // exact origins, never '*'
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => {
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
