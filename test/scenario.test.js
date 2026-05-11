// Tests for src/scenario.js. parseScenarios and the prompt builders are
// pure functions; the LLM round-trip is exercised via a fake provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseScenarios, generateScenarios, _internals } from '../src/scenario.js';

const VALID = [
  {
    cat: '己',
    title: '夜深独坐',
    scenario:
      '某夜独坐，回想日间言语，觉与同事争执有意气在，明知不当而当时不能自持。如此事再来，当何处用功？此情境含两难，需自察。',
  },
  {
    cat: '职',
    title: '工作之困',
    scenario:
      '同事请你帮忙完成他的报告，已答应在先，但你自己工作也未做完。家人在等。你在两难之间，到底如何处？此情境含两难，需自察。',
  },
];

test('parseScenarios accepts a bare JSON array', () => {
  const arr = parseScenarios(JSON.stringify(VALID));
  assert.equal(arr.length, 2);
  assert.equal(arr[0].cat, '己');
});

test('parseScenarios strips ```json fences', () => {
  const wrapped = '```json\n' + JSON.stringify(VALID) + '\n```';
  const arr = parseScenarios(wrapped);
  assert.equal(arr.length, 2);
});

test('parseScenarios tolerates prose before and after', () => {
  const wrapped = '以下是四则情境：\n' + JSON.stringify(VALID) + '\n谨呈。';
  const arr = parseScenarios(wrapped);
  assert.equal(arr.length, 2);
});

test('parseScenarios filters items below min length', () => {
  const mixed = [...VALID, { cat: '己', title: 'x', scenario: '太短' }];
  const arr = parseScenarios(JSON.stringify(mixed));
  assert.equal(arr.length, 2);
});

test('parseScenarios filters items missing a title', () => {
  const mixed = [...VALID, { cat: '己', scenario: VALID[0].scenario }];
  const arr = parseScenarios(JSON.stringify(mixed));
  assert.equal(arr.length, 2);
});

test('parseScenarios rejects no-array output', () => {
  assert.throws(() => parseScenarios('{"oops": true}'), /JSON array/);
});

test('parseScenarios rejects all-invalid output', () => {
  assert.throws(
    () => parseScenarios(JSON.stringify([{ cat: '己', title: '', scenario: '太短' }])),
    /no valid scenarios/,
  );
});

test('parseScenarios truncates over-long cat and title', () => {
  const arr = parseScenarios(
    JSON.stringify([{ cat: '过长之类别字串', title: 'a'.repeat(40), scenario: VALID[0].scenario }]),
  );
  assert.ok(arr[0].cat.length <= 4);
  assert.ok(arr[0].title.length <= 32);
});

test('ageBandFor uses age when available', () => {
  assert.equal(_internals.ageBandFor({ age: 10 }), 'child');
  assert.equal(_internals.ageBandFor({ age: 15 }), 'teen');
  assert.equal(_internals.ageBandFor({ age: 22 }), 'young-adult');
});

test('ageBandFor falls back to life_stage when age missing', () => {
  assert.equal(_internals.ageBandFor({ life_stage: 'parent' }), 'parent');
  assert.equal(_internals.ageBandFor({ life_stage: 'unknown-bucket' }), 'unspecified');
  assert.equal(_internals.ageBandFor({}), 'unspecified');
});

test('buildPrompt includes age-band text and themes', () => {
  const { system, user } = _internals.buildPrompt({
    summary: { age: 10, themes: ['学业'] },
    n: 3,
  });
  assert.match(system, /7–12岁/);
  assert.match(user, /学业/);
  assert.match(user, /3 则/);
});

test('buildPrompt adds traditional-script suffix when script=tw', () => {
  const { system } = _internals.buildPrompt({
    summary: { age: 30, script: 'tw' },
    n: 2,
  });
  assert.match(system, /繁体|繁體/);
});

test('generateScenarios invokes provider and returns parsed array', async () => {
  const fakeProvider = {
    async *streamText() {
      yield JSON.stringify(VALID);
    },
  };
  const arr = await generateScenarios({ provider: fakeProvider, summary: { age: 30 }, count: 2 });
  assert.equal(arr.length, 2);
  assert.equal(arr[0].title, '夜深独坐');
});

test('generateScenarios clamps count to [1, 6]', async () => {
  let observedSystem = null;
  const fakeProvider = {
    async *streamText({ messages }) {
      observedSystem = messages[0].content;
      yield JSON.stringify(VALID);
    },
  };
  await generateScenarios({ provider: fakeProvider, summary: { age: 30 }, count: 99 });
  assert.match(observedSystem, /6 则/);
});
