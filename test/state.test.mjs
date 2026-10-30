/**
 * Backend state, display-config validation and freshness watchdog tests.
 * Time is injected so the watchdog is tested without sleeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ParamState, STALE_MS } from '../backend/src/state.js';
import { DisplayConfig } from '../backend/src/config.js';
import { encodeWord, encodeValue, SSM } from '../backend/src/a429/codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const labelsDoc = JSON.parse(readFileSync(join(here, '..', 'shared', 'labels.json'), 'utf8'));

function harness() {
  let t = 1_000_000;
  const state = new ParamState(labelsDoc, { now: () => t });
  return { state, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

/** Build a word for a tag from an engineering value. */
function wordFor(tag, value, ssmOverride) {
  const def = labelsDoc.labels.find((d) => d.tag === tag);
  const { magnitude, ssm } = encodeValue(value, def);
  return encodeWord({ label: def.label, magnitude, ssm: ssmOverride ?? ssm });
}

test('ingest decodes a valid word into engineering units', () => {
  const { state } = harness();
  assert.equal(state.ingestWord(wordFor('BARO_ALT', 12000)), 'ok');
  const p = state.snapshot().params.find((x) => x.tag === 'BARO_ALT');
  assert.equal(p.value, 12000);
  assert.equal(p.valid, true);
  assert.equal(p.stale, false);
});

test('parity-corrupt word is rejected and counted', () => {
  const { state } = harness();
  const good = wordFor('CAS', 150);
  state.ingestWord(good ^ 0x1);
  const s = state.snapshot();
  assert.equal(s.stats.parityErrors, 1);
  assert.equal(s.params.find((p) => p.tag === 'CAS').value, null);
});

test('unknown label is rejected and counted, valid labels still work', () => {
  const { state } = harness();
  state.ingestWord(encodeWord({ label: '077', magnitude: 10, ssm: SSM.PLUS }));
  state.ingestWord(wordFor('PITCH', 5));
  const s = state.snapshot();
  assert.equal(s.stats.unknownLabels, 1);
  assert.ok(Math.abs(s.params.find((p) => p.tag === 'PITCH').value - 5) <= 0.05);
});

test('watchdog marks a silence stale after STALE_MS', () => {
  const { state, advance } = harness();
  state.ingestWord(wordFor('HEADING', 90));
  assert.equal(state.snapshot().params.find((p) => p.tag === 'HEADING').stale, false);

  advance(STALE_MS - 1);
  assert.equal(state.snapshot().params.find((p) => p.tag === 'HEADING').stale, false);

  advance(2);
  const p = state.snapshot().params.find((x) => x.tag === 'HEADING');
  assert.equal(p.stale, true);
  assert.equal(p.valid, false);
  // A stale parameter must not keep showing its last value.
  assert.equal(p.value, null);
});

test('a parameter never heard is stale with null age', () => {
  const { state } = harness();
  const all = state.snapshot().params;
  assert.equal(all.length, 6);
  for (const p of all) {
    assert.equal(p.stale, true);
    assert.equal(p.ageMs, null);
    assert.equal(p.value, null);
  }
});

test('NCD word is fresh but not valid', () => {
  const { state } = harness();
  state.ingestWord(wordFor('VERT_SPEED', 0, SSM.NCD));
  const p = state.snapshot().params.find((x) => x.tag === 'VERT_SPEED');
  assert.equal(p.stale, false, 'the word did arrive');
  assert.equal(p.valid, false, 'but carries no computed data');
  assert.equal(p.value, null);
  assert.equal(p.ssm, 'NCD');
});

test('byte-stream ingest resynchronises after garbage', () => {
  const { state } = harness();
  const good = Buffer.alloc(6 * 4);
  const tags = ['PITCH', 'ROLL', 'HEADING', 'BARO_ALT', 'CAS', 'VERT_SPEED'];
  tags.forEach((tag, i) => good.writeUInt32LE(wordFor(tag, 0), i * 4));

  // Leading junk that is not a whole number of words.
  let pending = Buffer.concat([Buffer.from([0xde, 0xad]), good]);
  pending = Buffer.from(state.ingestChunk(pending));

  const s = state.snapshot();
  assert.ok(s.stats.words >= 6);
  // All six tags eventually decoded despite the 2-byte misalignment.
  const fresh = s.params.filter((p) => !p.stale);
  assert.equal(fresh.length, 6, `resync failed: ${JSON.stringify(s.stats)}`);
});

test('snapshot is JSON-serialisable (it goes over SSE)', () => {
  const { state } = harness();
  state.ingestWord(wordFor('PITCH', 3));
  assert.doesNotThrow(() => JSON.stringify(state.snapshot()));
});

/* ------------------------------------------------------------ display config */

test('display config starts from the label defaults', () => {
  const c = new DisplayConfig(labelsDoc);
  const pitch = c.list().find((p) => p.tag === 'PITCH');
  assert.deepEqual(pitch.config, { min: -20, max: 20, visible: true });
});

test('display config accepts a valid window', () => {
  const c = new DisplayConfig(labelsDoc);
  const r = c.set('324', { min: -10, max: 10 });
  assert.equal(r.ok, true);
  assert.deepEqual(c.forDisplay().PITCH, {
    label: '324', min: -10, max: 10, visible: true, unit: 'deg',
  });
});

test('display config rejects min >= max', () => {
  const c = new DisplayConfig(labelsDoc);
  assert.equal(c.set('324', { min: 10, max: 10 }).ok, false);
  assert.equal(c.set('324', { min: 10, max: 5 }).ok, false);
});

test('display config rejects a window outside the label range', () => {
  const c = new DisplayConfig(labelsDoc);
  assert.equal(c.set('206', { max: 700 }).ok, false, 'CAS hard max is 600');
  assert.equal(c.set('206', { min: -1 }).ok, false, 'CAS hard min is 0');
});

test('display config rejects wrong types', () => {
  const c = new DisplayConfig(labelsDoc);
  assert.equal(c.set('324', { min: 'low' }).ok, false);
  assert.equal(c.set('324', { visible: 'yes' }).ok, false);
  assert.equal(c.set('324', null).ok, false);
  assert.equal(c.set('nope', { min: 0 }).ok, false);
});

test('display config rejects NaN and Infinity', () => {
  const c = new DisplayConfig(labelsDoc);
  assert.equal(c.set('324', { min: NaN }).ok, false);
  assert.equal(c.set('324', { max: Infinity }).ok, false);
});

test('reset restores the label defaults', () => {
  const c = new DisplayConfig(labelsDoc);
  c.set('325', { min: -5, max: 5, visible: false });
  c.reset('325');
  const roll = c.list().find((p) => p.tag === 'ROLL');
  assert.deepEqual(roll.config, { min: -45, max: 45, visible: true });
});

test('one slider per received parameter: config covers every label', () => {
  const c = new DisplayConfig(labelsDoc);
  assert.equal(c.list().length, labelsDoc.labels.length);
  for (const p of c.list()) {
    assert.equal(typeof p.config.min, 'number');
    assert.equal(typeof p.config.max, 'number');
    assert.equal(typeof p.config.visible, 'boolean');
  }
});
