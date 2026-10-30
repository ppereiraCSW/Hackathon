# Rules: embedded (`firmware/`, `host/`)

## 1. Target

| Item | Value |
|---|---|
| Board | QEMU `mps2-an385`, ARM Cortex-M3 |
| Clock | `SYSCLK_HZ` = 25 MHz (`firmware/src/uart.h`) |
| Memory | CODE `0x00000000` 4 MiB (rx), RAM `0x20000000` 4 MiB (rwx), `firmware/mps2-an385.ld` |
| Entry | `Reset_Handler` in `firmware/src/startup.c`: copies `.data`, zeroes `.bss`, calls `main()` |
| Vectors | `.isr_vector` at `0x0`, 16 system exceptions only. No peripheral interrupts. |
| Scheduler | Superloop. SysTick is **polled**, not interrupt-driven. No RTOS. |

## 2. Build

- `node firmware/build.mjs [--entry main|bringup] [--clean]`, or `npm run firmware`.
- Toolchain location: `ARM_TOOLCHAIN_BIN` / `QEMU_BIN` env vars, else the Windows
  defaults in `build.mjs`. `.exe` is added only on Windows. The toolchain include
  dir is passed only if it exists (apt packages find `stdint.h` on their own).
- The same sources must build on the Windows Arm GNU 14.2 release and on Ubuntu's
  `gcc-arm-none-eabi` in CI. Use only freestanding C11 (`_Static_assert` is fine).
- Output: `firmware/build/firmware-<entry>.elf` and `.map`. Never commit `firmware/build/`.
- Flags (keep them): `-mcpu=cortex-m3 -mthumb -mfloat-abi=soft -O2 -g -Wall -Wextra
  -ffreestanding -fno-builtin -nostdlib -ffunction-sections -fdata-sections`,
  linked with `-Wl,--gc-sections -nostartfiles ... -lgcc`.
- `-lgcc` is required: soft-float helpers (`__aeabi_fadd`, `__aeabi_fcmplt`...) live there.
- Build must finish with **zero warnings**. Treat a new warning as a failure.
- `-Wl,-Map` and its path are separate argv elements because the repo path may
  contain spaces. Keep that pattern for any new path argument.
- No libc. Only `<stdint.h>` from the toolchain include dir. No `printf`, `malloc`,
  `memcpy` from libc; write what you need.

## 3. Sources

| File | Role |
|---|---|
| `src/startup.c` | Vector table, reset handler, default handler (infinite loop) |
| `src/main.c` | Superloop: drain UART1, 50 Hz tick, `flight_step`, `flight_transmit` |
| `src/bringup.c` | Smoke test entry: banner + first golden vector `0x8000002B` |
| `src/uart.h` | CMSDK APB UART driver. UART0 `0x40004000` TX to backend, UART1 `0x40005000` RX from pad |
| `src/pad.h` | Pad frame parser, axis normalisation, deadzone |
| `src/flight.h` | Flight model, button handling, A429 transmit schedule, label/LSB defines |
| `src/a429.h` | A429 encoder, C mirror of `backend/src/a429/codec.js` |

Headers hold `static inline` code; there is one translation unit plus `startup.c`.

## 4. UART (CMSDK APB)

Registers at base + `0x00` DATA, `0x04` STATE (bit0 TX full, bit1 RX full),
`0x08` CTRL (bit0 TX en, bit1 RX en), `0x10` BAUDDIV. Init: 115200 baud,
CTRL = `0x3`. `uart_getc` is non-blocking and returns `-1` when empty. Write to
the registers as on silicon; the firmware must not know QEMU's chardev is a socket.

## 5. Timebase (do not regress)

- SysTick runs free: `SYST_RVR = 0x00FFFFFF`, one wrap ≈ 0.67 s at 25 MHz.
- Elapsed = `(last - now) + wraps * (RVR + 1)`, wrap detected when `now > last`.
- Ticks accumulate in `tick_accum`; each frame subtracts `SYSCLK_HZ / RATE_HZ`,
  with `RATE_HZ` = 50 (`flight.h`). No pass may lose time.
- Never use a short reload with `elapsed = last - now`. That gave 0.76 Hz instead
  of 50 Hz (`docs/ARCHITECTURE.md` §5).
- Any timing change must be measured: `node tools/probe-rate.mjs 5` must report
  ≈ 50 Hz (last measured 49.8 Hz).

## 6. Pad frame contract (host → firmware)

```
A5 5A | seq:u16 | X Y Z R : u16 x4 | buttons:u16 | pov:i16 | xor:u8     = 17 bytes
```

- All little-endian. XOR over the 16 preceding bytes. 50 Hz.
- Axes 0..65535, centre 32767 (WinMM convention). The HID path in
  `host/pad-reader.ps1` normalises to this so the firmware never changes.
- Firmware resynchronises byte by byte on `A5 5A`; bad checksum drops the frame and
  counts `pad_frames_bad`.
