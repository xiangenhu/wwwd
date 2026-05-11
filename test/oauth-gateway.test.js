// Tests for src/oauth-gateway.js — verifies cache behaviour, error
// handling, and that the userinfo response is normalised before caching.
// Fetch is injected via the constructor so we never touch the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OAuthGatewayClient } from '../src/oauth-gateway.js';

function makeFetch(routes) {
  // routes: Array<{ match: (url, init) => boolean, response: Response | () => Response }>
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (r.match(url, init)) {
        return typeof r.response === 'function' ? r.response() : r.response;
      }
    }
    throw new Error(`unmocked: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const USER_OK = {
  user: {
    email: 'Alice@Example.com',
    name: 'Alice',
    picture: 'https://x/a.png',
    provider: 'google',
  },
};

test('verify: 200 + valid body returns normalised user', async () => {
  const fetchImpl = makeFetch([
    { match: (u) => u.endsWith('/auth/userinfo'), response: jsonResponse(200, USER_OK) },
  ]);
  const c = new OAuthGatewayClient({ fetchImpl });
  const u = await c.verify('a'.repeat(20));
  assert.equal(u.email, 'alice@example.com', 'email is lowercased');
  assert.equal(u.name, 'Alice');
  assert.equal(u.provider, 'google');
});

test('verify: short or missing token returns null without calling gateway', async () => {
  const fetchImpl = makeFetch([]);
  const c = new OAuthGatewayClient({ fetchImpl });
  assert.equal(await c.verify(''), null);
  assert.equal(await c.verify('abc'), null);
  assert.equal(await c.verify(null), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('verify: non-2xx returns null and is not cached', async () => {
  const fetchImpl = makeFetch([
    { match: () => true, response: jsonResponse(401, { error: 'nope' }) },
  ]);
  const c = new OAuthGatewayClient({ fetchImpl });
  assert.equal(await c.verify('a'.repeat(20)), null);
  assert.equal(await c.verify('a'.repeat(20)), null);
  assert.equal(fetchImpl.calls.length, 2, 'failures must not poison the cache');
});

test('verify: malformed body (no email) returns null', async () => {
  const fetchImpl = makeFetch([
    { match: () => true, response: jsonResponse(200, { user: { name: 'no-email' } }) },
  ]);
  const c = new OAuthGatewayClient({ fetchImpl });
  assert.equal(await c.verify('a'.repeat(20)), null);
});

test('verify: caches positive results across calls', async () => {
  const fetchImpl = makeFetch([{ match: () => true, response: jsonResponse(200, USER_OK) }]);
  const c = new OAuthGatewayClient({ fetchImpl, ttlMs: 60_000 });
  const a = await c.verify('token-A-aaaaaaaa');
  const b = await c.verify('token-A-aaaaaaaa');
  assert.deepEqual(a, b);
  assert.equal(fetchImpl.calls.length, 1, 'second call should be cache hit');
});

test('verify: ignores cache after ttl expires', async () => {
  const fetchImpl = makeFetch([{ match: () => true, response: () => jsonResponse(200, USER_OK) }]);
  const c = new OAuthGatewayClient({ fetchImpl, ttlMs: 1 });
  await c.verify('token-B-bbbbbbbb');
  await new Promise((r) => setTimeout(r, 5));
  await c.verify('token-B-bbbbbbbb');
  assert.equal(fetchImpl.calls.length, 2);
});

test('verify: sends Bearer auth header', async () => {
  const fetchImpl = makeFetch([{ match: () => true, response: jsonResponse(200, USER_OK) }]);
  const c = new OAuthGatewayClient({ fetchImpl });
  await c.verify('token-C-cccccccc');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer token-C-cccccccc');
});

test('verify: network rejection returns null, not throw', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const c = new OAuthGatewayClient({ fetchImpl });
  assert.equal(await c.verify('a'.repeat(20)), null);
});

test('post: forwards JSON body and Bearer token', async () => {
  const fetchImpl = makeFetch([{ match: () => true, response: jsonResponse(200, { ok: true }) }]);
  const c = new OAuthGatewayClient({ fetchImpl });
  const res = await c.post('/api/send-email', { to: 'x@y.z', subject: 's', body: 'b' }, 'tok-XYZ');
  assert.equal(res.status, 200);
  const call = fetchImpl.calls[0];
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer tok-XYZ');
  assert.deepEqual(JSON.parse(call.init.body), { to: 'x@y.z', subject: 's', body: 'b' });
});

test('describe: returns shape with gatewayUrl and cache stats', async () => {
  const c = new OAuthGatewayClient({ fetchImpl: async () => jsonResponse(200, USER_OK) });
  const d = c.describe();
  assert.equal(typeof d.gatewayUrl, 'string');
  assert.equal(typeof d.cached, 'number');
  assert.equal(typeof d.ttlMs, 'number');
});
