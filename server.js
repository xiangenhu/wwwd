// 阳明何为 · WWWD backend
//
// Same API as samples/extracted/server.py. The frontend in public/index.html
// works against this backend unchanged.
//
//   GET  /api/health
//   POST /api/deliberate   → text/event-stream (SSE)
//   POST /api/xapi/event
//
// Pluggable layers:
//   • LLM provider  · LLM_PROVIDER  · anthropic | openai | deepseek | zhipu | openai-compat
//   • Corpus loader · WWWD_CORPUS_SOURCE · local | gcs
//   • LRS sink      · stdout always; +HTTP POST when LRS_ENDPOINT is set

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';

import crypto from 'node:crypto';
import { CorpusRetriever } from './src/rag.js';
import { createCorpusLoader } from './src/corpus/index.js';
import { buildStageMessages, STAGE_NAMES } from './src/prompts.js';
import { actorMiddleware, authConfig, requireGatewayAuth } from './src/auth.js';
import { createProvider, describeProvider } from './src/providers/index.js';
import {
  createProfileStore,
  validateProfilePatch,
  profileSummaryForPrompt,
  ValidationError as ProfileValidationError,
  PROFILE_SCHEMA,
} from './src/profile-store.js';
import { generateScenarios } from './src/scenario.js';
import { sendEmail, EmailError } from './src/email.js';
import { gatewayConfig } from './src/oauth-gateway.js';
import * as lrs from './src/lrs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// CORS default is dev-only (loopback). Production deployments must set
// CORS_ORIGINS explicitly — wildcard '*' combined with an unauthenticated
// /api/deliberate would let any site on the internet burn the LLM key.
const CORS_DEFAULT = IS_PROD ? '' : `http://localhost:${PORT},http://127.0.0.1:${PORT}`;
const CORS_ORIGINS = (process.env.CORS_ORIGINS || CORS_DEFAULT)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (IS_PROD && CORS_ORIGINS.includes('*') && process.env.WWWD_REQUIRE_AUTH !== '1') {
  console.error(
    "✗ Refusing to start: CORS_ORIGINS='*' with WWWD_REQUIRE_AUTH unset in production.\n" +
      '  Either set CORS_ORIGINS to an explicit allow-list, or set WWWD_REQUIRE_AUTH=1.',
  );
  process.exit(1);
}
if (IS_PROD && CORS_ORIGINS.length === 0) {
  console.error('✗ Refusing to start: CORS_ORIGINS must be set explicitly in production.');
  process.exit(1);
}

// ────────────────────────────────────────────────
// CORS (parity with the Python middleware)
// ────────────────────────────────────────────────
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Wwwd-Session');
  res.setHeader('Access-Control-Expose-Headers', 'X-Wwwd-Session');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// ────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────
const provider = createProvider();
const providerInfo = describeProvider();

const loader = createCorpusLoader();
const retriever = new CorpusRetriever({ loader });
const profileStore = createProfileStore();
const gwCfg = gatewayConfig();

console.log('='.repeat(60));
console.log('阳明何为 · 启动中');
console.log(
  `  LLM     · ${providerInfo.provider} · ${providerInfo.model}` +
    (providerInfo.baseURL ? ` · ${providerInfo.baseURL}` : ''),
);
console.log(`  Corpus  · ${loader.name} ${JSON.stringify(loader.describe())}`);
console.log(`  Profile · ${JSON.stringify(profileStore.describe())}`);
console.log(`  OAuth   · gateway=${gwCfg.gatewayUrl}`);
console.log(
  `  LRS     · stdout` + (lrs.lrsConfig.forwardToLrs ? ` + ${lrs.lrsConfig.endpoint}` : ''),
);
console.log('='.repeat(60));

await retriever.load();
console.log(`语料 · ${retriever.size} 段, dim=${retriever.dim}`);

