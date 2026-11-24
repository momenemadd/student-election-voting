// Tamper-evident audit trail: each record stores the hash of the previous one (hash chain).
// Store: DynamoDB table AUDIT_TABLE when set (Floci/AWS); otherwise the Postgres table audit_log
// (local dev and the Vercel fallback). Records never contain passwords, tokens or candidate choices.
const crypto = require('crypto');
const { log } = require('./logger');

const ALLOWED_FIELDS = ['actor_id', 'role', 'action', 'resource', 'outcome', 'election_id'];

const hashOf = (r) =>
  crypto
    .createHash('sha256')
    .update([r.prev_hash, r.pk, r.seq, r.ts, r.actor_id, r.role, r.action, r.resource, r.outcome].join('|'))
    .digest('hex');

// ---- DynamoDB adapter -------------------------------------------------------------------
function dynamoStore() {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, QueryCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const T = process.env.AUDIT_TABLE;
  return {
    async latest(pk) {
      const r = await db.send(new QueryCommand({
        TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk },
        ScanIndexForward: false, Limit: 1, ConsistentRead: true,
      }));
      return r.Items[0];
    },
    async put(item) {
      try {
        await db.send(new PutCommand({ TableName: T, Item: item, ConditionExpression: 'attribute_not_exists(seq)' }));
        return true;
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') return false; // someone else took this seq: retry
        throw e;
      }
    },
    async list(pk, limit) {
      const r = await db.send(new QueryCommand({
        TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk },
        ScanIndexForward: false, Limit: limit,
      }));
      return r.Items;
    },
    async all(pk) {
      // DynamoDB returns at most 1 MB per query: follow LastEvaluatedKey so the whole chain is checked.
      const items = [];
      let start;
      do {
        const r = await db.send(new QueryCommand({
          TableName: T, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk },
          ConsistentRead: true, ExclusiveStartKey: start,
        }));
        items.push(...r.Items);
        start = r.LastEvaluatedKey;
      } while (start);
      return items;
    },
  };
}

// ---- Postgres adapter -------------------------------------------------------------------
function pgStore() {
  const { query } = require('./db');
  return {
    async latest(pk) {
      const { rows } = await query('SELECT * FROM audit_log WHERE pk=$1 ORDER BY seq DESC LIMIT 1', [pk]);
      return rows[0] && { ...rows[0], ts: rows[0].ts.toISOString() };
    },
    async put(i) {
      const { rowCount } = await query(
        `INSERT INTO audit_log(pk,seq,ts,actor_id,role,action,resource,outcome,prev_hash,hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [i.pk, i.seq, i.ts, i.actor_id, i.role, i.action, i.resource, i.outcome, i.prev_hash, i.hash]
      );
      return rowCount === 1;
    },
    async list(pk, limit) {
      const { rows } = await query('SELECT * FROM audit_log WHERE pk=$1 ORDER BY seq DESC LIMIT $2', [pk, limit]);
      return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
    },
    async all(pk) {
      const { rows } = await query('SELECT * FROM audit_log WHERE pk=$1 ORDER BY seq ASC', [pk]);
      return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
    },
  };
}

let store;
const getStore = () => (store = store || (process.env.AUDIT_TABLE ? dynamoStore() : pgStore()));

async function write(event) {
  const s = getStore();
  const pk = event.election_id || 'GLOBAL';
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await s.latest(pk);
    const item = {
      pk,
      seq: prev ? Number(prev.seq) + 1 : 1,
      ts: new Date().toISOString(),
      actor_id: event.actor_id || 'anonymous',
      role: event.role || 'NONE',
      action: event.action,
      resource: event.resource || '-',
      outcome: event.outcome || 'OK',
      prev_hash: prev ? prev.hash : 'GENESIS',
    };
    item.hash = hashOf(item);
    if (await s.put(item)) return item;
  }
  throw new Error('audit write contention');
}

// Fire-and-forget: a failing audit write must never break the user's request, but it is logged.
function record(event) {
  const clean = Object.fromEntries(ALLOWED_FIELDS.map((k) => [k, event[k]]));
  return write(clean).catch((e) => log('error', { event: 'audit_write_failed', msg: e.message }));
}

// Awaitable version for flows where the audit entry is part of the business rule (e.g. publish).
const recordStrict = (event) => write(Object.fromEntries(ALLOWED_FIELDS.map((k) => [k, event[k]])));

const list = (pk, limit = 100) => getStore().list(pk, Math.min(limit, 500));

async function verifyChain(pk) {
  const items = await getStore().all(pk);
  let prev = 'GENESIS';
  for (const it of items) {
    if (it.prev_hash !== prev || it.hash !== hashOf(it)) return { valid: false, brokenAt: Number(it.seq), count: items.length };
    prev = it.hash;
  }
  return { valid: true, count: items.length };
}

module.exports = { record, recordStrict, list, verifyChain, hashOf };
