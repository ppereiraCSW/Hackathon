---
name: run-and-verify-demo
description: Start the stack in full, no-pad or replay mode and prove it works - pages served, values flowing, rate near 50 Hz, validity path visible. Use before a demo, after integration, or when asked whether the system runs.
---

# Skill: run and verify the demo

Facts come from `ai/rules/`. Full demo script for people: `docs/DEMO.md`.

## 1. Pick the mode

For people: `start.cmd` / `npm start` (menu, opens the browser). For agents and
scripts, call `run-all.mjs` directly as below, or `node tools/start.mjs <mode> --no-browser`.

| Mode | Command | Needs |
|---|---|---|
| Full | `node tools/run-all.mjs` | QEMU, toolchain, gamepad |
| Keyboard | `node tools/run-all.mjs --keyboard` | QEMU, toolchain, Windows |
| Scripted demo | `node tools/run-all.mjs --demo` | QEMU, toolchain |
| No input | `node tools/run-all.mjs --no-pad` | QEMU, toolchain |
| Replay (decoupled) | `node tools/run-all.mjs --replay` | Node only |

Default to **replay** when unsure: it needs nothing but Node. For a moving display
without a gamepad, use **demo** (scripted) or **keyboard** (you fly it; key map in
`ai/rules/embedded.md` §9). **No input** holds the model still: nothing feeds UART1.

Run it in the background; it runs until stopped. Stop with Ctrl+C, or end the
process, before running `npm test` (port 8090 / 5555 conflicts).

## 2. Wait for ready

Watch the output for `[backend] config page  http://127.0.0.1:8090/config`.
In full mode also wait for QEMU and the pad reader lines. Never probe port 5556.

## 3. Check the backend

```bash
curl -s http://127.0.0.1:8090/api/health
```

Pass:
- `"ok":true`
- `words` rising between two calls a second apart
- `staleTags` empty (`[]`)
- `parityErrors` and `unknownLabels` not rising after start-up
  (a few at boot from the firmware banner is expected in live modes)

```bash
curl -s http://127.0.0.1:8090/api/state
```

Pass: six `params`, each `"valid":true`, `"stale":false`, values within the label range.

## 4. Check the rate (live modes)

Stop `run-all` first (the probe runs its own pipeline), then:

```bash
node tools/probe-rate.mjs 5
```

Pass: about 50 Hz (49.6–50 measured historically).

## 5. Check the pages

- `http://127.0.0.1:8090/sfd`: ADI, three tapes, heading, status `labels 6/6`,
  annunciator `NONE`.
- `http://127.0.0.1:8090/config`: one row per label; moving a slider changes the
  SFD scale; values never change.
- Validity: in full mode press START, all instruments show `NCD`; press again to
  recover. Or stop the stack and watch `A429 LOSS` appear.

No browser available? Say so, and report steps 3–4 only.

## 6. Report

```
Mode:    replay
Health:  ok, words 1234 -> 1534 in 1 s, staleTags []
State:   6/6 valid
Rate:    49.8 Hz (probe-rate 5)        or: not run, replay mode
Pages:   /sfd and /config checked in browser   or: not checked, no browser
```
