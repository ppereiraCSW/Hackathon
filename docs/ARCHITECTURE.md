# ARCHITECTURE

How the four pieces fit together, why each boundary is where it is, and what was
measured rather than assumed.

## 1. The pipeline

```
  USB gamepad                host/pad-reader.ps1                 QEMU guest
  (DirectInput)  --HID---->  poll 50 Hz, normalise,  -->  TCP :5556  -->  UART1 RX
                             frame + XOR checksum                      |
                                                                       v
                                                        bare-metal Cortex-M3 firmware
                                                        (50 Hz flight model, BNR encode,
                                                         odd parity, 6 A429 words)
                                                                       |
                                                                       v  UART0 TX
                                                                  TCP :5555
                                                                       |
                                                                       v
                                          backend (Node 24, zero dependencies)
                                          a429 decode -> engineering units -> validity
                                          display config store (6 sliders)
                                                                       |
                                              SSE /events        SSE /config-events
                                                   |                    |
                                                   v                    v
                                             /sfd  (the SFD)     /config (sliders)
```

## 2. Why the boundaries are where they are

### The A429 boundary is the decoupling point
The requirement is that A429 data is processed by a backend *in a decoupled way*.
That is only true if the backend would work with the embedded layer replaced.

It does, and this is enforced by a test rather than asserted:
`test/e2e.test.mjs` → **"DECOUPLED: backend replays a capture with QEMU and gamepad
absent"** starts the backend in replay mode (`--replay shared/capture.a429`), opens
no A429 TCP port at all, and still produces all six valid parameters. A second test
asserts the port really is closed in that mode.

The capture (`shared/capture.a429`) is a real recording from the firmware in QEMU —
1,786 words, zero rejected, ~49.6 Hz — not a hand-written fixture.

### The qemu boundary is a UART, not a socket in the firmware
The firmware has no idea QEMU's chardev is a socket. It writes to
`UART_DATA(0x40004000)` exactly as it would on silicon, so pointing it at a real
MPS2 board is a change of `-serial`, not a change of code. This is what makes
"flash to a real STM32" (deck stretch goal 1) a port rather than a rewrite.

### The backend does not filter
Decision (2026-10-30): the backend decodes, converts BNR to engineering units and
judges validity/freshness. It does not smooth, fuse or derive. Filtering would make
it a flight-model component, harder to justify in a certification argument and
irrelevant to what the SFD needs to show.

Arrow of blame is explicit: an invalid value at the SFD means the bus said
something invalid or nothing at all — never that the backend post-processed it away.

### The sliders configure, they do not override
Decision (2026-10-30). Each slider sets the **display window** (min/max mapped onto
the instrument) and **visibility**. The embedded layer remains the only source of
value. This keeps a single source of truth: you can never get a plausible display
out of an empty bus by moving a slider.

## 3. Wire contracts

### ARINC 429 word
| Bits | Field | Notes |
|---|---|---|
| 1–8 | Label | bit order reversed on the wire |
| 9–10 | SDI | 0 |
| 11–29 | Data | 19-bit BNR magnitude |
| 30–31 | SSM | `00` +, `01` NCD, `10` TEST, `11` − |
| 32 | Parity | odd over all 32 bits |

Sign lives in the SSM, not two's complement — the single most common way to get
A429 subtly wrong. `test/a429.test.mjs` pins this.

### Transport (deliberately not bit-timed)
Each word is 4 bytes little-endian. No 12.5 kbit/s bit timing, no clock recovery —
decided 2026-10-30 as the word-framed option. The *word semantics* are bit-exact;
only the physical layer is simulated.

Consequence, stated honestly: this is not a substitute for a real A429 bus, and a
receiver could not resynchronise the way a real one does by watching gaps between
words. It is A429 at the word level.

