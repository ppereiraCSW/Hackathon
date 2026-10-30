#!/usr/bin/env node
/**
 * Runs the whole stack, in the right order, and tears it down on Ctrl+C.
 *
 *   node tools/run-all.mjs                # full: pad reader + QEMU + backend
 *   node tools/run-all.mjs --keyboard     # fly with the keyboard instead of the pad
 *   node tools/run-all.mjs --demo         # scripted flight, nobody at the controls
 *   node tools/run-all.mjs --no-pad       # no input at all (firmware holds its state)
 *   node tools/run-all.mjs --replay       # DECOUPLED: backend only, from capture
 *
 * Ordering matters: QEMU's UART1 is a TCP *client* to the pad reader's listener,
 * and its UART0 is a client to the backend's listener, so both servers must be
 * up before QEMU starts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qemuPath, build, TOOLCHAIN_BIN } from '../firmware/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const HTTP_PORT = 8090;
const A429_PORT = 5555;
const PAD_PORT = 5556;

const children = [];
let shuttingDown = false;

function log(tag, msg) {
    const colors = { backend: '\x1b[36m', qemu: '\x1b[35m', pad: '\x1b[33m', kbd: '\x1b[33m', demo: '\x1b[33m', sys: '\x1b[32m' };
    const c = colors[tag] ?? '\x1b[0m';
    console.log(`${c}[${tag.padEnd(7)}]\x1b[0m ${msg}`);
}

function launch(tag, cmd, argv, opts = {}) {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    children.push({ tag, child });
    const emit = (d) => {
        for (const l of String(d).trimEnd().split('\n')) {
            if (!l) continue;
            log(tag, l);
            opts.onLine?.(l);
        }
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('exit', (code) => {
        if (!shuttingDown) log(tag, `exited with code ${code}`);
    });
    return child;
}

function shutdown(why = 'SIGINT') {
    if (shuttingDown) return;
    shuttingDown = true;
    log('sys', `shutting down (${why})`);
    for (const { tag, child } of children.reverse()) {
        try {
            child.kill();
            log('sys', `stopped ${tag}`);
        } catch {
            /* ignore */
        }
    }
    setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Wait for a component to announce readiness on its stdout.
 *
 * Do NOT probe the pad reader's port to see whether it is up: it calls
 * AcceptTcpClient() exactly once, so a probe connection is mistaken for the
 * guest, gets a frame, and then closes -- leaving the real guest (QEMU) locked
 * out with "Failed to connect". Watching for the printed line is the only safe
 * signal.
 */
function waitForAnnouncement(register, match, { timeoutMs = 40000, label = 'component' } = {}) {
    return new Promise((res, rej) => {
        const timer = setTimeout(
            () => rej(new Error(`${label} did not announce readiness within ${timeoutMs} ms`)),
            timeoutMs,
        );
        register.onAnnounce((line) => {
            if (match.test(line)) {
                clearTimeout(timer);
                res();
            }
        });
    });
}

/* ------------------------------------------------------------------- start */

mkdirSync(join(ROOT, 'build'), { recursive: true });

const mode = has('--replay')
    ? 'replay'
    : has('--no-pad')
      ? 'no-pad'
      : has('--keyboard')
        ? 'keyboard'
        : has('--demo')
          ? 'demo'
          : 'full';

/**
 * Whatever feeds pad frames to QEMU's UART1. All of them listen on PAD_PORT and
 * speak the same 17-byte frame, so the firmware cannot tell them apart.
 * `ready` matches the line each one prints once its socket is bound.
 */
const PAD_SOURCES = {
    full: {
        tag: 'pad',
        cmd: 'powershell.exe',
        argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'host', 'pad-reader.ps1'), '-Port', String(PAD_PORT)],
        ready: /listening on 127\.0\.0\.1:/,
    },
    keyboard: {
        tag: 'kbd',
        cmd: 'powershell.exe',
        argv: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'host', 'keyboard-reader.ps1'), '-Port', String(PAD_PORT)],
        ready: /listening on 127\.0\.0\.1:/,
    },
    demo: {
        tag: 'demo',
        cmd: process.execPath,
        argv: [join(ROOT, 'tools', 'demo-inject.mjs'), '3600'],
        ready: /listening on/,
    },
};
const padSource = PAD_SOURCES[mode] ?? null;

async function main() {
log('sys', `mode: ${mode}`);

// --- 1. backend (both modes need it; in replay it is the only data source)
const backendArgs = [join(ROOT, 'backend', 'serve.mjs')];
if (mode === 'replay') {
    backendArgs.push('--replay', join(ROOT, 'shared', 'capture.a429'));
}
let backendReady = () => {};
const backendAnnounced = new Promise((res) => { backendReady = res; });
launch('backend', process.execPath, backendArgs, {
    onLine: (line) => {
        if (/awaiting A429 words|DECOUPLED replay/.test(line)) backendReady();
    },
});

if (mode !== 'replay') {
    // --- 2. pad reader (listens; QEMU connects to it)
    // It announces "listening on ..." only after it has compiled its C# interop
    // and bound the socket, so that line is the readiness signal.
    let padReady = () => {};
    const padAnnounced = new Promise((res) => { padReady = res; });
    if (padSource) {
        launch(padSource.tag, padSource.cmd, padSource.argv, {
            onLine: (line) => {
                if (padSource.ready.test(line)) padReady();
            },
        });
    } else {
        padReady();
        log('sys', 'no pad: the firmware will hold its default flight state');
    }

    // --- 3. firmware: build, then boot in QEMU
    const elf = join(ROOT, 'firmware', 'build', 'firmware-main.elf');
    if (!existsSync(elf)) {
        log('sys', 'building firmware...');
        build({ entry: 'main', quiet: true });
    }

    // The backend prints its "awaiting A429 words" line once it is bound.
    const withTimeout = (p, ms, what) =>
        Promise.race([
            p,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not become ready within ${ms} ms`)), ms)),
        ]);
    try {
        await withTimeout(backendAnnounced, 20000, 'backend');
        if (padSource) {
            await withTimeout(padAnnounced, 40000, `${padSource.tag} input (PowerShell compiles C# interop first, ~3 s)`);
        }
        log('sys', padSource ? `backend and ${padSource.tag} input are both listening` : 'backend is listening');
    } catch (err) {
        log('sys', `cannot start QEMU: ${err.message}`);
        log('sys', 'fix the failing component above, then run again');
        shutdown('startup failure');
        return;
    }

    const argv = [
        '-M', 'mps2-an385',
        '-cpu', 'cortex-m3',
        '-nographic',
        '-monitor', 'none',
        // UART0 TX -> backend (we are a TCP client)
        '-chardev', `socket,id=u0,host=127.0.0.1,port=${A429_PORT},server=off`,
        '-serial', 'chardev:u0',
    ];
    // UART1 only exists when a pad source is listening.
    if (padSource) {
        argv.push(
            // UART1 RX <- pad reader (we are also a client)
            '-chardev', `socket,id=u1,host=127.0.0.1,port=${PAD_PORT},server=off`,
            '-serial', 'chardev:u1',
        );
    }
    argv.push('-kernel', elf);
    launch('qemu', qemuPath(), argv);
    log('sys', 'firmware booted in QEMU');
}

setTimeout(() => {
    log('sys', `configuration page: http://127.0.0.1:${HTTP_PORT}/config`);
    log('sys', `secondary flight display: http://127.0.0.1:${HTTP_PORT}/sfd`);
}, 1200);
}

main().catch((err) => {
    log('sys', `fatal: ${err.message}`);
    shutdown('fatal error');
});
