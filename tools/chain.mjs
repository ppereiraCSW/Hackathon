#!/usr/bin/env node
/**
 * The run chain: build and verify the whole project, stage by stage.
 *
 * Stages live in ai/chain.json (milestones M0-M6 from docs/PLAN.md, plus the
 * measured rate and the AI framework). For each stage this runs its checks and
 * reports DONE / FAIL / SKIP / MANUAL. On the first failure it stops and prints
 * a brief for the owning agent, so the chain doubles as the work plan.
 *
 *   node tools/chain.mjs                   # run until the first failing stage
 *   node tools/chain.mjs --all             # run every stage, report all
 *   node tools/chain.mjs --stage M4        # one stage
 *   node tools/chain.mjs --list            # show the stages, run nothing
 *   node tools/chain.mjs --brief M2        # print the agent brief for a stage
 *   node tools/chain.mjs --hw              # also run hardware stages (gamepad)
 *   node tools/chain.mjs --require-toolchain   # missing toolchain = FAIL (CI)
 *
 * Exit 0 when every stage that ran passed, 1 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gccPath, qemuPath } from '../firmware/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const chain = JSON.parse(readFileSync(join(ROOT, 'ai', 'chain.json'), 'utf8'));
const ownership = JSON.parse(readFileSync(join(ROOT, 'ai', 'ownership.json'), 'utf8'));

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);

const TIMEOUT_MS = 180_000;

function have(need) {
    switch (need) {
        case 'toolchain':
            try {
                gccPath();
                qemuPath();
                return { ok: true };
            } catch (e) {
                return { ok: false, why: e.message };
            }
        case 'windows':
            return process.platform === 'win32'
                ? { ok: true }
                : { ok: false, why: 'needs Windows (PowerShell pad reader)' };
        case 'pad':
            return has('--hw') ? { ok: true } : { ok: false, why: 'needs the gamepad; pass --hw' };
        default:
            return { ok: false, why: `unknown need ${need}` };
    }
}

function runCheck(check) {
    const t0 = Date.now();
    const r = spawnSync(check.run, {
        cwd: ROOT,
        shell: true,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const ms = Date.now() - t0;
    if (r.error) return { ok: false, ms, out, why: r.error.message };
    if (r.status !== 0) return { ok: false, ms, out, why: `exit ${r.status}` };
    if (check.failOn && out.includes(check.failOn)) {
        return { ok: false, ms, out, why: `output contains "${check.failOn}"` };
    }
    if (check.expect && !new RegExp(check.expect).test(out)) {
        return { ok: false, ms, out, why: `output does not match /${check.expect}/` };
    }
    return { ok: true, ms, out };
}

function brief(stage) {
    const agentFile = `ai/agents/${stage.owner}.md`;
    const rules = ['ai/rules/common.md', `ai/rules/${stage.owner}.md`];
    const owns = ownership.agents[stage.owner]?.owns ?? [];
    return [
        `Agent: ${stage.owner}   (${agentFile})`,
        `Stage: ${stage.id} - ${stage.title}`,
        `Goal: ${stage.goal}`,
        `Read first: ${rules.join(', ')}`,
        `Your paths: ${owns.join(', ') || '(none)'}`,
        `Deliverables:`,
        ...stage.deliverables.map((d) => `  - ${d}`),
        `Done when these pass (run from the repo root):`,
        ...stage.checks.map((c) => `  $ ${c.run}`),
        ...(stage.manual ? [`Manual check: ${stage.manual}`] : []),
        `Skill: ai/skills/${stage.skill}/SKILL.md`,
        `Finish with the hand-off note from ${agentFile}.`,
    ].join('\n');
}

function list() {
    for (const s of chain.stages) {
        const deps = s.dependsOn.length ? ` after ${s.dependsOn.join(',')}` : '';
        const needs = s.needs ? ` needs ${s.needs.join('+')}` : '';
        console.log(`${s.id.padEnd(3)} ${s.owner.padEnd(10)} ${s.title}${deps}${needs}`);
    }
}

function main() {
    if (has('--list')) return list();
    if (has('--brief')) {
        const s = chain.stages.find((x) => x.id === opt('--brief'));
        if (!s) {
            console.error(`unknown stage ${opt('--brief')}`);
            process.exit(2);
        }
        console.log(brief(s));
        return;
    }

    const only = opt('--stage');
    const stages = only ? chain.stages.filter((s) => s.id === only) : chain.stages;
    if (only && stages.length === 0) {
        console.error(`unknown stage ${only}`);
        process.exit(2);
    }

    const status = new Map();
    let failed = null;
    for (const s of stages) {
        const blocked = s.dependsOn.filter((d) => status.has(d) && status.get(d) !== 'DONE');
        if (blocked.length) {
            status.set(s.id, 'SKIP');
            console.log(`SKIP   ${s.id} ${s.title}  (waits on ${blocked.join(', ')})`);
            continue;
        }
        const missing = (s.needs ?? []).map(have).filter((h) => !h.ok);
        if (missing.length) {
            const toolchainMissing = (s.needs ?? []).includes('toolchain') && !have('toolchain').ok;
            if (has('--require-toolchain') && toolchainMissing) {
                status.set(s.id, 'FAIL');
                console.log(`FAIL   ${s.id} ${s.title}  (${missing[0].why})`);
                failed ??= s;
                if (!has('--all')) break;
                continue;
            }
            status.set(s.id, 'SKIP');
            console.log(`SKIP   ${s.id} ${s.title}  (${missing.map((m) => m.why).join('; ')})`);
            continue;
        }

        let ok = true;
        let total = 0;
        for (const c of s.checks) {
            const r = runCheck(c);
            total += r.ms;
            if (!r.ok) {
                ok = false;
                console.log(`FAIL   ${s.id} ${s.title}`);
                console.log(`       $ ${c.run}  -> ${r.why}`);
                const tail = r.out.trimEnd().split('\n').slice(-15).join('\n       ');
                if (tail) console.log(`       ${tail}`);
                break;
            }
        }
        if (ok) {
            const state = s.manual ? 'MANUAL' : 'DONE';
            status.set(s.id, 'DONE');
            console.log(`${state.padEnd(6)} ${s.id} ${s.title}  (${(total / 1000).toFixed(1)} s)`);
            if (s.manual) console.log(`       checks pass; still confirm by hand: ${s.manual}`);
        } else {
            status.set(s.id, 'FAIL');
            failed ??= s;
            if (!has('--all')) break;
        }
    }

    const counts = [...status.values()].reduce((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {});
    console.log(`\n[chain] ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);

    if (failed) {
        console.log(`\n[chain] next: stage ${failed.id}, owned by the ${failed.owner} agent\n`);
        console.log(brief(failed));
        process.exit(1);
    }
}

main();
