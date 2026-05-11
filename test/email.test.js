// Tests for src/email.js — validates input and forwards to a mock
// gateway client. The real network is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendEmail, EmailError } from '../src/email.js';

function makeClient(response) {
  const calls = [];
  return {
    calls,
    async post(pathname, payload, token) {
      calls.push({ pathname, payload, token });
      return response;
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('sendEmail rejects missing gatewayToken', async () => {
  await assert.rejects(
    sendEmail({ to: 'a@b.c', subject: 'x', body: 'y', client: makeClient(jsonResponse(200, {})) }),
    /gatewayToken required/,
  );
});

test('sendEmail rejects malformed `to`', async () => {
  await assert.rejects(
    sendEmail({
      to: 'not-an-email',
      subject: 'x',
      body: 'y',
      gatewayToken: 'tok-aaaaaaaaaa',
      client: makeClient(jsonResponse(200, {})),
    }),
    /invalid `to`/,
  );
});

test('sendEmail rejects empty / over-long subject', async () => {
  await assert.rejects(
    sendEmail({
      to: 'a@b.c',
      subject: '',
      body: 'y',
      gatewayToken: 'tok-aaaaaaaaaa',
      client: makeClient(jsonResponse(200, {})),
    }),
    /subject must be 1\.\.200 chars/,
  );
  await assert.rejects(
    sendEmail({
      to: 'a@b.c',
      subject: 'x'.repeat(201),
      body: 'y',
      gatewayToken: 'tok-aaaaaaaaaa',
      client: makeClient(jsonResponse(200, {})),
    }),
    /subject must be 1\.\.200 chars/,
  );
});

test('sendEmail rejects empty / over-long body', async () => {
  await assert.rejects(
    sendEmail({
      to: 'a@b.c',
      subject: 's',
      body: '',
      gatewayToken: 'tok-aaaaaaaaaa',
      client: makeClient(jsonResponse(200, {})),
    }),
    /body must be 1\.\.32000 chars/,
  );
  await assert.rejects(
    sendEmail({
      to: 'a@b.c',
      subject: 's',
      body: 'x'.repeat(32_001),
      gatewayToken: 'tok-aaaaaaaaaa',
      client: makeClient(jsonResponse(200, {})),
    }),
    /body must be 1\.\.32000 chars/,
  );
});

test('sendEmail forwards correct payload and bearer to gateway', async () => {
  const client = makeClient(jsonResponse(200, { id: 'msg-1' }));
  const result = await sendEmail({
    to: 'a@b.c',
    subject: 's',
    body: 'b',
    html: '<p>b</p>',
    cc: 'c@d.e',
    gatewayToken: 'tok-aaaaaaaaaa',
    provider: 'google',
    client,
  });
  assert.deepEqual(result, { id: 'msg-1' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].pathname, '/api/send-email');
  assert.equal(client.calls[0].payload.to, 'a@b.c');
  assert.equal(client.calls[0].payload.gatewayToken, 'tok-aaaaaaaaaa');
  assert.equal(client.calls[0].payload.provider, 'google');
  assert.equal(client.calls[0].payload.html, '<p>b</p>');
  assert.equal(client.calls[0].payload.cc, 'c@d.e');
});

test('sendEmail throws EmailError on non-2xx', async () => {
  const client = makeClient(jsonResponse(502, { error: 'smtp down' }));
  try {
    await sendEmail({
      to: 'a@b.c',
      subject: 's',
      body: 'b',
      gatewayToken: 'tok-aaaaaaaaaa',
      client,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof EmailError);
    assert.equal(err.status, 502);
    assert.match(err.message, /gateway send-email failed/);
  }
});

test('sendEmail returns {ok:true} when response is 2xx but not JSON', async () => {
  const client = makeClient(
    new Response('plain text ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
  );
  const r = await sendEmail({
    to: 'a@b.c',
    subject: 's',
    body: 'b',
    gatewayToken: 'tok-aaaaaaaaaa',
    client,
  });
  assert.deepEqual(r, { ok: true });
});

test('sendEmail strips optional fields when absent', async () => {
  const client = makeClient(jsonResponse(200, {}));
  await sendEmail({
    to: 'a@b.c',
    subject: 's',
    body: 'b',
    gatewayToken: 'tok-aaaaaaaaaa',
    client,
  });
  const payload = client.calls[0].payload;
  assert.equal(payload.html, undefined);
  assert.equal(payload.cc, undefined);
  assert.equal(payload.bcc, undefined);
});
