# Multi-stage build for WWWD backend.
#
# Stage 1 — deps: install production node_modules.
# Stage 2 — model: pre-fetch the bge-small-zh-v1.5 weights so Cloud Run
#                  cold start doesn't pay the HuggingFace download.
# Stage 3 — runtime: minimal image.

# ─────────────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─────────────────────────────────────────────────────────────
FROM node:20-slim AS model
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Warm the transformers cache. Pin the model name so the cache key
# matches what src/rag.js resolves at runtime.
ENV WWWD_HF_CACHE=/app/.cache/transformers
RUN node -e "import('@xenova/transformers').then(m => { \
  const { env } = m; \
  env.cacheDir = process.env.WWWD_HF_CACHE; \
  env.allowLocalModels = false; \
  return m.pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { quantized: true }); \
}).then(() => console.log('model cache warmed'))"

# ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV WWWD_HF_CACHE=/app/.cache/transformers
ENV PORT=8000

# Drop privileges. The base image ships a 'node' user (uid 1000).
USER node

COPY --chown=node:node --from=deps  /app/node_modules                   ./node_modules
COPY --chown=node:node --from=model /app/.cache/transformers            ./.cache/transformers
COPY --chown=node:node package.json package-lock.json                   ./
COPY --chown=node:node server.js                                        ./
COPY --chown=node:node src                                              ./src
COPY --chown=node:node public                                           ./public
COPY --chown=node:node data                                             ./data

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT||8000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
