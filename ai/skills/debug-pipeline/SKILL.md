---
name: debug-pipeline
description: Find where flight data is lost or wrong along gamepad, pad reader, firmware, A429 bus, backend and SFD, using the health counters and the probe tools. Use when the display shows NO DATA, STALE, NCD, frozen or wrong values, or the rate is off.
---

# Skill: debug the pipeline

Work **upstream from the display**: find the last hop where data is still right.
Facts come from `ai/rules/`. Diagnose before editing; the fix belongs to the
agent that owns the faulty hop.

```
pad ─► pad-reader.ps1 ─► :5556 ─► firmware (QEMU) ─► :5555 ─► backend ─► SSE ─► SFD
 H1        H2                         H3                         H4        H5
```

## 1. Read the symptom

| SFD shows | Most likely hop | Go to |
|---|---|---|
| `A429 LOSS`, every tape `STALE`, `NO DATA` | nothing reaches :5555 (QEMU down or not connected) | §3 |
| every tape `NCD` | firmware freeze is on (START pressed) | press START again; §3 |
| one tape `STALE` | that label not sent | §3, then §4 |
| values frozen but valid | pad frames stopped; firmware holds last state | §2 |
| values wrong or jumpy | mapping, deadzone or encoding | §2 then §4 |
| `parity` counter climbing after start-up | byte stream misaligned or corrupt | §4 |
| page blank or not updating | SSE or frontend | §5 |

A few parity errors and unknown labels at start-up are expected (firmware banner).
Only a *rising* count is a fault.

## 2. Pad and reader (H1–H2, embedded agent)

```bash
powershell -File host/test-hid.ps1        # does HID see the pad?
powershell -File host/test-pad.ps1        # does WinMM see it?
node tools/probe-hid-axes.mjs             # raw HID axes
node tools/verify-pad-live.mjs --seconds 30   # Windows axis vs decoded A429, live
```

- Reader never prints its `listening on 127.0.0.1:` line: it failed before
  accepting. Check its output for the backend it chose (`-Backend hid|winmm`).
- Something probed :5556: the reader accepts one client only. Restart the stack.
- No pad at all: `node tools/run-all.mjs --no-pad` plus `node tools/demo-inject.mjs 60`
  isolates the rest of the chain from the pad.

## 3. Firmware and bus (H3, embedded agent)

```bash
node firmware/build.mjs                   # builds clean?
node tools/test-pad-path.mjs              # synthetic frames -> firmware -> A429 -> decode, 16 checks
node tools/probe-rate.mjs 5               # word rate, expect ~50 Hz
node tools/capture.mjs 6 data/debug.a429  # record what the firmware sends
node tools/decode-capture.mjs data/debug.a429
```

- `test-pad-path` fails: the fault is in the firmware or encoder, not the pad.
- Rate far from 50 Hz: timebase regression (`ai/rules/embedded.md` §5).
- Capture decodes cleanly but the live system does not: the fault is in transport
  or the backend (§4). `data/` is git-ignored, so debug captures stay local.

## 4. Backend (H4, backend agent)

```bash
curl -s http://127.0.0.1:8090/api/health
curl -s http://127.0.0.1:8090/api/state
```

| Field | Reading |
|---|---|
| `words` not rising | no bytes arriving on :5555 → back to §3 |
| `parityErrors` rising | misaligned or corrupt stream; compare with a capture (§3) |
| `unknownLabels` rising | firmware sends a label not in `shared/labels.json` → integrator |
| `staleTags` lists one tag | that label is missing from the stream |
| `ssm` `NCD` / `TEST` | the firmware said so; the backend is right to mark it invalid |

Decouple to prove the backend alone: `node tools/run-all.mjs --replay`. Healthy in
replay but not live means the fault is upstream.

## 5. Frontend (H5, frontend agent)

- `curl -N http://127.0.0.1:8090/events` must stream `event: state` about 50 times
  a second. If it does, the backend is fine.
- Open the browser console on `/sfd`: errors there are frontend faults.
- Value right in `/api/state` but wrong on screen: check the display window on
  `/config` (sliders set the scale, not the value), then `frontend/js/sfd.js`.

## 6. Report

```
Symptom:  <what the SFD showed>
Last good hop: H<n> (<evidence: command -> output>)
First bad hop: H<n> (<evidence>)
Owner: <agent>
Cause: <confirmed cause, or "not yet confirmed: <next check>">
```

Hand the finding to the owning agent; do not fix another layer's code.
