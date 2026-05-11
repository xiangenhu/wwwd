// GCS connectivity smoke test
//
//   npm run check-gcs
//
// What it does:
//   1. Reads service-account credentials from WWWD_GCS_KEY_FILE / ADC.
//   2. Lists buckets the credential can see (sanity check on the SA).
//   3. If WWWD_GCS_BUCKET is set, probes that bucket and lists objects
//      under corpus/{WWWD_CORPUS_VERSION}/.

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { GCSCorpusLoader } from '../src/corpus/gcs.js';

const keyFile = process.env.WWWD_GCS_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const projectId = process.env.WWWD_GCP_PROJECT;
const bucket = process.env.WWWD_GCS_BUCKET;
const version = process.env.WWWD_CORPUS_VERSION || 'v1';

console.log('credentials ·', keyFile ? path.resolve(keyFile) : '(ADC / metadata)');
if (keyFile && !fs.existsSync(keyFile)) {
  console.error(`✗ key file not found: ${keyFile}`);
  process.exit(1);
}

let saInfo = null;
if (keyFile) {
  try {
    const k = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    saInfo = { project_id: k.project_id, client_email: k.client_email };
    console.log('service acc ·', k.client_email);
    console.log('project     ·', k.project_id);
  } catch (err) {
    console.error(`✗ key file unreadable: ${err.message}`);
    process.exit(1);
  }
}

const storage = new Storage({
  ...(keyFile ? { keyFilename: keyFile } : {}),
  ...(projectId ? { projectId } : {}),
});

console.log('\n[1/2] listing buckets visible to this credential…');
let visible = [];
try {
  const [buckets] = await storage.getBuckets();
  visible = buckets.map(b => b.name);
  if (visible.length) {
    visible.forEach(n => console.log('       ·', n));
  } else {
    console.log('       (no buckets — service account may lack storage.buckets.list, this is fine)');
  }
} catch (err) {
  console.warn(`       ⚠ getBuckets failed: ${err.message}`);
  console.warn('         (often expected — many service accounts have only object-level perms)');
}

if (!bucket) {
  console.log('\n[2/2] WWWD_GCS_BUCKET not set — skipping bucket probe.');
  console.log('       set WWWD_GCS_BUCKET in .env, then re-run.');
  process.exit(0);
}

console.log(`\n[2/2] probing gs://${bucket}/corpus/${version}/`);
const loader = new GCSCorpusLoader({
  bucket,
  version,
  keyFilename: keyFile,
  projectId,
});

const result = await loader.probe();
if (!result.ok) {
  console.error(`✗ ${result.reason}`);
  process.exit(1);
}

console.log(`✓ bucket reachable`);
if (result.objects.length === 0) {
  console.log(`  (prefix is empty — run \`npm run precompute\` to upload corpus + embeddings)`);
} else {
  console.log(`  found ${result.objects.length} object(s):`);
  result.objects.forEach(o =>
    console.log(`    · ${o.name}  (${o.size.toLocaleString()} bytes)`),
  );
}
