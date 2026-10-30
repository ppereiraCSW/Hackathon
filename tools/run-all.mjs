#!/usr/bin/env node
/**
 * Runs the whole stack, in the right order, and tears it down on Ctrl+C.
 *
 *   node tools/run-all.mjs                # full: pad reader + QEMU + backend
 *   node tools/run-all.mjs --no-pad       # no gamepad (firmware keeps defaults)
 *   node tools/run-all.mjs --replay       # DECOUPLED: backend only, from capture
 *
 * Ordering matters: QEMU's UART1 is a TCP *client* to the pad reader's listener,
 * and its UART0 is a client to the backend's listener, so both servers must be
 * up before QEMU starts.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
    const colors = { backend: '\x1b[36m', qemu: '\x1b[35m', pad: '\x1b[33m', sys: '\x1b[32m' };
    const c = colors[tag] ?? '\x1b[0m';
    console.log(`${c}[${tag.padEnd(7)}]\x1b[0m ${msg}`);
}

function launch(tag, cmd, argv, opts = {}) {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    children.push({ tag, child });
    child.stdout?.on('data', (d) => String(d).trimEnd().split('\n').forEach((l) => l && log(tag, l)));
    child.stderr?.on('data', (d) => String(d).trimEnd().split('\n').forEach((l) => l && log(tag, l)));
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

/* ------------------------------------------------------------------- start */

mkdirSync(join(ROOT, 'build'), { recursive: true });

const mode = has('--replay') ? 'replay' : has('--no-pad') ? 'no-pad' : 'full';
log('sys', `mode: ${mode}`);

// --- 1. backend (both modes need it; in replay it is the only data source)
const backendArgs = [join(ROOT, 'backend', 'serve.mjs')];
if (mode === 'replay') {
    backendArgs.push('--replay', join(ROOT, 'shared', 'capture.a429'));
}
launch('backend', process.execPath, backendArgs);

if (mode !== 'replay') {
    // --- 2. pad reader (listens; QEMU connects to it)
    if (mode === 'full') {
        launch('pad', 'powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', join(ROOT, 'host', 'pad-reader.ps1'),
            '-Port', String(PAD_PORT),
        ]);
    } else {
        log('sys', 'no pad: the firmware will hold its default flight state');
    }

    // --- 3. firmware: build, then boot in QEMU
    const elf = join(ROOT, 'firmware', 'build', 'firmware-main.elf');
    if (!existsSync(elf)) {
        log('sys', 'building firmware...');
        build({ entry: 'main', quiet: true });
    }

    setTimeout(() => {
        const argv = [
            '-M', 'mps2-an385',
            '-cpu', 'cortex-m3',
            '-nographic',
            '-monitor', 'none',
            // UART0 TX -> backend (we are a TCP client)
            '-chardev', `socket,id=u0,host=127.0.0.1,port=${A429_PORT},server=off`,
            '-serial', 'chardev:u0',
        ];
        // UART1 only exists when a pad reader is listening. QEMU exits if a
        // client chardev cannot connect, so attaching it unconditionally would
        // make the whole stack die just because no gamepad is plugged in.
        if (mode === 'full') {
            argv.push(
                // UART1 RX <- pad reader (we are also a client)
                '-chardev', `socket,id=u1,host=127.0.0.1,port=${PAD_PORT},server=off`,
                '-serial', 'chardev:u1',
            );
        }
        argv.push('-kernel', elf);
        launch('qemu', qemuPath(), argv);
        log('sys', 'firmware booted in QEMU');
    }, 1500);
}

setTimeout(() => {
    log('sys', `configuration page: http://127.0.0.1:${HTTP_PORT}/config`);
    log('sys', `secondary flight display: http://127.0.0.1:${HTTP_PORT}/sfd`);
}, 1200);
