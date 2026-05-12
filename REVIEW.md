# WWWD · Code Review & Improvement Plan

_Reviewer: Claude (Opus 4.7) · Date: 2026-05-11 · Branch: `main` (HEAD `c215437`)_

## 0. Scope of review

Read end-to-end:
- `server.js`, all of `src/` (auth, rag, prompts, lrs, providers/\*, corpus/\*)
- `public/index.html` (3,444 lines, inline CSS + JS)
- All five `scripts/` entries
- `package.json`, `.env.example`, `.gitignore`, `README.md`

Not exercised: I did **not** run the app, nor send a real `/api/deliberate` request, nor measure cold-start latency. Findings below are derived from static reading; items that need empirical confirmation are tagged **[verify]**.

---

## 1. Executive summary

The codebase is **small, clean, and well-scoped**. The provider/corpus/LRS abstractions are the strongest part — pluggable in one env var, no leaky coupling. The privacy posture (pseudonymous hashing, output never logged, frontend verb allowlist) is unusually thoughtful for a project this size.

What it is **not** yet ready for: untrusted public deployment. Three issues stand out:

| # | Severity | One-line                                                                                              |
|---|----------|-------------------------------------------------------------------------------------------------------|
| 1 | **Critical** | `CORS_ORIGINS=*` default + `WWWD_REQUIRE_AUTH=0` default = any website on the internet can burn your LLM key. |
| 2 | **High**     | No rate limiting anywhere; `/api/deliberate` is a four-call LLM endpoint open to spam.            |
| 3 | **High**     | Express 4 + bare `async` handlers — exceptions before `flushHeaders` hang the client and may crash the process. |

Everything else is medium / low / DX. Details below, organized by category, each with a concrete fix.

---

## 2. Critical & high-severity issues

### 2.1 CORS wide-open by default — wallet-draining vector
**File:** `server.js:35,42-43` · **Severity:** Critical (for any deployed instance)

```js
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',')...
if (CORS_ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
```

`*` is fine for a strictly localhost dev machine, but the moment this is deployed at `wwwd.skoonline.org` (referenced in `lrs.js:12`) any third-party page can:

1. Send `fetch('https://your-domain/api/deliberate', { method:'POST', body: '...' })`
2. Browser allows it (no credentials → `*` is legal)
3. `WWWD_REQUIRE_AUTH=0` by default → server happily runs four LLM calls
4. Cost lands on you

**Fix:**
- Change the default in `server.js:35` to `'http://localhost:8000'` (or even `''`) and **require** explicit allow-list in production.
- In `README.md` "Quick start" call out that deploying without setting `CORS_ORIGINS` is unsafe.
- Optionally: refuse to start with `CORS_ORIGINS=*` AND no auth configured.

### 2.2 No rate limiting on cost-bearing endpoints
**Files:** `server.js:103, 193` · **Severity:** High

Neither `/api/deliberate` (4 LLM calls + RAG search) nor `/api/xapi/event` (writes to stdout, optionally POSTs to LRS) has any throttling. Even with auth enabled, one signed-in actor can fire 1000 deliberations.

**Fix:** Add `express-rate-limit`. Suggested:
- `/api/deliberate`: 10 / hour per actor identity (or per IP if anonymous)
- `/api/xapi/event`: 60 / minute per actor
- `/api/health`: 30 / minute per IP (cheap, but DoS surface)

Keyed off `req.actor.identity` is better than IP because the actor hash already exists. Persist counters in-memory for now; Redis if you scale beyond one instance.

### 2.3 Unhandled async errors in Express 4
**File:** `server.js:103-110` · **Severity:** High

```js
app.post('/api/deliberate', async (req, res) => {
  const { scenario, mode = 'standard', script = 'cn' } = req.body || {};
  if (...) return res.status(422).json(...);
  const sessionId = randomUUID();
  const retrieved = await retriever.search(scenario, 8);   // <-- can throw, no catch
  lrs.beganDeliberation(req.actor, scenario, mode, script, sessionId);
  ...
  res.flushHeaders?.();  // happens AFTER the await
  ...
  try { ... } catch (err) { ... }   // catches model errors, not search errors
```

