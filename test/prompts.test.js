// Tests for src/prompts.js. Pure functions — no env, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStageMessages, flattenSystem, STAGE_NAMES } from '../src/prompts.js';

const sampleRetrieved = [
  { id: 'p1', source: '传习录·上', text: '心即理也。' },
  { id: 'p2', source: '传习录·上', text: '知是行之始，行是知之成。' },
];

test('STAGE_NAMES covers all four stages', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.equal(typeof STAGE_NAMES[n], 'string');
    assert.ok(STAGE_NAMES[n].length > 0);
  }
});

test('buildStageMessages returns system as a two-block array', () => {
  const { system, messages } = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: sampleRetrieved,
    mode: 'standard',
    script: 'cn',
  });
  assert.ok(Array.isArray(system), 'system must be an array');
  assert.equal(system.length, 2);
  assert.equal(system[0].type, 'text');
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
  assert.equal(system[1].type, 'text');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.ok(messages[0].content.includes('第 1 阶'));
});

test('the cached preamble is identical across stages 1-4', () => {
  const preambles = [1, 2, 3, 4].map(
    (stage) =>
      buildStageMessages({
        stage,
        scenario: 's'.repeat(20),
        retrieved: sampleRetrieved,
        mode: 'standard',
        script: 'cn',
      }).system[0].text,
  );
  assert.equal(new Set(preambles).size, 1, 'preamble varies across stages — caching will not hit');
});

test('the cached preamble is identical across styles too', () => {
  const preambles = ['classical', 'vernacular'].map(
    (style) =>
      buildStageMessages({
        stage: 1,
        scenario: 's'.repeat(20),
        retrieved: sampleRetrieved,
        style,
      }).system[0].text,
  );
  assert.equal(
    new Set(preambles).size,
    1,
    'preamble varies across styles — style instructions must live in the tail, not the cached preamble',
  );
});

test('default style is classical (文言) when omitted', () => {
  const explicit = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    style: 'classical',
  });
  const omitted = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
  });
  assert.equal(omitted.system[1].text, explicit.system[1].text);
  assert.ok(omitted.system[1].text.includes('浅近文言'));
});

test('vernacular style emits a 白话 instruction in the tail', () => {
  const v = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    style: 'vernacular',
  });
  assert.ok(v.system[1].text.includes('现代白话'));
  assert.ok(!v.system[1].text.includes('浅近文言'));
});

test('unknown style falls back to classical', () => {
  const bogus = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    style: 'made-up',
  });
  const classical = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    style: 'classical',
  });
  assert.equal(bogus.system[1].text, classical.system[1].text);
});

test('the legacy 文白相间 rule is no longer hard-coded in the preamble', () => {
  const { system } = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
  });
  assert.ok(
    !system[0].text.includes('文白相间'),
    'preamble must be style-agnostic so cache hits across all four 文/白 combinations',
  );
});

test('stage 3 embeds retrieved passages', () => {
  const { system } = buildStageMessages({
    stage: 3,
    scenario: 'x'.repeat(40),
    retrieved: sampleRetrieved,
    mode: 'standard',
    script: 'cn',
  });
  assert.ok(system[1].text.includes('心即理也'));
  assert.ok(system[1].text.includes('知是行之始'));
});

test('stage 3 with empty retrieved announces no contextual passages', () => {
  const { system } = buildStageMessages({
    stage: 3,
    scenario: 'x'.repeat(40),
    retrieved: [],
    mode: 'standard',
    script: 'cn',
  });
  assert.ok(system[1].text.includes('语料中无契合之段'));
});

test('mode and script suffixes only attach to the tail block', () => {
  const cnStandard = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    mode: 'standard',
    script: 'cn',
  });
  const twDeep = buildStageMessages({
    stage: 1,
    scenario: 'x'.repeat(40),
    retrieved: [],
    mode: 'deep',
    script: 'tw',
  });
  assert.equal(cnStandard.system[0].text, twDeep.system[0].text, 'preamble must not change');
  assert.notEqual(cnStandard.system[1].text, twDeep.system[1].text, 'tail must change');
  assert.ok(twDeep.system[1].text.includes('深析'));
  assert.ok(twDeep.system[1].text.includes('繁体中文'));
});

test('buildStageMessages rejects invalid stage', () => {
  assert.throws(
    () => buildStageMessages({ stage: 99, scenario: 'x'.repeat(40), retrieved: [] }),
    /Invalid stage/,
  );
});

test('flattenSystem joins block text with double newline', () => {
  const s = flattenSystem([{ text: 'a' }, { text: 'b' }]);
  assert.equal(s, 'a\n\nb');
});

test('flattenSystem passes strings through unchanged', () => {
  assert.equal(flattenSystem('hello'), 'hello');
});

test('flattenSystem on undefined / empty returns empty string', () => {
  assert.equal(flattenSystem(undefined), '');
  assert.equal(flattenSystem([]), '');
});
