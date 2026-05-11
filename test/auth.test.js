// Tests for src/auth.js. Uses a fixed salt so hashes are reproducible.
// The gateway client picks up globalThis.fetch at module load — we install
// a controllable fake *before* importing auth.js so the gateway path can
// be exercised without touching the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WWWD_ACTOR_SALT = 'test-salt-not-the-placeholder';
process.env.WWWD_REQUIRE_AUTH = '0';
// NODE_ENV intentionally left as-is — production guards exit() the
// process, which would tear down the whole test runner.

const gatewayResponses = []; // queue of { status, body } for the fake fetch
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.includes('/auth/userinfo')) {
    const next = gatewayResponses.shift() || { status: 401, body: { error: 'unmocked' } };
    return jsonResponse(next.status, next.body);
  }
  throw new Error(`unmocked fetch: ${url}`);
};

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
  assert.equal(typeof auth.authConfig.gatewayEnabled, 'boolean');
});

test('resolveActor: gateway path attaches gatewayUser and returns gateway actor', async () => {
  gatewayResponses.push({
    status: 200,
    body: { user: { email: 'Alice@Example.com', name: 'Alice', picture: '', provider: 'google' } },
  });
  const req = { headers: { authorization: 'Bearer gw-token-aaaaaaaaaa' } };
  const a = await auth.resolveActor(req);
  assert.equal(a.source, 'gateway');
  assert.equal(a.email, 'alice@example.com');
  assert.equal(req.gatewayUser.email, 'alice@example.com');
  assert.equal(req.gatewayToken, 'gw-token-aaaaaaaaaa');
  assert.equal(a.identity.length, 32);
});

test('resolveActor: same email → same gateway actor identity across providers', async () => {
  gatewayResponses.push({
    status: 200,
    body: { user: { email: 'bob@example.com', name: 'Bob', picture: '', provider: 'google' } },
  });
  gatewayResponses.push({
    status: 200,
    body: { user: { email: 'bob@example.com', name: 'Bob', picture: '', provider: 'microsoft' } },
  });
  const a1 = await auth.resolveActor({ headers: { authorization: 'Bearer gw-token-bbbbbbbb-1' } });
  const a2 = await auth.resolveActor({ headers: { authorization: 'Bearer gw-token-bbbbbbbb-2' } });
  assert.equal(a1.identity, a2.identity, 'identity must key off email, not provider');
});

test('resolveActor: gateway 401 falls through to anon when REQUIRE_AUTH=0', async () => {
  gatewayResponses.push({ status: 401, body: { error: 'nope' } });
  const a = await auth.resolveActor({
    headers: {
      authorization: 'Bearer bad-gw-token-cccccccc',
      'x-wwwd-session': 'fallback',
    },
  });
  assert.equal(a.source, 'anon');
});
