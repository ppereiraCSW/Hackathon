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

Easiest: double-click `start.cmd` (or `npm start`), pick a mode, and the SFD opens
in the browser once data is flowing. The direct commands:

```bash
node tools/run-all.mjs              # gamepad + QEMU + backend
node tools/run-all.mjs --keyboard   # fly with the keyboard (Windows)
node tools/run-all.mjs --demo       # scripted flight, nobody at the controls
node tools/run-all.mjs --no-pad     # no input: firmware holds its start state
node tools/run-all.mjs --replay   # DECOUPLED: backend only, from the recording
```

Then open both pages (two windows side by side is the best demo):
- **configuration** — http://127.0.0.1:8090/config
- **SFD** — http://127.0.0.1:8090/sfd

Ctrl+C stops everything.

### Without a gamepad, or with nobody at the stick

- `--keyboard` starts `host/keyboard-reader.ps1` in place of the pad reader. Keys
  work whichever window has the focus, so you can fly while watching the SFD.
  Key map below, under Controls.
- `--demo` starts `tools/demo-inject.mjs`, a scripted bank-and-climb. Useful for a
  screen recording or if the pad is not recognised.

Both send the same frames as the gamepad, so the firmware cannot tell the
difference. (`--no-pad` gives QEMU no input at all; running `demo-inject.mjs` next
to it has no effect.)

### Verifying the physical gamepad (one-time setup check)

```bash
node tools/verify-pad-live.mjs
```

This runs the **real** `pad-reader.ps1`, the **real** firmware in QEMU and the
**real** backend, then shows one live table comparing what Windows reports for each
axis with what the backend decoded from ARINC 429:

```
  Windows axis (0..65535, centre 32767)          decoded from ARINC 429
  ──────────────────────────────────────────────────────────────────────
  X  roll             ●···················         -27.2 deg
  Y  pitch            ·········●··········           3.8 deg
  Z  CAS              ··················●·          96.0 kt
  derived   heading  338.0 deg      V/S   -478 fpm      altitude   4,250 ft
```

Move each stick and press START; the footer names every input it saw move. This is
the only way to confirm the button bit ordering and axis assignment on *this* pad,
because synthetic frames cannot test the physical device. If an axis drives the
wrong parameter, change the mapping in `firmware/src/flight.h` (`flight_step`).

It exits with code 2 and instructions if no pad is plugged in.

## Controls

The sticks are **rate** controls: deflection changes the value, centring the stick
holds it where it is.

| Input | Effect |
|---|---|
| Left stick X | roll, up to 30°/s, held within ±45° |
| Left stick Y | pitch, up to 10°/s, held within ±20° (stick back = nose up) |
| Throttle / Z | calibrated airspeed, up to 25 kt/s, 0–250 kt |
| Heading | integrated in the firmware from bank (coordinated turn) |
| V/S, altitude | derived in the firmware: V/S = CAS × sin(pitch), altitude integrates V/S — so nose up climbs |
| Speed vs height | airborne, pitch trades airspeed for height: nose up slows down (about 6.5 kt/s at +20°), nose down speeds up; the throttle adds or removes speed on top |
| Rudder / R | unused |
| On the ground (0 ft) | wings held level, nose can't go below the runway, brakes slow CAS ~6 kt/s to 0; throttle forward past 130 kt (Vr) and pull back to take off |
| A | wings level (roll and pitch to 0) |
| B (hold 1 s) | reset heading to 0 |
| LB / RB | CAS −10 / +10 kt |
| D-pad up / down | altitude ±500 ft per press, between the ground (0 ft) and the 41,000 ft airliner ceiling |
| **START** | freeze — every label sent as **NCD** (demonstrates validity) |

**Xbox-style controller** (XInput, e.g. 8BitDo Ultimate 2): left stick = roll and
pitch, **RT / LT = speed up / down** (the throttle axis), right stick unused, and
A, B, LB, RB, START and the D-pad as above. The reader picks XInput automatically
when such a controller is connected.

