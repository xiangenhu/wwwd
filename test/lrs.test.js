// Tests for src/lrs.js — focused on the verb allowlist and result_ext
// filtering enforced by frontendEvent(). The xAPI shape of other emitters
// is also checked but their actual side-effect (console.log) is left alone.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  process.env.WWWD_ACTOR_SALT = 'test-salt-for-lrs';
  process.env.WWWD_REQUIRE_AUTH = '0';
});

const auth = await import('../src/auth.js');
const lrs = await import('../src/lrs.js');

function actor() {
  return new auth.Actor('actor-hash-fixture', 'anon');
}

test('frontendEvent: allowed verb returns an xAPI statement', () => {
  const stmt = lrs.frontendEvent(actor(), 'viewed-corpus', 'session-123');
  assert.ok(stmt);
  assert.ok(stmt.id);
  assert.match(stmt.verb.id, /viewed-corpus$/);
  assert.equal(stmt.actor.account.name, 'anon:actor-hash-fixture');
});

test('frontendEvent: rejected verb returns null', () => {
  const stmt = lrs.frontendEvent(actor(), 'not-in-allowlist', 'session-123');
  assert.equal(stmt, null);
});

test('frontendEvent: result_ext is filtered to SAFE_RESULT_KEYS', () => {
  const stmt = lrs.frontendEvent(actor(), 'committed-action', 'session-x', {
    'action-index': 2,
    'has-concept-tag': true,
    'pii-email': 'user@example.com', // must be dropped
    'arbitrary-key': 'leak attempt', // must be dropped
  });
  const ext = stmt.result?.extensions || {};
  const keys = Object.keys(ext);
  assert.ok(keys.some((k) => k.endsWith('/action-index')));
  assert.ok(keys.some((k) => k.endsWith('/has-concept-tag')));
  assert.ok(
    !keys.some((k) => k.endsWith('/pii-email')),
    'pii-email leaked through despite not being in the safe keys allowlist',
  );
  assert.ok(!keys.some((k) => k.endsWith('/arbitrary-key')));
});

test('frontendEvent: missing result_ext → no extensions field', () => {
  const stmt = lrs.frontendEvent(actor(), 'parted-ways', 'session-x');
  // result is either {} or has no extensions key.
  assert.ok(!stmt.result?.extensions);
});

test('lrsConfig reflects the absence of an LRS endpoint by default', () => {
  // tests don't set LRS_ENDPOINT; lrsConfig.forwardToLrs must be false.
  assert.equal(lrs.lrsConfig.forwardToLrs, false);
});

test('all four staged builders produce well-formed statements', () => {
  const a = actor();
  for (const fn of [
    () => lrs.beganDeliberation(a, 'scenario text long enough', 'standard', 'cn', 's1'),
    () => lrs.consultedPassages(a, ['p1', 'p2'], 's1'),
    () => lrs.completedStage(a, 1, '心之体', 1234, 200, 's1'),
    () => lrs.completedDeliberation(a, 5678, 4, 's1'),
  ]) {
    const stmt = fn();
    assert.ok(stmt.id, 'must have id');
    assert.ok(stmt.actor, 'must have actor');
    assert.ok(stmt.verb?.id, 'must have verb.id');
    assert.ok(stmt.timestamp, 'must have timestamp');
    assert.match(stmt.timestamp, /\d{4}-\d{2}-\d{2}T/);
  }
});
