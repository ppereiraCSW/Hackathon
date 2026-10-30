/**
 * Boundary values for every parameter, at each layer the value crosses:
 *   A429 codec  -> backend state  -> display config  -> display formatting.
 *
 * The firmware's own limits (roll +-45, pitch +-20, CAS 0..250, V/S +-6000,
 * altitude ground..ceiling, heading wrap) need QEMU and are checked by
 * tools/test-boundaries.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ParamState } from '../backend/src/state.js';
import { DisplayConfig } from '../backend/src/config.js';
import { encodeWord, decodeWord, encodeValue, decodeValue, SSM, A429 } from '../backend/src/a429/codec.js';
import { formatValue } from '../frontend/js/format.js';

const here = dirname(fileURLToPath(import.meta.url));
const labelsDoc = JSON.parse(readFileSync(join(here, '..', 'shared', 'labels.json'), 'utf8'));

function wordFor(def, value) {
  const { magnitude, ssm } = encodeValue(value, def);
  return encodeWord({ label: def.label, magnitude, ssm });
}

/** min, max, one LSB inside each, and zero where the range spans it. */
function edges(def) {
  const v = [def.min, def.min + def.lsbPerBit, def.max - def.lsbPerBit, def.max];
  if (def.min < 0 && def.max > 0) v.push(-def.lsbPerBit, 0, def.lsbPerBit);
  return v;
}

for (const def of labelsDoc.labels) {
  test(`${def.tag}: range edges survive codec -> word -> backend exactly`, () => {
    for (const v of edges(def)) {
      const state = new ParamState(labelsDoc);
      const w = wordFor(def, v);
      const d = decodeWord(w);
      assert.equal(d.ok, true, `${def.tag}@${v}: word must have valid parity`);
      assert.equal(d.label, def.label);
      assert.equal(state.ingestWord(w), 'ok');
      const p = state.snapshot().params.find((x) => x.tag === def.tag);
      assert.equal(p.valid, true, `${def.tag}@${v}`);
      assert.ok(Math.abs(p.value - v) <= def.lsbPerBit / 2 + 1e-9, `${def.tag}@${v}: got ${p.value}`);
      // The sign rides in the SSM: the magnitude never goes negative.
      assert.ok(d.magnitude >= 0 && d.magnitude <= A429.DATA_MAX);
      assert.equal(d.ssm, v < 0 ? SSM.MINUS : SSM.PLUS, `${def.tag}@${v}: SSM`);
    }
  });

  test(`${def.tag}: values beyond the range clamp to the limit, never wrap`, () => {
    const span = def.max - def.min;
    for (const [v, want] of [
      [def.min - def.lsbPerBit, def.min],
      [def.min - span * 10, def.min],
      [def.max + def.lsbPerBit, def.max],
      [def.max + span * 10, def.max],
    ]) {
      const { magnitude, ssm } = encodeValue(v, def);
      assert.equal(decodeValue(magnitude, ssm, def).value, want, `${def.tag}@${v}`);
    }
  });

  test(`${def.tag}: display limits accept the label range exactly, reject one LSB beyond`, () => {
    const cfg = new DisplayConfig(labelsDoc);
    assert.equal(cfg.set(def.label, { min: def.min, max: def.max }).ok, true);
    assert.equal(cfg.set(def.label, { min: def.min - def.lsbPerBit }).ok, false);
    assert.equal(cfg.set(def.label, { max: def.max + def.lsbPerBit }).ok, false);
    // A zero-width window is not a window.
    assert.equal(cfg.set(def.label, { min: def.max, max: def.max }).ok, false);
    // Default display window sits inside the label range.
    assert.ok(def.display.min >= def.min && def.display.max <= def.max);
  });

  test(`${def.tag}: readout formats every range edge without a stray sign`, () => {
    for (const v of edges(def)) {
      const s = formatValue(def.tag, v);
      assert.match(s, /^-?\d+(\.\d)?$/, `${def.tag}@${v}: "${s}"`);
      assert.doesNotMatch(s, /^-0(\.0)?$/, `${def.tag}@${v}: negative zero shown as "${s}"`);
    }
    assert.equal(formatValue(def.tag, null), '—');
    assert.equal(formatValue(def.tag, NaN), '—');
  });
}

test('HEADING readout wraps 359.5..360 to 000 and stays 3 digits', () => {
  assert.equal(formatValue('HEADING', 0), '000');
  assert.equal(formatValue('HEADING', 0.4), '000');
  assert.equal(formatValue('HEADING', 359.4), '359');
  assert.equal(formatValue('HEADING', 359.6), '000');
  assert.equal(formatValue('HEADING', 360), '000');
  assert.equal(formatValue('HEADING', 5), '005');
});

test('tiny negatives read as zero, not "-0"', () => {
  assert.equal(formatValue('PITCH', -0.02), '0.0');
  assert.equal(formatValue('ROLL', -0), '0.0');
  assert.equal(formatValue('VERT_SPEED', -0.3), '0');
  assert.equal(formatValue('CAS', -0.4), '0');
});
