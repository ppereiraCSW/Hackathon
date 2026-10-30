# AGENTS.md

Entry point for AI assistants working in this repository.

The project: a USB gamepad drives bare-metal ARM Cortex-M3 firmware in QEMU, which
sends ARINC 429 words to a Node backend, which feeds a browser Secondary Flight
Display. See `README.md`, `docs/ARCHITECTURE.md` and `docs/project-overview.svg`.

## Before any task

1. Read `ai/rules/common.md`. It applies to every agent and every task.
2. Pick the agent that owns the paths you will change (`ai/ownership.json`).
   More than one layer, or anything in `shared/`? Use `ai/agents/integrator.md`.
3. Load that agent's file and the rule files it lists.
4. For a recurring task, follow the matching skill in `ai/skills/`.
5. Before committing: `node tools/check-ai.mjs` and `node tools/check-ownership.mjs`.

## Agents

- `ai/agents/integrator.md` — coordinator; owns shared contracts, tools, docs, CI.
- `ai/agents/embedded.md` — firmware and host pad reader.
- `ai/agents/backend.md` — A429 decode, state, config, HTTP/SSE.
- `ai/agents/frontend.md` — SFD and config pages.
- `ai/agents/reviewer.md` — read-only review against the rules.

## Skills

- `ai/skills/run-chain/SKILL.md` — build or audit the project, milestones M0–M8
- `ai/skills/build-and-test/SKILL.md`
- `ai/skills/add-a429-parameter/SKILL.md`
- `ai/skills/run-and-verify-demo/SKILL.md`
- `ai/skills/debug-pipeline/SKILL.md`
- `ai/skills/commit-and-review/SKILL.md`

How it fits together: `ai/README.md` and `docs/ai-workflow.svg`.
