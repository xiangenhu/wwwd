// Precompute corpus embeddings · uploads to whichever loader is configured.
//
// Reads canonical source corpus from disk, encodes with bge-small-zh-v1.5,
// then uploads corpus.json + embeddings.json + manifest.json to the
// destination loader (local or GCS).
//
// Local (default):
//   npm run precompute
//   → writes data/corpus.json, data/embeddings.json, data/manifest.json
//
// GCS:
//   WWWD_CORPUS_SOURCE=gcs npm run precompute
//   → uploads to gs://{WWWD_GCS_BUCKET}/corpus/{WWWD_CORPUS_VERSION}/

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env as xfEnv } from '@xenova/transformers';
import { createCorpusLoader } from '../src/corpus/index.js';

xfEnv.cacheDir = process.env.WWWD_HF_CACHE || './.cache/transformers';
xfEnv.allowLocalModels = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const SOURCE = process.env.WWWD_SOURCE_CORPUS || path.join(projectRoot, 'data/corpus.json');
const MODEL = process.env.WWWD_EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';
const VERSION = process.env.WWWD_CORPUS_VERSION || 'v1';

console.log(`[precompute] source · ${SOURCE}`);
const corpus = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
console.log(`[precompute] passages · ${corpus.passages.length}`);

const loader = createCorpusLoader();
console.log(`[precompute] dest · ${JSON.stringify(loader.describe())}`);

console.log(`[precompute] loading ${MODEL}…`);
const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });

console.log(`[precompute] encoding…`);
const t0 = Date.now();
const vecs = [];
let dim = 0;
for (const p of corpus.passages) {
  const out = await extractor(p.text, { pooling: 'cls', normalize: true });
  if (!dim) dim = out.data.length;
  vecs.push(out.data);
}
const flat = new Float32Array(vecs.length * dim);
vecs.forEach((v, i) => flat.set(v, i * dim));
console.log(`[precompute] encoded ${vecs.length} × ${dim} in ${Date.now() - t0}ms`);

console.log(`[precompute] uploading corpus.json…`);
if (loader.saveCorpus) await loader.saveCorpus(corpus);

console.log(`[precompute] uploading embeddings.json…`);
await loader.saveEmbeddings({
  model: MODEL,
  count: corpus.passages.length,
  dim,
  vectors: Array.from(flat),
  created_at: new Date().toISOString(),
});

if (loader.saveManifest) {
  console.log(`[precompute] uploading manifest.json…`);
  await loader.saveManifest({
    version: VERSION,
    model: MODEL,
    embedding_dim: dim,
    passage_count: corpus.passages.length,
    created_at: new Date().toISOString(),
  });
}

console.log(`[precompute] ✓ done`);
