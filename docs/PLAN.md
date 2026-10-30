# PLAN — USB gamepad → QEMU bare-metal firmware → ARINC 429 → backend → SFD

Status: **agreed with the operator on 2026-10-30**, before any code was written.
Every decision below was taken from an explicit answer, not inferred.

---

## 1. Requirements

| # | Requirement | Decision taken |
|---|---|---|
| R1 | Input device | Physical USB gamepad on the Windows host |
| R2 | Embedded layer | **Bare-metal ARM Cortex-M3 firmware**, cross-compiled, executed in **QEMU** |
| R3 | Pad → firmware path | Host-side reader injects pad frames into the guest over a **QEMU virtual serial chardev** (no USB passthrough) |
| R4 | Firmware output | **Bit-exact ARINC 429 32-bit words** over a simulated A429 bus |
| R5 | Coupling | **Decoupled**: the backend must not know, or need, the gamepad, the firmware or QEMU |
| R6 | Backend scope | A429 **decode + BNR→engineering-unit conversion + validity/freshness only** (no filtering, no derived maths) |
| R7 | Backend UI | **One slider per received parameter, configuring the display** — range/scale/visibility, *not* a value override |
| R8 | Frontend | A **Secondary Flight Display** |
| R9 | Parameter set | **6 fixed A429 labels**: pitch 324, roll 325, heading 314, baro altitude 204, CAS 206, vertical speed 212 (octal) |
| R10 | Surfaces | **Two pages** served by the backend: config page (sliders) and a separate SFD page |
| R11 | Repo | Built in `Hackathon/`, branch `sandbox` |

## 2. Verified environment (measured, not assumed)

```
$ arm-none-eabi-gcc --version
arm-none-eabi-gcc.exe (Arm GNU Toolchain 14.2.Rel1 (Build arm-14.52)) 14.2.1 20241119
$ qemu-system-arm --version
QEMU emulator version 11.1.0 (v11.1.0-12130-ge470268ff4)
$ node --version
v24.21.0
```

QEMU target board: **`mps2-an385`** (Cortex-M3, two CMSDK APB UARTs — UART0 TX to the
backend, UART1 RX from the pad reader).

Installed with `winget` on 2026-10-30, on the operator's approval:
`SoftwareFreedomConservancy.QEMU` 11.1.0, `Arm.GnuArmEmbeddedToolchain` 14.2.Rel1.

Absolute paths (not on PATH):

- `C:\Program Files\qemu\`
- `C:\Program Files (x86)\Arm GNU Toolchain arm-none-eabi\14.2 rel1\bin\`

## 3. The gamepad, as the operating system actually reports it

```
FriendlyName : HID-compliant game controller
InstanceId   : HID\VID_0079&PID_181C\6&8A672F4&0&0000

$ XInputGetState(0..3)  -> 1167 (ERROR_DEVICE_NOT_CONNECTED) on all slots
$ joyGetDevCaps(0)      -> 0,  'Microsoft PC-joystick driver'
                           axes=4/6  buttons=15  X,Y,Z,R ∈ [0..65535], centre 32767
                           period 10-1000 ms
$ joyGetPosEx(0)        -> 0 (works)
```

Consequences, both decided with the operator:

- The pad is **DirectInput-only**: XInput cannot see it. The host reader therefore uses
  the **WinMM joystick API** (`joyGetPosEx`) through PowerShell/.NET — zero dependencies.
- There are **4 usable axes**, so the 6 parameters are driven as:

| Axis / control | Parameter | Notes |
|---|---|---|
| X | Roll | −45…+45° |
| Y | Pitch | −20…+20°, stick back = pitch up |
| Z | Calibrated airspeed | 0…250 kt |
| R | Vertical speed | −2000…+2000 ft/min |
| *derived* | Heading | integrated from roll as a coordinated turn (turn rate ∝ tan(roll)) |
| *derived* | Baro altitude | integrated from vertical speed |
| A | Reset pitch/roll trim to neutral | |
| B | Reset heading to 0 | |
| LB / RB | CAS −10 / +10 kt | |
| D-pad up / down | Altitude +500 / −500 ft | |
| Start | **Freeze**: firmware sends all labels with SSM = No-Computed-Data | demonstrates the validity path |

## 4. Data flow

```
USB gamepad ──DirectInput──► host/pad-reader.ps1  (PowerShell + WinMM)
                                   │ binary pad frames, 50 Hz
                                   ▼ TCP :5556  (guest UART1 RX)
        ┌──── QEMU: qemu-system-arm -M mps2-an385 ────────────┐
        │ bare-metal firmware                                 │
        │   50 Hz: axes → 6 engineering values                │
        │           → BNR + SSM → odd parity → 32-bit words   │
        │   UART0 TX: one word = 4 bytes                      │
        └──────────────────────┬──────────────────────────────┘
                               ▼ TCP :5555  (guest UART0 TX)
        ┌──── backend (Node 24, zero dependencies) ───────────┐
        │ a429/decode.js  label/SDI/SSM/parity + resync       │
        │ labels.json     6-label table (label → unit, res)   │
        │ state.js        value + valid + freshness (250 ms)   │
        │ config.js       display config per label            │
        │ http.js         /config /sfd /api/state /api/config │
        └────────┬─────────────────────────┬──────────────────┘
                 ▼ SSE config             ▼ SSE values
          config page (6 sliders)     SFD page (cockpit)
