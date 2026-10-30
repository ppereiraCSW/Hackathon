#!/usr/bin/env node
/**
 * Keyboard path test: the REAL host/keyboard-reader.ps1 feeding the REAL firmware
 * in QEMU, decoded by the backend's ParamState.
 *
 *     keyboard-reader.ps1 -Hold <keys> -> firmware -> A429 -> decode -> value
 *
 * No key presses are injected into Windows: the reader's -Hold switch makes it
 * act as if those keys were held, so the test is deterministic and harmless to
 * whatever window has the focus. Windows only (PowerShell + user32).
 *
 * Usage: node tools/test-keyboard-path.mjs
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { qemuPath, build } from '../firmware/build.mjs';
import { ParamState } from '../backend/src/state.js';

const KBD_PORT = 5576;
const A429_PORT = 5575;
const ELF = 'firmware/build/firmware-main.elf';

const labelsDoc = JSON.parse(readFileSync('shared/labels.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the reader holding `keys` for `ms` after the guest connects, and return
 * the decoded snapshot at the end.
 */
async function runWith(keys, ms) {
    const state = new ParamState(labelsDoc);
    let pending = Buffer.alloc(0);
    const a429 = createTcpServer((s) => {
        s.on('data', (d) => {
            pending = Buffer.concat([pending, d]);
            pending = Buffer.from(state.ingestChunk(pending));
        });
        s.on('error', () => {});
    });
    await new Promise((r) => a429.listen(A429_PORT, '127.0.0.1', r));

    const reader = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'host/keyboard-reader.ps1',
        '-Port', String(KBD_PORT), '-Hold', keys.join(','),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let readerOut = '';
    let listening = false;
    let connected = false;
    const onOut = (d) => {
        readerOut += d;
        if (/listening on 127\.0\.0\.1:/.test(readerOut)) listening = true;
        if (/guest connected/.test(readerOut)) connected = true;
    };
    reader.stdout.on('data', onOut);
    reader.stderr.on('data', onOut);

    let qemu = null;
    try {
        for (let i = 0; i < 400 && !listening; i++) await sleep(50);
        if (!listening) throw new Error(`keyboard reader never listened:\n${readerOut}`);

        qemu = spawn(qemuPath(), [
            '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
            '-chardev', `socket,id=u0,host=127.0.0.1,port=${A429_PORT},server=off`,
            '-serial', 'chardev:u0',
            '-chardev', `socket,id=u1,host=127.0.0.1,port=${KBD_PORT},server=off`,
            '-serial', 'chardev:u1',
            '-kernel', ELF,
        ], { stdio: 'ignore' });

        for (let i = 0; i < 200 && !connected; i++) await sleep(50);
        if (!connected) throw new Error(`guest never connected to the keyboard reader:\n${readerOut}`);

        await sleep(ms);
        return state.snapshot();
    } finally {
        qemu?.kill();
        reader.kill();
        a429.close();
        await sleep(300);
    }
}

const byTag = (snap) => Object.fromEntries(snap.params.map((p) => [p.tag, p]));

let failures = 0;
function check(label, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)} ${detail}`);
    if (!ok) failures++;
}
const f = (v) => (v === null || v === undefined ? 'null' : v.toFixed(1));

async function main() {
    if (process.platform !== 'win32') {
        console.log('[kbd-test] needs Windows (PowerShell + user32)');
        process.exit(2);
    }
    if (!existsSync(ELF)) build({ entry: 'main', quiet: true });

    // V/S follows pitch and airspeed in the firmware, so the pitch keys are
    // also the climb / descend keys.
    console.log('[kbd-test] Right, Up, W held 2 s (full deflection)');
    let p = byTag(await runWith(['Right', 'Up', 'W'], 2000));
    check('Right arrow banks right', p.ROLL.value > 20, `roll ${f(p.ROLL.value)} deg`);
    check('Up arrow pitches up', p.PITCH.value > 5, `pitch ${f(p.PITCH.value)} deg`);
    check('W speeds up', p.CAS.value > 140, `CAS ${f(p.CAS.value)} kt (from 120)`);
    check('Up arrow climbs', p.VERT_SPEED.value > 1000, `V/S ${f(p.VERT_SPEED.value)} ft/min`);

    console.log('[kbd-test] Shift + Left, Down, S held 2 s (gentle)');
    p = byTag(await runWith(['Shift', 'Left', 'Down', 'S'], 2000));
    check('Left arrow banks left, gently', p.ROLL.value < -5 && p.ROLL.value > -30, `roll ${f(p.ROLL.value)} deg`);
    check('Down arrow pitches down', p.PITCH.value < -1, `pitch ${f(p.PITCH.value)} deg`);
    check('S slows down', p.CAS.value < 120, `CAS ${f(p.CAS.value)} kt (from 120)`);
    check('Down arrow descends', p.VERT_SPEED.value < -100, `V/S ${f(p.VERT_SPEED.value)} ft/min`);

    console.log('[kbd-test] Page Up held 1.5 s');
    p = byTag(await runWith(['PageUp'], 1500));
    check('Page Up steps altitude once, not per frame', Math.abs(p.BARO_ALT.value - 5500) <= 20, `alt ${f(p.BARO_ALT.value)} ft (want 5500)`);

    console.log('[kbd-test] Enter held 1 s');
    const snap = await runWith(['Enter'], 1000);
    const ncd = snap.params.every((q) => q.ssm === 'NCD');
    check('Enter freezes: every label NCD', ncd, snap.params.map((q) => q.ssm).join(','));

    console.log(failures ? `[kbd-test] FAIL: ${failures} check(s)` : '[kbd-test] all checks pass');
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(`[kbd-test] ${e.message}`);
    process.exit(1);
});
