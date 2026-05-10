// 良知库 RAG · loader-driven
//
// Cold start:
//   1. loader.loadCorpus()       → corpus.json
//   2. loader.loadEmbeddings()   → cached embeddings (if any)
//   3. encode missing passages with bge-small (CLS pooled, normalized)
//   4. loader.saveEmbeddings(...) → write through (local file / GCS / etc.)
//
// Search: dot-product (cosine since normalized).

import { pipeline, env as xfEnv } from '@xenova/transformers';

xfEnv.cacheDir = process.env.WWWD_HF_CACHE || './.cache/transformers';
xfEnv.allowLocalModels = false;

const DEFAULT_MODEL = process.env.WWWD_EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5';

export class CorpusRetriever {
  constructor({ loader, modelName = DEFAULT_MODEL } = {}) {
    if (!loader) throw new Error('CorpusRetriever: loader is required');
    this.loader = loader;
    this.modelName = modelName;
    this.passages = [];
    this.embeddings = null; // { dim, vectors: Float32Array (n*dim flat) }
    this.extractor = null;
    this.manifest = {};
  }

  async load() {
    const corpus = await this.loader.loadCorpus();
    this.passages = corpus.passages || [];
    this.manifest = corpus._meta || {};

    let cached = null;
    try {
      cached = await this.loader.loadEmbeddings();
    } catch (err) {
      console.warn(`[rag] loader.loadEmbeddings failed: ${err.message}`);
    }

    console.log(`[rag] loading embedding model · ${this.modelName} (first run downloads ~50MB)`);
    this.extractor = await pipeline('feature-extraction', this.modelName, { quantized: true });

    if (cached && cached.model === this.modelName && cached.count === this.passages.length) {
      this.embeddings = {
        dim: cached.dim,
        vectors: Float32Array.from(cached.vectors),
      };
      console.log(`[rag] loaded ${cached.count} cached embeddings · dim=${cached.dim}`);
      return;
    }

    console.log(`[rag] precomputed embeddings missing — encoding ${this.passages.length} passages…`);
    const t0 = Date.now();
    this.embeddings = await this._encodeAll(this.passages.map(p => p.text));
    console.log(`[rag] encoded in ${Date.now() - t0}ms · dim=${this.embeddings.dim}`);

    try {
      await this.loader.saveEmbeddings({
        model: this.modelName,
        count: this.passages.length,
        dim: this.embeddings.dim,
        vectors: Array.from(this.embeddings.vectors),
        created_at: new Date().toISOString(),
      });
      console.log(`[rag] saved embeddings via ${this.loader.name} loader`);
    } catch (err) {
      console.warn(`[rag] failed to save embeddings: ${err.message}`);
    }
  }

  async _encodeOne(text) {
    const out = await this.extractor(text, { pooling: 'cls', normalize: true });
    return out.data;
  }

  async _encodeAll(texts) {
    const vecs = [];
    let dim = 0;
    for (const t of texts) {
      const v = await this._encodeOne(t);
      if (!dim) dim = v.length;
      vecs.push(v);
    }
    const flat = new Float32Array(vecs.length * dim);
    vecs.forEach((v, i) => flat.set(v, i * dim));
    return { dim, vectors: flat };
  }

  async search(query, k = 5) {
    if (!this.passages.length || !this.embeddings || !this.extractor) return [];
    const q = await this._encodeOne(query);
    const { dim, vectors } = this.embeddings;
    const n = this.passages.length;

    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const off = i * dim;
      for (let j = 0; j < dim; j++) s += vectors[off + j] * q[j];
      scores[i] = s;
    }

    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, k).map(i => ({ ...this.passages[i], score: scores[i] }));
  }

  get dim() {
    return this.embeddings?.dim || 0;
  }
  get size() {
    return this.passages.length;
  }
}
