// Local-disk corpus loader.
// Used for development and as the default when WWWD_CORPUS_SOURCE is unset.

import fs from 'node:fs/promises';
import path from 'node:path';

export class LocalCorpusLoader {
  constructor({ corpusPath, embeddingsPath }) {
    if (!corpusPath) throw new Error('LocalCorpusLoader: corpusPath is required');
    this.corpusPath = corpusPath;
    this.embeddingsPath = embeddingsPath;
  }

  get name() {
    return 'local';
  }

  async loadCorpus() {
    const raw = await fs.readFile(this.corpusPath, 'utf8');
    return JSON.parse(raw);
  }

  async loadEmbeddings() {
    if (!this.embeddingsPath) return null;
    try {
      const raw = await fs.readFile(this.embeddingsPath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveEmbeddings(payload) {
    if (!this.embeddingsPath) return;
    await fs.mkdir(path.dirname(this.embeddingsPath), { recursive: true });
    await fs.writeFile(this.embeddingsPath, JSON.stringify(payload));
  }

  describe() {
    return { source: 'local', corpus: this.corpusPath, embeddings: this.embeddingsPath || null };
  }
}