// Corpus data/corpus.json carries an explicit verification_required flag
// when it's the sample/unverified text. Refuse to serve such a corpus in
// production — the third-stage prompt cites these passages verbatim and
// presents them as classical Confucian text; an unverified version
// circulating under that framing would be misleading.
if (IS_PROD && retriever.manifest?.verification_required === true) {
  console.error(
    '✗ Refusing to start: corpus is marked verification_required=true. ' +
      'Replace data/corpus.json with a verified edition before deploying.',
  );
  process.exit(1);
}

// ────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Security headers + CSP. The frontend now navigates to the OAuth
// gateway via top-level redirect (not iframe / XHR), so the CSP needs
// no allowlist entry for the gateway origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-inline' for scripts — all JS is external.
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        // Inline style attributes (e.g. <div style="width:78%"> for the
        // cultivation bars) remain, so 'unsafe-inline' is still needed
        // here. Tightening would require an attribute-to-class sweep.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // SSE responses include credentials by virtue of cookies; the default
    // CORP of 'same-origin' is fine for the static assets.
  }),
);

app.use(cors);
app.use(express.json({ limit: '32kb' }));
app.use(actorMiddleware());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 doesn't catch async-handler rejections. Wrap async handlers so
// any throw lands in the global error middleware instead of hanging the
// client or triggering an unhandledRejection.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Rate limiting keyed off the pseudonymous actor identity (or IP fallback).
// This means rotating session UUIDs from the same person doesn't help —
// the hash collapses to a single key for anon-with-same-session-cookie,
// and IP catches the no-headers case.
const actorKey = (req) =>
  req.actor?.identity ? `actor:${req.actor.identity}` : `ip:${ipKeyGenerator(req.ip)}`;
const limitMessage = { error: 'Too many requests — please try again later.' };

// session_id → actor.identity, populated when /api/deliberate begins.
// /api/xapi/event rejects events whose claimed session_id belongs to a
// different actor — otherwise anyone could pollute another user's
// xAPI timeline by guessing or scraping a session ID.
const SESSION_TTL_MS = 60 * 60 * 1000; // 1h matches the deliberation rate window
const sessionOwners = new Map(); // sessionId -> { actor, expiresAt }
function rememberSession(sessionId, actor) {
  sessionOwners.set(sessionId, { actor: actor.identity, expiresAt: Date.now() + SESSION_TTL_MS });
  // Opportunistic eviction — cheap O(n) sweep when the map grows.
  if (sessionOwners.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of sessionOwners) if (v.expiresAt < now) sessionOwners.delete(k);
  }
}
function sessionBelongsTo(sessionId, actor) {
  const entry = sessionOwners.get(sessionId);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    sessionOwners.delete(sessionId);
    return false;
  }
  return entry.actor === actor.identity;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deliberateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  limit: Number(process.env.RATE_LIMIT_DELIBERATE || 10),
  keyGenerator: actorKey,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const xapiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1m
  limit: Number(process.env.RATE_LIMIT_XAPI || 60),
  keyGenerator: actorKey,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_HEALTH || 30),
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Health probe.
// In dev (default) returns the full diagnostic payload — used by the
// frontend to render the "实时 AI · model · N 段语料" badge.
// In production, the same detail leaks reconnaissance signal (provider,
// model name, GCS bucket, LRS endpoint); it's only included when a
// matching WWWD_HEALTH_DETAIL_TOKEN is presented in ?token=...
const HEALTH_DETAIL_TOKEN = process.env.WWWD_HEALTH_DETAIL_TOKEN || '';
app.get('/api/health', healthLimiter, (req, res) => {
  const wantDetail = !IS_PROD || (HEALTH_DETAIL_TOKEN && req.query.token === HEALTH_DETAIL_TOKEN);
  if (!wantDetail) {
    return res.json({ status: 'ok' });
  }
  res.json({
    status: 'ok',
    corpus_size: retriever.size,
    corpus_version: process.env.WWWD_CORPUS_VERSION || 'local-dev',
    corpus_source: loader.describe(),
    model: providerInfo.model,
    provider: providerInfo.provider,
    lrs: { stdout: true, forward: lrs.lrsConfig.forwardToLrs },
    auth: {
      oauth_configured: authConfig.oauthConfigured,
      gateway_enabled: authConfig.gatewayEnabled,
      gateway_url: gwCfg.gatewayUrl,
      require_auth: authConfig.requireAuth,
    },
    profile: profileStore.describe(),
  });
});

