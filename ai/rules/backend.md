# Rules: backend (`backend/`, `test/a429.test.mjs`, `test/state.test.mjs`)

## 1. Scope (decision R6)

The backend does exactly three things:

1. Decode ARINC 429 words.
2. Convert BNR magnitude + SSM to engineering units.
3. Judge validity and freshness.

It does **not** filter, smooth, fuse, interpolate or derive values. An invalid value
on the SFD must mean the bus sent something invalid or nothing. Never that the
backend changed it.

It does **not** know about QEMU, the gamepad or the firmware (decision R5). No
code may reference them. Input is A429 bytes on TCP, or a capture file.

## 2. Runtime

- Node 24 (`engines: >=22`), ES modules (`"type": "module"`). **Zero dependencies.**
- Start: `node backend/serve.mjs [--http-port 8090] [--a429-port 5555] [--replay <file>]`.
- Entry point for tests: `startBackend({ labelsPath, httpPort, a429Port, sseHz,
  replayPath, now })` in `backend/src/server.js`. It returns `state`, `config`,
  `labelsDoc`, `httpServer`, `a429Server`, `ports`, `close()`.
- Inject time through the `now` option. Never call `Date.now()` directly in new
  logic; tests rely on a controllable clock.

## 3. Modules

| File | Role |
|---|---|
| `serve.mjs` | CLI wrapper, SIGINT/SIGTERM shutdown |
| `src/server.js` | HTTP + SSE + A429 TCP ingest + replay |
| `src/state.js` | `ParamState`: ingest, stats, watchdog, snapshot |
| `src/config.js` | `DisplayConfig`: per-label display window + visibility |
| `src/a429/codec.js` | Bit-exact encode/decode, the reference for the C encoder |

`src/config.js` here is the **display config**, not app settings. Ports and paths
are arguments to `startBackend`.

## 4. A429 codec (`src/a429/codec.js`)

- Word: bits 1–8 label (stored bit-reversed), 9–10 SDI, 11–29 19-bit magnitude
  (`DATA_MAX` = `0x7FFFF`), 30–31 SSM, 32 odd parity.
- `SSM`: PLUS `0`, NCD `1`, TEST `2`, MINUS `3`. Sign is in the SSM.
- `decodeWord` **never throws**. Bad parity returns `{ ok: false, reason: 'parity' }`.
  Labels come back as 3-digit octal strings (`'324'`).
- `decodeValue`: NCD and TEST return `{ value: null, valid: false }`, never a number.
- `encodeValue`: non-finite → NCD; clamp to `def.min..def.max`; round
  `|v| / lsbPerBit`; cap at `DATA_MAX`.
- Transport: 4 bytes little-endian per word (`wordToBytes`, `bytesToWord`).
- `firmware/src/a429.h` mirrors this file. Any change to encoding rules changes
  both, coordinated by the integrator, and the golden vectors must still match.

## 5. State and watchdog (`src/state.js`)

- `STALE_MS` = 250. A label not heard within 250 ms is `stale`.
- `ingestWord` returns `'ok' | 'parity' | 'unknown'` and updates
  `stats.words`, `parityErrors`, `unknownLabels`.
- `ingestChunk` resynchronises: on an unknown label it backs up 3 bytes (net one
  byte forward) and counts a resync; on bad parity it counts a resync and moves on.
  It returns the unconsumed tail; the caller keeps it.
- `snapshot()` shape (sent over SSE, must stay JSON-serialisable):

```js
{ t, params: [{ label, tag, unit, value, valid, stale, ageMs, ssm, sdi,
                range: { min, max } }],
  stats: { words, parityErrors, unknownLabels, resyncs, startedAt, uptimeMs } }
```

- `value` is `null` unless the label is fresh **and** valid. `ageMs` is `null` if
  never heard. `ssm` is `'NONE'` before the first word.

## 6. Display config (`src/config.js`, decision R7)

- One entry per label, from `display` in `shared/labels.json`: `{ min, max, visible }`.
- `set(label, patch)` validates: known label; patch is an object; `min`/`max`
  finite numbers; `visible` boolean; `min < max`; window inside the label's
  `min..max`. Returns `{ ok, config }` or `{ ok: false, error }`.
- `reset(label)` restores the `labels.json` default.
- Config is in memory only. A restart resets it (no persistence, by decision).
- Config **never** touches values. No code path from config into `ParamState`.

## 7. HTTP API (127.0.0.1:8090)

| Method | Path | Response |
|---|---|---|
| GET | `/api/state` | `snapshot()` |
| GET | `/api/config` | `{ params: list(), display: forDisplay(), labels: labelsDoc }` |
| POST | `/api/config` | body `{ label, patch }` (or flat) → `{ ok, label, config }`, 400 on error |
| POST | `/api/config/reset` | body `{ label }` → `{ ok }`, 400 on error |
| GET | `/api/health` | `{ ok, uptimeMs, words, parityErrors, unknownLabels, resyncs, staleTags, sseClients, configClients }` |
| GET | `/events`, `/api/events` | SSE: `state` at 50 Hz + initial `config` |
| GET | `/config-events` | SSE: `config` on every change + initial |
| GET | `/`, `/config`, `/sfd`, static | files from `frontend/`, path-traversal guarded |

- SSE event payloads: `state` = `snapshot()`; `config` = `{ config: forDisplay(), at }`.
  `forDisplay()` is keyed by **tag**: `{ PITCH: { label, min, max, visible, unit }, ... }`.
- Every SSE stream sends an initial snapshot on connect, so a page renders before
  the first change.
- CORS `*`, methods `GET,POST,OPTIONS`. Request body limit 1 MB.
- Bind to `127.0.0.1` only. Never `0.0.0.0`.
- These shapes are the contract with the frontend. Changing a field name or shape
  is a cross-layer change: go through the integrator.

## 8. Ingest modes

- **Live**: TCP server on `a429Port`; chunks feed `ingestChunk` with a carried tail.
- **Replay** (`replayPath`): reads the capture, feeds 6 words every 20 ms (50 Hz),
  loops at the end. **No TCP port is opened.** A test asserts this.
- `shared/capture.a429` is a real QEMU recording: 1,786 words, zero rejected,
  about 49.6 Hz. Do not regenerate it without the integrator.

## 9. Tests you own

| File | Count | Covers |
|---|---|---|
| `test/a429.test.mjs` | 16 | codec vs golden vectors, parity, bit reversal, SSM sign, clamping, label table |
| `test/state.test.mjs` | 16 | ingest, watchdog, resync, snapshot, display config validation |

`test/e2e.test.mjs` (6) belongs to the integrator but exercises your server; run it.

- Runner: `node:test` + `node:assert/strict`. No other test library.
- New behaviour gets a test in the same commit. A bug fix gets a test that failed
  before the fix.

## 10. Verification for backend changes

`npm run test:a429`, `npm run test:state`, `npm run test:e2e`, then `npm test`
(all pass; the count only goes up). Chain stages: `node tools/chain.mjs --stage M4`
and `--stage M6`. For HTTP changes also run
`node tools/run-all.mjs --replay` and check `/api/health`.