### Keyboard (`--keyboard`)

| Key | Effect | Gamepad equivalent |
|---|---|---|
| Arrow Left / Right | roll | left stick X |
| Arrow Up / Down | pitch up / down — and so climb / descend (V/S follows pitch) | left stick Y |
| W / S | speed up / down | throttle Z |
| Shift (held) | gentle: about a third of full deflection | partial stick |
| Space | wings level | A |
| H (hold 1 s) | reset heading | B |
| Q / E | CAS −10 / +10 kt | LB / RB |
| Page Up / Page Down | altitude +500 / −500 ft per press | D-pad |
| Enter | freeze, every label **NCD**; again to clear | START |

## Aural alerts

Browsers block audio until the page gets a click or key press, so click
anywhere on the SFD once; a chime confirms the alerts are armed. The SFD has no
sound control on screen. Every sound has its text in the annunciator line, so
the two always agree.

| Level | Sound | When |
|---|---|---|
| Warning | repeating hi-lo alarm | A429 LOSS — no label fresh |
| Callout | spoken "TERRAIN" | airborne below 1,000 ft (ground is 0 ft) and not climbing; silent on the ground |
| Callout | spoken "BANK ANGLE" | \|roll\| > 35° |
| Callout | spoken "SINK RATE" | V/S below −3000 ft/min |
| Caution | single chime when it appears | a parameter goes INOP / NCD / STALE, or leaves its display limits (LIMIT) |

## The demo script (about 4 minutes)

1. **Show the pipeline is real.** `node tools/run-all.mjs`; in the terminal point
   out the three processes: pad reader, QEMU (the ARM firmware), backend.
2. **Fly it.** Move the stick: attitude banks, heading turns, altitude and CAS tapes
   move. Say which layer each thing came from — nothing on the SFD is computed in
   the browser.
3. **Move a slider.** On `/config`, narrow PITCH's display range to ±10°. The SFD
   pitch ladder now ends at ±10°; pitch beyond it pins the horizon at the limit and
   turns the readout amber, while the *value* stays the same — this is the "one
   slider per parameter, configuring the display" requirement, and it shows values
   cannot be faked with a slider. Every instrument follows the same rules: min/max
   are where its scale ends, "show on SFD" off blanks and dims it, and invalid data
   blanks it behind an INOP / NCD / STALE flag.
4. **Press START.** Every instrument annunciates NCD and the A429 badge degrades.
   Press again to recover. That is SSM handling proven live.
5. **Unplug / stop the pad** (`Ctrl+C` on the pad reader, or stop the injector).
   After 250 ms every parameter goes STALE and the SFD annunciates A429 LOSS. That
   is the freshness watchdog.
6. **Now the decoupling proof.** Stop everything. Run
   `node tools/run-all.mjs --replay` — **no QEMU, no gamepad, no serial port** — and
   the SFD flies again from the recorded capture. This is the requirement that the
   A429 processing is decoupled from the embedded layer.
7. **Show the tests.** `npm test` → 64 passing, including the two decoupled tests.

## Verify claims yourself

```bash
npm test                              # 64 tests, incl. boundary values per label
node tools/test-pad-path.mjs          # 22 checks: pad frame -> firmware -> A429 -> backend
node tools/test-boundaries.mjs        # 49 checks: every parameter into both limits, plus ground/takeoff, in QEMU
node tools/test-keyboard-path.mjs     # the REAL keyboard reader through the firmware (Windows)
node tools/verify-pad-live.mjs        # the REAL pad through the real pipeline
node tools/probe-rate.mjs 5           # measured frame rate, expect ~50 Hz
node tools/gen-vectors.mjs            # regenerates the golden vectors (must not change)
node tools/decode-capture.mjs shared/capture.a429   # decode a recording offline
```

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `No joystick found` | pad not plugged in, or seen by neither HID nor WinMM | `powershell -File host/test-pad.ps1` to inspect; use `--keyboard` or `--demo` |
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
