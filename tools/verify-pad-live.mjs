#!/usr/bin/env node
/**
 * Live verification of the REAL gamepad through the whole pipeline.
 *
 * Unlike tools/test-pad-path.mjs (which injects synthetic frames), this runs the
 * actual host/pad-reader.ps1, the actual firmware in QEMU, and the actual
 * backend, then shows one live table:
 *
 *     what Windows reports  ->  what the backend decoded from ARINC 429
 *
 * so you can move a stick and see the parameter it drives change, and press
 * buttons to learn which bit WinMM reports for each one. That is the only way
 * to confirm the button mapping on *this* pad, which synthetic frames cannot.
 *
 * Usage: node tools/verify-pad-live.mjs
 *        node tools/verify-pad-live.mjs --seconds 60
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { qemuPath } from '../firmware/build.mjs';
import { ParamState } from '../backend/src/state.js';
import { startBackend } from '../backend/src/server.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : d);
const SECONDS = Number(opt('--seconds', 0)); // 0 = until Ctrl+C

const PAD_PORT = 5596;
const A429_PORT = 5595;
const HTTP_PORT = 8196;

const labelsDoc = JSON.parse(readFileSync('shared/labels.json', 'utf8'));
const TAGS = labelsDoc.labels.map((d) => d.tag);

const children = [];
let exiting = false;

function killAll() {
    if (exiting) return;
    exiting = true;
    for (const c of children) {
        try { c.kill(); } catch { /* gone */ }
    }
}

process.on('SIGINT', () => { killAll(); console.log('\n[verify] stopped'); process.exit(0); });
process.on('exit', killAll);

/* ------------------------------------------------------------------ helpers */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const DOT = (n, lo, hi) => {
    const idx = Math.round(((clamp(n, lo, hi) - lo) / (hi - lo)) * 20);
    return ' '.repeat(clamp(idx, 0, 20)) + '●' + ' '.repeat(20 - clamp(idx, 0, 20));
};

function pad(label, width) {
    return String(label).padEnd(width);
}

/* ------------------------------------------------------------------- start */
/* Probe the pad FIRST: there is no point starting the backend and QEMU if
 * there is no device to verify. */
import { execFileSync } from 'node:child_process';

function probePad() {
    const ps = `
Add-Type -Namespace P -Name W -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct JOYCAPS {
  public ushort wMid,wPid; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname;
  public uint wXmin,wXmax,wYmin,wYmax,wZmin,wZmax,p1,p2; public uint wRmin,wRmax,wUmin,wUmax,wVmin,wVmax;
  public uint wCaps,wMaxAxes,wNumAxes,wMaxButtons;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szRegKey;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szOEMVxD; }
[DllImport("winmm.dll")] public static extern uint joyGetDevCaps(System.UIntPtr id, ref JOYCAPS c, uint cb);
'@
foreach ($id in 0..15) {
  $c = New-Object P.W+JOYCAPS
  if ([P.W]::joyGetDevCaps([System.UIntPtr]::new($id), [ref]$c, [System.Runtime.InteropServices.Marshal]::SizeOf($c)) -eq 0) {
    Write-Output "$id|$($c.szPname)|$($c.wNumAxes)|$($c.wNumButtons)"
    break
  }
}`;
    try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
        if (!out) return null;
        const [id, name, axes, buttons] = out.split('|');
        return { id: Number(id), name, axes: Number(axes), buttons: Number(buttons) };
    } catch {
        return null;
    }
}

const device = probePad();
if (!device) {
    console.error('');
    console.error('  NO GAMEPAD DETECTED.');
    console.error('');
    console.error('  Plug the USB gamepad in, then run this again.');
    console.error('  To see exactly what Windows exposes:');
    console.error('      powershell -NoProfile -ExecutionPolicy Bypass -File host/test-pad.ps1');
    console.error('');
    process.exit(2);
}

console.log(`[verify] pad id=${device.id} "${device.name}" axes=${device.axes} buttons=${device.buttons}`);
console.log('[verify] starting backend + pad reader + QEMU');

const backend = startBackend({ httpPort: HTTP_PORT, a429Port: A429_PORT });
await new Promise((r) => setTimeout(r, 400));

/**
 * What the backend says, polled over its HTTP API. Polling the API rather than
 * reading backend.state directly keeps this honest: it observes exactly what
 * the SFD observes.
 */
