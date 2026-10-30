# Interface Control Document — Embedded Firmware ↔ Backend (ARINC 429 Link)

| Field | Value |
|---|---|
| Document ID | ICD-FW-BE-001 |
| Revision | A (Draft) |
| Date | 2026-10-30 |
| Baseline | branch `sandbox`, commit `6f1ebd3` |
| Status | Draft — for review |
| Interfacing items | **IU-FW**: bare-metal Cortex-M3 firmware (`firmware/`) · **IU-BE**: backend ARINC 429 ingest (`backend/src/`) |
| Software level (DAL) | **TBD** — not assigned by a system safety assessment (see §10) |

### Revision history

| Rev | Date | Author | Description |
|---|---|---|---|
| A | 2026-10-30 | — | Initial draft, derived from the as-built baseline `6f1ebd3` |

### Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Firmware owner (IU-FW) | | | |
| Backend owner (IU-BE) | | | |
| Software verification (independent) | | | |
| Software quality assurance | | | |

---

## 1. Scope

### 1.1 Purpose
This ICD specifies, completely and verifiably, all information exchanged between the
embedded firmware (IU-FW) and the backend (IU-BE). It is the controlled interface
definition on which both sides' software requirements are based, and against which
interface verification is performed.

### 1.2 Interface boundary
In scope: the **unidirectional** link from IU-FW UART0 TX to the IU-BE ARINC 429 ingest port,
including physical/transport layer, framing, word format, label definitions, data
encoding, validity semantics, timing and error handling.

Out of scope: pad reader → firmware (UART1), backend → browser (HTTP/SSE), display
configuration. These are separate interfaces and are referenced only where they affect
this one.

### 1.3 Direction of data flow
IU-FW → IU-BE only. **IU-BE transmits no data to IU-FW.** There is no handshake,
acknowledgement, or flow control at the application layer.

### 1.4 DO-178C context
This document is structured to support the following DO-178C objectives and data items.
It does not, by itself, claim certification credit.

| DO-178C reference | How this ICD contributes |
|---|---|
| §5.1 / §11.9 Software Requirements Data | Interface requirements `ICD-xxx` (§5–§8) are the source for the high-level requirements of IU-FW and IU-BE on this interface |
| §5.2 / §11.10 Design Description | Data and control flow across the interface (§3, §7) |
| §5.5 / §6.5 / §11.21 Trace Data | Requirement → implementation → verification trace (§9) |
| §6.3.1 (a)–(g) Reviews of HLR | Each requirement is atomic, identified, and has a verification method; §10 lists known gaps |
| §6.4.2 / §6.4.3 Requirements-based test | Normal-range and robustness cases identified per requirement (§9) |
| §7 / §11.4 Configuration Management | Document ID, revision, baseline commit, change control (§11) |

### 1.5 Requirement conventions
- **shall** — mandatory and verifiable; **should** — recommended; **may** — permitted.
- Each requirement has a unique ID `ICD-<area>-<nnn>`, a responsible item (FW, BE or BOTH),
  and a verification method: **T** test, **A** analysis, **R** review, **I** inspection.
- Bit numbering follows ARINC 429: **bit 1 is the first bit transmitted**. In code,
  bit *n* is at register position *n − 1*.
- Label numbers are **octal** throughout.

---

## 2. Applicable and reference documents

| ID | Document | Use |
|---|---|---|
| AD-1 | RTCA DO-178C, *Software Considerations in Airborne Systems and Equipment Certification* | Process framework |
| AD-2 | ARINC Specification 429 Part 1 (Mark 33 DITS) | Word format, BNR, SSM, parity conventions |
| RD-1 | `docs/PLAN.md` | Agreed system requirements R1–R11 |
| RD-2 | `docs/ARCHITECTURE.md` | Architectural rationale for the decoupling boundary |
| RD-3 | `shared/labels.json` (version 1) | Machine-readable label table — normative for §6 |
| RD-4 | `shared/a429-vectors.json` (version 1) | Golden word vectors — normative for §5 |
| RD-5 | Arm *MPS2 AN385* / CMSDK APB UART reference | UART register model used by IU-FW |

If this ICD and RD-3 disagree, the discrepancy shall be raised as a problem report;
neither silently takes precedence.

---

## 3. Interface overview

