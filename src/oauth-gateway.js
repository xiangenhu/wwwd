// OAuth gateway verifier · oauth.xiangenhu.info
//
// The gateway issues a JWT after a user completes the /auth/{provider}/login
// flow. We don't verify the JWT signature ourselves — the gateway is the
// trust root. Instead, on first sight of a token we GET /auth/userinfo with
// the Bearer token; a 200 + {user:{email,...}} means the token is valid and
// gives us the user's identity.
//
// Tokens are cached in-process (Map with TTL) so we don't hit the gateway
// on every request. The cache holds positive results only; failures fall
// through and re-verify next time.

const DEFAULT_GATEWAY = 'https://oauth.xiangenhu.info';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_CACHE = 5_000;
const FETCH_TIMEOUT_MS = 4_000;

function envGatewayUrl(env = process.env) {
  return (env.WWWD_OAUTH_GATEWAY_URL || DEFAULT_GATEWAY).replace(/\/+$/, '');
}

export class OAuthGatewayClient {
  constructor({ gatewayUrl, ttlMs, fetchImpl } = {}) {
    this.gatewayUrl = (gatewayUrl || envGatewayUrl()).replace(/\/+$/, '');
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (!this.fetchImpl) throw new Error('OAuthGatewayClient: global fetch unavailable');
    this.cache = new Map(); // token -> { user, expiresAt }
  }

  // Returns { email, name, picture, provider } on success, null on failure.
  // Never throws; auth.js decides whether a failure is fatal per request.
  async verify(token) {
    if (typeof token !== 'string' || token.length < 8) return null;

    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.user;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetchImpl(`${this.gatewayUrl}/auth/userinfo`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ctrl.signal,
      });
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    let body;
    try {
      body = await res.json();
    } catch (_) {
      return null;
    }
    const u = body?.user;
    if (!u || typeof u.email !== 'string' || !u.email.includes('@')) return null;

    const user = {
      email: u.email.toLowerCase(),
      name: typeof u.name === 'string' ? u.name : '',
      picture: typeof u.picture === 'string' ? u.picture : '',
      provider: typeof u.provider === 'string' ? u.provider : 'google',
    };

    if (this.cache.size >= MAX_CACHE) {
      const now = Date.now();
      for (const [k, v] of this.cache) if (v.expiresAt < now) this.cache.delete(k);
      if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(token, { user, expiresAt: Date.now() + this.ttlMs });
    return user;
  }

  // Forwarder for SMTP / token-exchange endpoints. Not all callers want
  // verification — this just returns the raw response.
  async post(pathname, payload, token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS * 2);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await this.fetchImpl(`${this.gatewayUrl}${pathname}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  describe() {
    return { gatewayUrl: this.gatewayUrl, cached: this.cache.size, ttlMs: this.ttlMs };
  }
}

let _shared;
export function getGatewayClient() {
  if (!_shared) _shared = new OAuthGatewayClient();
  return _shared;
}

export function gatewayConfig() {
  return {
    gatewayUrl: envGatewayUrl(),
    enabled: !!(process.env.WWWD_OAUTH_GATEWAY_URL || DEFAULT_GATEWAY),
  };
}
