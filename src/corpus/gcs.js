// GCS-backed corpus loader.
//
// GCS layout (matches the Python sample / DEPLOYMENT.md):
//   gs://{bucket}/corpus/{version}/corpus.json
//   gs://{bucket}/corpus/{version}/embeddings.json    ← Node version uses .json
//   gs://{bucket}/corpus/{version}/manifest.json
//
// Cold start: download blobs to the cache dir (default /tmp/wwwd-cache),
// reuse on subsequent reads within the container's lifetime.
//
// The Python sample uses embeddings.npy. To stay native Node-friendly,
// this loader uses embeddings.json with the same schema as LocalCorpusLoader
// produces. If you only have an .npy from the Python pipeline, run
// `npm run precompute` against the same corpus.json to regenerate as JSON.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Storage } from '@google-cloud/storage';

const CACHE_DIR = process.env.WWWD_CACHE_DIR || path.join(os.tmpdir(), 'wwwd-cache');

export class GCSCorpusLoader {
  constructor({ bucket, version = 'v1' }) {
    if (!bucket) throw new Error('GCSCorpusLoader: bucket is required');
    this.bucket = bucket;
    this.version = version;
    this.storage = new Storage();
    this._bucket = this.storage.bucket(bucket);
  }

  get name() {
    return 'gcs';
  }

  _blobPath(name) {
    return `corpus/${this.version}/${name}`;
  }

  _cachePath(name) {
    return path.join(CACHE_DIR, `${this.version}_${name}`);
  }

  async _download(name) {
    const blobPath = this._blobPath(name);
    const cachePath = this._cachePath(name);
    try {
      const stat = await fs.stat(cachePath);
      if (stat.size > 0) return cachePath;
    } catch (_) { /* miss — fall through */ }

    const blob = this._bucket.file(blobPath);
    const [exists] = await blob.exists();
    if (!exists) return null;

    await fs.mkdir(CACHE_DIR, { recursive: true });
    await blob.download({ destination: cachePath });
    return cachePath;
  }

  async loadCorpus() {
    const local = await this._download('corpus.json');
    if (!local) {
      throw new Error(
        `corpus.json not found at gs://${this.bucket}/${this._blobPath('corpus.json')}`,
      );
    }
    const raw = await fs.readFile(local, 'utf8');
    return JSON.parse(raw);
  }

  async loadEmbeddings() {
    const local = await this._download('embeddings.json');
    if (!local) return null;
    const raw = await fs.readFile(local, 'utf8');
    return JSON.parse(raw);
  }

  async saveEmbeddings(payload) {
    // Write through to GCS so the next container start sees them.
    const cachePath = this._cachePath('embeddings.json');
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(payload));
    await this._bucket
      .file(this._blobPath('embeddings.json'))
      .save(JSON.stringify(payload), { contentType: 'application/json' });
  }

  async loadManifest() {
    const local = await this._download('manifest.json');
    if (!local) return {};
    const raw = await fs.readFile(local, 'utf8');
    return JSON.parse(raw);
  }

  describe() {
    return {
      source: 'gcs',
      bucket: this.bucket,
      version: this.version,
      cacheDir: CACHE_DIR,
    };
  }
}
