/**
 * A429 codec tests.
 *
 * The point of these is not coverage for its own sake: they pin the wire
 * format against the golden vectors, so a change to either the JS codec or the
 * C firmware that breaks bit-compatibility fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  encodeWord, decodeWord, encodeValue, decodeValue,
  reverseByte, oddParityBit, wordToBytes, bytesToWord, SSM, A429,
} from '../backend/src/a429/codec.js';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '..', 'shared', 'a429-vectors.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(here, '..', 'shared', 'labels.json'), 'utf8'));

test('reverseByte reverses bit order', () => {
  assert.equal(reverseByte(0b10000000), 0b00000001);
  assert.equal(reverseByte(0b00000001), 0b10000000);
  assert.equal(reverseByte(0b11000000), 0b00000011);
  // involution: reversing twice is identity
  for (let i = 0; i < 256; i++) assert.equal(reverseByte(reverseByte(i)), i);
});

test('oddParityBit makes total ones odd', () => {
  for (const w of [0, 1, 0xff, 0x1234567, 0x7fffffff]) {
    const bit = oddParityBit(w);
    let ones = bit;
    for (let i = 0; i < 31; i++) ones += (w >>> i) & 1;
    assert.equal(ones % 2, 1, `word ${w.toString(16)} must have odd parity`);
  }
});

test('golden vectors encode exactly', () => {
  assert.equal(vectors.vectors.length, 11);
  for (const v of vectors.vectors) {
    const w = encodeWord({ label: v.label, sdi: v.sdi, magnitude: v.magnitude, ssm: v.ssm });
    assert.equal(w, v.word, `${v.name}: got 0x${w.toString(16)}, expected ${v.wordHex}`);
  }
});

test('golden vectors decode back to their inputs', () => {
  for (const v of vectors.vectors) {
    const d = decodeWord(v.word);
    assert.equal(d.ok, true, v.name);
    assert.equal(d.label, v.label, `${v.name} label`);
    assert.equal(d.sdi, v.sdi, `${v.name} sdi`);
    assert.equal(d.magnitude, v.magnitude, `${v.name} magnitude`);
    assert.equal(d.ssm, v.ssm, `${v.name} ssm`);
  }
});

test('golden vector byte order is little-endian 4 bytes', () => {
  for (const v of vectors.vectors) {
    const bytes = [...wordToBytes(v.word)];
    assert.deepEqual(bytes, v.bytesLE, `${v.name} bytes`);
    assert.equal(bytesToWord(Buffer.from(bytes)), v.word, `${v.name} roundtrip`);
  }
});

test('label is bit-reversed on the wire', () => {
  // label 324 octal = 0xD4 = 0b11010100 -> reversed 0b00101011 = 0x2B
  const w = encodeWord({ label: '324', sdi: 0, magnitude: 0, ssm: SSM.PLUS });
  assert.equal(w & 0xff, 0x2b);
  assert.equal(decodeWord(w).label, '324');
});

test('SSM encodes the sign, not two\'s complement', () => {
  const pos = encodeWord({ label: '324', magnitude: 100, ssm: SSM.PLUS });
  const neg = encodeWord({ label: '324', magnitude: 100, ssm: SSM.MINUS });
  assert.equal(decodeWord(pos).magnitude, decodeWord(neg).magnitude, 'same magnitude');
  assert.equal(decodeWord(pos).sign, 1);
  assert.equal(decodeWord(neg).sign, -1);
});

test('single-bit corruption is caught by parity', () => {
  const w = encodeWord({ label: '206', magnitude: 800, ssm: SSM.PLUS });
  for (let bit = 0; bit < 32; bit++) {
    const bad = (w ^ (1 << bit)) >>> 0;
    const d = decodeWord(bad);
    // Flipping a bit may or may not flip parity, but decode must never
    // silently return the original magnitude with ok:true after a data flip.
    if (d.ok) {
      const differs = d.magnitude !== 800 || d.label !== '206';
      assert.ok(differs || bit === 31, `flip of bit ${bit} undetected`);
    }
  }
});

test('decodeWord never throws on garbage', () => {
  for (const w of [0, 1, 0xffffffff, 0xdeadbeef, 0x80000000, 0x7fffffff]) {
    const d = decodeWord(w);
    assert.equal(typeof d.ok, 'boolean');
  }
});

test('encodeWord rejects out-of-range input', () => {
  assert.throws(() => encodeWord({ label: '999999', magnitude: 0, ssm: SSM.PLUS }), RangeError);
  assert.throws(() => encodeWord({ label: '324', magnitude: -1, ssm: SSM.PLUS }), RangeError);
  assert.throws(() => encodeWord({ label: '324', magnitude: A429.DATA_MAX + 1, ssm: SSM.PLUS }), RangeError);
  assert.throws(() => encodeWord({ label: '324', sdi: 4, magnitude: 0, ssm: SSM.PLUS }), RangeError);
  assert.throws(() => encodeWord({ label: '324', magnitude: 0, ssm: 4 }), RangeError);
});

test('engineering conversion roundtrips within one LSB', () => {
  for (const def of labels.labels) {
    const samples = [
      def.min, def.max, 0,
      def.min / 2, def.max / 2,
    ].filter((v) => v >= def.min && v <= def.max);

    for (const v of samples) {
      const { magnitude, ssm } = encodeValue(v, def);
      const back = decodeValue(magnitude, ssm, def);
      assert.equal(back.valid, true, `${def.tag}@${v}`);
      assert.ok(
        Math.abs(back.value - v) <= def.lsbPerBit / 2 + 1e-9,
        `${def.tag}@${v}: got ${back.value}, LSB ${def.lsbPerBit}`,
      );
    }
  }
});

test('baro altitude below sea level keeps its sign', () => {
  const def = labels.labels.find((d) => d.tag === 'BARO_ALT');
  const { magnitude, ssm } = encodeValue(-500, def);
  assert.equal(ssm, SSM.MINUS);
  assert.equal(decodeValue(magnitude, ssm, def).value, -500);
});

test('NCD and TEST report not-valid rather than a number', () => {
  const def = labels.labels.find((d) => d.tag === 'PITCH');
  assert.deepEqual(decodeValue(100, SSM.NCD, def), { value: null, valid: false });
  assert.deepEqual(decodeValue(100, SSM.TEST, def), { value: null, valid: false });
});

test('non-finite input becomes NCD', () => {
  const def = labels.labels.find((d) => d.tag === 'CAS');
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(encodeValue(bad, def).ssm, SSM.NCD);
  }
});

test('values outside the range are clamped, not wrapped', () => {
  const def = labels.labels.find((d) => d.tag === 'CAS');
  const hi = encodeValue(1e6, def);
  assert.equal(decodeValue(hi.magnitude, hi.ssm, def).value, def.max);
});

test('label table matches the agreed contract', () => {
  const byTag = Object.fromEntries(labels.labels.map((d) => [d.tag, d]));
  assert.deepEqual(Object.keys(byTag).sort(), [
    'BARO_ALT', 'CAS', 'HEADING', 'PITCH', 'ROLL', 'VERT_SPEED',
  ]);
  // Octal labels, decided 2026-10-30.
  assert.equal(byTag.PITCH.label, '324');
  assert.equal(byTag.ROLL.label, '325');
  assert.equal(byTag.HEADING.label, '314');
  assert.equal(byTag.BARO_ALT.label, '204');
  assert.equal(byTag.CAS.label, '206');
  assert.equal(byTag.VERT_SPEED.label, '212');
  for (const d of labels.labels) {
    assert.ok(parseInt(d.label, 8) <= 0o377, `${d.tag} label must fit 8 bits`);
    assert.ok(d.lsbPerBit > 0);
    assert.ok(d.min < d.max);
  }
});
