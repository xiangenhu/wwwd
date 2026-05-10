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
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

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

// ────────────────────────────────────────────────
// App
// ────────────────────────────────────────────────
const app = express();
app.use(cors);
app.use(express.json({ limit: '32kb' }));
app.use(actorMiddleware());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
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
app.post('/api/deliberate', async (req, res) => {
  const { scenario, mode = 'standard', script = 'cn' } = req.body || {};
  if (typeof scenario !== 'string' || scenario.length < 10 || scenario.length > 2000) {
    return res.status(422).json({ error: 'scenario must be 10..2000 chars' });
  }

  const sessionId = randomUUID();
  const retrieved = await retriever.search(scenario, 8);

  lrs.beganDeliberation(req.actor, scenario, mode, script, sessionId);
  lrs.consultedPassages(req.actor, retrieved.map(p => p.id), sessionId);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Wwwd-Session', sessionId);
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const startedAt = Date.now();
  let stagesCompleted = 0;
  const abortCtrl = new AbortController();
  req.on('close', () => abortCtrl.abort());

  try {
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
});

// ────────────────────────────────────────────────
// /api/xapi/event · whitelisted frontend events
// ────────────────────────────────────────────────
app.post('/api/xapi/event', (req, res) => {
  const { verb_key, session_id, result_ext } = req.body || {};
  if (typeof verb_key !== 'string' || typeof session_id !== 'string') {
    return res.status(422).json({ error: 'verb_key and session_id required' });
  }
  const stmt = lrs.frontendEvent(req.actor, verb_key, session_id, result_ext);
  if (!stmt) return res.status(400).json({ error: `Verb '${verb_key}' not in allowlist` });
  res.json({ ok: true, id: stmt.id });
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