// ────────────────────────────────────────────────
// Profile · GCS-backed user profile (gateway auth required)
// ────────────────────────────────────────────────
const profileLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PROFILE || 60),
  keyGenerator: actorKey,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.get(
  '/api/profile',
  profileLimiter,
  requireGatewayAuth,
  asyncHandler(async (req, res) => {
    const profile = await profileStore.getOrCreate(req.gatewayUser);
    res.json({ profile, schema: PROFILE_SCHEMA });
  }),
);

app.put(
  '/api/profile',
  profileLimiter,
  requireGatewayAuth,
  asyncHandler(async (req, res) => {
    let patch;
    try {
      patch = validateProfilePatch(req.body || {});
    } catch (err) {
      if (err instanceof ProfileValidationError) {
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }
    const profile = await profileStore.update(req.gatewayUser, patch);
    res.json({ profile });
  }),
);

// ────────────────────────────────────────────────
// Scenario generation · age-appropriate, context-sensitive
// ────────────────────────────────────────────────
const scenarioLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_SCENARIO || 20),
  keyGenerator: actorKey,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.post(
  '/api/scenario/generate',
  scenarioLimiter,
  requireGatewayAuth,
  asyncHandler(async (req, res) => {
    const { count = 4 } = req.body || {};
    const profile = await profileStore.getOrCreate(req.gatewayUser);
    const summary = profileSummaryForPrompt(profile);

    const abortCtrl = new AbortController();
    req.on('close', () => abortCtrl.abort());

    const SCENARIO_TIMEOUT_MS = Number(process.env.SCENARIO_TIMEOUT_MS || 45_000);
    const timer = setTimeout(() => abortCtrl.abort(), SCENARIO_TIMEOUT_MS);

    try {
      const scenarios = await generateScenarios({
        provider,
        summary,
        count,
        signal: abortCtrl.signal,
      });
      res.json({ scenarios, profile_summary: summary });
    } catch (err) {
      console.error(`[scenario/generate] ${err?.stack || err}`);
      res.status(502).json({ error: `scenario generation failed: ${err.message}` });
    } finally {
      clearTimeout(timer);
    }
  }),
);

// ────────────────────────────────────────────────
// Email summary · sends a deliberation summary via the gateway SMTP proxy.
// Body: { subject, body, html? }. Recipient is always req.gatewayUser.email.
// ────────────────────────────────────────────────
const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_EMAIL || 10),
  keyGenerator: actorKey,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.post(
  '/api/email/summary',
  emailLimiter,
  requireGatewayAuth,
  asyncHandler(async (req, res) => {
    const { subject, body, html } = req.body || {};
    const profile = await profileStore.getOrCreate(req.gatewayUser);
    if (!profile.email_prefs?.receive_summaries) {
      return res
        .status(409)
        .json({ error: 'email summaries not enabled — opt in via PUT /api/profile first' });
    }
    try {
      const result = await sendEmail({
        to: req.gatewayUser.email,
        subject: typeof subject === 'string' ? subject : '阳明何为 · 问心摘要',
        body,
        html,
        gatewayToken: req.gatewayToken,
        provider: req.gatewayUser.provider || 'google',
      });
      await profileStore.update(req.gatewayUser, {
        email_prefs: { receive_summaries: true },
      });
      // last_sent_at is not in the validated patch shape, write through directly.
      const p = await profileStore.getOrCreate(req.gatewayUser);
      p.email_prefs.last_sent_at = new Date().toISOString();
      await profileStore._writeRaw(p.id, p);
      res.json({ ok: true, result });
    } catch (err) {
      if (err instanceof EmailError) {
        return res.status(err.status || 502).json({ error: err.message });
      }
      throw err;
    }
  }),
);

