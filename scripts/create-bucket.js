// One-shot bucket creator. Tries WWWD_GCS_BUCKET, then WWWD_GCS_BUCKET-{project}
// as a fallback if the global name is taken.

import 'dotenv/config';
import fs from 'node:fs';
import { Storage } from '@google-cloud/storage';

const keyFile = process.env.WWWD_GCS_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const wantedBucket = process.env.WWWD_GCS_BUCKET;
const location = process.env.WWWD_GCS_LOCATION || 'asia-east1';

if (!wantedBucket) {
  console.error('✗ WWWD_GCS_BUCKET not set');
  process.exit(1);
}

const projectId = keyFile ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).project_id : undefined;
const storage = new Storage(keyFile ? { keyFilename: keyFile, projectId } : {});

async function tryCreate(name) {
  try {
    const [b] = await storage.createBucket(name, {
      location,
      uniformBucketLevelAccess: true,
      publicAccessPrevention: 'enforced',
    });
    return { ok: true, name: b.name };
  } catch (err) {
    return { ok: false, code: err.code, message: err.message };
  }
}

console.log(`[bucket] try gs://${wantedBucket} in ${location}…`);
let res = await tryCreate(wantedBucket);

if (!res.ok && (res.code === 409 || /already (own|exists)|conflict|name is not available/i.test(res.message))) {
  // Maybe we already own it (then GET would succeed); maybe taken globally.
  const [exists] = await storage.bucket(wantedBucket).exists();
  if (exists) {
    // Confirm we actually own it by reading metadata.
    try {
      const [meta] = await storage.bucket(wantedBucket).getMetadata();
      console.log(`[bucket] already exists in our project · location=${meta.location}`);
      console.log(`[bucket] ✓ using gs://${wantedBucket}`);
      process.exit(0);
    } catch (_err) {
      console.log(`[bucket] gs://${wantedBucket} taken by another project; trying fallback…`);
    }
  } else {
    console.log(`[bucket] gs://${wantedBucket} taken globally; trying fallback…`);
  }
  const fallbackName = `${wantedBucket}-${projectId}`;
  console.log(`[bucket] try gs://${fallbackName}…`);
  res = await tryCreate(fallbackName);
}

if (!res.ok) {
  console.error(`✗ create failed (${res.code}): ${res.message}`);
  process.exit(1);
}

console.log(`[bucket] ✓ created gs://${res.name}`);
if (res.name !== wantedBucket) {
  console.log(`\n⚠ Fallback name used. Update .env:`);
  console.log(`    WWWD_GCS_BUCKET=${res.name}`);
}
