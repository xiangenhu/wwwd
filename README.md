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
       ├─ src/providers/      · pluggable LLM (Anthropic | OpenAI | Azure | Deepseek | Zhipu | …)
       ├─ src/corpus/         · pluggable storage (local file | GCS)
       ├─ src/rag.js          · bge-small-zh-v1.5 embeddings (transformers.js) + cosine
       ├─ src/prompts.js      · 四阶 prompt chain + HAA preamble
       ├─ src/auth.js         · OAuth gateway → Google ID-token → anonymous session
       ├─ src/oauth-gateway.js· verifier client for oauth.xiangenhu.info
       ├─ src/profile-store.js· GCS-backed user profile (gateway auth)
       ├─ src/scenario.js     · age- and life-stage-aware scenario generator
       ├─ src/email.js        · SMTP via the gateway's send-email proxy
       └─ src/lrs.js          · xAPI → stdout (always) + LRS POST (when configured)
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

| Provider         | `LLM_PROVIDER=` | Required env                                                                               |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------ |
| Anthropic Claude | `anthropic`     | `ANTHROPIC_API_KEY` (default model: `claude-haiku-4-5`; set `ANTHROPIC_MODEL` to override) |
| OpenAI           | `openai`        | `OPENAI_API_KEY` (+ `OPENAI_MODEL=gpt-4o`)                                                 |
| Azure OpenAI     | `azure`         | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`               |
| Deepseek         | `deepseek`      | `DEEPSEEK_API_KEY` (+ `DEEPSEEK_MODEL=deepseek-chat`)                                      |
| Zhipu / GLM      | `zhipu`         | `ZHIPU_API_KEY` (+ `ZHIPU_MODEL=glm-4-plus`)                                               |
| Anything else¹   | `openai-compat` | `OPENAI_COMPAT_API_KEY` + `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_MODEL`                 |

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

## OAuth gateway

The backend trusts the gateway at `oauth.xiangenhu.info` (override with
`WWWD_OAUTH_GATEWAY_URL`) as the primary identity source. The flow is:

1. Frontend redirects the user to `https://oauth.xiangenhu.info/auth/{provider}/login`
   (`google`, `microsoft`, `github`, …).
2. Gateway runs the upstream OAuth dance, then returns a Bearer JWT.
3. Frontend includes that JWT as `Authorization: Bearer <jwt>` on backend calls.
4. Backend GETs `{gateway}/auth/userinfo` once per token (cached 5 min in
   process); a 200 + `{user:{email,name,picture,provider}}` means the
   token is valid.

JWT signature verification is the gateway's responsibility — this backend
holds no provider secrets. The user's actor identity is keyed off their
lower-cased email, so the same human is the same actor regardless of
which provider they used. Set `WWWD_OAUTH_GATEWAY_DISABLE=1` to skip the
gateway entirely (useful for fully-offline dev).

The legacy direct Google ID-token path (`GOOGLE_OAUTH_CLIENT_ID`) is
retained as a fallback for clients still using GIS one-tap.

## Endpoints

| Method | Path                     | Auth     | Notes                                                               |
| ------ | ------------------------ | -------- | ------------------------------------------------------------------- |
| GET    | `/api/health`            | none     | corpus + provider + LRS + gateway introspection                     |
| POST   | `/api/deliberate`        | optional | SSE: `session`, `corpus`, `stage_{start,chunk,end}`, `complete`     |
| POST   | `/api/xapi/event`        | optional | whitelisted frontend events only                                    |
| GET    | `/api/profile`           | gateway  | returns the user's profile + schema enum lists                      |
| PUT    | `/api/profile`           | gateway  | partial update; validated against `PROFILE_SCHEMA`                  |
| POST   | `/api/scenario/generate` | gateway  | returns N age-appropriate scenarios derived from the user profile   |
| POST   | `/api/email/summary`     | gateway  | sends a deliberation summary to the user via the gateway SMTP proxy |
| GET    | `/`                      | none     | serves `public/index.html`                                          |

Gateway-authed endpoints require a valid `Authorization: Bearer <jwt>`
issued by the gateway; they 401 otherwise. `/api/deliberate` and
`/api/xapi/event` also accept the gateway JWT (and append history to
the user's profile on completion) but fall back to anonymous mode when
absent.

### Headers consumed

- `Authorization: Bearer <gateway-jwt>` → `gateway:<hash>` (primary)
- `Authorization: Bearer <google-id-token>` → `google:<hash>` (legacy fallback)
- `X-Wwwd-Session: <uuid>` → `anon:<hash>` (anonymous mode)
- Without either → ephemeral statements

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
├── auth.js                     OAuth gateway / Google ID-token / anon session
├── oauth-gateway.js            verifier client for oauth.xiangenhu.info
├── profile-store.js            GCS-backed user profile (gateway auth)
├── scenario.js                 age-banded scenario generator
├── email.js                    SMTP wrapper for the gateway's send-email proxy
└── lrs.js                      xAPI builders + stdout/LRS sinks
data/                           corpus.json, embeddings.json (auto-generated)
public/index.html               frontend portal
scripts/precompute-embeddings.js
samples/extracted/              original Python reference (kept for reference)
```
