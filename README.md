# 阳明何为 · WWWD (Node.js)

Node.js port of the Wang Yangming four-stage deliberation backend.
Same API contract as the Python/Cloud Run version — the bundled
`public/index.html` frontend works against this backend unchanged.

## Stack

```
[ Browser · public/index.html ]
       │  fetch / SSE
       ▼
[ Express server.js ]
       │
       ├─ src/providers/   · pluggable LLM (Anthropic | OpenAI | Azure | Deepseek | Zhipu | …)
       ├─ src/corpus/      · pluggable storage (local file | GCS)
       ├─ src/rag.js       · bge-small-zh-v1.5 embeddings (transformers.js) + cosine
       ├─ src/prompts.js   · 四阶 prompt chain + HAA preamble
       ├─ src/auth.js      · Google OAuth ID-token, anonymous session fallback
       └─ src/lrs.js       · xAPI → stdout (always) + LRS POST (when configured)
```

## Quick start (local · Anthropic · file corpus)

```bash
npm install
cp .env.example .env
# edit .env → set ANTHROPIC_API_KEY
npm start
```

Open http://localhost:8000/.

> First start downloads `Xenova/bge-small-zh-v1.5` (~50 MB, quantized) into
> `.cache/transformers/` and encodes the 24 sample passages once
> (~250 ms). Subsequent starts are instant.

## Switching LLM provider

The provider is selected by **one env var** plus a per-provider key/model.
All other blocks in `.env.example` can stay commented.

| Provider          | `LLM_PROVIDER=`  | Required env                                                                         |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------ |
| Anthropic Claude  | `anthropic`      | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`)                                            |
| OpenAI            | `openai`         | `OPENAI_API_KEY` (+ `OPENAI_MODEL=gpt-4o`)                                           |
| Azure OpenAI      | `azure`          | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`         |
| Deepseek          | `deepseek`       | `DEEPSEEK_API_KEY` (+ `DEEPSEEK_MODEL=deepseek-chat`)                                |
| Zhipu / GLM       | `zhipu`          | `ZHIPU_API_KEY` (+ `ZHIPU_MODEL=glm-4-plus`)                                         |
| Anything else¹    | `openai-compat`  | `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL`           |

¹ Use `openai-compat` for Moonshot, Qwen/Doubao, Mistral La Plateforme,
self-hosted vLLM, or Ollama (`OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1`).
Anything that exposes `/chat/completions` in OpenAI format works.

The server prints the active provider on boot and exposes it at
`GET /api/health` for the frontend to display.

## GCS-backed corpus (production)

```bash
# 1. Authenticate locally (or use a service account on Cloud Run)
gcloud auth application-default login

# 2. Configure
echo 'WWWD_CORPUS_SOURCE=gcs'       >> .env
echo 'WWWD_GCS_BUCKET=wwwd-corpus'  >> .env
echo 'WWWD_CORPUS_VERSION=v1'       >> .env

# 3. Precompute + upload embeddings (one-time, repeat when corpus.json changes)
npm run precompute
# → uploads gs://wwwd-corpus/corpus/v1/embeddings.json

# 4. Boot
npm start
```

Layout in the bucket:

```
gs://{bucket}/corpus/{version}/corpus.json       (you upload this)
gs://{bucket}/corpus/{version}/embeddings.json   (precompute writes this)
gs://{bucket}/corpus/{version}/manifest.json     (optional)
```

Cloud Run runtime caches downloads to `/tmp/wwwd-cache` for the container
lifetime. See `samples/extracted/DEPLOYMENT.md` for the full GCP setup
(IAM, secrets, Cloud Build) — substitute `node server.js` for the
Python/uvicorn invocation.

## Real xAPI LRS

By default xAPI statements only go to stdout (Cloud Logging picks them up
when deployed). To forward to a real LRS:

```env
LRS_ENDPOINT=https://your-lrs.example/xapi
LRS_BASIC_AUTH=<base64-of-user:password>
```

Each emitted statement is also POSTed to `{LRS_ENDPOINT}/statements` with
`Authorization: Basic …` and `X-Experience-API-Version: 1.0.3`,
fire-and-forget. The deliberation stream is never blocked on LRS latency
or errors. First few failures are logged to warn; after that the LRS sink
goes silent (so a dead LRS doesn't spam stdout).

The privacy whitelist is enforced regardless of sink:

- Scenario text and model output are **never** included in statements
- Only hashes, lengths, durations, and stage numbers are emitted
- Frontend-supplied `result_ext` is filtered against `SAFE_RESULT_KEYS`
- Actor identity is `sha256(salt + sub_or_session)[:32]` — pseudonymous,
  never reversible to user PII

## Endpoints

| Method | Path                 | Notes                                                           |
| ------ | -------------------- | --------------------------------------------------------------- |
| GET    | `/api/health`        | corpus + provider + LRS introspection                           |
| POST   | `/api/deliberate`    | SSE: `session`, `corpus`, `stage_{start,chunk,end}`, `complete` |
| POST   | `/api/xapi/event`    | whitelisted frontend events only                                |
| GET    | `/`                  | serves `public/index.html`                                      |

### Headers consumed

- `Authorization: Bearer <google-id-token>` → `google:<hash>`
- `X-Wwwd-Session: <uuid>`                  → `anon:<hash>` (default)
- Without either                            → ephemeral statements

## Configuration reference

See `.env.example` for the canonical list. All variables are optional
except `ANTHROPIC_API_KEY` (or whatever key the chosen provider needs).

## Layout

```
server.js                       Express app, SSE deliberate, /api endpoints
src/
├── providers/
│   ├── index.js                createProvider() factory
│   ├── anthropic.js            Anthropic Messages API
│   ├── azure.js                Azure OpenAI (per-resource endpoint + deployment)
│   └── openai-compat.js        OpenAI / Deepseek / Zhipu / etc.
├── corpus/
│   ├── index.js                createCorpusLoader() factory
│   ├── local.js                read/write from disk
│   └── gcs.js                  download to /tmp cache, write through
├── rag.js                      embedding model + cosine search
├── prompts.js                  四阶 prompt chain + HAA preamble
├── auth.js                     OAuth + anon session
└── lrs.js                      xAPI builders + stdout/LRS sinks
data/                           corpus.json, embeddings.json (auto-generated)
public/index.html               frontend portal
scripts/precompute-embeddings.js
samples/extracted/              original Python reference (kept for reference)
```