```
 ┌──────────── IU-FW (QEMU guest, mps2-an385) ────────────┐
 │ 50 Hz superloop                                         │
 │   flight_step()      -> 6 engineering values           │
 │   flight_transmit()  -> BNR + SSM + parity -> 6 words  │
 │   a429_send_word()   -> 4 bytes LE per word            │
 │ CMSDK UART0 @ 0x40004000                                │
 └──────────────────────────┬──────────────────────────────┘
                            │ QEMU -serial chardev:u0
                            │ socket, client (server=off)
                            ▼ TCP 127.0.0.1:5555
 ┌──────────── IU-BE (Node.js) ────────────────────────────┐
 │ TCP server  -> ParamState.ingestChunk()  (framing)     │
 │             -> ingestWord() -> decodeWord() (A429)     │
 │             -> decodeValue()            (BNR -> EU)    │
 │             -> snapshot()      (validity + freshness)  │
 └─────────────────────────────────────────────────────────┘
```

| Layer | Definition | Section |
|---|---|---|
| L1 Physical / transport | UART byte stream carried over a TCP socket | §4 |
| L2 Framing | 4 bytes per word, little-endian | §4.3 |
| L3 Word | ARINC 429 32-bit word, odd parity | §5 |
| L4 Data | 6 BNR labels, engineering units | §6 |
| L5 Validity / timing | SSM semantics, 50 Hz refresh, 250 ms staleness | §7, §8 |

---

## 4. Physical and transport layer

### 4.1 Characteristics

| Characteristic | Value |
|---|---|
| Source peripheral | CMSDK APB UART0, base `0x40004000` |
| UART configuration | 115 200 baud nominal (`BAUDDIV = 25 MHz / 115200`), 8 data bits, TX+RX enabled |
| Transport | QEMU socket chardev, TCP, IPv4 loopback |
| Endpoint roles | IU-BE = TCP **server**; QEMU (on behalf of IU-FW) = TCP **client** |
| Address / port | `127.0.0.1:5555` |
| Direction | IU-FW → IU-BE |
| Flow control | None |
| Electrical ARINC 429 (bipolar RZ, 12.5/100 kbit/s) | **Not implemented** — out of scope per RD-1 §9 |

Under QEMU, the UART baud divisor does not throttle the socket; effective byte rate is
governed by the IU-FW transmit schedule (§8).

### 4.2 Requirements

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-PHY-001 | IU-FW shall transmit interface data exclusively by writing bytes to the UART0 `DATA` register at `0x40004000`, and shall not depend on the transport behind it. | FW | I |
| ICD-PHY-002 | IU-BE shall accept the interface byte stream as a TCP server bound to `127.0.0.1` on port 5555 (configurable via `a429Port`). | BE | T |
| ICD-PHY-003 | IU-BE shall bind the ingest port to the loopback address only. | BE | I |
| ICD-PHY-004 | IU-BE shall not transmit any data on the ingest connection. | BE | I |
| ICD-PHY-005 | IU-BE shall continue operating (HTTP and SSE services, staleness evaluation) when no ingest connection exists or the connection is closed or errors. | BE | T |
| ICD-PHY-006 | In replay mode IU-BE shall not open the ingest port and shall read the same L2 byte format from a capture file. | BE | T |

### 4.3 Framing (L2)

Each ARINC 429 word is transmitted as **exactly 4 bytes, least-significant byte first**.
No start/end delimiters, length fields, sequence numbers or checksums are added; word
integrity relies on the ARINC 429 parity bit (§5) and label validation (§6).

```
byte offset:   +0           +1            +2             +3
contents:      w[7:0]       w[15:8]       w[23:16]       w[31:24]
A429 bits:     1..8 label   9..10 SDI,    19..26 data    27..29 data,
                            11..16 data                  30..31 SSM, 32 P
```

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-FRM-001 | IU-FW shall transmit each 32-bit word as 4 consecutive bytes in little-endian order (bits 1–8 first). | FW | T |
| ICD-FRM-002 | IU-FW shall not interleave bytes of different words. | FW | I |
| ICD-FRM-003 | IU-BE shall reassemble words from 4 consecutive bytes in little-endian order and shall retain any trailing partial word (< 4 bytes) until more bytes arrive. | BE | T |
| ICD-FRM-004 | IU-BE shall recover word alignment after corrupt or non-A429 bytes without operator action (resynchronisation rule in §7.3). | BE | T |

### 4.4 Start-up banner (non-A429 data)

