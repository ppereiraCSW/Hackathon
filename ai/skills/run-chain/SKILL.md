---
name: run-chain
description: Build or complete the whole project by walking the run chain (milestones M0-M9) - find the first unfinished stage, brief its owner agent, verify, repeat until every stage passes. Use to implement the project from scratch, resume it on a new machine, or check how complete it is.
owner: integrator
---

# Skill: run the chain

The chain is the project's build order. Stages, owners, deliverables and checks
live in `ai/chain.json`; `tools/chain.mjs` runs them. The **integrator** drives
this skill and hands each stage to its owner agent.

```
M0 toolchain ──► M2 firmware ──► M3 real pad (hw)
M1 codec ──────┘      ├────────► M7 measured 50 Hz
                      └────────► M9 keyboard input (Windows)
M1 codec ──► M4 backend ──► M5 pages ──► M6 end to end + replay
M8 AI framework consistent (independent)
```

## 1. See where the project stands

```bash
node tools/chain.mjs --list     # the stages
node tools/chain.mjs --all      # run every check, report each stage
```

Status meanings:

| Status | Meaning |
|---|---|
| DONE | every check passed |
| MANUAL | checks passed; a person must still confirm by eye (pages, real pad) |
| FAIL | a check failed; output tail is printed |
| SKIP | waits on a failed stage, or needs something absent (toolchain, Windows, pad) |

The project already exists, so on a set-up machine most stages are DONE. On a new
machine expect M0 to fail until the toolchain is installed (installing needs the
user's approval; see `README.md` Prerequisites).

## 2. Work the first unfinished stage

```bash
node tools/chain.mjs            # stops at the first FAIL and prints its brief
node tools/chain.mjs --brief M4 # the brief for any stage
```

The brief names the owner agent, goal, deliverables, rule files, paths it may
touch and the done checks. Hand it to that agent **unchanged**, plus any extra
context the user gave. Independent stages (for example M1 and M8, or M2 and M4)
can go to their agents in parallel.

Building a stage from nothing: the deliverables list is the file plan, the owner's
rule file is the spec, and the checks are the acceptance test. If the rule file
does not say enough to build it, stop and ask the user. Do not invent requirements.

## 3. Accept the stage

1. Read the agent's hand-off note.
2. `node tools/check-ownership.mjs --agent <owner>`: no file outside its paths.
3. `node tools/chain.mjs --stage <id>`: the stage is DONE (or MANUAL and confirmed).
4. Re-run the stages that depend on it (`dependsOn` in `ai/chain.json`).
5. Hand the combined diff to the reviewer agent; settle its findings.
6. Commit with `commit-and-review`, one commit per stage or per coherent change.

## 4. Repeat until done

Loop 2–3 until `node tools/chain.mjs --all` shows no FAIL. Hardware stages:

```bash
node tools/chain.mjs --all --hw     # includes M3, the real gamepad
```

## 5. Report

```
Chain: 7 DONE, 1 MANUAL (M5 confirmed in browser), 1 SKIP (M3, no pad)
Changed: <stages worked, commits>
Open: <what is left and who owns it>
```

## Changing the chain

`ai/chain.json` is owned by the integrator. A new stage needs an owner from
`ai/ownership.json`, a skill that exists, deliverables that exist once built, and
at least one automated check. `node tools/check-ai.mjs` validates all of that.
