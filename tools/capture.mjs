#!/usr/bin/env node
/**
 * Record a real A429 capture from the firmware running in QEMU.
 *
 * The result is the decoupling fixture: the backend replays it with QEMU and the
 * gamepad both absent, proving the backend does not depend on either.
 *
 * Usage: node tools/capture.mjs [seconds] [outPath]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { qemuPath } from '../firmware/build.mjs';
import { decodeWord, decodeValue } from '../backend/src/a429/codec.js';
import { readFileSync } from 'node:fs';

const seconds = Number(process.argv[2] || 6);
const out = process.argv[3] || 'shared/capture.a429';
const port = 5570;

const labels = JSON.parse(readFileSync('shared/labels.json', 'utf8'));
const byLabel = new Map(labels.labels.map((l) => [l.label, l]));

const chunks = [];
const srv = createServer((sock) => {
  sock.on('data', (d) => chunks.push(d));
  sock.on('error', () => {}); // QEMU is killed at the end: ECONNRESET is expected
});

srv.listen(port, '127.0.0.1', () => {
  const q = spawn(qemuPath(), [
    '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
    '-chardev', `socket,id=u0,host=127.0.0.1,port=${port},server=off`,
    '-serial', 'chardev:u0',
    '-kernel', 'firmware/build/firmware-main.elf',
  ], { stdio: 'ignore' });

  setTimeout(() => {
    q.kill();
    srv.close();

    const raw = Buffer.concat(chunks);
    // Skip the firmware banner: keep from the first word that decodes cleanly
    // and is followed by more clean words, so the capture starts word-aligned.
    let start = -1;
    for (let off = 0; off + 8 <= raw.length; off++) {
      const a = decodeWord(raw.readUInt32LE(off));
      const b = decodeWord(raw.readUInt32LE(off + 4));
      if (a.ok && b.ok && byLabel.has(a.label) && byLabel.has(b.label)) { start = off; break; }
    }
    if (start < 0) throw new Error('no word-aligned start found in capture');
    const aligned = raw.subarray(start);
    const words = aligned.subarray(0, aligned.length - (aligned.length % 4));
    writeFileSync(out, words);

    // Report what the fixture contains.
    let n = 0, bad = 0;
    const tags = new Set();
    for (let i = 0; i + 4 <= words.length; i += 4) {
      const d = decodeWord(words.readUInt32LE(i));
      if (!d.ok) { bad++; continue; }
      const def = byLabel.get(d.label);
      if (!def) { bad++; continue; }
      tags.add(def.tag); n++;
    }
    console.log(`capture: ${out}`);
    console.log(`  bytes=${words.length} words=${n} rejected=${bad} labels=${[...tags].join(',')}`);
    console.log(`  rate ~${(n / 6 / seconds).toFixed(1)} Hz over ${seconds}s`);
  }, seconds * 1000);
});