At reset, before the first A429 word, IU-FW emits the 12-byte ASCII string
`"FLIGHT-FW 1\n"` on UART0.

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-FRM-010 | IU-FW may emit the 12-byte banner `46 4C 49 47 48 54 2D 46 57 20 31 0A` once after reset, before the first word. No other non-A429 bytes shall be emitted on UART0. | FW | I |
| ICD-FRM-011 | IU-BE shall tolerate the banner without producing a parameter update, and shall be word-aligned no later than the end of the first complete transmit frame (§8) following it. | BE | T |

> Analysis note: none of the three 4-byte groups of the banner decodes to a defined
> label (low bytes `0x46`, `0x48`, `0x57` reverse to octal 142, 022, 352). See OI-01.

---

## 5. ARINC 429 word format (L3)

### 5.1 Field layout

| Bits | Field | Width | Definition |
|---|---|---|---|
| 1–8 | Label | 8 | Octal label; transmitted MSB of the octal code **first**, so the stored byte is the bit-reversal of the label value |
| 9–10 | SDI | 2 | Source/Destination Identifier |
| 11–29 | Data | 19 | Unsigned BNR magnitude, LSB at bit 11 |
| 30–31 | SSM | 2 | Sign/Status Matrix (§7.1) |
| 32 | P | 1 | Odd parity over bits 1–32 |

### 5.2 Worked example (normative, from RD-4)

Pitch = +10.0°, label 324, SDI 0, SSM 00:

| Step | Value |
|---|---|
| Label 324₈ = `1101 0100`₂ → reversed | `0010 1011`₂ = `0x2B` |
| Magnitude = round(10.0 / 0.0439453125) | 228 = `0xE4` |
| Data field (228 ≪ 10) | `0x00039000` |
| Bits 1–31 | `0x0003902B` — 8 ones (even) |
| Parity bit 32 | 1 |
| Word | `0x8003902B` |
| Bytes on wire (L2) | `2B 90 03 80` |

### 5.3 Requirements

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-WRD-001 | IU-FW shall place the label in bits 1–8 as the bit-reversal of the 8-bit octal label value. | FW | T |
| ICD-WRD-002 | IU-FW shall set SDI (bits 9–10) to `00` for all labels. | FW | T |
| ICD-WRD-003 | IU-FW shall place the BNR magnitude in bits 11–29 as an unsigned integer in the range 0 … 524 287 (2¹⁹ − 1), saturating at 524 287. | FW | T |
| ICD-WRD-004 | IU-FW shall set bit 32 such that the total number of ones in bits 1–32 is odd. | FW | T |
| ICD-WRD-005 | IU-FW and IU-BE shall produce/accept words bit-identical to every vector in RD-4. | BOTH | T |
| ICD-WRD-006 | IU-BE shall reject any word with even parity, increment `parityErrors`, and shall not update any parameter from it. | BE | T |
| ICD-WRD-007 | IU-BE shall extract label, SDI, magnitude and SSM as defined in §5.1 and shall never terminate or throw on any 32-bit input. | BE | T |
| ICD-WRD-008 | IU-BE shall record the received SDI per label. IU-BE shall not filter on SDI (single-source bus). | BE | T |

---

## 6. Label definitions (L4)

### 6.1 Label table

All labels are **BNR**. Engineering value = sign(SSM) × magnitude × LSB.

| Label (oct) | Tag | Parameter | Unit | LSB (unit/bit) | Encodable range | Max magnitude | Operational range produced by IU-FW |
|---|---|---|---|---|---|---|---|
| 324 | PITCH | Pitch angle | deg | 0.0439453125 (180/4096) | −180 … +180 | 4 096 | −20 … +20 |
| 325 | ROLL | Roll angle | deg | 0.0439453125 (180/4096) | −180 … +180 | 4 096 | −45 … +45 |
| 314 | HEADING | Heading | deg | 0.0439453125 (180/4096) | 0 … 360 | 8 192 | 0 … < 360 |
| 204 | BARO_ALT | Baro-corrected altitude | ft | 4 | −1 000 … +100 000 | 25 000 | 0 … 100 000 |
| 206 | CAS | Calibrated airspeed | kt | 0.125 | 0 … 600 | 4 800 | 0 … 250 |
| 212 | VERT_SPEED | Vertical speed | ft/min | 1 | −32 000 … +32 000 | 32 000 | −6 000 … +6 000 |

Sign convention: pitch positive nose-up; roll positive right-wing-down; vertical speed
positive climbing; heading 0 = reference north, increasing clockwise.

Resolution: the quantisation error of any transmitted value is ≤ ½ LSB.

