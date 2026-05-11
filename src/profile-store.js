// GCS-backed user profile store.
//
// Layout:
//   gs://{WWWD_GCS_BUCKET}/users/{userid}.json
//
// where userid = sha256(WWWD_ACTOR_SALT + "profile:" + email).slice(0,32).
// Same salt-and-prefix scheme as src/auth.js so the on-disk identifier
// cannot be reversed to an email even by someone with bucket read access.
//
// Profile schema (see PROFILE_SCHEMA below):
//   identity   · email (lowercased, immutable), name, picture, provider
//   demographics · birthdate, age, locale, script (cn|tw), education_level
//   interests  · themes[], life_stage, cultivation_goals[]
//   email_prefs · receive_summaries, last_sent_at
//   history    · capped list of deliberation summaries (no scenario text)
//   created_at, updated_at, version
//
// In-process write coalescing: concurrent updates for the same user are
// serialised through a per-user promise chain so we never lose the last
// writer's data.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Storage } from '@google-cloud/storage';

const HISTORY_CAP = 50;
const PROFILE_VERSION = 1;

// Valid enum values — used for input validation on PUT /api/profile.
const SCRIPTS = new Set(['cn', 'tw']);
const EDUCATION_LEVELS = new Set([
  'primary',
  'middle',
  'high',
  'undergraduate',
  'graduate',
  'doctoral',
  'self-taught',
  'unspecified',
]);
const LIFE_STAGES = new Set([
  'child',
  'teen',
  'student',
  'young-adult',
  'parent',
  'professional',
  'mid-career',
  'retired',
  'unspecified',
]);

export const PROFILE_SCHEMA = {
  scripts: [...SCRIPTS],
  educationLevels: [...EDUCATION_LEVELS],
  lifeStages: [...LIFE_STAGES],
  historyCap: HISTORY_CAP,
};

function todayIso() {
  return new Date().toISOString();
}

