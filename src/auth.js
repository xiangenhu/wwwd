// 身份解析 · Google OAuth ID token 验证 + 匿名 session 兜底
//
// Two pseudonymous identity modes:
//   1. Bearer <Google ID token>      → "google:<hash>"
//   2. X-Wwwd-Session: <client UUID> → "anon:<hash>"
//
// WWWD_REQUIRE_AUTH=1 rejects mode 2.

import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const PLACEHOLDER_SALT = 'wwwd-CHANGE-ME-via-Secret-Manager';
const HASH_SALT = process.env.WWWD_ACTOR_SALT || PLACEHOLDER_SALT;
const ACTOR_HOMEPAGE = process.env.WWWD_ACTOR_HOMEPAGE || 'https://wwwd.skoonline.org';
const REQUIRE_AUTH = process.env.WWWD_REQUIRE_AUTH === '1';

// Refuse to boot in production with the placeholder salt — otherwise every
// instance that forgot to set WWWD_ACTOR_SALT would share the same hash
// space, making cross-deployment correlation of pseudonymous actor IDs
// trivially possible.
if (process.env.NODE_ENV === 'production' && HASH_SALT === PLACEHOLDER_SALT) {
  console.error(
    "✗ Refusing to start: WWWD_ACTOR_SALT is unset (or equal to the placeholder) " +
    "in production. Set it to a long random secret via env / Secret Manager.",
  );
  process.exit(1);
}

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

export class Actor {
  constructor(identity, source) {
    this.identity = identity;
    this.source = source; // 'google' | 'anon'
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
  return crypto.createHash('sha256').update(HASH_SALT + s).digest('hex').slice(0, 32);
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

  // 1. Try Google OAuth
  if (authorization.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    if (oauthClient) {
      try {
        const ticket = await oauthClient.verifyIdToken({
          idToken: token,
          audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (payload?.sub) return new Actor(hash(payload.sub), 'google');
      } catch (err) {
        if (REQUIRE_AUTH) throw new HttpError(401, `Invalid Google ID token: ${err.message}`);
        // else fall through to anon
      }
    } else if (REQUIRE_AUTH) {
      throw new HttpError(500, 'OAuth not configured (GOOGLE_OAUTH_CLIENT_ID missing)');
    }
  }

  // 2. Anonymous mode requires a session ID when REQUIRE_AUTH is on
  if (REQUIRE_AUTH) {
    throw new HttpError(401, 'Authentication required (WWWD_REQUIRE_AUTH=1)');
  }

  if (sessionHeader) return new Actor(hash(String(sessionHeader)), 'anon');

  // 3. No headers — ephemeral; statements still emit but are not joinable.
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

export const authConfig = {
  oauthConfigured: Boolean(GOOGLE_CLIENT_ID),
  requireAuth: REQUIRE_AUTH,
};
