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

        let failures = 0;
        const results = [];

        // ---- neutral
        for (let i = 0; i < 20; i++) { send({}); await sleep(20); }
        await sleep(150);
        let v = values();
        results.push(expect('neutral roll', v.ROLL, 0, 0.5));
        results.push(expect('neutral pitch', v.PITCH, 0, 0.5));
        results.push(expect('neutral CAS', v.CAS, 125, 2)); // Z centre -> 125 kt

        // ---- full right roll: X max -> +45 deg
        for (let i = 0; i < 20; i++) { send({ x: 65535 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('roll full right', v.ROLL, 45, 1));

        // ---- full left roll
        for (let i = 0; i < 20; i++) { send({ x: 0 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('roll full left', v.ROLL, -45, 1));

        // ---- stick back: Y max -> +20 deg pitch
        for (let i = 0; i < 20; i++) { send({ y: 65535 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('pitch full back', v.PITCH, 20, 1));

        // ---- stick forward: Y min -> -20 deg
        for (let i = 0; i < 20; i++) { send({ y: 0 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('pitch full forward', v.PITCH, -20, 1));

        // ---- throttle full: Z max -> 250 kt
        for (let i = 0; i < 20; i++) { send({ z: 65535 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('CAS full throttle', v.CAS, 250, 2));

        // ---- vertical speed full up: R max -> +2000 fpm
        for (let i = 0; i < 20; i++) { send({ r: 65535 }); await sleep(20); }
        await sleep(120);
        v = values();
        results.push(expect('VS full up', v.VERT_SPEED, 2000, 40));

        // ---- heading integrates from roll: hold right bank and watch it climb
        const hdgBefore = values().HEADING;
        for (let i = 0; i < 60; i++) { send({ x: 65535 }); await sleep(20); }
        await sleep(120);
        const hdgAfter = values().HEADING;
        const turned = ((hdgAfter - hdgBefore) + 360) % 360;
        const hdgOk = turned > 1 && turned < 180;
        console.log(`  ${hdgOk ? 'PASS' : 'FAIL'}  heading integrates right    ${hdgBefore.toFixed(1)} -> ${hdgAfter.toFixed(1)} (+${turned.toFixed(1)} deg)`);
        results.push(hdgOk);

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
