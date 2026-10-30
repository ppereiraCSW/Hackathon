# Rules: frontend (`frontend/`)

## 1. Scope

Two pages, served by the backend from `frontend/` (decision R10):

| URL | File | Purpose |
|---|---|---|
| `/sfd` | `sfd.html`, `js/sfd.js`, `css/sfd.css` | Secondary Flight Display |
| `/config`, `/` | `config.html`, `js/config.js` | One slider set per parameter |
| shared | `css/app.css` | Colour tokens, base styles |

The display **never computes a flight quantity**. Every number shown is either a
value the backend decoded or the user's display configuration. No prediction,
integration or unit conversion in the browser.

One exception, for motion only (commit `eb91704`): the horizon, tapes and heading
arc are **eased** toward the latest decoded value (`SMOOTH_TAU_MS` = 60, heading
eased the short way round 360/0). Rules for it:

- Numeric readouts always show the exact decoded value, never the eased one.
- An invalid or stale parameter drops its eased value at once (`shown.delete`);
  easing must never carry a last-good value across a loss of validity.
- Easing stays a drawing detail in `sfd.js`. It is not a filter on data.

## 2. Stack

- Plain HTML, CSS, ES modules (`<script type="module">`). Canvas 2D and inline SVG.
- **No frameworks, no build step, no npm packages, no CDN.** Everything loads from
  the backend at `127.0.0.1:8090`.
- Absolute asset paths (`/css/app.css`, `/js/sfd.js`). The backend maps
  `/config` and `/sfd` to their `.html` files.
- The backend serves only `.html .js .css .json .svg` with a correct MIME type.
  A new asset type needs a backend change (integrator).

## 3. Data in (the contract with the backend)

| Stream | Event | Payload |
|---|---|---|
| `EventSource('/events')` | `state` (50 Hz) | `{ t, params: [...], stats: {...} }` |
| same | `config` (on connect) | `{ config, at }` |
| `EventSource('/config-events')` | `config` (on change + connect) | `{ config, at }` |

Each `params[]` entry: `{ label, tag, unit, value, valid, stale, ageMs, ssm, sdi,
range: { min, max } }`. `value` is `null` unless fresh and valid.
`ssm` is `PLUS | MINUS | NCD | TEST | NONE`.

`config` is keyed by **tag**: `{ PITCH: { label, min, max, visible, unit }, ... }`.

`stats`: `{ words, parityErrors, unknownLabels, resyncs, startedAt, uptimeMs }`.

REST used by the config page:
- `GET /api/config` → `{ params: [{ label, tag, unit, hardRange: { min, max },
  config: { min, max, visible } }], display, labels }`
- `POST /api/config` body `{ label, patch: { min?, max?, visible? } }`
- `POST /api/config/reset` body `{ label }`

Tags: `PITCH`, `ROLL`, `HEADING`, `BARO_ALT`, `CAS`, `VERT_SPEED`. Labels are
3-digit octal strings. Key by tag in the SFD, by label in the config page (as now).

Need a field the backend does not send? Ask the integrator. Do not compute it.

## 4. Validity display (must hold on every instrument)

| Condition | Display |
|---|---|
| fresh and valid and visible | value drawn |
| `stale` | flag `STALE`, `.stale` class (red) |
| fresh, `ssm === 'NCD'` | flag `NCD` |
| otherwise not valid | flag `INOP` |
| `visible === false` | `.hidden-param` class |
| no fresh label at all | annunciator `A429 LOSS` |
| some stale | annunciator `<TAG> STALE` (underscore → space) |
| fresh but invalid | annunciator `<TAG> <ssm>` |
| none of the above | annunciator `NONE` |

- Never show a number for an invalid or stale parameter. `—` is the empty value.
- The ADI draws level (0°) when pitch or roll is invalid; the readout shows `—`.
- Status panel shows bus badge, `words`, `parity`, `labels fresh/total` (computed
  from the snapshot, never hard-coded).

## 5. Display config (decision R7)

- `min`/`max` set the window mapped onto the instrument (`norm()` in `sfd.js`
  clamps to 0..1). `visible` hides the instrument.
- Sliders range over the label's `hardRange`. The backend rejects `min >= max` and
  windows outside the hard range; show its `error` text, do not pre-empt it silently.
- The config page **never** sends a value. Only `min`, `max`, `visible`.

## 6. SFD layout facts

- Grid: areas `"adi hdg hdg" / "adi tapes status"`, full viewport, no page scroll.
- ADI: SVG `viewBox 0 0 320 320`, clip radius 150, `pxPerDeg` 6.2, ladder every
  2.5°, labels every 10°, negative pitch dashed.
- Tapes: CAS, V/S, BARO ALT on canvases sized from `clientWidth/Height × devicePixelRatio`.
- Heading: canvas arc, 60° visible span.

## 7. Style

- Colour tokens in `css/app.css` `:root`: `--bg #0b0f14`, `--panel #111820`,
  `--ink #d7e3ef`, `--dim #7d8fa1`, `--ok #3ddc84`, `--warn #ffc857`,
  `--bad #ff5c5c`, `--a429 #4fc3f7`, `--accent #7ee0ff`. Use tokens, not new hex.
- Fonts: `--sans` Segoe UI stack, `--mono` Cascadia Mono / Consolas stack.
- Aircraft symbol yellow `#ffcc00`. Sky and ground gradients live in the ADI SVG.
- Keep ARIA labels on every instrument section (`role="application"` on the SFD).
- 2-space indent in `frontend/` JS and CSS (the backend uses 4).

## 8. Verification for frontend changes

There are no browser unit tests. You must:

1. `npm test` 38/38 (the e2e suite checks both pages and their assets are served).
2. `node tools/run-all.mjs --replay`, open `/sfd` and `/config`, and confirm the
   change on screen. Move a slider; the SFD must follow.
3. Check validity flags (§4):
   - `node backend/serve.mjs` alone (nothing feeds port 5555): every instrument
     `STALE`, annunciator `A429 LOSS`.
   - Full stack with the pad, press START: every instrument `NCD`.
4. No errors in the browser console.

If you cannot open a browser, say so. Do not claim a visual check you did not do.
