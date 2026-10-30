---
name: add-a429-parameter
description: Add a new ARINC 429 parameter (label) end to end - contract, firmware encoder and flight model, backend decode and tests, SFD display and config slider. Use when asked to show, send or add a new flight value.
owner: integrator
---

# Skill: add an ARINC 429 parameter

A cross-layer change. The **integrator** runs this skill and hands steps to the
owning agents. Facts come from `ai/rules/`.

## 0. Decide (with the user)

Adding a seventh label changes decision R9 (six fixed labels). **Ask the user
first.** Then fix these values and write them down:

| Field | Example | Check |
|---|---|---|
| label (octal string) | `"150"` | unique, a valid octal 000–377, ideally the standard A429 label for this quantity |
| tag | `GROUND_SPEED` | unique, `UPPER_SNAKE` |
| unit | `kt` | |
| lsbPerBit | `0.125` | `max / lsbPerBit` ≤ 524287 (19 bits) |
| min, max | `0`, `600` | the label's range |
| display min, max, visible | `0`, `400`, `true` | inside min..max, min < max |
| source in firmware | pad axis, button or derived | the pad has only 4 axes, all in use |

The pad has no free axis. A new value must be derived in the firmware or driven by
buttons. Agree which with the user.

## 1. Contract — integrator

- Add the entry to `shared/labels.json` (schema in `ai/rules/integrator.md` §2).
- Add golden vectors for the new label in `tools/gen-vectors.mjs` (zero, positive,
  negative if signed, NCD), then run `node tools/gen-vectors.mjs`.

## 2. Embedded — embedded agent

In `firmware/src/flight.h`:
- `#define LBL_<TAG> 0<label>u` and `#define LSB_<TAG> <lsb>f`.
- A field in `flight_state_t`, its initial value in `flight_init`, and its update
  in `flight_step`.
- A row in the `defs[]` table of `flight_transmit`, and the array size and loop
  bound from 6 to the new count.

Verify: `node firmware/build.mjs` (0 warnings).

## 3. Backend — backend agent

- No decode code changes: the backend reads `labels.json` at start.
- Update `test/a429.test.mjs` "label table matches the agreed contract" to the new set.
- Add a `test/state.test.mjs` case decoding a word of the new label.

Verify: `npm run test:a429`, `npm run test:state`.

## 4. Frontend — frontend agent

- The config page builds sliders from `/api/config`, so it picks up the new label
  without code changes. Confirm it on screen.
- The SFD does not. Add an instrument or readout in `sfd.html` / `sfd.js`, keyed by
  the new tag, with the full validity handling in `ai/rules/frontend.md` §4.
- The status panel `labels n/N` count is computed from the snapshot; no change.

## 5. Integrate — integrator

1. Update tests, tools and docs that assume six labels:
   `grep -rn "6\b\|six\|0/6\|wordsPerTick" tools test docs backend frontend README.md`
   Known spots: `wordsPerTick = 6` in `backend/src/server.js` replay (backend
   agent), and `tools/probe-rate.mjs`, which divides by 24 bytes per frame
   (6 words × 4) after a 12-byte banner.
2. `shared/capture.a429` holds only the six old labels. Re-record it
   (`node tools/capture.mjs 6`) so replay shows the new label, and check the e2e
   decoupled test still passes.
3. Update `docs/PLAN.md` (R9 and label table), `docs/ARCHITECTURE.md`, `README.md`
   parameter table, and the label tables in `ai/rules/`.
4. Full verification: `ai/rules/integrator.md` §6.
5. Commit all layers together with `commit-and-review`.
