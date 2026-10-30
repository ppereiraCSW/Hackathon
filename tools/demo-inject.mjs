#!/usr/bin/env node
/**
 * Demo driver: injects a scripted pad sequence so the SFD can be shown moving
 * on a machine where nobody is holding the stick. Stands in for pad-reader.ps1.
 *
 * Usage: node tools/demo-inject.mjs [seconds]
 */
import { createServer } from 'node:net';

const PAD_PORT = 5556;
const seconds = Number(process.argv[2] || 30);

function padFrame({ seq, x, y, z, r, buttons = 0, pov = -1 }) {
  const b = Buffer.alloc(17);
  b[0] = 0xa5; b[1] = 0x5a;
  b.writeUInt16LE(seq & 0xffff, 2);
  b.writeUInt16LE(x, 4); b.writeUInt16LE(y, 6);
  b.writeUInt16LE(z, 8); b.writeUInt16LE(r, 10);
  b.writeUInt16LE(buttons, 12); b.writeInt16LE(pov, 14);
  let xor = 0; for (let i = 0; i < 16; i++) xor ^= b[i];
  b[16] = xor;
  return b;
}

// The firmware treats the axes as rate commands, so these are stick rates: each
// is a cosine, which integrates to a value swinging either side of where it
// started (roll about +/-30 deg, pitch +/-5 deg, CAS +/-30 kt, V/S +/-1300 fpm).
const script = (t) => ({
  x: Math.round(32767 + 22000 * Math.cos(t * 0.6)),  // roll
  y: Math.round(32767 + 8000 * Math.cos(t * 0.35)),  // pitch
  z: Math.round(32767 + 18000 * Math.cos(t * 0.4)),  // CAS
  r: Math.round(32767 + 22000 * Math.cos(t * 0.5)),  // VS
});

const srv = createServer((sock) => {
  console.log('[demo] firmware connected, injecting pad frames');
  sock.on('error', () => {});
  const t0 = Date.now();
  let seq = 0;
  const iv = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    if (t > seconds) { clearInterval(iv); sock.end(); srv.close(); console.log('[demo] done'); return; }
    const a = script(t);
    try { sock.write(padFrame({ seq: seq++, ...a })); } catch { clearInterval(iv); }
  }, 20);
});

srv.listen(PAD_PORT, '127.0.0.1', () => console.log(`[demo] listening on ${PAD_PORT} for the guest`));