```

## 5. Wire contracts

### 5.1 ARINC 429 word (32 bits, bit 1 transmitted first)

| Bits | Field | Rule |
|---|---|---|
| 1–8 | Label | 8-bit label, **bit order reversed** on the wire (A429 convention) |
| 9–10 | SDI | `00` (single source) |
| 11–29 | Data | 19-bit magnitude, BNR |
| 30–31 | SSM | `00` valid +, `01` no-computed-data, `10` functional test, `11` valid − |
| 32 | Parity | **odd** over all 32 bits |

### 5.2 Label table (`shared/labels.json` — the single source for firmware and backend)

| Label (octal) | Parameter | Unit | LSB | Range |
|---|---|---|---|---|
| 324 | Pitch | ° | 0.0439 | ±180 |
| 325 | Roll | ° | 0.0439 | ±180 |
| 314 | Heading | ° | 0.0439 | 0…360 |
| 204 | Baro altitude | ft | 4 | −1000…100000 |
| 206 | Calibrated airspeed | kt | 0.125 | 0…600 |
| 212 | Vertical speed | ft/min | 1 | ±32000 |

### 5.3 Guest UART0 → backend

Word-framed (decided): **4 bytes, little-endian, per word**; no bit timing, no clock
recovery. The decoder resynchronises byte-by-byte on any word with bad parity or an
unknown label and counts resyncs.

### 5.4 Host reader → guest UART1

```
A5 5A | seq:u16 | X Y Z R : u16 ×4 | buttons: u16 | pov: i16 | xor:u8
```

All little-endian, 50 Hz, XOR checksum over every preceding byte.

### 5.5 Backend → browsers

SSE; `event: state` at 20 Hz carrying engineering values + validity, `event: config`
whenever a slider changes.

## 6. Repository layout

```
firmware/   src/*.c *.h  startup.c  mps2-an385.ld  build.mjs
host/       pad-reader.ps1        (WinMM → TCP)
backend/    src/*.js  serve.mjs
frontend/   config.html  sfd.html  css/  js/
shared/     labels.json  a429-vectors.json  capture.a429
tools/      qemu.mjs  run-all.mjs  capture.mjs
test/       *.test.mjs
docs/       PLAN.md  ARCHITECTURE.md  ARINC429.md  DEMO.md
```

## 7. Milestones and their evidence

| # | Milestone | Proof command |
|---|---|---|
| M0 | Toolchain installed and verified | `arm-none-eabi-gcc --version`, `qemu-system-arm -M help` ✅ done |
| M1 | A429 codec in JS + hand-computed golden vectors | `node --test test/a429.test.mjs` |
| M2 | Firmware builds and boots in QEMU; its bytes equal the golden vectors | `node firmware/build.mjs && node tools/qemu.mjs --vectors` |
| M3 | Pad reader streams live axes over TCP | `host/pad-reader.ps1 -Echo` |
| M4 | Backend decodes, converts, watches freshness, serves API | `node --test` + `/api/health` |
| M5 | SFD page + config page with 6 sliders | both pages open, slider changes the SFD mapping |
| M6 | End-to-end and **decoupled replay** (QEMU and pad absent) | `node --test test/e2e.test.mjs` |

Budget estimate ≈ 4 h 50 min against a 4 h 30 window. Mitigation: the frontend and the
backend are built against a **recorded A429 capture**, so neither waits on QEMU;
if board bring-up overruns, the recorded replay still gives a working demo and QEMU
becomes the live variant.

## 8. Risks

| Risk | Mitigation |
|---|---|
| QEMU `mps2-an385` UART mapping differs from the plan | first firmware milestone is "one byte out of UART0 visible in the backend" |
| Pad is DirectInput-only | settled: WinMM reader, verified working above |
| Axis jitter / deadzone | deadzone + hysteresis in the reader, documented constant |
| 4 h 30 window | capture-first ordering; frontend independent of QEMU |
| winget installs need admin | done, on approval |

## 9. Out of scope (explicit)

- Real STM32 hardware, real ARINC 429 transceivers, real 12.5 kbit/s timing
- Filtering, sensor fusion, air-data corrections (backend is decode + convert only)
- Value override from the sliders (they configure the display only)
- Persistence of configuration across restarts (unless asked)