### 6.2 Requirements

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-LBL-001 | The label set shall be exactly the six labels of §6.1, with the LSB and range values defined in RD-3. | BOTH | R |
| ICD-LBL-002 | IU-FW shall convert each engineering value to a magnitude as round(\|clamp(v, min, max)\| / LSB), rounding half away from zero. | FW | T |
| ICD-LBL-003 | IU-FW shall clamp values outside the encodable range to the nearest range limit; values shall never wrap. | FW | T |
| ICD-LBL-004 | IU-FW shall transmit heading normalised to [0, 360). | FW | T |
| ICD-LBL-005 | IU-BE shall convert a valid word to engineering units as sign × magnitude × LSB, with sign = −1 for SSM `11` and +1 for SSM `00`. | BE | T |
| ICD-LBL-006 | The round trip FW encode → BE decode shall reproduce the engineering value within ½ LSB across the full encodable range, including both range edges. | BOTH | T |
| ICD-LBL-007 | IU-BE shall reject a parity-valid word whose label is not in §6.1, increment `unknownLabels`, and not update any parameter. | BE | T |
| ICD-LBL-008 | IU-BE shall perform no filtering, smoothing, rate-limiting or derivation on received values (RD-1 R6). | BE | R |
| ICD-LBL-009 | IU-BE shall load the label table from RD-3 at start-up; IU-FW label constants (`flight.h`) shall match RD-3 exactly. | BOTH | R |

---

## 7. Validity and error handling (L5)

### 7.1 SSM semantics (BNR)

| SSM (bits 31,30) | Name | IU-FW use | IU-BE interpretation |
|---|---|---|---|
| `00` | Normal, positive | value ≥ 0 | **valid**, sign + |
| `11` | Normal, negative | value < 0 | **valid**, sign − |
| `01` | No Computed Data (NCD) | all labels while FREEZE active | **not valid**, value = null |
| `10` | Functional Test | never transmitted | **not valid**, value = null |

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-VAL-001 | IU-FW shall encode the sign of a BNR value in the SSM (`00` / `11`), not as two's complement in the data field. | FW | T |
| ICD-VAL-002 | While the FREEZE mode is active, IU-FW shall transmit every label with SSM `01` and magnitude 0, at the normal rate. | FW | T |
| ICD-VAL-003 | IU-FW shall not transmit SSM `10`. | FW | I |
| ICD-VAL-004 | IU-BE shall report a label as not valid, with a null value, when its last received SSM is `01` or `10`. | BE | T |
| ICD-VAL-005 | An NCD word shall refresh the label's freshness timer (the source is alive but has no data). | BE | T |

### 7.2 Freshness (data-loss detection)

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-VAL-010 | IU-BE shall timestamp each accepted word per label and shall report a label **stale** when no accepted word for it has been received within **250 ms** (`STALE_MS`). | BE | T |
| ICD-VAL-011 | A stale label shall be reported not valid with a null value, regardless of its last SSM. | BE | T |
| ICD-VAL-012 | A label never received since start-up shall be reported stale with a null age. | BE | T |
| ICD-VAL-013 | Freshness shall be evaluated per label, so the loss of one label is detected independently of the others. | BE | T |

Rationale: 250 ms equals 12.5 transmit periods at 50 Hz (§8), tolerating scheduling
jitter on the host while detecting loss within a quarter second.

### 7.3 Corruption and resynchronisation

Resynchronisation rule implemented by IU-BE (`ParamState.ingestChunk`):

| Condition on the 4-byte candidate word | Action | Counters |
|---|---|---|
| Parity valid, label defined | accept; advance 4 bytes | `words` |
| Parity invalid | reject; advance 4 bytes | `words`, `parityErrors`, `resyncs` |
| Parity valid, label undefined | reject; advance **1 byte** and retry | `words`, `unknownLabels`, `resyncs` |

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-ERR-001 | IU-BE shall expose the counters `words`, `parityErrors`, `unknownLabels`, `resyncs` via `/api/health` and the state snapshot. | BE | T |
| ICD-ERR-002 | IU-BE shall apply the resynchronisation rule of §7.3. | BE | T |
| ICD-ERR-003 | A corrupt or rejected word shall not alter the value, validity or freshness of any label. | BE | T |

---

## 8. Timing and transmit schedule

