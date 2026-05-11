// LRS connectivity smoke test
//
// Builds one minimal xAPI statement and POSTs it to {LRS_ENDPOINT}/statements
// using whatever auth is configured. Prints status + first ~500 chars of the
// LRS response so you can diagnose 401/404/415/etc.
//
// Usage:
//   node scripts/check-lrs.js

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { lrsConfig, probeLrs } from '../src/lrs.js';

console.log('endpoint  ·', lrsConfig.endpoint || '(unset)');
console.log(
  'auth      ·',
  lrsConfig.authType,
  lrsConfig.forwardToLrs ? '(configured)' : '(MISSING)',
);
console.log('version   ·', lrsConfig.xapiVersion);

if (!lrsConfig.forwardToLrs) {
  console.error('\n✗ LRS not configured. Set LRS_ENDPOINT and either');
  console.error('  LRS_USERNAME+LRS_PASSWORD or LRS_BASIC_AUTH in .env.');
  process.exit(1);
}

// Minimal valid xAPI 1.0.3 statement. Pseudonymous actor, no PII.
const stmt = {
  id: randomUUID(),
  actor: {
    objectType: 'Agent',
    account: {
      homePage: 'https://wwwd.skoonline.org',
      name: 'probe:check-lrs-script',
    },
  },
  verb: {
    id: 'http://adlnet.gov/expapi/verbs/experienced',
    display: { 'en-US': 'experienced' },
  },
  object: {
    id: 'https://wwwd.skoonline.org/activities/lrs-probe',
    objectType: 'Activity',
    definition: {
      name: { 'en-US': 'WWWD LRS connectivity probe' },
    },
  },
  timestamp: new Date().toISOString(),
};

console.log('\nstatement id ·', stmt.id);
const t0 = Date.now();
const result = await probeLrs(stmt);
const ms = Date.now() - t0;

if (result.ok) {
  console.log(`\n✓ ${result.status} in ${ms}ms`);
  if (result.body) console.log('  body:', result.body);
} else {
  console.error(`\n✗ ${result.status ? `HTTP ${result.status}` : 'transport failure'} in ${ms}ms`);
  if (result.reason) console.error('  reason:', result.reason);
  if (result.body) console.error('  body:  ', result.body);
  process.exit(1);
}