function calcAge(birthdate) {
  if (typeof birthdate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function userIdFor(email, salt) {
  if (!email || typeof email !== 'string') throw new Error('userIdFor: email required');
  if (!salt) throw new Error('userIdFor: salt required');
  return crypto
    .createHash('sha256')
    .update(`${salt}profile:${email.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
}

export function emptyProfile({ email, name = '', picture = '', provider = 'google' }) {
  return {
    version: PROFILE_VERSION,
    id: null, // filled in by store on save
    identity: {
      email: email.toLowerCase(),
      name,
      picture,
      provider,
    },
    demographics: {
      birthdate: null, // 'YYYY-MM-DD' or null
      age: null, // derived, cached for prompt builders
      locale: 'zh-CN',
      script: 'cn',
      education_level: 'unspecified',
    },
    interests: {
      themes: [], // free-form short tags, ≤20 chars each, ≤16 entries
      life_stage: 'unspecified',
      cultivation_goals: [], // free-form, ≤80 chars each, ≤8 entries
    },
    email_prefs: {
      receive_summaries: false,
      last_sent_at: null,
    },
    history: [], // newest first
    created_at: todayIso(),
    updated_at: todayIso(),
  };
}

// Input validator for the PUT payload. Returns a sanitised patch or
// throws ValidationError so the route can 422 with a clear message.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 422;
  }
}

function stringOr(v, max) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new ValidationError('expected string');
  const s = v.trim();
  if (s.length > max) throw new ValidationError(`string exceeds ${max} chars`);
  return s;
}

function stringArray(v, { maxItems, maxLen }) {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new ValidationError('expected array');
  if (v.length > maxItems) throw new ValidationError(`array exceeds ${maxItems} items`);
  return v.map((x) => {
    if (typeof x !== 'string') throw new ValidationError('array items must be strings');
    const s = x.trim();
    if (!s) throw new ValidationError('array items must be non-empty');
    if (s.length > maxLen) throw new ValidationError(`array item exceeds ${maxLen} chars`);
    return s;
  });
}

export function validateProfilePatch(patch) {
  if (!patch || typeof patch !== 'object') throw new ValidationError('body must be an object');

  const out = {};

  if (patch.demographics) {
    const d = patch.demographics;
    out.demographics = {};
    if ('birthdate' in d) {
      if (d.birthdate === null) {
        out.demographics.birthdate = null;
      } else {
        const s = stringOr(d.birthdate, 10);
        if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s))
          throw new ValidationError('birthdate must be YYYY-MM-DD');
        if (s) {
          const yr = Number(s.slice(0, 4));
          if (yr < 1900 || yr > new Date().getUTCFullYear())
            throw new ValidationError('birthdate year out of range');
        }
        out.demographics.birthdate = s || null;
      }
    }
    if ('locale' in d) out.demographics.locale = stringOr(d.locale, 16) || 'zh-CN';
    if ('script' in d) {
      const s = stringOr(d.script, 4);
      if (s && !SCRIPTS.has(s)) throw new ValidationError(`script must be one of ${[...SCRIPTS]}`);
      if (s) out.demographics.script = s;
    }
    if ('education_level' in d) {
      const s = stringOr(d.education_level, 32);
      if (s && !EDUCATION_LEVELS.has(s))
        throw new ValidationError(`education_level must be one of ${[...EDUCATION_LEVELS]}`);
      if (s) out.demographics.education_level = s;
    }
  }

  if (patch.interests) {
    const i = patch.interests;
    out.interests = {};
    if ('themes' in i) {
      const arr = stringArray(i.themes, { maxItems: 16, maxLen: 20 });
      if (arr) out.interests.themes = arr;
    }
    if ('life_stage' in i) {
      const s = stringOr(i.life_stage, 24);
      if (s && !LIFE_STAGES.has(s))
        throw new ValidationError(`life_stage must be one of ${[...LIFE_STAGES]}`);
      if (s) out.interests.life_stage = s;
    }
    if ('cultivation_goals' in i) {
      const arr = stringArray(i.cultivation_goals, { maxItems: 8, maxLen: 80 });
      if (arr) out.interests.cultivation_goals = arr;
    }
  }

  if (patch.email_prefs) {
    const p = patch.email_prefs;
    out.email_prefs = {};
    if ('receive_summaries' in p) {
      if (typeof p.receive_summaries !== 'boolean')
        throw new ValidationError('receive_summaries must be boolean');
      out.email_prefs.receive_summaries = p.receive_summaries;
    }
  }

  return out;
}

function mergePatch(profile, patch) {
  const next = JSON.parse(JSON.stringify(profile));
  if (patch.demographics) Object.assign(next.demographics, patch.demographics);
  if (patch.interests) Object.assign(next.interests, patch.interests);
  if (patch.email_prefs) Object.assign(next.email_prefs, patch.email_prefs);
  // Derived: age from birthdate.
  next.demographics.age = calcAge(next.demographics.birthdate);
  next.updated_at = todayIso();
  return next;
}

export class ProfileStore {
  // backend: { kind: 'gcs', bucket, keyFilename?, projectId? } | { kind: 'memory' }
  // The memory backend is only used by tests — production always uses GCS.
  constructor({ backend, salt }) {
    if (!salt) throw new Error('ProfileStore: salt required');
    this.salt = salt;
    this._locks = new Map(); // userId -> Promise (write coalescing)

    if (backend.kind === 'memory') {
      this.backend = 'memory';
      this._mem = new Map();
      return;
    }
    if (backend.kind !== 'gcs') throw new Error(`Unknown backend: ${backend.kind}`);
    if (!backend.bucket) throw new Error('ProfileStore(gcs): bucket required');

    this.backend = 'gcs';
    this.bucket = backend.bucket;
    const opts = {};
    if (backend.keyFilename) opts.keyFilename = backend.keyFilename;
    if (backend.projectId) opts.projectId = backend.projectId;
    this.storage = new Storage(opts);
    this._bucket = this.storage.bucket(backend.bucket);
    this._cacheDir = backend.cacheDir || path.join(os.tmpdir(), 'wwwd-cache');
  }

  _blobPath(userId) {
    return `users/${userId}.json`;
  }

  async _readRaw(userId) {
    if (this.backend === 'memory') {
      const raw = this._mem.get(userId);
      return raw ? JSON.parse(raw) : null;
    }
    const blob = this._bucket.file(this._blobPath(userId));
    const [exists] = await blob.exists();
    if (!exists) return null;
    const [buf] = await blob.download();
    return JSON.parse(buf.toString('utf8'));
  }

  async _writeRaw(userId, profile) {
    const json = JSON.stringify(profile, null, 2);
    if (this.backend === 'memory') {
      this._mem.set(userId, json);
      return;
    }
    await fs.mkdir(this._cacheDir, { recursive: true });
    await this._bucket.file(this._blobPath(userId)).save(json, {
      contentType: 'application/json',
      // Skip resumable upload — these are tiny.
      resumable: false,
    });
  }

  // Serialise writes per user so concurrent get+update operations don't
  // race. Reads are not gated (the worst case is a slightly stale read,
  // which is fine — the GET endpoint is the only caller, and history
  // append flows through update()).
  async _withLock(userId, fn) {
    const prev = this._locks.get(userId) || Promise.resolve();
    const next = prev.then(fn, fn);
    // Don't store rejected promises — they would poison the chain.
    this._locks.set(
      userId,
      next.catch(() => null),
    );
    return next;
  }

  // get-or-create. The gateway has already verified email/name/picture,
  // so we trust them as initial seed values.
  async getOrCreate(gatewayUser) {
    const userId = userIdFor(gatewayUser.email, this.salt);
    return this._withLock(userId, async () => {
      let p = await this._readRaw(userId);
      let dirty = false;
      if (!p) {
        p = emptyProfile(gatewayUser);
        p.id = userId;
        dirty = true;
      } else {
        // Keep identity refreshed from the gateway in case the user changed
        // their name/picture upstream. Email is the stable key — never overwrite.
        if (p.identity?.name !== gatewayUser.name && gatewayUser.name) {
          p.identity.name = gatewayUser.name;
          dirty = true;
        }
        if (p.identity?.picture !== gatewayUser.picture && gatewayUser.picture) {
          p.identity.picture = gatewayUser.picture;
          dirty = true;
        }
        if (!p.id) {
          p.id = userId;
          dirty = true;
        }
      }
      if (dirty) {
        p.updated_at = todayIso();
        await this._writeRaw(userId, p);
      }
      return p;
    });
  }

  // Partial update. validateProfilePatch must be called by the route first.
  async update(gatewayUser, patch) {
    const userId = userIdFor(gatewayUser.email, this.salt);
    return this._withLock(userId, async () => {
      let p = await this._readRaw(userId);
      if (!p) {
        p = emptyProfile(gatewayUser);
        p.id = userId;
      }
      const next = mergePatch(p, patch);
      await this._writeRaw(userId, next);
      return next;
    });
  }

  // Append a history entry. Capped at HISTORY_CAP, newest-first.
  // The entry is whatever the caller hands in — typically:
  //   { session_id, scenario_hash, scenario_len, mode, script,
  //     stages_completed, themes: [], created_at }
  // No raw scenario text — matching the LRS privacy whitelist.
  async appendHistory(gatewayUser, entry) {
    const userId = userIdFor(gatewayUser.email, this.salt);
    return this._withLock(userId, async () => {
      let p = await this._readRaw(userId);
      if (!p) {
        p = emptyProfile(gatewayUser);
        p.id = userId;
      }
      const e = { ...entry, created_at: entry.created_at || todayIso() };
      p.history = [e, ...(p.history || [])].slice(0, HISTORY_CAP);
      p.updated_at = todayIso();
      await this._writeRaw(userId, p);
      return p;
    });
  }

  describe() {
    return {
      backend: this.backend,
      bucket: this.backend === 'gcs' ? this.bucket : null,
    };
  }
}

export function createProfileStore(env = process.env) {
  const salt = env.WWWD_ACTOR_SALT;
  if (!salt) throw new Error('createProfileStore: WWWD_ACTOR_SALT required');

  // Reuse the same bucket as the corpus by default; allow override.
  const bucket = env.WWWD_PROFILE_BUCKET || env.WWWD_GCS_BUCKET;
  if (!bucket) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'createProfileStore: WWWD_PROFILE_BUCKET (or WWWD_GCS_BUCKET) required in production',
      );
    }
    // Dev fallback: in-memory store so the rest of the system boots
    // without GCS configured.
    return new ProfileStore({ backend: { kind: 'memory' }, salt });
  }

  return new ProfileStore({
    backend: {
      kind: 'gcs',
      bucket,
      keyFilename: env.WWWD_GCS_KEY_FILE || env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
      projectId: env.WWWD_GCP_PROJECT || undefined,
      cacheDir: env.WWWD_CACHE_DIR || undefined,
    },
    salt,
  });
}

// Reasoning helper used by scenario generation — extracts the bits a
// prompt needs without exposing full PII (email, picture, raw history).
export function profileSummaryForPrompt(profile) {
  if (!profile) return null;
  const d = profile.demographics || {};
  const i = profile.interests || {};
  const recentThemes = [];
  for (const h of (profile.history || []).slice(0, 10)) {
    if (Array.isArray(h.themes)) recentThemes.push(...h.themes);
  }
  return {
    age: d.age,
    script: d.script || 'cn',
    locale: d.locale || 'zh-CN',
    education_level: d.education_level || 'unspecified',
    life_stage: i.life_stage || 'unspecified',
    themes: (i.themes || []).slice(0, 16),
    cultivation_goals: (i.cultivation_goals || []).slice(0, 8),
    recent_history_themes: [...new Set(recentThemes)].slice(0, 16),
    recent_count: (profile.history || []).length,
  };
}
