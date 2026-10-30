/**
 * Generates shared/a429-vectors.json by *encoding* known cases, then the test suite
 * checks them against values computed independently by hand below.
 *
 * Run: node tools/gen-vectors.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeWord, SSM } from '../backend/src/a429/codec.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Hand-derived expectation, independent of encodeWord:
 * build the word with plain arithmetic and a locally written parity check.
 */
function handEncode(labelOct, sdi, magnitude, ssm) {
  // reverse the 8 label bits by hand-shaped loop
  let rev = 0;
  for (let i = 0; i < 8; i++) if ((labelOct >> i) & 1) rev += 1 << (7 - i);
  let w = rev + sdi * 0x100 + magnitude * 0x400 + ssm * 2 ** 29;
  let ones = 0;
  for (let i = 0; i < 31; i++) if (Math.floor(w / 2 ** i) % 2 === 1) ones++;
  if (ones % 2 === 0) w += 2 ** 31; // make total parity odd
  return w;
}

const cases = [
  { name: 'pitch_zero', label: '324', sdi: 0, magnitude: 0, ssm: SSM.PLUS },
  { name: 'pitch_pos_10deg', label: '324', sdi: 0, magnitude: Math.round(10 / (180 / 4096)), ssm: SSM.PLUS },
  { name: 'pitch_neg_10deg', label: '324', sdi: 0, magnitude: Math.round(10 / (180 / 4096)), ssm: SSM.MINUS },
  { name: 'roll_pos_45deg', label: '325', sdi: 0, magnitude: Math.round(45 / (180 / 4096)), ssm: SSM.PLUS },
  { name: 'heading_270deg', label: '314', sdi: 0, magnitude: Math.round(270 / (180 / 4096)), ssm: SSM.PLUS },
  { name: 'baro_alt_30000ft', label: '204', sdi: 0, magnitude: 30000 / 4, ssm: SSM.PLUS },
  { name: 'cas_120kt', label: '206', sdi: 0, magnitude: 120 / 0.125, ssm: SSM.PLUS },
  { name: 'vs_neg_1500fpm', label: '212', sdi: 0, magnitude: 1500, ssm: SSM.MINUS },
  { name: 'vs_ncd', label: '212', sdi: 0, magnitude: 0, ssm: SSM.NCD },
  { name: 'pitch_test', label: '324', sdi: 0, magnitude: 100, ssm: SSM.TEST },
  { name: 'sdi_3_case', label: '206', sdi: 3, magnitude: 800, ssm: SSM.PLUS },
];

const out = cases.map((c) => {
  const encoded = encodeWord(c);
  const hand = handEncode(parseInt(c.label, 8), c.sdi, c.magnitude, c.ssm);
  if (encoded !== hand) {
    throw new Error(`${c.name}: encoder ${encoded} != hand ${hand}`);
  }
  return {
    ...c,
    labelOct: parseInt(c.label, 8),
    word: encoded,
    wordHex: '0x' + encoded.toString(16).toUpperCase().padStart(8, '0'),
    bytesLE: [
      encoded & 0xff,
      (encoded >>> 8) & 0xff,
      (encoded >>> 16) & 0xff,
      (encoded >>> 24) & 0xff,
    ],
  };
});

const doc = {
  version: 1,
  comment:
    'Hand-computed ARINC 429 golden vectors. Every word here was derived twice: by backend/src/a429/codec.js and by an independent handEncode() in tools/gen-vectors.mjs. The C encoder in frontend... firmware must reproduce bytesLE exactly.',
  ssm: SSM,
  vectors: out,
};

writeFileSync(join(here, '..', 'shared', 'a429-vectors.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${out.length} vectors`);
for (const v of out) console.log(`  ${v.name.padEnd(18)} label ${v.label} -> ${v.wordHex}`);