If `retriever.search` rejects (e.g., embedding model unloaded, OOM, corrupt cache), Express 4 does **not** catch the rejection. The client hangs until the load balancer times out and Node may emit `unhandledRejection`.

Same shape repeats in `/api/xapi/event` only because `frontendEvent` is synchronous — but that's accidental safety.

**Fix:** either
- Upgrade to **Express 5** (handles async errors natively), or
- Wrap handlers in an `asyncHandler(fn)` helper that does `Promise.resolve(fn(req, res, next)).catch(next)`, and
- Add a global error middleware that translates errors into SSE `error` events if headers are already sent, JSON otherwise.

Also move the `try { ... }` block in `/api/deliberate` up to wrap the search call so SSE-state-aware error handling is uniform.

### 2.4 Mild XSS surface in frontend error path
**File:** `public/index.html:3117, 3162` · **Severity:** Medium

```js
throw new Error(`后端错误 ${response.status}: ${await response.text()}`);
...
header.innerHTML = `<span class="pulse-dot" ...></span>问心受阻 · ${err.message}`;
```

The raw body of an HTTP error response is interpolated into `innerHTML`. If the backend (or anything proxying it — gateway, WAF, CORS preflight responder) ever returns HTML with a `<img onerror>`, it executes.

**Fix:** Replace `header.innerHTML = ...` with two children: a `<span class="pulse-dot">` and a text-node holding `err.message`. Same fix at `realDeliberate` initial state line ~3082, and the rendered `googleProfileName` at line 2731 (already safer because it's from a JWT you decoded, but still `innerHTML` with template-string interpolation — flip to `textContent`).

---

## 3. Security & privacy

### 3.1 Service-account key on disk
**File:** `gcs-key.json` (working tree only; correctly gitignored)

Properly excluded from git. But it sits in the repo working directory next to source, which means:
- A misconfigured editor / extension may upload it (telemetry, AI assistants, etc.)
- `docker build .` with a permissive `COPY . .` will bake the key into images
- Backup tooling captures it

**Fix:** Move it outside the repo (e.g., `~/.config/gcloud/wwwd-key.json`), point `WWWD_GCS_KEY_FILE` at the new path. Better: use Application Default Credentials (`gcloud auth application-default login` for local, workload identity on Cloud Run). The README already mentions this — make it the default.

### 3.2 Anonymous identity is trivially spoofable
**File:** `src/auth.js:75-78`

Anyone can set `X-Wwwd-Session: <any-uuid>` to assume an arbitrary anonymous identity. This is **by design** for the pseudonymity model, but if you ever use the identity hash for anything trust-bearing (rate limits, history, follow-up access) you're trusting client-supplied state.

**Fix:** If/when the actor identity drives anything other than xAPI tagging, mint the session UUID server-side on first hit and return it via `Set-Cookie` (HttpOnly + SameSite=Lax) instead of trusting a client header.

### 3.3 Google ID token in `localStorage`
**File:** `public/index.html:2694, 2706, 2719`

```js
let googleIdToken = localStorage.getItem('wwwd_id_token') || '';
localStorage.setItem('wwwd_id_token', googleIdToken);
```

ID tokens last ~1 hour, so blast radius is small, but `localStorage` is reachable by any XSS payload. If a future dependency upgrade introduces a vuln, the token leaks.

**Fix (in order of effort):**
- Easiest: rely on Google Identity Services' in-memory state and re-prompt on reload (don't persist the JWT).
- Better: have the backend exchange the ID token for a short-lived server-issued session cookie (HttpOnly), and pass nothing through JS.

### 3.4 `/api/xapi/event` doesn't bind sessions to actors
**File:** `server.js:193-201`, `src/lrs.js:262-284`

The handler validates that `verb_key` is allowlisted and `session_id` is a string, but it does not verify that this actor actually started this `session_id` (which was minted in `/api/deliberate` at `server.js:109`). An attacker can spam fake `committed-action` events for any session ID, polluting xAPI data.

**Fix:** Track an in-memory `Map<sessionId, actorIdentity>` populated at `beganDeliberation`, evict after 1h. Reject `/api/xapi/event` when the actor doesn't match. Failing that, at least validate `session_id` is a UUID v4 to filter obvious garbage.

### 3.5 No CSP / no helmet
**File:** `server.js`

