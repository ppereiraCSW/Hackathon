#!/usr/bin/env node
/**
 * Which agent owns each changed file, and did anyone step outside their paths?
 *
 * Ownership comes from ai/ownership.json (longest matching entry wins).
 *
 *   node tools/check-ownership.mjs                    # working tree vs HEAD
 *   node tools/check-ownership.mjs --staged           # staged files only (pre-commit)
 *   node tools/check-ownership.mjs --base sandbox     # commits on this branch vs sandbox
 *   node tools/check-ownership.mjs --agent backend    # fail if backend touched other paths
 *   node tools/check-ownership.mjs path/a path/b      # explicit files
 *
 * Exit 1 on an unowned file, or on a file outside --agent's paths. A change that
 * spans several layers is reported, not failed: the integrator coordinates those.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

export function loadOwnership(root = ROOT) {
    return JSON.parse(readFileSync(join(root, 'ai', 'ownership.json'), 'utf8'));
}

/** @returns {string|null} the owning agent, or null when no entry matches */
export function ownerOf(path, ownership) {
    const p = path.replace(/\\/g, '/');
    let best = null;
    let bestLen = -1;
    for (const [agent, def] of Object.entries(ownership.agents)) {
        for (const entry of def.owns) {
            const hit = entry.endsWith('/') ? p.startsWith(entry) : p === entry;
            if (hit && entry.length > bestLen) {
                best = agent;
                bestLen = entry.length;
            }
        }
    }
    return best;
}

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
}

function changedFiles(args) {
    const i = args.indexOf('--base');
    if (i >= 0) return git(['diff', '--name-only', `${args[i + 1]}...HEAD`]);
    if (args.includes('--staged')) return git(['diff', '--name-only', '--cached']);
    // working tree: modified, staged and untracked, relative to HEAD
    const tracked = git(['diff', '--name-only', 'HEAD']);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    return [...new Set([...tracked, ...untracked])];
}

function main() {
    const args = process.argv.slice(2);
    const ownership = loadOwnership();
    const ai = args.indexOf('--agent');
    const agent = ai >= 0 ? args[ai + 1] : null;
    if (agent && !ownership.agents[agent]) {
        console.error(`unknown agent: ${agent}`);
        process.exit(2);
    }

    const valueFlags = new Set(['--agent', '--base']);
    const explicit = args.filter((a, k) => !a.startsWith('--') && !valueFlags.has(args[k - 1]));
    const files = explicit.length ? explicit : changedFiles(args);

    if (files.length === 0) {
        console.log('[ownership] no changed files');
        return;
    }

    let errors = 0;
    const layers = new Map();
    for (const f of files) {
        const owner = ownerOf(f, ownership);
        let mark = 'ok ';
        if (!owner) {
            mark = 'ERR';
            errors++;
        } else if (agent && owner !== agent) {
            mark = 'ERR';
            errors++;
        }
        if (owner) layers.set(owner, (layers.get(owner) ?? 0) + 1);
        console.log(`  ${mark} ${(owner ?? 'UNOWNED').padEnd(11)} ${f}`);
    }

    const owners = [...layers.keys()];
    if (owners.length > 1) {
        console.log(`[ownership] cross-layer change (${owners.join(', ')}): the integrator coordinates it`);
    }
    if (errors) {
        console.log(
            agent
                ? `[ownership] FAIL: ${errors} file(s) outside ${agent}'s paths or unowned (see ai/ownership.json)`
                : `[ownership] FAIL: ${errors} unowned file(s); add them to ai/ownership.json`,
        );
        process.exit(1);
    }
    console.log(`[ownership] ok: ${files.length} file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
