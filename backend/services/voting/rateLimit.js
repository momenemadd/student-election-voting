// Rate limiter on DynamoDB table RATE_TABLE (AWS service of the Voting service).
// One counter item per key (e.g. "login:1.2.3.4:a@uni.edu"). The first hit sets expires_at; DynamoDB TTL
// deletes the item after the window, which resets the counter (fixed window).
// When RATE_TABLE is not set (local PC) every request is allowed.
const { AppError } = require('../../shared/errors');
const audit = require('../../shared/audit');

const LIMITS = {
  login: [10, 300], // 10 tries per 5 minutes per IP + e-mail
  register: [5, 600], // 5 per 10 minutes per IP
  otp: [5, 600], // 5 new codes per 10 minutes per e-mail
  vote: [10, 60], // 10 vote requests per minute per user
};

let db;
function client() {
  if (!db) {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return db;
}

async function hit(key, limit, windowSeconds) {
  if (!process.env.RATE_TABLE) return;
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const now = Math.floor(Date.now() / 1000);
  const out = await client().send(new UpdateCommand({
    TableName: process.env.RATE_TABLE,
    Key: { pk: key },
    UpdateExpression: 'ADD #c :one SET expires_at = if_not_exists(expires_at, :exp)',
    ExpressionAttributeNames: { '#c': 'count' },
    ExpressionAttributeValues: { ':one': 1, ':exp': now + windowSeconds },
    ReturnValues: 'UPDATED_NEW',
  }));
  const { count, expires_at: expiresAt } = out.Attributes;
  // TTL deletion can lag behind; an item whose window has passed must not keep blocking.
  if (count > limit && expiresAt > now) {
    audit.record({ actor_id: 'rate-limit', role: 'NONE', action: 'RATE_LIMITED', resource: key.split(':')[0], outcome: 'DENIED' });
    throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts, try again later');
  }
}

// limit('login', req.ip) -> uses the limits table above
const limit = (kind, id) => hit(`${kind}:${id}`, ...LIMITS[kind]);

module.exports = { hit, limit, LIMITS };
