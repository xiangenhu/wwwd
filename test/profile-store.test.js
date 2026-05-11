// Tests for src/profile-store.js. Uses the in-memory backend so no GCS
// credentials are required. The salt is fixed so userIds are reproducible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProfileStore,
  validateProfilePatch,
  profileSummaryForPrompt,
  userIdFor,
  emptyProfile,
  ValidationError,
  PROFILE_SCHEMA,
} from '../src/profile-store.js';

const SALT = 'test-salt-for-profile-store';

function newStore() {
  return new ProfileStore({ backend: { kind: 'memory' }, salt: SALT });
}

const ALICE = {
  email: 'alice@example.com',
  name: 'Alice',
  picture: 'https://x/a.png',
  provider: 'google',
};

test('userIdFor is deterministic and salt-sensitive', () => {
  const a = userIdFor('alice@example.com', SALT);
  const b = userIdFor('alice@example.com', SALT);
  const c = userIdFor('alice@example.com', 'other-salt');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 32);
});

test('userIdFor lowercases email', () => {
  assert.equal(userIdFor('Alice@Example.com', SALT), userIdFor('alice@example.com', SALT));
});

test('userIdFor rejects missing inputs', () => {
  assert.throws(() => userIdFor('', SALT), /email required/);
  assert.throws(() => userIdFor('a@b.c', ''), /salt required/);
});

test('emptyProfile carries identity and defaults', () => {
  const p = emptyProfile(ALICE);
  assert.equal(p.identity.email, 'alice@example.com');
  assert.equal(p.demographics.script, 'cn');
  assert.equal(p.email_prefs.receive_summaries, false);
  assert.deepEqual(p.history, []);
});

test('getOrCreate creates a profile on first access', async () => {
  const s = newStore();
  const p = await s.getOrCreate(ALICE);
  assert.equal(p.identity.email, 'alice@example.com');
  assert.equal(p.id, userIdFor('alice@example.com', SALT));
  // second call returns the same persisted record
  const p2 = await s.getOrCreate(ALICE);
  assert.equal(p2.id, p.id);
  assert.equal(p2.created_at, p.created_at);
});

test('getOrCreate refreshes name/picture from gateway user', async () => {
  const s = newStore();
  await s.getOrCreate(ALICE);
  const updated = await s.getOrCreate({ ...ALICE, name: 'Alice 2', picture: 'https://x/b.png' });
  assert.equal(updated.identity.name, 'Alice 2');
  assert.equal(updated.identity.picture, 'https://x/b.png');
  // email is the stable key — it is never overwritten even if it differs in case
  assert.equal(updated.identity.email, 'alice@example.com');
});

test('update applies a validated patch and persists', async () => {
  const s = newStore();
  await s.getOrCreate(ALICE);
  const patch = validateProfilePatch({
    demographics: { birthdate: '2000-01-15', script: 'tw', education_level: 'undergraduate' },
    interests: { themes: ['职场', '家庭'], life_stage: 'young-adult' },
    email_prefs: { receive_summaries: true },
  });
  const after = await s.update(ALICE, patch);
  assert.equal(after.demographics.birthdate, '2000-01-15');
  assert.equal(after.demographics.script, 'tw');
  assert.equal(after.demographics.education_level, 'undergraduate');
  assert.equal(typeof after.demographics.age, 'number');
  assert.deepEqual(after.interests.themes, ['职场', '家庭']);
  assert.equal(after.email_prefs.receive_summaries, true);

  // round-trip
  const reread = await s.getOrCreate(ALICE);
  assert.equal(reread.demographics.birthdate, '2000-01-15');
});

test('appendHistory caps at HISTORY_CAP and is newest-first', async () => {
  const s = newStore();
  for (let i = 0; i < PROFILE_SCHEMA.historyCap + 5; i++) {
    await s.appendHistory(ALICE, {
      session_id: `s${i}`,
      scenario_hash: `h${i}`,
      scenario_len: 100,
    });
  }
  const p = await s.getOrCreate(ALICE);
  assert.equal(p.history.length, PROFILE_SCHEMA.historyCap);
  // The last appended is at the head.
  assert.equal(p.history[0].session_id, `s${PROFILE_SCHEMA.historyCap + 4}`);
});

test('validateProfilePatch rejects unknown script', () => {
  assert.throws(
    () => validateProfilePatch({ demographics: { script: 'jp' } }),
    /script must be one of/,
  );
});

test('validateProfilePatch rejects birthdate not YYYY-MM-DD', () => {
  assert.throws(
    () => validateProfilePatch({ demographics: { birthdate: '2000/01/15' } }),
    /YYYY-MM-DD/,
  );
});

test('validateProfilePatch accepts null birthdate (clear)', () => {
  const out = validateProfilePatch({ demographics: { birthdate: null } });
  assert.equal(out.demographics.birthdate, null);
});

test('validateProfilePatch caps themes array length', () => {
  const themes = Array.from({ length: 17 }, (_, i) => `t${i}`);
  assert.throws(() => validateProfilePatch({ interests: { themes } }), /array exceeds 16 items/);
});

test('validateProfilePatch rejects non-boolean receive_summaries', () => {
  assert.throws(
    () => validateProfilePatch({ email_prefs: { receive_summaries: 'yes' } }),
    /must be boolean/,
  );
});

test('validateProfilePatch returns ValidationError instances', () => {
  try {
    validateProfilePatch({ interests: { life_stage: 'wizard' } });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.status, 422);
  }
});

test('profileSummaryForPrompt extracts the relevant subset', async () => {
  const s = newStore();
  await s.update(
    ALICE,
    validateProfilePatch({
      demographics: { birthdate: '2010-01-15' },
      interests: { themes: ['学业'], life_stage: 'teen' },
    }),
  );
  await s.appendHistory(ALICE, {
    session_id: 's1',
    scenario_hash: 'h1',
    themes: ['friendship', 'school'],
  });
  const p = await s.getOrCreate(ALICE);
  const sum = profileSummaryForPrompt(p);
  assert.equal(typeof sum.age, 'number');
  assert.equal(sum.life_stage, 'teen');
  assert.deepEqual(sum.themes, ['学业']);
  assert.deepEqual(sum.recent_history_themes, ['friendship', 'school']);
  assert.equal(sum.recent_count, 1);
});

test('concurrent updates serialise (no lost writes)', async () => {
  const s = newStore();
  // Kick off five appends in flight at once; the per-user lock should
  // chain them so all five entries land.
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      s.appendHistory(ALICE, { session_id: `c${i}`, scenario_hash: `h${i}` }),
    ),
  );
  const p = await s.getOrCreate(ALICE);
  assert.equal(p.history.length, 5);
  const ids = new Set(p.history.map((h) => h.session_id));
  assert.equal(ids.size, 5, 'all five sessions must be present');
});

test('ProfileStore requires salt', () => {
  assert.throws(() => new ProfileStore({ backend: { kind: 'memory' } }), /salt required/);
});

test('ProfileStore rejects unknown backend kind', () => {
  assert.throws(
    () => new ProfileStore({ backend: { kind: 'firebase' }, salt: SALT }),
    /Unknown backend/,
  );
});
