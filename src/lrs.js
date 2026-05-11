// xAPI statement emitter
//
// Stage 1 (current): emit to stdout as JSON. Cloud Run / any logger will pick up.
// Stage 2 (later): change `emit()` once to POST to a real LRS — call sites unchanged.
//
// 「不传」之实践:
//   ✓ Records: pseudonymous actor hash, verb, stage num, duration, char count, passage IDs
//   ✗ Never:   raw scenario text, model output, user names/emails

import crypto from 'node:crypto';

const VERB_BASE = process.env.WWWD_VERB_BASE || 'https://wwwd.skoonline.org/verbs';
const ACTIVITY_BASE = process.env.WWWD_ACTIVITY_BASE || 'https://wwwd.skoonline.org/activities';
const PLATFORM = 'wwwd-portal';

// Optional real LRS forwarding. When LRS_ENDPOINT is set, every emitted
// statement is also POSTed to {LRS_ENDPOINT}/statements with Basic Auth.
// Fire-and-forget — never block deliberation on LRS latency or errors.
const LRS_ENDPOINT = (process.env.LRS_ENDPOINT || '').replace(/\/+$/, '');
const LRS_VERSION = process.env.LRS_XAPI_VERSION || '1.0.3';
const LRS_TIMEOUT_MS = Number(process.env.LRS_TIMEOUT_MS || 2000);
const LRS_AUTH_TYPE = (process.env.LRS_AUTH_TYPE || 'basic').toLowerCase();

function resolveLrsAuthHeader() {
  if (LRS_AUTH_TYPE !== 'basic') {
    console.warn(`[lrs] LRS_AUTH_TYPE='${LRS_AUTH_TYPE}' not supported; only 'basic' is implemented.`);
    return '';
  }
  // Pre-encoded form wins if both are set.
  if (process.env.LRS_BASIC_AUTH) return `Basic ${process.env.LRS_BASIC_AUTH}`;
  const u = process.env.LRS_USERNAME;
  const p = process.env.LRS_PASSWORD;
  if (u && p) return `Basic ${Buffer.from(`${u}:${p}`, 'utf8').toString('base64')}`;
  return '';
}

const LRS_AUTH_HEADER = resolveLrsAuthHeader();

// Sliding-window log limiter: at most 5 warnings per LRS_ERROR_WINDOW_MS.
// Without this, a brief LRS outage produces 5 warnings and then the sink
// goes silent forever; with it, a recovered-then-failing LRS is visible.
const LRS_ERROR_WINDOW_MS = Number(process.env.LRS_ERROR_WINDOW_MS || 5 * 60 * 1000);
const LRS_ERROR_MAX_PER_WINDOW = 5;
let lrsRecentErrors = []; // timestamps
let lrsTotalErrors = 0;

function recordLrsErrorAndShouldLog() {
  const now = Date.now();
  lrsRecentErrors = lrsRecentErrors.filter((t) => now - t < LRS_ERROR_WINDOW_MS);
  lrsTotalErrors += 1;
  if (lrsRecentErrors.length < LRS_ERROR_MAX_PER_WINDOW) {
    lrsRecentErrors.push(now);
    return true;
  }
  return false;
}

