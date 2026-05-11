// SMTP via gateway · oauth.xiangenhu.info/api/send-email
//
// The gateway forwards through Gmail using a configured GMAIL_APP_PASSWORD.
// We only need to POST a message + the gateway JWT; the gateway handles
// auth and SMTP-over-OAuth on its side.

import { getGatewayClient } from './oauth-gateway.js';

const SUBJECT_MAX = 200;
const BODY_MAX = 32_000;

class EmailError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ensure(condition, status, message) {
  if (!condition) throw new EmailError(status, message);
}

// sendEmail({to, subject, body, html?, cc?, bcc?, provider?, gatewayToken})
//   - to: required, must be email-ish
//   - subject/body: required
//   - gatewayToken: required (Bearer JWT issued by the gateway)
//   - provider: defaults to 'google' (matches the gateway's expected key)
// Returns the parsed JSON response on 2xx; throws EmailError otherwise.
export async function sendEmail(opts) {
  const {
    to,
    subject,
    body,
    html,
    cc,
    bcc,
    provider = 'google',
    gatewayToken,
    client = getGatewayClient(),
  } = opts || {};

  ensure(typeof gatewayToken === 'string' && gatewayToken.length > 8, 401, 'gatewayToken required');
  ensure(typeof to === 'string' && to.includes('@') && to.length <= 320, 422, 'invalid `to`');
  ensure(
    typeof subject === 'string' && subject.length > 0 && subject.length <= SUBJECT_MAX,
    422,
    `subject must be 1..${SUBJECT_MAX} chars`,
  );
  ensure(
    typeof body === 'string' && body.length > 0 && body.length <= BODY_MAX,
    422,
    `body must be 1..${BODY_MAX} chars`,
  );
  if (html != null)
    ensure(typeof html === 'string' && html.length <= BODY_MAX, 422, 'invalid html');
  if (cc != null) ensure(typeof cc === 'string' && cc.length <= 320, 422, 'invalid cc');
  if (bcc != null) ensure(typeof bcc === 'string' && bcc.length <= 320, 422, 'invalid bcc');

  const payload = { to, subject, body, gatewayToken, provider };
  if (html) payload.html = html;
  if (cc) payload.cc = cc;
  if (bcc) payload.bcc = bcc;

  const res = await client.post('/api/send-email', payload);
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (_) {
      /* ignore */
    }
    throw new EmailError(
      res.status,
      `gateway send-email failed: ${res.status} ${detail.slice(0, 200)}`,
    );
  }
  try {
    return await res.json();
  } catch (_) {
    return { ok: true };
  }
}

export { EmailError };
