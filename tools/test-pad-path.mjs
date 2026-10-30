#!/usr/bin/env node
/**
 * Pad path test WITHOUT a physical stick movement.
 *
 * The pad reader listens for QEMU; here we stand in for it and inject synthetic
 * pad frames into the *firmware* over a TCP socket, then read the resulting
 * A429 words from the backend. This proves the whole chain
 *
 *     pad frame -> firmware model -> A429 encode -> backend decode -> value
 *
 * and is what a demo run cannot show on a machine with no hands on the stick.
 *
 * Usage: node tools/test-pad-path.mjs
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer, connect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { qemuPath } from '../firmware/build.mjs';
import { ParamState } from '../backend/src/state.js';

const PAD_PORT = 5586;
const A429_PORT = 5585;
const HTTP_PORT = 8199;

const labelsDoc = JSON.parse(readFileSync('shared/labels.json', 'utf8'));

/** Build a pad frame exactly as host/pad-reader.ps1 does. */
function padFrame({ seq = 0, x = 32767, y = 32767, z = 32767, r = 32767, buttons = 0, pov = -1 }) {
    const b = Buffer.alloc(17);
    b[0] = 0xa5;
    b[1] = 0x5a;
    b.writeUInt16LE(seq & 0xffff, 2);
    b.writeUInt16LE(x, 4);
    b.writeUInt16LE(y, 6);
    b.writeUInt16LE(z, 8);
    b.writeUInt16LE(r, 10);
    b.writeUInt16LE(buttons, 12);
    b.writeInt16LE(pov, 14);
    let xor = 0;
    for (let i = 0; i < 16; i++) xor ^= b[i];
    b[16] = xor;
    return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // 1. pad-frame server: QEMU connects here for UART1.
    let padSock = null;
    const padServer = createTcpServer((s) => {
        padSock = s;
        s.on('error', () => {});
    });
    await new Promise((r) => padServer.listen(PAD_PORT, '127.0.0.1', r));

    // 2. A429 collector: QEMU connects here for UART0.
    const state = new ParamState(labelsDoc);
    let pending = Buffer.alloc(0);
    const a429Server = createTcpServer((s) => {
        s.on('data', (d) => {
            pending = Buffer.concat([pending, d]);
            pending = Buffer.from(state.ingestChunk(pending));
        });
        s.on('error', () => {});
    });
    await new Promise((r) => a429Server.listen(A429_PORT, '127.0.0.1', r));

    // 3. Boot the firmware pointed at both.
    const qemu = spawn(qemuPath(), [
        '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
        '-chardev', `socket,id=u0,host=127.0.0.1,port=${A429_PORT},server=off`,
        '-serial', 'chardev:u0',
        '-chardev', `socket,id=u1,host=127.0.0.1,port=${PAD_PORT},server=off`,
        '-serial', 'chardev:u1',
        '-kernel', 'firmware/build/firmware-main.elf',
    ], { stdio: 'ignore' });

    try {
        // Wait for the guest to connect both UARTs.
        for (let i = 0; i < 100 && !padSock; i++) await sleep(50);
        if (!padSock) throw new Error('firmware never connected UART1');

        let seq = 0;
        const send = (opts) => {
            seq++;
            padSock.write(padFrame({ seq, ...opts }));
        };

        const values = () => {
            const snap = state.snapshot();
            return Object.fromEntries(snap.params.map((p) => [p.tag, p.valid ? p.value : null]));
        };

        const expect = (label, actual, want, tol) => {
            const ok = actual !== null && Math.abs(actual - want) <= tol;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} got ${actual === null ? 'null' : actual.toFixed(2)}  want ~${want}`);
            return ok;
        };

        /** Hold one stick state for `ms`, sending frames at the reader's 50 Hz. */
        const hold = async (opts, ms) => {
            for (let t = 0; t < ms; t += 20) { send(opts); await sleep(20); }
            await sleep(120);
            return values();
        };

        let failures = 0;
        const results = [];

        // The axes are rate commands (firmware/src/flight.h): deflection moves
        // the value, a centred stick holds it.

        // ---- neutral: the model's defaults, unchanged
        let v = await hold({}, 400);
        results.push(expect('neutral roll', v.ROLL, 0, 0.5));
        results.push(expect('neutral pitch', v.PITCH, 0, 0.5));
        results.push(expect('neutral CAS', v.CAS, 120, 1));

        // ---- full right roll for 2 s at 30 deg/s -> saturates at +45
        v = await hold({ x: 65535 }, 2000);
        results.push(expect('roll full right -> limit', v.ROLL, 45, 1));

        // ---- centre the stick: roll HOLDS, and the held bank keeps turning
        const hdgBefore = v.HEADING;
        v = await hold({}, 1000);
        results.push(expect('roll holds when centred', v.ROLL, 45, 1));
        const turned = ((v.HEADING - hdgBefore) + 360) % 360;
        const hdgOk = turned > 2 && turned < 180;
        console.log(`  ${hdgOk ? 'PASS' : 'FAIL'}  held bank keeps turning    ${hdgBefore.toFixed(1)} -> ${v.HEADING.toFixed(1)} (+${turned.toFixed(1)} deg)`);
        results.push(hdgOk);

        // ---- B pulsing at 5 Hz (a pad with turbo on) must NOT reset heading
        const hdgTurbo = values().HEADING;
        for (let i = 0; i < 5; i++) {
            await hold({ buttons: 0x0002 }, 100);
            await hold({}, 100);
        }
        const hdgAfterTurbo = values().HEADING;
        const turboOk = hdgAfterTurbo > hdgTurbo + 1;
        console.log(`  ${turboOk ? 'PASS' : 'FAIL'}  B pulses ignored           ${hdgTurbo.toFixed(1)} -> ${hdgAfterTurbo.toFixed(1)} (still turning)`);
        results.push(turboOk);

        // ---- B held for 1 s resets heading (the 45 deg bank keeps turning at
        // ~5 deg/s afterwards, so allow for the time since the reset)
        v = await hold({ buttons: 0x0002 }, 1100);
        const resetOk = v.HEADING < 4;
        console.log(`  ${resetOk ? 'PASS' : 'FAIL'}  B held 1 s resets heading  got ${v.HEADING.toFixed(2)}  want 0..4`);
        results.push(resetOk);

        // ---- half a second of left stick takes off ~15 deg, not all of it
        v = await hold({ x: 0 }, 500);
        const partial = v.ROLL > 20 && v.ROLL < 40;
        console.log(`  ${partial ? 'PASS' : 'FAIL'}  roll is incremental        got ${v.ROLL.toFixed(2)}  want 20..40`);
        results.push(partial);

        // ---- A levels the wings
        await hold({ buttons: 0x0001 }, 80);
        v = await hold({}, 200);
        results.push(expect('A -> wings level (roll)', v.ROLL, 0, 0.5));

        // ---- stick back for 2.5 s at 10 deg/s -> +20; forward 4.5 s -> -20
        v = await hold({ y: 65535 }, 2500);
        results.push(expect('pitch full back -> limit', v.PITCH, 20, 1));
        v = await hold({ y: 0 }, 4500);
        results.push(expect('pitch full forward -> limit', v.PITCH, -20, 1));

        // ---- throttle forward 1 s at 25 kt/s -> CAS rises by ~25 kt
        const casBefore = values().CAS;
        v = await hold({ z: 65535 }, 1000);
        const casUp = v.CAS - casBefore;
        const casOk = casUp > 15 && casUp < 35;
        console.log(`  ${casOk ? 'PASS' : 'FAIL'}  CAS rate                   +${casUp.toFixed(1)} kt in 1 s  want ~25`);
        results.push(casOk);

        // ---- D-pad up held 1 s steps altitude once (+500), not on every tick
        const altBefore = values().BARO_ALT;
        v = await hold({ pov: 0 }, 1000);
        await hold({}, 100);
        const altStep = values().BARO_ALT - altBefore;
        const povOk = Math.abs(altStep - 500) <= 20;
        console.log(`  ${povOk ? 'PASS' : 'FAIL'}  D-pad held: one step       +${altStep.toFixed(0)} ft  want 500`);
        results.push(povOk);

        // ---- vertical speed up 2.5 s at 1000 fpm/s -> +2000
        v = await hold({ r: 65535 }, 2500);
        results.push(expect('VS full up -> limit', v.VERT_SPEED, 2000, 40));

        // ---- START button toggles NCD on every label
        for (let i = 0; i < 4; i++) { send({ buttons: 0x0010 }); await sleep(20); }
        for (let i = 0; i < 12; i++) { send({}); await sleep(20); }
        await sleep(150);
        const snapNcd = state.snapshot();
        const allNcd = snapNcd.params.every((p) => p.valid === false && p.ssm === 'NCD');
        console.log(`  ${allNcd ? 'PASS' : 'FAIL'}  START freeze -> NCD        ${snapNcd.params.map((p) => p.ssm).join(',')}`);
        results.push(allNcd);

        // ---- START again clears NCD
        for (let i = 0; i < 4; i++) { send({ buttons: 0x0010 }); await sleep(20); }
        for (let i = 0; i < 12; i++) { send({}); await sleep(20); }
        await sleep(150);
        const cleared = state.snapshot().params.every((p) => p.ssm !== 'NCD');
        console.log(`  ${cleared ? 'PASS' : 'FAIL'}  START again clears NCD`);
        results.push(cleared);

        failures = results.filter((r) => !r).length;
        console.log('');
        console.log(`pad frame -> firmware -> A429 -> backend: ${results.length - failures}/${results.length} checks passed`);
        console.log(`A429 words decoded by the backend: ${state.snapshot().stats.words}`);
        if (failures) process.exitCode = 1;
    } finally {
        qemu.kill();
        padSock?.destroy();
        padServer.close();
        a429Server.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
