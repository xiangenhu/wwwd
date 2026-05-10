// Precompute corpus embeddings · uses whichever loader is configured.
//
// Local (default):
//   npm run precompute
//   → writes data/embeddings.json
//
// GCS:
//   WWWD_CORPUS_SOURCE=gcs WWWD_GCS_BUCKET=wwwd-corpus WWWD_CORPUS_VERSION=v1 \
//     npm run precompute
//   → uploads gs://wwwd-corpus/corpus/v1/embeddings.json

import 'dotenv/config';
import { createCorpusLoader } from '../src/corpus/index.js';
import { CorpusRetriever } from '../src/rag.js';

const loader = createCorpusLoader();
console.log('[precompute] loader:', loader.describe());

const r = new CorpusRetriever({ loader });
await r.load();

console.log(`[precompute] done · ${r.size} passages, dim=${r.dim}`);