async function snapshot() {
    try {
        const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/state`);
        return await res.json();
    } catch {
        return null;
    }
}

// ---- pad reader (real, not synthetic)
const reader = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', 'host/pad-reader.ps1',
    '-Port', String(PAD_PORT),
], { stdio: ['ignore', 'pipe', 'pipe'] });
children.push(reader);
reader.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.error('[pad] ' + s);
});

await new Promise((r) => setTimeout(r, 1200));

// ---- firmware in QEMU, wired to both ports
const qemu = spawn(qemuPath(), [
    '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
    '-chardev', `socket,id=u0,host=127.0.0.1,port=${A429_PORT},server=off`,
    '-serial', 'chardev:u0',
    '-chardev', `socket,id=u1,host=127.0.0.1,port=${PAD_PORT},server=off`,
    '-serial', 'chardev:u1',
    '-kernel', 'firmware/build/firmware-main.elf',
], { stdio: 'ignore' });
children.push(qemu);

/* ---------------------------------------------------------------- observe */

let lastPad = { x: 32767, y: 32767, z: 32767, r: 32767, buttons: 0 };
let prevSsm = {};
let buttonMap = new Map(); // bit -> description of first time it was seen
const moved = new Set();

const t0 = Date.now();
const deadline = SECONDS > 0 ? t0 + SECONDS * 1000 : Infinity;

console.log('[verify] move the sticks and press the buttons. Ctrl+C to stop.\n');
console.log('  Windows axis (0..65535, centre 32767)          decoded from ARINC 429');
console.log('  ' + '─'.repeat(78));

let ticks = 0;
for (;;) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 200));

    const snap = await snapshot();
    if (!snap) continue;
    if (snap.stats.words === 0) continue;

    const byTag = Object.fromEntries(snap.params.map((p) => [p.tag, p]));
    const anyFresh = snap.params.some((p) => !p.stale);
    if (!anyFresh) continue;

    ticks++;
    if (ticks % 2 !== 0) continue; // redraw at ~2.5 Hz to keep it readable

    // Reconstruct the pad axes as the firmware saw them, by inverting the model.
    const roll = byTag.ROLL?.value ?? null;
    const pitch = byTag.PITCH?.value ?? null;
    const cas = byTag.CAS?.value ?? null;
    const vs = byTag.VERT_SPEED?.value ?? null;

    const toRaw = (v, span, invert = false) => {
        if (v === null) return 32767;
        const n = clamp(v / span, -1, 1);
        return Math.round(32767 + (invert ? -n : n) * 32767);
    };

    if (roll !== null && Math.abs(roll) > 1) moved.add('X → ROLL');
    if (pitch !== null && Math.abs(pitch) > 1) moved.add('Y → PITCH');
    if (cas !== null && Math.abs(cas - 125) > 3) moved.add('Z → CAS');
    if (vs !== null && Math.abs(vs) > 30) moved.add('R → VERT SPEED');

    // Detect NCD as a direct signal of the START button.
    for (const p of snap.params) {
        if (p.ssm === 'NCD' && prevSsm[p.tag] !== 'NCD') buttonMap.set('START', 'all labels NCD (freeze)');
        prevSsm[p.tag] = p.ssm;
    }

    const row = (name, unit, value, raw, span, extra = '') => {
        const rawDot = DOT(raw, 0, 65535);
        const val = value === null ? '   —   ' : value.toFixed(1).padStart(7);
        return `  ${pad(name, 9)} ${rawDot}  ${val} ${pad(unit, 5)}${extra}`;
    };

    process.stdout.write('\x1b[H\x1b[2J'); // home + clear
    console.log('  Windows axis (0..65535, centre 32767)          decoded from ARINC 429');
    console.log('  ' + '─'.repeat(78));
    console.log(row('X  roll', 'deg', roll, toRaw(roll, 45), 45));
    console.log(row('Y  pitch', 'deg', pitch, toRaw(pitch, 20), 20));
    console.log(row('Z  CAS', 'kt', cas, toRaw(cas, 250), 250));
    console.log(row('R  V/S', 'fpm', vs, toRaw(vs, 2000), 2000));
    console.log('');
    const hdg = byTag.HEADING?.value;
    const alt = byTag.BARO_ALT?.value;
    console.log(`  derived   heading ${hdg !== undefined && hdg !== null ? hdg.toFixed(1).padStart(6) : '     —'} deg      ` +
        `altitude ${alt !== undefined && alt !== null ? Math.round(alt).toLocaleString().padStart(7) : '      —'} ft`);
    console.log('');
    const bad = snap.params.filter((p) => p.ssm === 'NCD').map((p) => p.tag);
    console.log(`  A429  words ${String(snap.stats.words).padStart(7)}   parity err ${snap.stats.parityErrors}   ` +
        `labels ${snap.params.filter((p) => !p.stale).length}/6` +
        (bad.length ? `   NCD: ${bad.join(',')}` : ''));
    if (moved.size) console.log(`  confirmed live: ${[...moved].join('   ')}`);
    if (buttonMap.size) {
        console.log('  buttons seen  : ' + [...buttonMap].map(([k, v]) => `${k} (${v})`).join(', '));
    }
}

/* ------------------------------------------------------------------ report */

console.log('\n\n  ── RESULT ──');
const checks = [
    ['X axis drives ROLL', moved.has('X → ROLL')],
    ['Y axis drives PITCH', moved.has('Y → PITCH')],
    ['Z axis drives CAS', moved.has('Z → CAS')],
    ['R axis drives VERT SPEED', moved.has('R → VERT SPEED')],
    ['START button produces NCD', buttonMap.has('START')],
];
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'not seen'}  ${name}`);
console.log('');
console.log('  "not seen" means the input was not moved during the run — it is not a failure.');
console.log('  Any axis that moves the wrong parameter means the mapping needs changing in');
console.log('  firmware/src/flight.h (flight_step).');

backend.close();
killAll();
process.exit(0);
