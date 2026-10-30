// Decode a raw UART0 capture into engineering values, using the backend codec.
import { readFileSync } from 'node:fs';
import { decodeWord, decodeValue } from '../backend/src/a429/codec.js';

const labels = JSON.parse(readFileSync('shared/labels.json', 'utf8'));
const byLabel = new Map(labels.labels.map((l) => [l.label, l]));
const buf = readFileSync(process.argv[2]);
const out = [];
let bad = 0;
for (let i = 0; i + 4 <= buf.length; i += 4) {
  const w = buf.readUInt32LE(i);
  const d = decodeWord(w);
  if (!d.ok) { bad++; continue; }
  const def = byLabel.get(d.label);
  const v = def ? decodeValue(d.magnitude, d.ssm, def) : { value: null, valid: false };
  out.push({ label: d.label, tag: def?.tag ?? '?', ssm: d.ssmName, value: v.value, valid: v.valid });
}
// show the last full 6-label group
const tail = out.slice(-6);
for (const r of tail) console.log(`${r.label} ${String(r.tag).padEnd(11)} ${r.ssm.padEnd(5)} ${r.valid ? r.value.toFixed(3) : 'NCD/TEST'}`);
console.log(`words=${out.length} badParityOrLabel=${bad}`);