No `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, etc. Frontend loads from three CDNs (`fonts.googleapis.com`, `cdn.jsdelivr.net`, `accounts.google.com`) — a CSP that whitelists exactly those reduces XSS impact dramatically.

**Fix:** Add `helmet` with a CSP like:

```js
import helmet from 'helmet';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://accounts.google.com/gsi/client", "'unsafe-inline'"], // remove unsafe-inline after splitting the inline <script>
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc: ["https://fonts.gstatic.com"],
      connectSrc: ["'self'", "https://accounts.google.com"],
      frameSrc: ["https://accounts.google.com"],
    },
  },
}));
```

The `'unsafe-inline'` directives are temporary until you extract the 1,800-line `<style>` and 780-line `<script>` blocks from `index.html` (see §6.1).

### 3.6 `/api/health` is verbose
**File:** `server.js:84-98`

Returns provider, model, base URL, corpus version, embedding dim, LRS endpoint. Useful internally, but on a public deployment this is reconnaissance signal.

**Fix:** Either gate the verbose payload behind `?detail=1` + a server-side token, or strip everything except `{status:'ok'}` when `NODE_ENV==='production'`.

### 3.7 Salt default looks like a placeholder
**File:** `src/auth.js:13`

```js
const HASH_SALT = process.env.WWWD_ACTOR_SALT || 'wwwd-CHANGE-ME-via-Secret-Manager';
```

If a deployment forgets to set `WWWD_ACTOR_SALT`, all instances share the same salt → cross-deployment correlation of actor hashes becomes possible.

**Fix:** Refuse to start with the default salt when `NODE_ENV==='production'`. Print a stern message.

---

## 4. Performance & cost

### 4.1 Four sequential LLM calls; no Anthropic prompt caching
**Files:** `server.js:143-174`, `src/prompts.js:142-159`, `src/providers/anthropic.js`

Each deliberation runs four stages **sequentially**, and each stage re-sends the entire `HAA_PREAMBLE` (~700 chars) plus the stage prompt (~600 chars) plus the retrieved corpus passages (variable). For Anthropic this is pure waste — they have prompt caching that would give ~90% input-token discount on the preamble after the first call.

**Fix (Anthropic-specific):**
```js
// in AnthropicProvider.streamText
this.client.messages.stream({
  model, max_tokens, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  messages, ...
});
```

Split `system` into two blocks: the immutable `HAA_PREAMBLE` (cached) and the per-stage prompt (not cached). Expected savings: roughly 30–50% on input tokens per deliberation. Stage 1 pays full price; stages 2–4 read from cache.

For OpenAI/Azure/Deepseek: prompt caching is automatic for prefixes ≥1024 tokens — your prompts are smaller than that, so no help there. Mitigate by **batching** the stages — see §4.2.

### 4.2 The four stages don't have to be strictly serial
**File:** `server.js:143-174`

Stages 1 and 2 only depend on the scenario. Stage 3 depends on the scenario + retrieved corpus. Stage 4 depends conceptually on stages 1-3, but in practice your prompt doesn't pass prior-stage outputs as context, so **stages are actually parallelizable** given the current prompt design.

A close read of `src/prompts.js`: none of the stage templates reference outputs from previous stages. The only sequencing requirement is the user-visible SSE order, which can be reconstructed at the client side.

**Fix (medium effort):** Run all four `provider.streamText` calls in parallel, buffer their chunks, and interleave the SSE output so stage 1's chunks ship first. Wall-clock improvement: roughly 4× → 1.5×–2× (limited by the slowest stage).

If you **want** later stages to read earlier outputs (which would be more faithful to 心学's chain), that's a prompt-design change worth making — but say so explicitly in `prompts.js`.

### 4.3 RAG: linear scan is fine now, will break at ~1000 passages
**File:** `src/rag.js:90-107`

The dot-product scan is JS-level (`for (let j = 0; j < dim; j++) s += vectors[off + j] * q[j]`). For n=24 passages × dim=512 it's trivial. At n=10,000 it's ~50ms per query — survivable but worth measuring **[verify]**.

**Fix:** When you grow past ~1000 passages, switch to:
- Approximate NN (`hnswlib-node` for in-process, or Cloud Vertex Vector Search / Vespa for managed)
- Or quantize embeddings to int8 (3-4× memory + speed)

Not urgent at current size.

### 4.4 Cold start: embedding model is downloaded on first run
**File:** `src/rag.js:13-42`, `scripts/precompute-embeddings.js`

`Xenova/bge-small-zh-v1.5` (~50 MB) is downloaded from HuggingFace on first `pipeline(...)` call. On Cloud Run cold start this is dead time the user pays for (5-15 seconds **[verify]**).

**Fix:** Bake the model into the deploy image:
```dockerfile
RUN node -e "import('@xenova/transformers').then(m => m.pipeline('feature-extraction','Xenova/bge-small-zh-v1.5',{quantized:true}))"
```
Place this after `npm ci` so it's cached separately from app code. Or commit the cache under `.cache/transformers/` to a release branch (it's already gitignored — that's deliberate, but you can override per-deploy).

### 4.5 `embeddings.json` is text JSON
**File:** `src/rag.js:62-65`, `scripts/precompute-embeddings.js:59-65`

```js
vectors: Array.from(this.embeddings.vectors), // Float32Array -> JS Array -> JSON
```

For n=24 this is 258 KB. At n=10,000 it's ~100 MB — bigger than necessary by ~4× because every float costs ~10-20 chars instead of 4 bytes binary. The Python sample used `.npy`; the comment in `gcs.js` acknowledges this is a trade-off.

**Fix when scaling:** add an `embeddings.f32` binary format (raw `Float32Array.buffer`). Keep `embeddings.json` as the small-corpus default for debuggability.

### 4.6 Mysterious 50ms inter-stage sleep
**File:** `server.js:173`

```js
await new Promise(r => setTimeout(r, 50));
```

No comment. Probably a workaround for some SSE flush quirk. If it isn't load-bearing, delete it. If it is, comment why (e.g., "let proxy flush before next event burst").

---

## 5. Reliability & error handling

### 5.1 LRS error counter never resets
**File:** `src/lrs.js:39, 58-66`

```js
let lrsErrorCount = 0;
...
if (!res.ok && lrsErrorCount < 5) { lrsErrorCount += 1; console.warn(...); }
```

After 5 LRS failures, the warnings stop **forever** (for the lifetime of the process). If the LRS is flaky and recovers, you won't know it failed again until restart.

**Fix:** Decay the counter — e.g., decrement every 5 minutes — or use a sliding-window logger (warn at most 5 per hour). Bonus: expose `lrs_error_count` on `/api/health` (internal mode only).

### 5.2 Anthropic stream abort wiring may be brittle
**File:** `src/providers/anthropic.js:25-27`

```js
if (signal) signal.addEventListener('abort', () => stream.controller?.abort?.(), { once: true });
```

`stream.controller` is an internal SDK property. Newer SDK versions may rename/remove it. `@anthropic-ai/sdk@^0.30.1` is pinned, but a casual minor bump could silently break aborts (request would continue, costing tokens).

**Fix:** Pass `signal` directly into `messages.stream` when the SDK supports it (later versions do), and remove the manual wiring. **[verify]** which SDK version added that option.

### 5.3 No timeout on `/api/deliberate`
**File:** `server.js:103-188`

A misbehaving provider could hang the SSE stream indefinitely. The abort is wired to `req.on('close')` but if the model just stalls and the client patiently waits, nothing fires.

**Fix:** Add a per-stage soft deadline (e.g., 60s) using `AbortController.abort()` on a `setTimeout`; emit an `error` SSE event with `{stage, reason:'timeout'}` instead of hanging.

### 5.4 Frontend `realDeliberate` doesn't tolerate partial network drops
**File:** `public/index.html:3120-3160`

`reader.read()` in a loop with no retry. If the SSE connection drops mid-stage 3, the user sees no chunks after that point and the header stays in "正在审心". The `try`/`catch` only fires for thrown exceptions; a silent disconnect just stops looping.

**Fix:** Detect "done with no `complete` event" as an error case → display "连接中断". Optionally implement reconnection via the EventSource API (which has built-in reconnect) instead of `fetch` + manual streaming.

### 5.5 Frontend resilience: backend health is checked once
**File:** `public/index.html:2785-2801, 3344`

`checkBackend()` runs on `DOMContentLoaded` and never again. If the backend goes down later, the user gets the cryptic error path at §2.4 instead of the friendly "demo mode" fallback.

**Fix:** Re-run `checkBackend()` before each `/api/deliberate` call, or wrap the deliberate POST so a 5xx flips `backendAvailable=false` and routes the next click to mock mode.

---

## 6. Frontend quality (`public/index.html`)

### 6.1 The monolith
3,444 lines, with:
- ~1,800 lines of inline `<style>` (lines 11–1858)
- ~780 lines of inline `<script>` (lines 2660–3441)
- ~800 lines of HTML in between
- Hard-coded `scenarios` (lines 2834–2891) and `caseLibrary` (lines 2896–2906) inside JS

This is fine for a single-page demo but actively hostile to:
- Maintainability (CSS rules are unscoped, e.g. `button { ... }`)
- CDN caching (HTML is uncacheable; CSS could be `Cache-Control: immutable`)
- CSP hardening (every inline block needs `'unsafe-inline'` or nonces)

**Fix:**
- Extract `<style>` → `public/style.css`
- Extract `<script>` → `public/app.js`
- Move `scenarios` + `caseLibrary` → `public/scenarios.json`, fetch on load
- Keep `public/index.html` under 500 lines

No build step required — Express's static serving handles it.

### 6.2 CN ↔ TW toggle breaks case filtering
**File:** `public/index.html:2966-2978`

```js
chip.addEventListener('click', () => {
  const filter = chip.textContent.trim();           // ← converts to 繁 in TW mode
  document.querySelectorAll('.case-tile').forEach(tile => {
    if (filter === '全部' || tile.dataset.cat === filter) {  // ← stays as 简
      ...
    }
  });
});
```

`tile.dataset.cat` is set from `c.catFull` (e.g., `'家庭'`) at render time and **never** converted by the OpenCC traversal (which only touches text nodes and a couple of input attributes — not arbitrary `data-*`). So in TW mode `filter='家庭'` (or whichever traditional form OpenCC picks) won't match the simplified `dataset.cat`.

**Fix:** Either
- Compare against an immutable key: store `data-cat-key="jiating"` (pinyin or short code) and have the chip carry the same key.
- Or run the same conversion on `dataset.cat` when toggling script.

Same issue silently affects the case-tile `<span class="case-tile-cat">` display character (line 2952) — gets converted, which is fine — but reinforces that any matching logic should use an opaque ID, not display text.

### 6.3 Accessibility gaps
- Scenario cards (`<button class="scenario-card">`) and filter chips have no `aria-label` describing the case; screen readers hear "button".
- Stage panels are visual-only; no `role="status"` or `aria-live="polite"` on the streaming output, so updates aren't announced.
- Color contrast: `var(--ink-mute)` (#6b5d4b) on `var(--paper)` (#f4ecdc) is roughly 4.6:1 — passes AA for body but borderline for small text **[verify]**.
- The CN/TW toggle is a pair of buttons with character labels; needs `aria-pressed`.

**Fix:** Add appropriate ARIA. Run axe-core or Lighthouse — a one-shot pass would catch most of these.

### 6.4 Inline styles on dynamically rendered elements
**Files:** `index.html:2732, 2808, 2821, 3060-3061, ...`

CSS strings embedded in `innerHTML` and `style.cssText` make theme changes painful and bypass the existing CSS variable system.

**Fix:** Add classes (`auth-bar--signed-in`, `backend-badge--connected`, `stream-target--stage-4`) and put the rules in CSS.

### 6.5 `setTimeout` polling loops
**File:** `index.html:2759, 3325-3337, 3372-3378, 3391-3400`

Five different "poll until X is ready" timers (Google Identity Services, OpenCC, etc.). Each has its own `setInterval`/`setTimeout` lifecycle.

**Fix:** Wrap as `whenReady(() => window.OpenCC)` and `whenReady(() => window.google?.accounts?.id)`, both returning Promises that resolve when the global appears (and reject after 5s). Cleaner cancellation, easier to reason about.

---

## 7. Backend quality (`server.js`, `src/`)

### 7.1 Provider files duplicate streamText boilerplate
**Files:** `src/providers/openai-compat.js:21-40`, `src/providers/azure.js:29-48`

These two `streamText` methods are byte-for-byte identical except for the constructor and the `name` getter. The OpenAI compat class can be the parent; Azure can simply subclass it and override `constructor`.

**Fix:** `class AzureOpenAIProvider extends OpenAICompatProvider` with a 10-line constructor. Saves 30 lines and a future-bug magnet.

### 7.2 Body limit is generous for the request shape
**File:** `server.js:80`

`express.json({ limit: '32kb' })`. Scenario max is 2000 chars (~6 KB of UTF-8 Chinese), and `/api/xapi/event` body is tiny. 32 KB is 5× headroom.

**Fix (paranoid):** drop to `8kb` to make abuse marginally harder.

### 7.3 `req.body || {}` swallows malformed JSON silently
**Files:** `server.js:104, 194`

If `Content-Type: application/json` is sent with malformed JSON, Express's body-parser will set `req.body = undefined` (or throw, depending on version). The `|| {}` here means malformed bodies are treated as empty objects → 422 instead of 400. Mildly misleading client error.

**Fix:** Add a JSON-parse error middleware that responds 400 with `{error:'malformed JSON'}` explicitly.

### 7.4 `/api/xapi/event` validates presence but not shape
**File:** `server.js:194-201`

```js
const { verb_key, session_id, result_ext } = req.body || {};
if (typeof verb_key !== 'string' || typeof session_id !== 'string') return res.status(422).json(...);
```

No length cap. A client posting a 20 MB `session_id` string would get past this gate (until the 32kb body limit catches it elsewhere) and the string would be hashed and emitted.

**Fix:** `if (verb_key.length > 64 || session_id.length > 64 || !UUID_REGEX.test(session_id)) return 422`.

### 7.5 Config drift in `.env`
The repo's working-tree `.env` contains both:
- `GCS_BUCKET_NAME=`, `GCS_PROJECT_ID=`, `GCS_KEY_FILE=` (unused by code)
- `WWWD_GCS_BUCKET=`, `WWWD_GCS_KEY_FILE=`, `WWWD_GCP_PROJECT=` (consumed by `src/corpus/index.js`)

The non-`WWWD_`-prefixed ones look like leftovers from an earlier iteration. They're harmless but confusing.

**Fix:** Either delete the unused variables from `.env.example`, or unify on one naming scheme. (`.env` itself isn't tracked, so this is mostly an `.env.example` hygiene issue **[verify]** — check if any caller still reads `GCS_*`.)

### 7.6 Default Anthropic model
**File:** `src/providers/index.js:27`

```js
defaultModel: 'claude-opus-4-5',
```

If `ANTHROPIC_MODEL` isn't set, you're defaulting to the most expensive Claude model. For a 4-stage chain at 1024 max-tokens each, that's not trivial.

**Fix:** Default to `claude-haiku-4-5` (or sonnet) and have users opt into opus via env. The README's Quick Start would still work end-to-end on the cheaper default.

---

## 8. Testing & DX

### 8.1 Zero tests
No `test/`, no test runner in `package.json`. The four `scripts/check-*.js` are excellent smoke tests for **infrastructure**, but no tests cover:
- `prompts.buildStageMessages` (regression risk when prompts evolve)
- `auth.resolveActor` (most subtle code in the repo)
- `lrs.frontendEvent` allowlist filtering
- `rag.search` ordering (deterministic with fixed corpus + query)

**Fix:** Add `node --test` (built-in, zero dependencies). Start with `prompts.test.js` and `auth.test.js`, which are pure functions / take a mock req. Aim for ~20 cases; takes an afternoon.

### 8.2 No lint / format config
No `.eslintrc`, no `.prettierrc`, no `editorconfig`. Style is consistent across files (good sign of a careful author), but a fresh contributor has no automated guard rails.

**Fix:** Drop in `eslint:recommended` + `prettier`, run on pre-commit via `husky` or just document it in `package.json` scripts.

### 8.3 No CI
No `.github/workflows/`. Means §8.1 and §8.2 only run when someone remembers.

**Fix:** Single GitHub Actions workflow: `npm ci && npm test && npm run lint`. Even with zero tests, having the lint pass on PRs catches a lot.

### 8.4 No Dockerfile / deploy artifact
README references `samples/extracted/DEPLOYMENT.md` (Python) but the Node side has no `Dockerfile`, no `cloudbuild.yaml`. Reproducing the deploy is left as an exercise.

**Fix:** Commit a minimal multi-stage `Dockerfile`:
```dockerfile
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node -e "import('@xenova/transformers').then(m=>m.pipeline('feature-extraction','Xenova/bge-small-zh-v1.5',{quantized:true}))"
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "server.js"]
```

### 8.5 No structured logging
Console logs are human-readable, which is fine for stdout-driven Cloud Logging — but mixing `console.log(JSON.stringify(...))` (lrs.js:100) with free-form `console.log` strings (server.js:64-73) makes log parsers cranky.

**Fix:** Wrap all server-side logging in a thin helper that emits `{kind, ts, ...}` JSON in production and pretty strings in dev.

---

## 9. Documentation & ethics

### 9.1 README
Strong. Clear quick-start, table of providers, GCS section. **Minor:** the "Anonymous mode" flow isn't explained — a reader has to read `auth.js` to learn that sending no headers gives an "ephemeral" identity. Add three lines.

### 9.2 Corpus warning is good — make it enforced
**File:** `data/corpus.json:5`
```json
"warning": "⚠ 此为示例语料 · 仅作开发测试之用 · 部署前必须以权威校勘本…"
"verification_required": true
```
Beautiful that this is in the data file. Nothing checks it though — a deployment with the sample corpus is technically possible. Add a startup-time check:
```js
if (process.env.NODE_ENV === 'production' && corpus._meta?.verification_required === true) {
  console.error('Refusing to run in production with an unverified corpus.');
  process.exit(1);
}
```

### 9.3 Privacy promise ("不传") deserves a CSP equivalent
The lrs.js comment block listing what is/isn't recorded is excellent. Promote it to a top-level `PRIVACY.md` — easier to point at than `// 「不传」之实践` buried in a source file.