// ────────────────────────────────────────────────
// /api/deliberate · SSE stream of four stages
// ────────────────────────────────────────────────
app.post(
  '/api/deliberate',
  deliberateLimiter,
  asyncHandler(async (req, res) => {
    const { scenario, mode = 'standard', script = 'cn' } = req.body || {};
    if (typeof scenario !== 'string' || scenario.length < 10 || scenario.length > 2000) {
      return res.status(422).json({ error: 'scenario must be 10..2000 chars' });
    }

    const sessionId = randomUUID();
    const startedAt = Date.now();
    let stagesCompleted = 0;
    let retrieved;

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abortCtrl = new AbortController();
    req.on('close', () => abortCtrl.abort());

    try {
      retrieved = await retriever.search(scenario, 8);

      rememberSession(sessionId, req.actor);
      lrs.beganDeliberation(req.actor, scenario, mode, script, sessionId);
      lrs.consultedPassages(
        req.actor,
        retrieved.map((p) => p.id),
        sessionId,
      );

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Wwwd-Session', sessionId);
      res.flushHeaders?.();

      send('session', { session_id: sessionId });

      send('corpus', {
        passages: retrieved.map((p) => ({
          source: p.source,
          text: p.text,
          score: p.score ?? 0,
        })),
      });

      const STAGE_TIMEOUT_MS = Number(process.env.STAGE_TIMEOUT_MS || 60_000);
      const PARALLEL_STAGES = process.env.WWWD_PARALLEL_STAGES === '1';

      // Run one stage end-to-end. Emits stage_start, stage_chunk*, stage_end.
      // Throws if the stage's timeout fires (parent abort is silent).
      async function runStage(stage) {
        if (abortCtrl.signal.aborted) return;
        const stageStart = Date.now();
        let outputChars = 0;

        send('stage_start', { stage, name: STAGE_NAMES[stage] });

        const { system, messages } = buildStageMessages({
          stage,
          scenario,
          retrieved,
          mode,
          script,
        });

        // Per-stage soft deadline: a stalled provider would otherwise hold
        // the SSE stream open indefinitely (req.on('close') only fires if
        // the client gives up first). The timeout aborts only this stage.
        const stageAbort = new AbortController();
        const onParentAbort = () => stageAbort.abort();
        abortCtrl.signal.addEventListener('abort', onParentAbort, { once: true });
        const timeoutHandle = setTimeout(() => {
          if (!stageAbort.signal.aborted) {
            stageAbort.abort(new Error(`stage ${stage} exceeded ${STAGE_TIMEOUT_MS}ms`));
          }
        }, STAGE_TIMEOUT_MS);

        try {
          for await (const text of provider.streamText({
            system,
            messages,
            maxTokens: 1024,
            signal: stageAbort.signal,
          })) {
            if (stageAbort.signal.aborted) break;
            outputChars += text.length;
            send('stage_chunk', { stage, text });
          }
        } finally {
          clearTimeout(timeoutHandle);
          abortCtrl.signal.removeEventListener('abort', onParentAbort);
        }

        if (stageAbort.signal.aborted && !abortCtrl.signal.aborted) {
          throw new Error(`stage ${stage} timed out after ${STAGE_TIMEOUT_MS}ms`);
        }

        const stageMs = Date.now() - stageStart;
        lrs.completedStage(req.actor, stage, STAGE_NAMES[stage], stageMs, outputChars, sessionId);
        send('stage_end', { stage });
        stagesCompleted += 1;
      }

      if (PARALLEL_STAGES) {
        // None of the stage prompts reference outputs from earlier stages,
        // so running them concurrently produces the same model output as
        // serial — only the wall-clock changes. SSE writes are synchronous
        // and the client routes chunks by stage_chunk.stage.
        await Promise.all([1, 2, 3, 4].map(runStage));
      } else {
        for (const stage of [1, 2, 3, 4]) {
          if (abortCtrl.signal.aborted) break;
          await runStage(stage);
        }
      }

      const totalMs = Date.now() - startedAt;
      lrs.completedDeliberation(req.actor, totalMs, stagesCompleted, sessionId);
      if (!abortCtrl.signal.aborted) send('complete', { message: '问心已成' });

      // History append: only for gateway-authenticated users, and only on
      // a complete (not aborted) deliberation. Privacy-aligned with LRS —
      // no scenario text stored, only hash + length + metadata.
      if (req.gatewayUser && !abortCtrl.signal.aborted) {
        try {
          const scenarioHash = crypto
            .createHash('sha256')
            .update(scenario)
            .digest('hex')
            .slice(0, 16);
          await profileStore.appendHistory(req.gatewayUser, {
            session_id: sessionId,
            scenario_hash: scenarioHash,
            scenario_len: scenario.length,
            mode,
            script,
            stages_completed: stagesCompleted,
            total_ms: totalMs,
          });
        } catch (err) {
          // Don't fail the SSE response if the history write fails —
          // the user has already received their deliberation.
          console.error(`[profile.appendHistory] ${err?.message || err}`);
        }
      }
    } catch (err) {
      const totalMs = Date.now() - startedAt;
      lrs.completedDeliberation(req.actor, totalMs, stagesCompleted, sessionId);
      if (!abortCtrl.signal.aborted) {
        send('error', { message: err.message || String(err), stage: stagesCompleted + 1 });
      }
    } finally {
      res.end();
    }
  }),
);