- `pov` is degrees × 100, `-1` when centred. Up = `0`, down = `18000`.
- Changing this layout changes both `host/pad-reader.ps1` and `firmware/src/pad.h`
  in one commit, plus `tools/test-pad-path.mjs` (integrator).

## 7. Pad mapping and flight model (`flight.h`)

Axes are **rate commands** (decided 2026-10-30, commit `2b808bb`): deflection sets
how fast a value changes, a centred stick holds it. All four axes use
`pad_axis_norm` (−1..+1, 0 at centre, deadzone), Z included.

| Input | Parameter | Full-deflection rate | Limits |
|---|---|---|---|
| X | roll | `ROLL_RATE_DPS` = 30 °/s | ±`ROLL_LIMIT_DEG` = 45° |
| Y | pitch (stick back = up) | `PITCH_RATE_DPS` = 10 °/s | ±`PITCH_LIMIT_DEG` = 20° |
| Z | CAS | `CAS_RATE_KTS` = 25 kt/s | 0..`CAS_MAX_KT` = 250 kt |
| R | vertical speed | `VS_RATE_FPMS` = 1000 ft/min/s | ±`VS_LIMIT_FPM` = 2000 ft/min |
| derived | heading | turn rate = `3 * tan(roll) / tan(30°)` °/s, clamped ±25 °/s, wrapped 0..360 |
| derived | baro alt | integrates V/S, clamped −1000..100000 ft, starts at 5000 ft |

- Deadzone `PAD_DEADZONE` = 0.06, rescaled so full travel stays usable.
- Button masks are defined twice, `BTN_*` in `pad.h` and `BTN_*_<ACTION>` in
  `flight.h` (`BTN_A_LEVEL`, `BTN_B_RESET_HDG` ...); a `_Static_assert` in
  `flight.h` keeps them equal. Renaming one means updating the assert.
- Buttons: `0x0001` A wings level (roll and pitch to 0, edge), `0x0002` B **held
  1 s** resets heading (`HDG_RESET_HOLD_TICKS` = `RATE_HZ`; fires once per hold),
  `0x0004` LB CAS −10 (edge), `0x0008` RB CAS +10 (edge), `0x0010` START toggles
  freeze (edge).
- The demo pad auto-fires B at about 5 Hz (turbo). Any destructive action must
  need a hold, never a single edge, or the pad triggers it by itself.
- D-pad up/down: altitude ±500 ft per frame while held (not edge-triggered).
- Freeze: every label is sent with SSM = NCD. It demonstrates the validity path.
- No pad frame ever received: every rate command is 0, so the model holds its
  `flight_init` values (5000 ft, 120 kt, level, heading 0).

## 8. A429 output contract (firmware → backend)

- Every 50 Hz tick sends 6 words in this order: PITCH 324, ROLL 325, HEADING 314,
  BARO_ALT 204, CAS 206, VERT_SPEED 212.
- One word = 4 bytes **little-endian** on UART0.
- Word: bits 1–8 label (bit-reversed octal), 9–10 SDI = 0, 11–29 19-bit BNR
  magnitude, 30–31 SSM, 32 odd parity.
- SSM: `0` PLUS, `1` NCD, `2` TEST, `3` MINUS. **Sign lives in the SSM**, never
  two's complement.
- `a429_encode_value` clamps to the label range, rounds `|value| / lsb + 0.5`,
  caps at `0x7FFFF`. It must stay byte-identical to `encodeValue` in
  `backend/src/a429/codec.js`.
- Label and LSB defines in `flight.h` mirror `shared/labels.json` by hand. If one
  changes, the other must change in the same commit (integrator coordinates).
- Startup banner `FLIGHT-FW 1\n` goes out on UART0 before any word. The backend
  absorbs it as about 6 parity errors and 4 unknown labels, then resynchronises.
  Do not add more text output on UART0.

## 9. Host scripts (`host/`)

- PowerShell 5.1 + .NET only. No modules to install, no admin rights, no drivers.
- `pad-reader.ps1` params: `-Port 5556`, `-RateHz 50`, `-Echo`, `-Seconds`,
  `-Backend auto|hid|winmm`. HID first, WinMM fallback.
- The reader **listens**; QEMU is the TCP client. It calls `AcceptTcpClient()`
  once. Never probe its port to check readiness: the probe takes the slot and QEMU
  is locked out. `tools/run-all.mjs` waits for its printed ready line instead.
- `test-pad.ps1` and `test-hid.ps1` are diagnostics; keep them read-only.

## 10. Verification for embedded changes

| Change | Must pass |
|---|---|
| Any firmware code | `node tools/chain.mjs --stage M2` (build with zero warnings, `test-pad-path` 16/16) |
| Timing | `node tools/chain.mjs --stage M7` (`probe-rate` ≈ 50 Hz) |
| Encoder | `npm run test:a429`, `node tools/test-pad-path.mjs` |
| Host reader | `node tools/verify-pad-live.mjs` with the pad attached, or say it was not run |
| Always | `npm test`, all pass |
| No toolchain on this machine | say so; CI runs M2 and M7 on push |
