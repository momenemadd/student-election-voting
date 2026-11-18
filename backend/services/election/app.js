// Standalone app for this service (used by its Lambda). Locally, server.js mounts all three.
const { createApp, finish } = require('../../shared/http');
const app = createApp('election-svc');
require('./routes')(app);
module.exports = finish(app);
