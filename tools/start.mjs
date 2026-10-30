#!/usr/bin/env node
/**
 * Friendly launcher: pick how to fly, then the display opens by itself.
 *
 *   start.cmd                       # double-click on Windows: shows the menu
 *   node tools/start.mjs            # same menu
 *   node tools/start.mjs keyboard   # skip the menu: gamepad | keyboard | demo | replay
 *   node tools/start.mjs stop       # stop a running instance (also: npm run stop)
 *   node tools/start.mjs --no-browser
 *
 * If an old session is still running (closing the browser does not stop it),
 * it is closed first, so the menu always shows.
 *
 * It checks the prerequisites, suggests the gamepad when one is plugged in,
 * runs tools/run-all.mjs in the chosen mode, waits until flight data really
 * reaches the backend, then opens the SFD and prints the controls.
 */
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gccPath, qemuPath } from '../firmware/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const HTTP_PORT = 8090;
const SFD = `http://127.0.0.1:${HTTP_PORT}/sfd`;
const CONFIG = `http://127.0.0.1:${HTTP_PORT}/config`;

const args = process.argv.slice(2);
const noBrowser = args.includes('--no-browser');
const stopOnly = args.includes('stop');
const asked = stopOnly ? null : args.find((a) => !a.startsWith('--'));

const c = {
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const MODES = {
    gamepad: { flag: [], title: 'Gamepad', what: 'fly with the USB gamepad', needs: ['toolchain', 'windows'] },
    keyboard: { flag: ['--keyboard'], title: 'Keyboard', what: 'fly with the keyboard', needs: ['toolchain', 'windows'] },
    demo: { flag: ['--demo'], title: 'Demo', what: 'scripted flight, hands off', needs: ['toolchain'] },
    replay: { flag: ['--replay'], title: 'Replay', what: 'recorded flight, display only (no QEMU)', needs: [] },
};

const CONTROLS = {
    gamepad: [
        ['left stick', 'roll and pitch'],
        ['throttle / rudder', 'speed / climb'],
        ['A', 'wings level'],
        ['B (hold 1 s)', 'reset heading'],
        ['LB / RB', 'speed -10 / +10 kt'],
        ['D-pad up / down', 'altitude +500 / -500 ft'],
        ['START', 'freeze: every instrument NCD'],
    ],
    keyboard: [
        ['arrows', 'roll and pitch'],
        ['W / S', 'speed up / down'],
        ['R / F', 'climb / descend'],
        ['Shift (held)', 'gentle'],
        ['Space', 'wings level'],
        ['H (hold 1 s)', 'reset heading'],
        ['Q / E', 'speed -10 / +10 kt'],
        ['PgUp / PgDn', 'altitude +500 / -500 ft'],
        ['Enter', 'freeze: every instrument NCD'],
    ],
};

/* ---------------------------------------------------------------- checks */

function haveToolchain() {
    try {
        gccPath();
        qemuPath();
        return true;
    } catch {
        return false;
    }
}

function portBusy(port) {
    return new Promise((res) => {
        const s = connect(port, '127.0.0.1');
        s.once('connect', () => {
            s.destroy();
            res(true);
        });
        s.once('error', () => res(false));
    });
}

/** True when Windows lists a game controller. Best effort, never throws. */
function gamepadPresent() {
    if (process.platform !== 'win32') return Promise.resolve(false);
    const ps =
        "(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.FriendlyName -like '*game controller*' -or $_.InstanceId -like 'HID\\VID_0079&PID_181C*' }).Count";
    return new Promise((res) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, out) => {
            res(!err && Number(String(out).trim()) > 0);
        });
    });
}

function openBrowser(url) {
    const [cmd, argv] =
        process.platform === 'win32'
            ? ['cmd.exe', ['/c', 'start', '""', url]]
            : process.platform === 'darwin'
              ? ['open', [url]]
              : ['xdg-open', [url]];
    spawn(cmd, argv, { stdio: 'ignore', detached: true }).unref();
}