### Pad frame (host → guest)
```
A5 5A | seq:u16 | X Y Z R : u16×4 | buttons:u16 | pov:i16 | xor:u8     (17 bytes)
```
Axes use WinMM's 0..65535 convention with 32767 at centre (the HID path rescales
to it); the firmware normalises with a
6% deadzone and rescales so full travel remains usable.

## 4. The gamepad constraint that shaped the design

Measured on the target machine:

```
$ XInputGetState(0..3) -> 1167 (ERROR_DEVICE_NOT_CONNECTED) on every slot
$ joyGetDevCaps(0)     -> 0, 'Microsoft PC-joystick driver'
                          axes=4/6, buttons=15, X/Y/Z/R in [0..65535]
```

The pad is a generic **DirectInput** device (`HID\VID_0079&PID_181C`), invisible to
XInput, and it exposes **four** axes. The original six-axis mapping was therefore
impossible. Revised mapping (operator decision, 2026-10-30):

| Input | Parameter | Range |
|---|---|---|
| X | roll | ±45° |
| Y | pitch | ±20° (back = up) |
| Z | calibrated airspeed | 0…250 kt |
| R | vertical speed | ±2000 ft/min |
| *derived* | heading | integrated from bank as a coordinated turn |
| *derived* | baro altitude | integrated from vertical speed |

Since commit `2b808bb` the four axes are **rate commands**: deflection sets how
fast the value moves (roll 30°/s, pitch 10°/s, CAS 25 kt/s, V/S 1000 ft/min/s)
and a centred stick holds it. The ranges above are the limits.

Buttons level the wings, reset heading (1 s hold, because the pad auto-fires B),
and step CAS/altitude; START toggles an all-labels **NCD** freeze, which is a
one-button demo of the entire validity path.

Because heading and altitude are integrated in the firmware, the **backend's "no
derived values" rule is not violated**: integration happens upstream, and the
backend still only decodes what arrives.

## 5. Timebase — the bug worth documenting

SysTick counts down and wraps. The first implementation used a 20 ms reload and
`elapsed = last - now`. Measured result: **0.76 Hz instead of 50 Hz**, because a
superloop slower than one reload loses whole wraps.

Fixed with a free-running counter (max reload, one wrap ≈ 0.67 s) and explicit wrap
accumulation. Measured after: **49.81 Hz, 49.68 Hz** on consecutive runs.

Lesson: a microcontroller timer that looks obviously correct can be wrong by 50×,
and only measuring the output rate reveals it.

## 6. Testing strategy

| Layer | Test | What it proves |
|---|---|---|
| Codec | `test/a429.test.mjs` (16) | bit-exact words vs 11 golden vectors derived twice |
| Firmware | `tools/test-pad-path.mjs` (12) | pad frame → firmware → A429 → backend, incl. NCD and heading integration |
| Backend | `test/state.test.mjs` (16) | watchdog, NaN/Infinity/type rejection, resync |
| System | `test/e2e.test.mjs` (6) | live TCP ingest, SSE, stale-on-silence, **decoupled replay** |
| Visual | browser run | the SFD renders and responds |

Total: **38 automated tests** (`npm test`) plus the 17-check pad-path proof
and the 10-check keyboard-path proof.

Golden vectors are computed twice — once by the JS codec, once by an independent
`handEncode()` — and asserted equal. That is what allows the claim "the C encoder
and the JS decoder agree", rather than hoping so.

## 7. Limits, stated plainly

- **No bit timing.** Word-level A429 only (decided).
- **No RTOS.** Bare-metal superloop + SysTick; the deck's "tiny-RTOS" is satisfied
  by the QEMU target, not by a scheduler.
- **Simulated bus.** No ARINC 429 transceiver, no differential pair.
- **No persistence.** Display config lives in memory; a backend restart resets it.
- **One-way arrows.** No commands travel back to the embedded layer.
- **QEMU boot is not silent.** The firmware banner costs 6 parity errors and 4
  unknown labels in the counters at startup, then the decoder resynchronises and
  rejects nothing further (verified: counters frozen while words climb).