| Characteristic | Value |
|---|---|
| Frame period | 20 ms (50 Hz), SysTick-derived, accumulated (no drift from lost ticks) |
| Words per frame | 6 (one per label) |
| Transmission order within a frame | 324, 325, 314, 204, 206, 212 |
| Per-label refresh rate | 50 Hz |
| Bytes per frame | 24 |
| Nominal throughput | 300 words/s = 1 200 bytes/s |
| Frame structure | burst: the 6 words are written back-to-back at the start of each period |
| Measured rate (capture `shared/capture.a429`) | ≈ 49.6 Hz, 1 786 words, 0 rejected |

| ID | Requirement | Item | Ver. |
|---|---|---|---|
| ICD-TIM-001 | IU-FW shall transmit one complete frame of all six labels every 20 ms ± 2 ms (long-term mean 50 Hz ± 2 %). | FW | T |
| ICD-TIM-002 | IU-FW shall transmit the labels within a frame in the fixed order of §8. | FW | T |
| ICD-TIM-003 | All six words of a frame shall be computed from the same flight-model step (frame consistency). | FW | I |
| ICD-TIM-004 | IU-FW shall begin transmitting frames immediately after reset, independent of whether pad input has been received. | FW | T |
| ICD-TIM-005 | IU-BE shall not depend on word order within a frame. | BE | T |
| ICD-TIM-006 | IU-BE shall process received bytes as they arrive, adding no buffering delay beyond the reassembly of a partial word. | BE | I |

---

## 9. Traceability and verification

### 9.1 Implementation trace

| Area | IU-FW implementation | IU-BE implementation |
|---|---|---|
| PHY | `firmware/src/uart.h`, `firmware/src/main.c` (`uart_init`) | `backend/src/server.js` (`createTcpServer`, `listen`) |
| FRM | `main.c` `a429_send_word_impl`, banner `uart_puts` | `backend/src/state.js` `ingestChunk`; `server.js` `pending` buffer |
| WRD | `firmware/src/a429.h` `a429_encode`, `a429_parity_bit`, `a429_reverse_byte` | `backend/src/a429/codec.js` `decodeWord` |
| LBL | `firmware/src/flight.h` `LBL_*`, `LSB_*`, `flight_transmit`; `a429_encode_value` | `shared/labels.json`; `codec.js` `decodeValue`; `state.js` `ingestWord` |
| VAL | `flight.h` freeze → `A429_SSM_NCD` | `state.js` `STALE_MS`, `snapshot` |
| ERR | — | `state.js` `stats`, `ingestChunk`; `server.js` `/api/health` |
| TIM | `main.c` SysTick superloop; `flight.h` `RATE_HZ` | `state.js` `lastSeen` |

### 9.2 Verification trace

| Requirement(s) | Verification case | Method |
|---|---|---|
| WRD-001, WRD-004, WRD-005, WRD-007 | `test/a429.test.mjs`: *reverseByte reverses bit order*, *oddParityBit makes total ones odd*, *golden vectors encode exactly*, *golden vectors decode back*, *label is bit-reversed on the wire*, *decodeWord never throws on garbage* | T (BE side) |
| FRM-001, FRM-003 | `test/a429.test.mjs`: *golden vector byte order is little-endian 4 bytes* | T |
| WRD-006 | `test/a429.test.mjs`: *single-bit corruption is caught by parity*; `test/state.test.mjs`: *parity-corrupt word is rejected and counted* | T |
| LBL-007 | `test/state.test.mjs`: *unknown label is rejected and counted* | T |
| LBL-002, LBL-003, LBL-005, LBL-006 | `test/a429.test.mjs`: *engineering conversion roundtrips within one LSB*, *values outside the range are clamped*; `test/boundaries.test.mjs`: *range edges survive codec → word → backend exactly*, *values beyond the range clamp* | T (BE codec) |
| LBL-002…006, VAL-001, VAL-002, TIM-004 (FW side) | `tools/test-boundaries.mjs`, `tools/test-pad-path.mjs` via `tools/fw-harness.mjs` (real firmware in QEMU decoded by real `ParamState`) | T (integration) |
| LBL-001, LBL-009 | `test/a429.test.mjs`: *label table matches the agreed contract*; review of `flight.h` vs RD-3 | T + R |
| VAL-001 | `test/a429.test.mjs`: *SSM encodes the sign*, *baro altitude below sea level keeps its sign* | T |
| VAL-004, VAL-005 | `test/a429.test.mjs`: *NCD and TEST report not-valid*; `test/state.test.mjs`: *NCD word is fresh but not valid* | T |
| VAL-010…013 | `test/state.test.mjs`: *watchdog marks a silence stale after STALE_MS*, *a parameter never heard is stale with null age*; `test/e2e.test.mjs`: *a silent bus drives every parameter stale* | T |
| FRM-004, ERR-002 | `test/state.test.mjs`: *byte-stream ingest resynchronises after garbage* | T |
| PHY-002, PHY-005 | `test/e2e.test.mjs`: *A429 words over TCP reach the browser as engineering values*, *a silent bus …* | T |
| PHY-006 | `test/e2e.test.mjs`: *DECOUPLED: backend replays a capture …*, *no A429 port is opened in replay mode* | T |
| TIM-001 | `tools/probe-rate.mjs`; capture statistics of `shared/capture.a429` | T + A |
| PHY-001, PHY-003, PHY-004, FRM-002, FRM-010, VAL-003, TIM-003, TIM-006, LBL-008 | Code inspection / review | I / R |