---

## 10. Suggested roadmap

Tiered so you can stop at any level and still have improved the project:

### Tier 1 — Before public deployment (1-2 days)
1. **§2.1** Change `CORS_ORIGINS` default; require explicit allow-list in prod.
2. **§2.2** Add `express-rate-limit` on `/api/deliberate` and `/api/xapi/event`.
3. **§2.3** Wrap async handlers; add global error middleware.
4. **§2.4** Replace `innerHTML` with `textContent` on error and auth paths.
5. **§3.7** Refuse to boot in prod with placeholder salt.
6. **§9.2** Refuse to boot in prod with unverified corpus.

### Tier 2 — Hardening & cost (3-5 days)
7. **§4.1** Anthropic prompt caching for the HAA preamble.
8. **§3.5** Add `helmet` + CSP.
9. **§3.4** Bind session IDs to actors.
10. **§5.1, §5.3** LRS error decay; per-stage timeouts.
11. **§7.6** Cheaper default model.
12. **§8.4** Commit `Dockerfile`.

### Tier 3 — Quality of life (1-2 weeks)
13. **§6.1** Split `index.html` into HTML / CSS / JS / data files.
14. **§6.2, §6.3** Fix TW filter bug; add ARIA.
15. **§8.1, §8.2, §8.3** Tests + lint + CI.
16. **§4.2** Parallelize stages (if you want, after thinking through whether stages 2-4 should see prior outputs).
17. **§7.1** Refactor provider hierarchy.

### Tier 4 — Future scale (when needed)
18. **§4.3, §4.5** ANN index + binary embeddings — only when corpus > ~1000 passages.
19. **§5.4** EventSource reconnection.

---

## 11. What's already good (worth preserving as you refactor)

- The **provider/corpus/LRS** abstractions are clean and small. Don't over-engineer them.
- The **`HAA_PREAMBLE` + five constraints** in `prompts.js` is unusually principled prompt design — keep that voice when you make any prompt change.
- The **"不传" comment block** in `lrs.js:7-8` and the safe-result-keys allowlist are good operational privacy. Promote, don't dilute.
- The **`scripts/check-*.js`** smoke tests are a perfect pattern. Add `check-corpus.js` when you have a corpus verification step.
- The **English/Chinese log lines** in `server.js:64-73` are charming and informative. Don't sterilize them.

---

_End of review._
