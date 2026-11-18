// Lambda entry point. Lambda setting: handler = lambda/voting.handler  (same zip for all three functions)
const serverless = require('serverless-http');
module.exports.handler = serverless(require('../services/voting/app'));
