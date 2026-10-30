# DEMO — running it, and what to show

## Prerequisites (verified on this machine)

```
$ arm-none-eabi-gcc --version
arm-none-eabi-gcc.exe (Arm GNU Toolchain 14.2.Rel1) 14.2.1 20241119
$ qemu-system-arm --version
QEMU emulator version 11.1.0
$ node --version
v24.21.0
```

Installed with winget on 2026-10-30:
`SoftwareFreedomConservancy.QEMU` and `Arm.GnuArmEmbeddedToolchain`.

Neither is on `PATH`; the build script uses absolute paths:

- `C:\Program Files\qemu\`
- `C:\Program Files (x86)\Arm GNU Toolchain arm-none-eabi\14.2 rel1\bin\`

If the toolchain moves, edit `TOOLCHAIN_BIN` / `QEMU_BIN` in `firmware/build.mjs`.

## Run it

```bash
node tools/run-all.mjs            # pad reader + QEMU + backend
node tools/run-all.mjs --no-pad   # no gamepad: firmware holds a default state
node tools/run-all.mjs --replay   # DECOUPLED: backend only, from the recording
```

Then open both pages (two windows side by side is the best demo):

- **configuration** — http://127.0.0.1:8090/config
- **SFD** — http://127.0.0.1:8090/sfd

Ctrl+C stops everything.

### Without a gamepad, or with nobody at the stick

```bash
node tools/demo-inject.mjs 60
```

Standing in for `pad-reader.ps1`, it injects a scripted bank-and-climb so the SFD
visibly moves. Useful for a screen recording or if the pad is not recognised.

## Controls

| Input | Effect |
|---|---|
| Left stick X | roll ±45° |
| Left stick Y | pitch ±20° (stick back = nose up) |
| Throttle / Z | calibrated airspeed 0–250 kt |
| Rudder / R | vertical speed ±2000 ft/min |
| Heading, altitude | integrated in the firmware (bank → turn, V/S → altitude) |
| A | reset pitch/roll trim |
| B | reset heading to 0 |
| LB / RB | CAS −10 / +10 kt |
| D-pad up / down | altitude ±500 ft |
| **START** | freeze — every label sent as **NCD** (demonstrates validity) |

## The demo script (about 4 minutes)

1. **Show the pipeline is real.** `node tools/run-all.mjs`; in the terminal point
   out the three processes: pad reader, QEMU (the ARM firmware), backend.
2. **Fly it.** Move the stick: attitude banks, heading turns, altitude and CAS tapes
   move. Say which layer each thing came from — nothing on the SFD is computed in
   the browser.
3. **Move a slider.** On `/config`, narrow PITCH's display range. The SFD attitude
   scale changes while the *value* stays the same — this is the "one slider per
   parameter, configuring the display" requirement, and it shows values cannot be
   faked with a slider.
4. **Press START.** Every instrument annunciates NCD and the A429 badge degrades.
   Press again to recover. That is SSM handling proven live.
5. **Unplug / stop the pad** (`Ctrl+C` on the pad reader, or stop the injector).
   After 250 ms every parameter goes STALE and the SFD annunciates A429 LOSS. That
   is the freshness watchdog.
6. **Now the decoupling proof.** Stop everything. Run
   `node tools/run-all.mjs --replay` — **no QEMU, no gamepad, no serial port** — and
   the SFD flies again from the recorded capture. This is the requirement that the
   A429 processing is decoupled from the embedded layer.
7. **Show the tests.** `npm test` → 38 passing, including the two decoupled tests.

## Verify claims yourself

```bash
npm test                              # 38 tests
node tools/test-pad-path.mjs          # 12 checks: pad frame -> firmware -> A429 -> backend
node tools/probe-rate.mjs 5           # measured frame rate, expect ~50 Hz
node tools/gen-vectors.mjs            # regenerates the golden vectors (must not change)
node tools/decode-capture.mjs shared/capture.a429   # decode a recording offline
```

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `No joystick found` | pad not plugged in, or not a WinMM device | `powershell -File host/test-pad.ps1` to inspect; use `--no-pad` |
| pad visible but axes frozen | another app grabbed it, or it is asleep | move it; replug |
| SFD shows NO DATA | backend running but QEMU not connected | check port 5555 is free; restart |
| all parameters STALE | firmware died | check the QEMU line in the terminal |
| QEMU exits with "Failed to connect" | a chardev target was not listening yet | `run-all.mjs` requires the pad reader before QEMU; it waits 1.5 s |
| ports busy | a previous run still alive | `Get-Process node,qemu-system-arm \| Stop-Process -Force` |
| firmware won't build | toolchain moved | update `TOOLCHAIN_BIN` in `firmware/build.mjs` |

## Notes for the judges

- **Not a mock.** The ARINC 429 words are real 32-bit words with bit-reversed
  labels, BNR magnitudes, SSM sign handling and odd parity. The backend rejects
  corrupted words and resynchronises; you can watch the parity counter.
- **The embedded layer really is ARM.** The firmware is a bare-metal Cortex-M3
  image with its own vector table, linker script and CMSIS-style register writes,
  running in QEMU — not a Node script wearing a "firmware" label.
- **The decoupling is tested, not claimed.** `tools/run-all.mjs --replay` runs the
  whole display path with the embedded layer absent.
- **The gamepad finding is documented.** The pad is DirectInput-only with four
  axes; that constraint is in `docs/ARCHITECTURE.md` rather than hidden.
