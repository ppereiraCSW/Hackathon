/**
 * Shared harness: boot the real firmware in QEMU, stand in for the pad reader
 * on UART1, and decode its A429 output on UART0 with the real backend state.
 *
 *     pad frame -> firmware model -> A429 encode -> backend decode -> value
 *
 * Used by tools/test-pad-path.mjs and tools/test-boundaries.mjs.
 */
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { qemuPath } from '../firmware/build.mjs';
import { ParamState } from '../backend/src/state.js';

const labelsDoc = JSON.parse(readFileSync('shared/labels.json', 'utf8'));

/** Button masks as host/pad-reader.ps1 reports them. */
export const BTN = { A: 0x0001, B: 0x0002, LB: 0x0004, RB: 0x0008, START: 0x0010 };
/** Pad axis extremes and centre. */
export const AXIS = { MIN: 0, CENTRE: 32767, MAX: 65535 };

/** Build a pad frame exactly as host/pad-reader.ps1 does. */
export function padFrame({ seq = 0, x = 32767, y = 32767, z = 32767, r = 32767, buttons = 0, pov = -1 }) {
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the firmware and return helpers to drive it.
 * @param {{padPort:number, a429Port:number}} ports
 */
export async function startFirmware({ padPort, a429Port }) {
    let padSock = null;
    const padServer = createTcpServer((s) => {
        padSock = s;
        s.on('error', () => {});
    });
    await new Promise((r) => padServer.listen(padPort, '127.0.0.1', r));

    const state = new ParamState(labelsDoc);
    let pending = Buffer.alloc(0);
    const a429Server = createTcpServer((s) => {
        s.on('data', (d) => {
            pending = Buffer.concat([pending, d]);
            pending = Buffer.from(state.ingestChunk(pending));
        });
        s.on('error', () => {});
    });
    await new Promise((r) => a429Server.listen(a429Port, '127.0.0.1', r));

    const qemu = spawn(qemuPath(), [
        '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
        '-chardev', `socket,id=u0,host=127.0.0.1,port=${a429Port},server=off`,
        '-serial', 'chardev:u0',
        '-chardev', `socket,id=u1,host=127.0.0.1,port=${padPort},server=off`,
        '-serial', 'chardev:u1',
        '-kernel', 'firmware/build/firmware-main.elf',
    ], { stdio: 'ignore' });

    const close = () => {
        qemu.kill();
        padSock?.destroy();
        padServer.close();
        a429Server.close();
    };

    for (let i = 0; i < 100 && !padSock; i++) await sleep(50);
    if (!padSock) {
        close();
        throw new Error('firmware never connected UART1');
    }

    let seq = 0;
    const send = (opts) => {
        seq++;
        padSock.write(padFrame({ seq, ...opts }));
    };

    /** tag -> decoded value, or null when not valid. */
    const values = () => {
        const snap = state.snapshot();
        return Object.fromEntries(snap.params.map((p) => [p.tag, p.valid ? p.value : null]));
    };

    /** Hold one stick state for `ms`, sending frames at the reader's 50 Hz. */
    const hold = async (opts, ms) => {
        for (let t = 0; t < ms; t += 20) { send(opts); await sleep(20); }
        await sleep(120);
        return values();
    };

    /** Press and release a button (or D-pad direction) `n` times. */
    const press = async (opts, n = 1) => {
        for (let i = 0; i < n; i++) {
            send(opts); await sleep(20);
            send({}); await sleep(20);
        }
        await sleep(120);
        return values();
    };

    /**
     * Hold `opts` for `ms`, sampling every frame; returns every decoded sample.
     * For checks that must hold at every instant, not just at the end.
     */
    const trace = async (opts, ms) => {
        const out = [];
        for (let t = 0; t < ms; t += 20) { send(opts); await sleep(20); out.push(values()); }
        return out;
    };

    return { send, hold, press, trace, values, state, close };
}

/** Pass/fail line printer; collects results for the summary. */
export function checker() {
    const results = [];
    const report = (label, ok, detail) => {
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
        results.push(ok);
        return ok;
    };
    const near = (label, actual, want, tol) => report(
        label,
        actual !== null && Math.abs(actual - want) <= tol,
        `got ${actual === null ? 'null' : actual.toFixed(2)}  want ${want}${tol ? ` ±${tol}` : ''}`,
    );
    const summary = (title) => {
        const failures = results.filter((r) => !r).length;
        console.log('');
        console.log(`${title}: ${results.length - failures}/${results.length} checks passed`);
        if (failures) process.exitCode = 1;
    };
    return { report, near, summary };
}