// ────────────────────────────────────────────────
// /api/xapi/event · whitelisted frontend events
// ────────────────────────────────────────────────
app.post(
  '/api/xapi/event',
  xapiLimiter,
  asyncHandler(async (req, res) => {
    const { verb_key, session_id, result_ext } = req.body || {};
    if (typeof verb_key !== 'string' || verb_key.length > 64) {
      return res.status(422).json({ error: 'verb_key required (string, ≤64 chars)' });
    }
    if (typeof session_id !== 'string' || !UUID_RE.test(session_id)) {
      return res.status(422).json({ error: 'session_id must be a UUID' });
    }
    // Require that this actor previously started this session via
    // /api/deliberate. Without this, anyone could emit events for any
    // session ID and pollute another actor's xAPI timeline.
    if (!sessionBelongsTo(session_id, req.actor)) {
      return res.status(403).json({ error: 'session_id not owned by this actor' });
    }
    const stmt = lrs.frontendEvent(req.actor, verb_key, session_id, result_ext);
    if (!stmt) return res.status(400).json({ error: `Verb '${verb_key}' not in allowlist` });
    res.json({ ok: true, id: stmt.id });
  }),
);

// ────────────────────────────────────────────────
// JSON body parse errors (malformed Content-Type: application/json)
// ────────────────────────────────────────────────
// (mounted as global error middleware below)

// ────────────────────────────────────────────────
// Global error middleware
// Headers-not-sent  → JSON
// Headers-already-sent (SSE in flight) → SSE 'error' event then close
// ────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'malformed JSON body' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large' });
  }
  const safeMessage = IS_PROD ? 'internal error' : err?.message || String(err);
  console.error(`[error] ${req.method} ${req.path} → ${err?.stack || err}`);
  if (res.headersSent) {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: safeMessage, stage: null })}\n\n`);
    } catch (_) {
      /* connection probably already dead */
    }
    return res.end();
  }
  res.status(err?.status || 500).json({ error: safeMessage });
});

// ────────────────────────────────────────────────
// Listen
// ────────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`门户已立 · http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n门户关闭 (${sig})`);
    server.close(() => process.exit(0));
  });
}