async function waitForData(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/health`);
            const h = await r.json();
            if (h.words > 30 && h.staleTags.length === 0) return true;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

/* ------------------------------------------------- an instance already up */

/**
 * The system already running on HTTP_PORT, if it is ours: walks up from the
 * process listening on the port to the outermost start.mjs / run-all.mjs, so
 * stopping it takes the whole tree (QEMU and the input reader included).
 * @returns {Promise<{pid:number, mode:string, since:string}|null>}
 */
function findRunning() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    const ps = `
$l = Get-NetTCPConnection -LocalPort ${HTTP_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $l) { exit }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)"
$chain = @()
while ($p) {
    $chain += [pscustomobject]@{ Id = $p.ProcessId; Cmd = $p.CommandLine; Since = $p.CreationDate.ToString('HH:mm') }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
}
ConvertTo-Json -Compress -InputObject @($chain)`;
    return new Promise((res) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15000 }, (err, out) => {
            if (err || !String(out).trim()) return res(null);
            let chain;
            try {
                chain = JSON.parse(out);
            } catch {
                return res(null);
            }
            const ours = chain.filter((p) => /serve\.mjs|run-all\.mjs|start\.mjs/.test(p.Cmd ?? ''));
            if (ours.length === 0) return res(null);
            const top = ours[ours.length - 1];
            const runAll = ours.find((p) => /run-all\.mjs/.test(p.Cmd)) ?? null;
            const flags = runAll?.Cmd ?? '';
            const mode = !runAll
                ? 'backend only'
                : /--keyboard/.test(flags)
                  ? 'Keyboard'
                  : /--demo/.test(flags)
                    ? 'Demo'
                    : /--replay/.test(flags)
                      ? 'Replay'
                      : /--no-pad/.test(flags)
                        ? 'No input'
                        : 'Gamepad';
            res({ pid: top.Id, mode, since: top.Since });
        });
    });
}

/** Stop a running instance and wait until its ports are free. */
async function stopRunning(run) {
    await new Promise((res) => execFile('taskkill', ['/PID', String(run.pid), '/T', '/F'], () => res()));
    for (let i = 0; i < 40; i++) {
        const busy = await Promise.all([HTTP_PORT, 5555, 5556].map(portBusy));
        if (!busy.some(Boolean)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

/* ------------------------------------------------------------------ input */

// One readline for every question, fed into a queue: rl.question() drops lines
// that arrive before it is asked again (fast typing, pasted input).
let rl = null;
const pendingLines = [];
let lineWaiter = null;

function nextLine() {
    if (!rl) {
        rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on('line', (l) => (lineWaiter ? (lineWaiter(l), (lineWaiter = null)) : pendingLines.push(l)));
        rl.on('close', () => lineWaiter?.(null));
        // Without a listener readline swallows Ctrl+C; quit as the user expects.
        rl.on('SIGINT', () => process.exit(130));
    }
    if (pendingLines.length) return Promise.resolve(pendingLines.shift());
    return new Promise((r) => (lineWaiter = r));
}

function closeInput() {
    rl?.close();
    rl = null;
}

/** Ask for a number 1..max; Enter picks `def`. `accept(n)` returns an error text or null. */
async function askNumber(max, def, accept = () => null) {
    for (;;) {
        process.stdout.write(`\n  Choose 1-${max} [${def}]: `);
        const line = await nextLine();
        if (line === null) return null; // input closed
        const a = line.trim();
        const n = a === '' ? def : Number(a);
        if (!Number.isInteger(n) || n < 1 || n > max) {
            console.log(c.yellow('  Type a number from the list.'));
            continue;
        }
        const err = accept(n);
        if (!err) return n;
        console.log(c.yellow(`  ${err}`));
    }
}

/* ------------------------------------------------------------------ menu */

async function chooseMode(available, suggested) {
    const keys = Object.keys(MODES);
    console.log(c.bold('\n  Avionics pipeline: gamepad -> ARM firmware in QEMU -> ARINC 429 -> flight display\n'));
    keys.forEach((k, i) => {
        const m = MODES[k];
        const tag = k === suggested ? c.green(' (suggested)') : '';
        const line = `  ${i + 1}  ${m.title.padEnd(9)} ${m.what}${tag}`;
        console.log(available[k] ? line : c.dim(`${line}  - ${available.why[k]}`));
    });
    const n = await askNumber(keys.length, keys.indexOf(suggested) + 1, (i) =>
        available[keys[i - 1]] ? null : `${MODES[keys[i - 1]].title} is not available here: ${available.why[keys[i - 1]]}`,
    );
    return n === null ? null : keys[n - 1];
}

/**
 * Port 8090 is taken. If it is an old session of this system, close it;
 * otherwise explain.
 * @returns {Promise<'continue'|'done'>} continue = the port is free now
 */
async function handleRunning(wantedMode) {
    const run = await findRunning();
    if (!run) {
        console.log(c.yellow(`\n  Port ${HTTP_PORT} is used by another program, so the system cannot start.`));
        console.log(`  Close that program, or check what it is with: ${c.dim(`Get-NetTCPConnection -LocalPort ${HTTP_PORT}`)}\n`);
        process.exitCode = 1;
        return 'done';
    }

    if (stopOnly) {
        console.log(`  Stopping the running system (${run.mode}, started ${run.since})...`);
        console.log((await stopRunning(run)) ? c.green('  Stopped.') : c.red('  Could not free the ports; close its window by hand.'));
        return 'done';
    }

    // Closing the browser does not stop the system, so an old session is often
    // still running in a forgotten window. Starting again means "start fresh":
    // close the old one without asking, then show the menu as always.
    process.stdout.write(c.dim(`  Closing the previous session (${run.mode}, started ${run.since})... `));
    if (!(await stopRunning(run))) {
        console.log(c.red('\n  Could not close it. Close its window by hand and try again.'));
        process.exitCode = 1;
        return 'done';
    }
    console.log(c.dim('done.'));
    return 'continue';
}

/* ------------------------------------------------------------------ main */

async function main() {
    if (await portBusy(HTTP_PORT)) {
        if ((await handleRunning(asked)) === 'done') return closeInput();
    } else if (stopOnly) {
        console.log('  Nothing is running.');
        return;
    }

    const toolchain = haveToolchain();
    const windows = process.platform === 'win32';
    const available = { why: {} };
    for (const [k, m] of Object.entries(MODES)) {
        const missing = m.needs.filter((n) => (n === 'toolchain' ? !toolchain : n === 'windows' ? !windows : false));
        available[k] = missing.length === 0;
        if (missing.includes('toolchain')) available.why[k] = 'needs the ARM toolchain and QEMU (see README, Prerequisites)';
        else if (missing.includes('windows')) available.why[k] = 'needs Windows';
    }

    let mode = asked;
    if (mode && !MODES[mode]) {
        console.log(c.red(`  Unknown mode "${mode}". Use one of: ${Object.keys(MODES).join(', ')}`));
        process.exitCode = 1;
        return;
    }
    if (mode && !available[mode]) {
        console.log(c.red(`  ${MODES[mode].title} is not available here: ${available.why[mode]}`));
        process.exitCode = 1;
        return;
    }
    if (!mode) {
        let suggested = available.keyboard ? 'keyboard' : 'replay';
        if (available.gamepad) {
            process.stdout.write(c.dim('  Looking for a gamepad... '));
            const pad = await gamepadPresent();
            console.log(c.dim(pad ? 'found.' : 'none.'));
            if (pad) suggested = 'gamepad';
        }
        if (!toolchain) {
            console.log(c.yellow('\n  The ARM toolchain or QEMU is missing, so only Replay can run. To install them:'));
            console.log(c.dim('    winget install --id Arm.GnuArmEmbeddedToolchain --exact'));
            console.log(c.dim('    winget install --id SoftwareFreedomConservancy.QEMU --exact'));
        }
        mode = await chooseMode(available, suggested);
        if (!mode) return closeInput();
    }
    closeInput();

    const hint = mode === 'replay' ? '' : c.dim('(the first start builds the firmware; give it a few seconds)');
    console.log(`\n  Starting ${c.bold(MODES[mode].title)}... ${hint}`);

    const runAll = spawn(process.execPath, [join(ROOT, 'tools', 'run-all.mjs'), ...MODES[mode].flag], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const keep = (d) => {
        log = (log + d).slice(-8000);
    };
    runAll.stdout.on('data', keep);
    runAll.stderr.on('data', keep);

    let exited = false;
    let stopping = false;
    runAll.on('exit', (code) => {
        exited = true;
        // Ctrl+C reaches run-all too and it may exit before our own handler
        // runs, so give that a moment before calling it a crash.
        setTimeout(() => {
            if (stopping) return;
            console.log(c.red(`\n  The system stopped unexpectedly (exit ${code}). Last output:\n`));
            console.log(log.split('\n').slice(-25).join('\n'));
            process.exit(1);
        }, 300);
    });

    const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log(c.dim('\n  Stopping...'));
        if (!exited) {
            // On Windows kill() only ends run-all itself and would orphan QEMU
            // and the input reader; taskkill /T takes the whole tree.
            if (process.platform === 'win32') {
                execFile('taskkill', ['/PID', String(runAll.pid), '/T', '/F'], () => {});
            } else {
                runAll.kill('SIGINT');
            }
        }
        setTimeout(() => process.exit(0), 1500);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    const ok = await waitForData(60000);
    if (exited) return;
    if (!ok) {
        console.log(c.red('\n  No flight data reached the backend within 60 s. Last output:\n'));
        console.log(log.split('\n').slice(-25).join('\n'));
        console.log(c.dim('\n  See ai/skills/debug-pipeline/SKILL.md, or try the Replay mode.'));
        stop();
        return;
    }

    console.log(c.green('\n  Running. Flight data is flowing.\n'));
    console.log(`  Flight display   ${c.cyan(SFD)}`);
    console.log(`  Display config   ${c.cyan(CONFIG)}`);
    const keys = CONTROLS[mode];
    if (keys) {
        console.log(c.bold('\n  Controls') + (mode === 'keyboard' ? c.dim('  (work in any window, so keep the browser in front)') : ''));
        for (const [k, v] of keys) console.log(`    ${k.padEnd(18)} ${v}`);
    }
    console.log(c.bold('\n  Press Ctrl+C here to stop.\n'));
    if (!noBrowser) openBrowser(SFD);
}

main().catch((e) => {
    console.error(c.red(`  ${e.message}`));
    process.exitCode = 1;
});
