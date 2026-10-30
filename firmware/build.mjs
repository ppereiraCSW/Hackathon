#!/usr/bin/env node
/**
 * Firmware build orchestration in plain Node -- no make, no cmake, no npm packages.
 *
 * Compiles the bare-metal Cortex-M3 firmware for the QEMU mps2-an385 board with
 * the Arm GNU toolchain, producing firmware/firmware.elf (and .bin).
 *
 * Usage: node firmware/build.mjs [--entry bringup|main]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Defaults are the winget install locations on the Windows dev machine.
// ARM_TOOLCHAIN_BIN / QEMU_BIN override them (CI on Linux: /usr/bin).
export const TOOLCHAIN_BIN =
    process.env.ARM_TOOLCHAIN_BIN ??
    'C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\14.2 rel1\\bin';
export const QEMU_BIN = process.env.QEMU_BIN ?? 'C:\\Program Files\\qemu';

const EXE = process.platform === 'win32' ? '.exe' : '';

export function gccPath() {
    const exe = join(TOOLCHAIN_BIN, `arm-none-eabi-gcc${EXE}`);
    if (!existsSync(exe)) throw new Error(`ARM GCC not found at ${exe} (set ARM_TOOLCHAIN_BIN)`);
    return exe;
}

export function qemuPath() {
    const exe = join(QEMU_BIN, `qemu-system-arm${EXE}`);
    if (!existsSync(exe)) throw new Error(`QEMU not found at ${exe} (set QEMU_BIN)`);
    return exe;
}

/**
 * Toolchain include dir for stdint.h. The Arm GNU release ships it next to bin/;
 * distro packages (apt gcc-arm-none-eabi) find it on their own, so it is optional.
 */
function toolchainIncludeArgs() {
    const inc = join(TOOLCHAIN_BIN, '..', 'arm-none-eabi', 'include');
    return existsSync(inc) ? [`-I${inc}`] : [];
}

const FLAGS = [
    '-mcpu=cortex-m3',
    '-mthumb',
    '-mfloat-abi=soft',
    '-O2',
    '-g',
    '-Wall',
    '-Wextra',
    '-ffreestanding',
    '-fno-builtin',
    '-nostdlib',
    '-ffunction-sections',
    '-fdata-sections',
];

/**
 * True when the ELF is missing or older than anything it is built from.
 * "Exists" is not enough: after a git pull the old binary would keep running
 * with the old flight model while the rest of the system is new.
 */
export function isStale({ entry = 'main', outDir = join(here, 'build') } = {}) {
    const elf = join(outDir, `firmware-${entry}.elf`);
    if (!existsSync(elf)) return true;
    const built = statSync(elf).mtimeMs;
    const srcDir = join(here, 'src');
    const inputs = [
        ...readdirSync(srcDir).map((f) => join(srcDir, f)),
        join(here, 'mps2-an385.ld'),
        join(here, 'build.mjs'),
    ];
    return inputs.some((f) => statSync(f).mtimeMs > built);
}

/** Build only when isStale(); returns the ELF path either way. */
export function ensureBuilt({ entry = 'main', quiet = false } = {}) {
    const elf = join(here, 'build', `firmware-${entry}.elf`);
    return isStale({ entry }) ? build({ entry, quiet }) : elf;
}

export function build({ entry = 'main', outDir = join(here, 'build'), quiet = false } = {}) {
    const gcc = gccPath();
    mkdirSync(outDir, { recursive: true });
    const elf = join(outDir, `firmware-${entry}.elf`);

    const sources = [
        join(here, 'src', 'startup.c'),
        join(here, 'src', entry === 'bringup' ? 'bringup.c' : 'main.c'),
    ];

    const log = (...a) => {
        if (!quiet) console.log(...a);
    };

    log(`[build] entry=${entry}`);
    execFileSync(
        gcc,
        [
            ...FLAGS,
            `-I${join(here, 'src')}`,
            ...toolchainIncludeArgs(),
            `-T${join(here, 'mps2-an385.ld')}`,
            '-Wl,--gc-sections',
            '-nostartfiles',
            // Comma-separated so the path stays one argv element: the repo path
            // contains a space ("CRITICAL SOFTWARE, S.A") and '-Wl,-Map=...'
            // would be split by the driver.
            '-Wl,-Map',
            join(outDir, `firmware-${entry}.map`),
            '-o',
            elf,
            ...sources,
            // -nostdlib drops libgcc too, but soft-float compares/adds
            // (__aeabi_fcmplt, __aeabi_fadd...) live there.
            '-lgcc',
        ],
        { stdio: 'inherit' },
    );

    // size report
    const size = join(TOOLCHAIN_BIN, `arm-none-eabi-size${EXE}`);
    const sizeOut = execFileSync(size, [elf], { encoding: 'utf8' });
    log(sizeOut.trim());

    return elf;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const argEntry = process.argv.includes('--entry')
        ? process.argv[process.argv.indexOf('--entry') + 1]
        : 'main';
    if (process.argv.includes('--clean')) {
        rmSync(join(here, 'build'), { recursive: true, force: true });
        console.log('[build] cleaned');
    }
    build({ entry: argEntry });
}
