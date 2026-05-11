// Minimal LLM smoke test · uses the configured provider with max_tokens=30.
// Usage:
//   node scripts/check-llm.js              → uses LLM_PROVIDER from .env
//   LLM_PROVIDER=openai node scripts/check-llm.js   → override at run-time
//
// Expected cost: ≤ $0.002 per run.

import 'dotenv/config';
import { createProvider, describeProvider } from '../src/providers/index.js';

const info = describeProvider();
console.log(
  `provider · ${info.provider} · ${info.model}` + (info.baseURL ? ` · ${info.baseURL}` : ''),
);

let provider;
try {
  provider = createProvider();
} catch (err) {
  console.error(`✗ config error: ${err.message}`);
  process.exit(1);
}

const t0 = Date.now();
let chunks = 0;
let chars = 0;
let firstChunkMs = null;
process.stdout.write('reply    · ');

try {
  for await (const text of provider.streamText({
    system: '你是一名简洁的助手。',
    messages: [{ role: 'user', content: '请用一句不超过十二字的话回答：知行合一是何意？' }],
    maxTokens: 30,
  })) {
    if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
    chunks += 1;
    chars += text.length;
    process.stdout.write(text);
  }
  process.stdout.write('\n');
  console.log(
    `stats    · ${chunks} chunks, ${chars} chars, ttft=${firstChunkMs}ms, total=${Date.now() - t0}ms`,
  );
  console.log('✓ ok');
} catch (err) {
  process.stdout.write('\n');
  console.error(`✗ ${err.constructor.name}: ${err.message}`);
  if (err.status) console.error(`  http_status=${err.status}`);
  process.exit(1);
}
