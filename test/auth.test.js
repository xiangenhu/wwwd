// Tests for src/auth.js. Uses a fixed salt so hashes are reproducible.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  process.env.WWWD_ACTOR_SALT = 'test-salt-not-the-placeholder';
  process.env.WWWD_REQUIRE_AUTH = '0';
  // NODE_ENV intentionally left as-is — production guards exit() the
  // process, which would tear down the whole test runner.
});

const auth = await import('../src/auth.js');

test('Actor.toXapi returns a well-shaped account', () => {
  const a = new auth.Actor('abc123', 'google');
  const x = a.toXapi();
  assert.equal(x.objectType, 'Agent');
  assert.ok(x.account.homePage.startsWith('https://'));
  assert.equal(x.account.name, 'google:abc123');
});

test('resolveActor: no headers → ephemeral anon', async () => {
  const a = await auth.resolveActor({ headers: {} });
  assert.equal(a.source, 'anon');
  assert.equal(typeof a.identity, 'string');
  assert.equal(a.identity.length, 32);
});

test('resolveActor: X-Wwwd-Session → anon with stable hash', async () => {
  const a1 = await auth.resolveActor({ headers: { 'x-wwwd-session': 'abc' } });
  const a2 = await auth.resolveActor({ headers: { 'x-wwwd-session': 'abc' } });
  const a3 = await auth.resolveActor({ headers: { 'x-wwwd-session': 'def' } });
  assert.equal(a1.source, 'anon');
  assert.equal(a1.identity, a2.identity, 'same session must hash to same identity');
  assert.notEqual(a1.identity, a3.identity, 'different sessions must hash differently');
});

test('resolveActor: malformed Bearer falls through to anon when REQUIRE_AUTH=0', async () => {
  const a = await auth.resolveActor({
    headers: { authorization: 'Bearer not-a-jwt', 'x-wwwd-session': 'fallback-session' },
  });
  assert.equal(a.source, 'anon');
  // The session header is honored as fallback.
  assert.ok(a.identity);
});

test('authConfig reflects environment', () => {
  assert.equal(typeof auth.authConfig.requireAuth, 'boolean');
  assert.equal(typeof auth.authConfig.oauthConfigured, 'boolean');
});
