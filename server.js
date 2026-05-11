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
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { CorpusRetriever } from './src/rag.js';
import { createCorpusLoader } from './src/corpus/index.js';
import { buildStageMessages, STAGE_NAMES } from './src/prompts.js';
import { actorMiddleware, authConfig } from './src/auth.js';
import { createProvider, describeProvider } from './src/providers/index.js';
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
  .split(',').map(s => s.trim()).filter(Boolean);

if (IS_PROD && CORS_ORIGINS.includes('*') && process.env.WWWD_REQUIRE_AUTH !== '1') {
  console.error(
    "✗ Refusing to start: CORS_ORIGINS='*' with WWWD_REQUIRE_AUTH unset in production.\n" +
    "  Either set CORS_ORIGINS to an explicit allow-list, or set WWWD_REQUIRE_AUTH=1.",
  );
  process.exit(1);
}
if (IS_PROD && CORS_ORIGINS.length === 0) {
  console.error("✗ Refusing to start: CORS_ORIGINS must be set explicitly in production.");
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

console.log('='.repeat(60));
console.log('阳明何为 · 启动中');
console.log(`  LLM    · ${providerInfo.provider} · ${providerInfo.model}` +
            (providerInfo.baseURL ? ` · ${providerInfo.baseURL}` : ''));
console.log(`  Corpus · ${loader.name} ${JSON.stringify(loader.describe())}`);
console.log(`  LRS    · stdout` + (lrs.lrsConfig.forwardToLrs ? ` + ${lrs.lrsConfig.endpoint}` : ''));
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
    "✗ Refusing to start: corpus is marked verification_required=true. " +
    "Replace data/corpus.json with a verified edition before deploying.",
  );
  process.exit(1);
}

// ────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

// Security headers + CSP. 'unsafe-inline' remains for now because
// public/index.html still has inline <style> and <script> blocks; §6.1
// will extract them and these directives can then be removed.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.jsdelivr.net',
        'https://accounts.google.com',
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://accounts.google.com'],
      frameSrc: ['https://accounts.google.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Cross-Origin-Opener-Policy default ('same-origin') breaks the Google
  // Identity Services popup flow. Loosen to 'same-origin-allow-popups'.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  // SSE responses include credentials by virtue of cookies; the default
  // CORP of 'same-origin' is fine for the static assets.
}));

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
const actorKey = (req) => (req.actor?.identity ? `actor:${req.actor.identity}` : `ip:${req.ip}`);
const limitMessage = { error: 'Too many requests — please try again later.' };

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
  keyGenerator: (req) => `ip:${req.ip}`,
  message: limitMessage,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

app.get('/api/health', healthLimiter, (req, res) => {
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
      require_auth: authConfig.requireAuth,
    },
  });
});

// ────────────────────────────────────────────────
// /api/deliberate · SSE stream of four stages
// ────────────────────────────────────────────────
app.post('/api/deliberate', deliberateLimiter, asyncHandler(async (req, res) => {
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

    lrs.beganDeliberation(req.actor, scenario, mode, script, sessionId);
    lrs.consultedPassages(req.actor, retrieved.map(p => p.id), sessionId);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Wwwd-Session', sessionId);
    res.flushHeaders?.();

    send('session', { session_id: sessionId });

    send('corpus', {
      passages: retrieved.map(p => ({
        source: p.source,
        text: p.text,
        score: p.score ?? 0,
      })),
    });

    for (const stage of [1, 2, 3, 4]) {
      if (abortCtrl.signal.aborted) break;
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

      for await (const text of provider.streamText({
        system,
        messages,
        maxTokens: 1024,
        signal: abortCtrl.signal,
      })) {
        if (abortCtrl.signal.aborted) break;
        outputChars += text.length;
        send('stage_chunk', { stage, text });
      }

      const stageMs = Date.now() - stageStart;
      lrs.completedStage(req.actor, stage, STAGE_NAMES[stage], stageMs, outputChars, sessionId);
      send('stage_end', { stage });
      stagesCompleted += 1;
      await new Promise(r => setTimeout(r, 50));
    }

    const totalMs = Date.now() - startedAt;
    lrs.completedDeliberation(req.actor, totalMs, stagesCompleted, sessionId);
    if (!abortCtrl.signal.aborted) send('complete', { message: '问心已成' });
  } catch (err) {
    const totalMs = Date.now() - startedAt;
    lrs.completedDeliberation(req.actor, totalMs, stagesCompleted, sessionId);
    if (!abortCtrl.signal.aborted) {
      send('error', { message: err.message || String(err), stage: stagesCompleted + 1 });
    }
  } finally {
    res.end();
  }
}));

// ────────────────────────────────────────────────
// /api/xapi/event · whitelisted frontend events
// ────────────────────────────────────────────────
app.post('/api/xapi/event', xapiLimiter, asyncHandler(async (req, res) => {
  const { verb_key, session_id, result_ext } = req.body || {};
  if (typeof verb_key !== 'string' || typeof session_id !== 'string') {
    return res.status(422).json({ error: 'verb_key and session_id required' });
  }
  const stmt = lrs.frontendEvent(req.actor, verb_key, session_id, result_ext);
  if (!stmt) return res.status(400).json({ error: `Verb '${verb_key}' not in allowlist` });
  res.json({ ok: true, id: stmt.id });
}));

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
  const safeMessage = IS_PROD ? 'internal error' : (err?.message || String(err));
  console.error(`[error] ${req.method} ${req.path} → ${err?.stack || err}`);
  if (res.headersSent) {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: safeMessage, stage: null })}\n\n`);
    } catch (_) { /* connection probably already dead */ }
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
