---
name: build-and-test
description: Build the firmware and run the test suites at the right scope, then report results with evidence. Use after any code change, before committing, or when asked whether the system still works.
---

# Skill: build and test

Facts (ports, paths, counts) come from `ai/rules/`. This skill is the procedure.

## 1. Pick the scope

| Changed | Run |
|---|---|
| `backend/src/a429/` | `npm run test:a429`, then step 3 |
| `backend/src/state.js`, `config.js` | `npm run test:state`, then step 3 |
| `backend/src/server.js`, `serve.mjs` | `npm run test:e2e`, then step 3 |
| `frontend/` | step 3, then the visual check in `ai/rules/frontend.md` §8 |
| `firmware/` | step 2, `node tools/test-pad-path.mjs`, then step 3 |
| firmware timing | step 2, `node tools/probe-rate.mjs 5`, then step 3 |
| `host/` | `node tools/verify-pad-live.mjs` if a pad is attached, then step 3 |
| `shared/` or several layers | the full verification in `ai/rules/integrator.md` §6 |
| docs or `ai/` only | step 3 (cheap, catches accidental edits) |

## 2. Build the firmware

```bash
node firmware/build.mjs
```

- Pass: exit 0, a size table printed, **no** `warning:` lines.
- `ARM GCC not found at ...`: the toolchain path in `firmware/build.mjs` is wrong
  for this machine. Report it; do not change it without the user.

## 3. Run the full test suite

```bash
npm test
```

- Pass: `ℹ pass N` with `ℹ fail 0`, where N ≥ 38 (the baseline).
- A test that needs QEMU or the pad is not in `npm test`; those live in `tools/`.

## 4. On failure

1. Re-run only the failing file (`node --test test/<file>.test.mjs`) to see the
   full assertion.
2. Find the cause before editing. Do not change a test to make it pass unless the
   test itself is wrong, and say so explicitly.
3. Port already in use (`EADDRINUSE`): another backend or `run-all` is running.
   Stop it; do not change test ports.

## 5. Report

```
Build:  node firmware/build.mjs -> ok, 0 warnings     (or: not run, why)
Tests:  npm test -> 38/38 pass
Extra:  node tools/test-pad-path.mjs -> 17/17
Not run: <command> - <reason>
```

Quote real output. Never report a command you did not run.