async function postToLrs(stmt) {
  if (!LRS_ENDPOINT || !LRS_AUTH_HEADER) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LRS_TIMEOUT_MS);
    const res = await fetch(`${LRS_ENDPOINT}/statements`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LRS_AUTH_HEADER,
        'X-Experience-API-Version': LRS_VERSION,
      },
      // Some LRSes accept a single object, but [array] is the spec form.
      body: JSON.stringify([stmt]),
    });
    clearTimeout(t);
    if (!res.ok && recordLrsErrorAndShouldLog()) {
      const body = await res.text().catch(() => '');
      console.warn(`[lrs] POST failed ${res.status} (total=${lrsTotalErrors}) ${body.slice(0, 200)}`);
    }
  } catch (err) {
    if (recordLrsErrorAndShouldLog()) {
      console.warn(`[lrs] POST error: ${err.message} (total=${lrsTotalErrors})`);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function statementId() {
  return crypto.randomUUID();
}

function scenarioHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function ext(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[`${ACTIVITY_BASE}/ext/${k}`] = v;
  return out;
}

function ctx(sessionId, extra = {}) {
  return {
    platform: PLATFORM,
    extensions: ext({ 'session-id': sessionId, ...extra }),
  };
}

// Single point of egress. Always logs to stdout (Cloud Logging captures it
// on Cloud Run). When LRS_ENDPOINT is configured, also POSTs to the LRS —
// fire-and-forget so the deliberation stream is never blocked.
function emit(stmt) {
  console.log(JSON.stringify({ kind: 'xapi', statement: stmt }));
  if (LRS_ENDPOINT && LRS_AUTH_HEADER) {
    // Don't await — explicitly drop the promise.
    postToLrs(stmt);
  }
}

export const lrsConfig = {
  stdout: true,
  forwardToLrs: Boolean(LRS_ENDPOINT && LRS_AUTH_HEADER),
  endpoint: LRS_ENDPOINT || null,
  xapiVersion: LRS_VERSION,
  authType: LRS_AUTH_TYPE,
};

// Exported for the standalone check script.
export async function probeLrs(stmt) {
  if (!LRS_ENDPOINT) return { ok: false, reason: 'LRS_ENDPOINT not set' };
  if (!LRS_AUTH_HEADER) return { ok: false, reason: 'no LRS auth (set LRS_USERNAME+LRS_PASSWORD or LRS_BASIC_AUTH)' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LRS_TIMEOUT_MS);
    const res = await fetch(`${LRS_ENDPOINT}/statements`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LRS_AUTH_HEADER,
        'X-Experience-API-Version': LRS_VERSION,
      },
      body: JSON.stringify([stmt]),
    });
    clearTimeout(t);
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ────────────────────────────────────────────────
// Statement builders (all strip PII)
// ────────────────────────────────────────────────

export function beganDeliberation(actor, scenario, mode, script, sessionId) {
  const stmt = {
    id: statementId(),
    actor: actor.toXapi(),
    verb: {
      id: `${VERB_BASE}/began-deliberation`,
      display: { 'zh-CN': '始问心', 'en-US': 'began deliberation' },
    },
    object: {
      id: `${ACTIVITY_BASE}/scenario/${scenarioHash(scenario)}`,
      objectType: 'Activity',
      definition: {
        type: `${ACTIVITY_BASE}/types/scenario`,
        name: { 'zh-CN': '情境（隐名）', 'en-US': 'Scenario (pseudonymous)' },
      },
    },
    result: {
      extensions: ext({
        'scenario-length': scenario.length,
        mode,
        script,
      }),
    },
    timestamp: nowIso(),
    context: ctx(sessionId),
  };
  emit(stmt);
  return stmt;
}

export function consultedPassages(actor, passageIds, sessionId) {
  const stmt = {
    id: statementId(),
    actor: actor.toXapi(),
    verb: {
      id: `${VERB_BASE}/consulted-corpus`,
      display: { 'zh-CN': '稽诸传习录', 'en-US': 'consulted corpus' },
    },
    object: { id: `${ACTIVITY_BASE}/corpus/chuanxilu`, objectType: 'Activity' },
    result: { extensions: ext({ 'passage-ids': passageIds }) },
    timestamp: nowIso(),
    context: ctx(sessionId),
  };
  emit(stmt);
  return stmt;
}

export function completedStage(actor, stage, stageName, durationMs, outputCharCount, sessionId) {
  const stmt = {
    id: statementId(),
    actor: actor.toXapi(),
    verb: {
      id: `${VERB_BASE}/completed-stage`,
      display: { 'zh-CN': '成一阶', 'en-US': 'completed stage' },
    },
    object: {
      id: `${ACTIVITY_BASE}/stage/${stage}`,
      objectType: 'Activity',
      definition: {
        name: { 'zh-CN': stageName },
        type: `${ACTIVITY_BASE}/types/deliberation-stage`,
      },
    },
    result: {
      duration: `PT${(durationMs / 1000).toFixed(2)}S`,
      extensions: ext({
        'output-char-count': outputCharCount,
        'stage-num': stage,
      }),
    },
    timestamp: nowIso(),
    context: ctx(sessionId),
  };
  emit(stmt);
  return stmt;
}

export function completedDeliberation(actor, totalDurationMs, stagesCompleted, sessionId) {
  const stmt = {
    id: statementId(),
    actor: actor.toXapi(),
    verb: {
      id: `${VERB_BASE}/completed-deliberation`,
      display: { 'zh-CN': '问心已成', 'en-US': 'completed deliberation' },
    },
    object: { id: `${ACTIVITY_BASE}/deliberation`, objectType: 'Activity' },
    result: {
      completion: stagesCompleted === 4,
      duration: `PT${(totalDurationMs / 1000).toFixed(2)}S`,
      extensions: ext({ 'stages-completed': stagesCompleted }),
    },
    timestamp: nowIso(),
    context: ctx(sessionId),
  };
  emit(stmt);
  return stmt;
}

// ────────────────────────────────────────────────
// Frontend-emitted events (POSTed to /api/xapi/event)
// Server filters even if client sends extras.
// ────────────────────────────────────────────────

const ALLOWED_FRONTEND_EVENTS = {
  'viewed-corpus': { display: { 'zh-CN': '观语料', 'en-US': 'viewed corpus' } },
  'committed-action': { display: { 'zh-CN': '立志', 'en-US': 'committed action' } },
  'parted-ways': { display: { 'zh-CN': '暂别', 'en-US': 'parted ways' } },
  'declined-followup': { display: { 'zh-CN': '辞回访', 'en-US': 'declined follow-up' } },
};

const SAFE_RESULT_KEYS = new Set([
  'action-index',
  'has-concept-tag',
  'session-count',
  'days-since-first',
  'scrolled-to-bottom',
]);

export function frontendEvent(actor, verbKey, sessionId, resultExt) {
  if (!(verbKey in ALLOWED_FRONTEND_EVENTS)) return null;
  const safeExt = {};
  if (resultExt && typeof resultExt === 'object') {
    for (const [k, v] of Object.entries(resultExt)) {
      if (SAFE_RESULT_KEYS.has(k)) safeExt[k] = v;
    }
  }
  const stmt = {
    id: statementId(),
    actor: actor.toXapi(),
    verb: {
      id: `${VERB_BASE}/${verbKey}`,
      display: ALLOWED_FRONTEND_EVENTS[verbKey].display,
    },
    object: { id: `${ACTIVITY_BASE}/portal`, objectType: 'Activity' },
    result: Object.keys(safeExt).length ? { extensions: ext(safeExt) } : {},
    timestamp: nowIso(),
    context: ctx(sessionId),
  };
  emit(stmt);
  return stmt;
}