Requirements without a test case at this baseline: see §10.

---

## 10. Open issues and observations

Found while deriving this ICD from the baseline. Each shall be dispositioned through
problem reporting before this ICD is released.

| ID | Observation | Affects | Proposed disposition |
|---|---|---|---|
| OI-01 | The start-up banner is non-A429 data on the A429 channel. The first group `"FLIG"` has odd parity, so it is treated as an unknown label (1-byte shift); subsequent groups may then consume a following real word through a parity-reject (4-byte advance). Possible loss of the first frame after reset. | FRM-010, FRM-011 | Move the banner to a separate channel, or verify FRM-011 with a dedicated test |
| OI-02 | On a **parity** failure IU-BE advances 4 bytes, not 1. RD-1 §5.3 states byte-by-byte resynchronisation on *any* bad word. A misaligned stream realigns only through unknown-label rejects. | ERR-002, FRM-004 | Align RD-1 and code; add a test with a misaligned stream whose candidate words fail parity |
| OI-03 | The C encoder (`a429.h`) is not tested against RD-4 directly. RD-1 M2 refers to `tools/qemu.mjs --vectors`, which is not present at this baseline. FW-side compliance with WRD-005 is shown only indirectly (integration decode). | WRD-005 | Add a firmware vector test (host-compiled `a429.h` or QEMU vector mode) |
| OI-04 | `shared/labels.json` states it is "generated into C by firmware/build.mjs"; `build.mjs` does not do this. `flight.h` duplicates the table by hand. | LBL-009 | Generate `flight.h` constants from RD-3, or add an automated consistency check |
| OI-05 | `firmware/src/a429.h` header comment references `tools/qemu.mjs`, which does not exist. | — | Correct the comment |
| OI-06 | IU-BE keeps one reassembly buffer (`pending`) across all TCP connections. A reconnect after a partial word prepends stale bytes to the new stream. | FRM-003 | Reset the buffer per connection |
| OI-07 | QEMU connects as a client with no reconnect option. If IU-BE restarts, the link is not re-established until QEMU restarts. | PHY-005 | Use `reconnect=` on the chardev, or document the start-up order |
| OI-08 | No software level (DAL) is assigned. Objectives applicability (Annex A tables), independence and structural-coverage criteria depend on it. | All | Obtain DAL from the system safety assessment |
| OI-09 | IU-FW uses polynomial approximations for tan/sin in the flight model. This does not affect the interface encoding, but affects the accuracy of transmitted derived values (HEADING, VERT_SPEED). | §6.1 | Specify accuracy requirements for derived parameters in IU-FW HLRs |
| OI-10 | The ARINC 429 electrical layer, bit timing and inter-word gap are not represented. | §4 | Accepted out of scope (RD-1 §9); revisit if moving to target hardware |

---

## 11. Change control

- This ICD is a configuration item, controlled under CC1. Changes require a problem
  report or change request, impact analysis on both IU-FW and IU-BE, and re-approval
  by both owners.
- Any change to RD-3 or RD-4 is a change to this ICD.
- Every requirement change shall update §9 so the trace stays complete.

---

## Appendix A — Glossary

| Term | Definition |
|---|---|
| BNR | Binary Number Representation (sign-magnitude, sign in SSM) |
| DAL | Design Assurance Level (Software Level A–E) |
| HLR | High-Level Requirement |
| IU | Interfacing Unit |
| LSB | Least Significant Bit weight, engineering units per count |
| NCD | No Computed Data |
| SDI | Source/Destination Identifier |
| SSM | Sign/Status Matrix |
