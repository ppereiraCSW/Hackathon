# AI framework

Tool-neutral agents, rules and skills for working on this repository with AI
assistants. Plain Markdown and JSON, so any tool can load it. Claude Code
wrappers in `.claude/` are generated from it; other tools start from `AGENTS.md`.

![AI workflow](../docs/ai-workflow.svg)

## Layout

```
ai/
  agents/          WHO does the work: role, workflow, hand-off. Generic.
  rules/           WHAT must be true: every fact, contract and constraint. Specific.
  skills/          HOW to do a recurring task: step-by-step procedures.
  ownership.json   WHERE each agent may edit (single source).
  chain.json       WHEN: the run chain, stages M0–M8 with owners and checks.
```

The split is deliberate:

- **Agents stay generic.** An agent file says how the agent works and which rules
  and skills it loads. It holds no project facts.
- **Rules hold the knowledge.** File paths, wire formats, numbers, decisions,
  known pitfalls. When a fact changes, change it in exactly one rule file.
- **Skills are procedures.** Any agent may run a skill; the skill says which
  agent owns each step.
- **Scripts keep it honest.** `tools/check-ai.mjs` fails when a rule disagrees
  with the code; `tools/check-ownership.mjs` fails when a file has no owner or an
  agent edits outside its paths; `tools/chain.mjs` runs the milestones.

## Agents

| Agent | Owns (see `ownership.json`) | Loads rules |
|---|---|---|
| [integrator](agents/integrator.md) | `shared/`, `tools/`, `test/` (rest), `docs/`, `ai/`, CI, root files | `common`, `integrator` (+ all layers) |
| [embedded](agents/embedded.md) | `firmware/`, `host/` | `common`, `embedded` |
| [backend](agents/backend.md) | `backend/`, `test/a429.test.mjs`, `test/state.test.mjs` | `common`, `backend` |
| [frontend](agents/frontend.md) | `frontend/` | `common`, `frontend` |
| [reviewer](agents/reviewer.md) | nothing, read-only | `common` (+ all layers) |

Each layer agent edits **only its own paths**. Anything that touches a shared
contract or more than one layer goes through the integrator, which splits it into
per-layer tasks and has the reviewer check the result.

## Skills

| Skill | Use it to |
|---|---|
| [run-chain](skills/run-chain/SKILL.md) | Build, resume or audit the whole project, milestone by milestone. |
| [build-and-test](skills/build-and-test/SKILL.md) | Build the firmware, run the test suites, report results. |
| [add-a429-parameter](skills/add-a429-parameter/SKILL.md) | Add a new ARINC 429 label end to end, across all layers. |
| [run-and-verify-demo](skills/run-and-verify-demo/SKILL.md) | Start the stack in any mode and prove it works. |
| [debug-pipeline](skills/debug-pipeline/SKILL.md) | Find the hop where flight data is lost or wrong. |
| [commit-and-review](skills/commit-and-review/SKILL.md) | Review a change against the rules, then commit it. |

## Commands

```bash
node tools/chain.mjs --all          # status of every milestone M0–M8
node tools/chain.mjs --brief M4     # the task brief for one stage's owner
node tools/check-ai.mjs             # framework vs code; --write regenerates .claude/
node tools/check-ownership.mjs      # owner of every changed file
npm run hooks:install               # optional: run both checks before each commit
```

CI (`.github/workflows/ci.yml`) runs the same commands on every push and pull
request, including the firmware stages on Linux with apt's Arm GCC and QEMU.

## Using it from a tool

- **Claude Code**: agents in `.claude/agents/`, skills in `.claude/skills/`, both
  generated. `CLAUDE.md` imports `AGENTS.md` and `ai/rules/common.md`.
- **Any other tool**: load `AGENTS.md`, then the agent file for the task, then the
  rule files that agent lists. Run a skill by reading its `SKILL.md` and following it.

## Changing the framework

The integrator owns `ai/`. When code changes a fact that a rule states, update the
rule in the same commit; `check-ai.mjs` will fail until you do. After editing an
agent or skill, run `node tools/check-ai.mjs --write` to refresh `.claude/`.
