// Corpus loader factory
//
// Selection: WWWD_CORPUS_SOURCE (default: local)
//   local  — read from disk; paths via WWWD_CORPUS_PATH / WWWD_EMBEDDINGS_PATH
//   gcs    — read from gs://{WWWD_GCS_BUCKET}/corpus/{WWWD_CORPUS_VERSION}/
//
// Both loaders implement: loadCorpus(), loadEmbeddings(), saveEmbeddings(payload),
// describe().

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalCorpusLoader } from './local.js';
import { GCSCorpusLoader } from './gcs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

export function createCorpusLoader(env = process.env) {
  const src = (env.WWWD_CORPUS_SOURCE || 'local').trim().toLowerCase();
  if (src === 'gcs') {
    const bucket = env.WWWD_GCS_BUCKET;
    if (!bucket) throw new Error("WWWD_CORPUS_SOURCE=gcs requires WWWD_GCS_BUCKET");
    return new GCSCorpusLoader({
      bucket,
      version: env.WWWD_CORPUS_VERSION || 'v1',
    });
  }
  if (src !== 'local') {
    throw new Error(`Unknown WWWD_CORPUS_SOURCE='${src}'. Expected: local | gcs`);
  }
  return new LocalCorpusLoader({
    corpusPath: env.WWWD_CORPUS_PATH || path.join(projectRoot, 'data/corpus.json'),
    embeddingsPath:
      env.WWWD_EMBEDDINGS_PATH || path.join(projectRoot, 'data/embeddings.json'),
  });
}
