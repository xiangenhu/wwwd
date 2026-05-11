// 身份解析 · OAuth gateway / Google ID token / anonymous session
//
// Three identity modes, tried in order:
//   1. Bearer <gateway JWT>      → "gateway:<hash>" (oauth.xiangenhu.info)
//   2. Bearer <Google ID token>  → "google:<hash>"
//   3. X-Wwwd-Session: <UUID>    → "anon:<hash>"
//
// WWWD_REQUIRE_AUTH=1 rejects mode 3.
//
// When the gateway path succeeds, req.gatewayUser is populated with
// { email, name, picture, provider } and req.gatewayToken with the raw
// JWT so downstream handlers (profile store, SMTP proxy) can act on it.

import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { getGatewayClient } from './oauth-gateway.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const PLACEHOLDER_SALT = 'wwwd-CHANGE-ME-via-Secret-Manager';
const HASH_SALT = process.env.WWWD_ACTOR_SALT || PLACEHOLDER_SALT;
const ACTOR_HOMEPAGE = process.env.WWWD_ACTOR_HOMEPAGE || 'https://wwwd.skoonline.org';
const REQUIRE_AUTH = process.env.WWWD_REQUIRE_AUTH === '1';
const GATEWAY_ENABLED = process.env.WWWD_OAUTH_GATEWAY_DISABLE !== '1';

// Refuse to boot in production with the placeholder salt — otherwise every
// instance that forgot to set WWWD_ACTOR_SALT would share the same hash
// space, making cross-deployment correlation of pseudonymous actor IDs
// trivially possible.
if (process.env.NODE_ENV === 'production' && HASH_SALT === PLACEHOLDER_SALT) {
  console.error(
    '✗ Refusing to start: WWWD_ACTOR_SALT is unset (or equal to the placeholder) ' +
      'in production. Set it to a long random secret via env / Secret Manager.',
  );
  process.exit(1);
}

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const gatewayClient = GATEWAY_ENABLED ? getGatewayClient() : null;

export class Actor {
  constructor(identity, source) {
    this.identity = identity;
    this.source = source; // 'gateway' | 'google' | 'anon'
  }
  toXapi() {
    return {
      objectType: 'Agent',
      account: {
        homePage: ACTOR_HOMEPAGE,
        name: `${this.source}:${this.identity}`,
      },
    };
  }
}

function hash(s) {
  return crypto
    .createHash('sha256')
    .update(HASH_SALT + s)
    .digest('hex')
    .slice(0, 32);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function resolveActor(req) {
  const authorization = req.headers.authorization || '';
  const sessionHeader = req.headers['x-wwwd-session'] || '';

  if (authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7).trim();

    // 1. Try gateway JWT first — this is the primary auth path now.
    if (gatewayClient && token) {
      const user = await gatewayClient.verify(token);
      if (user) {
        req.gatewayUser = user;
        req.gatewayToken = token;
        // Identity keyed on lower-cased email so the same human is the
        // same actor regardless of which provider (google/microsoft/github)
        // they used at the gateway.
        const actor = new Actor(hash(`gateway:${user.email}`), 'gateway');
        actor.email = user.email;
        return actor;
      }
    }

    // 2. Try direct Google ID token (legacy, kept for /api/health-style probes
    //    and any client still using GIS one-tap).
    if (oauthClient) {
      try {
        const ticket = await oauthClient.verifyIdToken({
          idToken: token,
          audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (payload?.sub) return new Actor(hash(payload.sub), 'google');
      } catch (err) {
        if (REQUIRE_AUTH) throw new HttpError(401, `Invalid Bearer token: ${err.message}`);
        // else fall through to anon
      }
    } else if (REQUIRE_AUTH && !gatewayClient) {
      throw new HttpError(500, 'OAuth not configured (no gateway, no GOOGLE_OAUTH_CLIENT_ID)');
    } else if (REQUIRE_AUTH) {
      // Gateway was tried but rejected the token, and no Google client to fall back to.
      throw new HttpError(401, 'Invalid Bearer token');
    }
  }

  // 3. Anonymous mode requires a session ID when REQUIRE_AUTH is on
  if (REQUIRE_AUTH) {
    throw new HttpError(401, 'Authentication required (WWWD_REQUIRE_AUTH=1)');
  }

  if (sessionHeader) return new Actor(hash(String(sessionHeader)), 'anon');

  // 4. No headers — ephemeral; statements still emit but are not joinable.
  return new Actor(hash('ephemeral-no-headers'), 'anon');
}

// Express middleware that attaches req.actor.
export function actorMiddleware() {
  return async (req, res, next) => {
    try {
      req.actor = await resolveActor(req);
      next();
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
      } else {
        next(err);
      }
    }
  };
}

export function requireGatewayAuth(req, res, next) {
  if (req.gatewayUser) return next();
  res.status(401).json({ error: 'gateway authentication required' });
}

export const authConfig = {
  oauthConfigured: Boolean(GOOGLE_CLIENT_ID),
  gatewayEnabled: GATEWAY_ENABLED,
  requireAuth: REQUIRE_AUTH,
};
