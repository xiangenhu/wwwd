// Real-time LLM liveness probe with TTL cache + single-flight.
//
// pingLLM() makes the smallest viable streamText call (max_tokens=1, hard
// timeout) so /api/health can verify the provider is actually reachable
// — not just configured. pingLLMCached() reuses recent results so that
// load-balancer / uptime monitors hitting /api/health every few seconds
// don't translate into a paid API call every few seconds.

const DEFAULT_TTL_MS = Number(process.env.WWWD_HEALTH_LLM_TTL_MS || 30_000);
const DEFAULT_TIMEOUT_MS = Number(process.env.WWWD_HEALTH_LLM_TIMEOUT_MS || 5_000);

let cache = null; // {ok, latency_ms, error?, model, checked_at}
let inflight = null;

export async function pingLLM(provider, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const iter = provider.streamText({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 1,
      signal: ctrl.signal,
    });
    // First yielded chunk (or clean end of stream) is enough — we only
    // care that the request was accepted and the stream opened.
    // eslint-disable-next-line no-unused-vars
    for await (const _ of iter) break;
    return {
      ok: true,
      latency_ms: Date.now() - start,
      model: provider.model,
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      error: err?.message || String(err),
      model: provider.model,
      checked_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Non-blocking: returns the cached value when fresh; otherwise kicks off a
// background ping and returns a pending placeholder so /api/health responds
// in milliseconds even on cold cache. Subsequent calls (after the background
// ping resolves) get the real result. Use pingLLM() directly when you want
// to block on a real-time answer (the ?probe=fresh path does this).
export function pingLLMCached(provider, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (cache && Date.now() - new Date(cache.checked_at).getTime() < ttlMs) {
    return { ...cache, cached: true };
  }
  if (!inflight) {
    inflight = pingLLM(provider).then((result) => {
      cache = result;
      inflight = null;
      return result;
    });
    // Swallow rejections here — callers shouldn't crash if a background
    // refresh fails; pingLLM() already turns errors into {ok:false,...}.
    inflight.catch(() => {});
  }
  // If we have any prior cache value, prefer the stale one (more useful than
  // 'pending'); otherwise signal pending so the caller knows to retry.
  if (cache) return { ...cache, cached: true, stale: true };
  return {
    ok: null,
    pending: true,
    model: provider.model,
    checked_at: new Date().toISOString(),
  };
}

// Fire-and-forget cache warmer — call at server boot so the first
// /api/health hit gets a real result instead of pending.
export function warmLLMHealthCache(provider) {
  if (!inflight && !cache) pingLLMCached(provider);
}

// Test-only: drop any cached / in-flight state.
export function _resetLLMHealthCache() {
  cache = null;
  inflight = null;
}
