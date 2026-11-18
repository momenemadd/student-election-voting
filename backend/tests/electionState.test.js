const test = require('node:test');
const assert = require('node:assert');
const { canTransition, assertTransition, timeBasedStatus, canEditSetup, canEditDetails } = require('../shared/electionState');
const { v, pick } = require('../shared/validate');
const { hashOf } = require('../shared/audit');

test('legal and illegal transitions', () => {
  assert.ok(canTransition('DRAFT', 'SCHEDULED'));
  assert.ok(canTransition('CLOSED', 'TALLIED'));
  assert.ok(!canTransition('OPEN', 'DRAFT'));
  assert.ok(!canTransition('PUBLISHED', 'OPEN'));
  assert.throws(() => assertTransition('DRAFT', 'PUBLISHED'), (e) => e.status === 409);
});

test('edit guards', () => {
  assert.ok(canEditSetup('DRAFT') && !canEditSetup('SCHEDULED') && !canEditSetup('OPEN'));
  assert.ok(canEditDetails('SCHEDULED') && !canEditDetails('OPEN'));
});

test('time based status', () => {
  const e = { status: 'SCHEDULED', start_time: '2026-01-01T10:00:00Z', end_time: '2026-01-01T12:00:00Z' };
  assert.strictEqual(timeBasedStatus(e, new Date('2026-01-01T09:00:00Z')), 'SCHEDULED');
  assert.strictEqual(timeBasedStatus(e, new Date('2026-01-01T11:00:00Z')), 'OPEN');
  assert.strictEqual(timeBasedStatus(e, new Date('2026-01-01T13:00:00Z')), 'CLOSED');
  assert.strictEqual(timeBasedStatus({ ...e, status: 'DRAFT' }, new Date('2026-01-01T11:00:00Z')), 'DRAFT');
});

test('validators reject bad input (400)', () => {
  assert.throws(() => v.uuid('1 OR 1=1', 'id'), (e) => e.status === 400);
  assert.throws(() => v.string('ab', 'title', { min: 3 }), (e) => e.status === 400);
  assert.throws(() => v.email('not-an-email'), (e) => e.status === 400);
  assert.throws(() => pick([], ['a']), (e) => e.status === 400);
  assert.deepStrictEqual(pick({ title: 'x', role: 'ADMIN' }, ['title']), { title: 'x' }); // mass assignment blocked
});

test('audit hash changes when any field is tampered', () => {
  const rec = { prev_hash: 'GENESIS', pk: 'GLOBAL', seq: 1, ts: 't', actor_id: 'a', role: 'ADMIN', action: 'X', resource: 'r', outcome: 'OK' };
  assert.notStrictEqual(hashOf(rec), hashOf({ ...rec, outcome: 'DENIED' }));
});
