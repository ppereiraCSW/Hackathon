# Rules: frontend (`frontend/`)

## 1. Scope

Two pages, served by the backend from `frontend/` (decision R10):

| URL | File | Purpose |
|---|---|---|
| `/sfd` | `sfd.html`, `js/sfd.js`, `css/sfd.css` | Secondary Flight Display |
| `/config`, `/` | `config.html`, `js/config.js` | One slider set per parameter |
| shared | `js/format.js` | One number format per parameter, used by both pages |
| shared | `js/alerts.js` | Aural alerts (Web Audio + speech), driven by `sfd.js` |
| shared | `css/app.css` | Colour tokens, base styles |

The display **never computes a flight quantity**. Every number shown is either a
value the backend decoded or the user's display configuration. No prediction,
integration or unit conversion in the browser.

One exception, for motion only (commit `eb91704`): instruments are **eased**
toward the latest decoded value (`SMOOTH_TAU_MS` = 60, heading eased the short
way round 360/0). Rules for it:

- Graphics and readouts use the **same** eased value, so a tape never trails its
  own number (commit `6f1ebd3`; the readouts are rolling drums). The eased value
  reaches the decoded one within about 0.3 s and snaps to it exactly.
- Every judgement (LIMIT caution, callouts, annunciations) uses the **decoded**
  value, never the eased one: easing runs on animation frames, which the browser
  pauses in a background tab.
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

One rule set for every instrument, in `view()` in `sfd.js`:

| Condition | Display |
|---|---|
| fresh and valid and visible | value drawn |
| not valid (stale, NCD, INOP) | graphic blanked; `.failed` shows a red flag naming the instrument (`ATT`, `SPD`, `ALT`, `V/S`, `HDG`) with the reason `STALE` / `NCD` / `INOP` under it |
| `visible === false` | graphic blanked, `.hidden-param` dims the instrument |
| beyond the display limits | graphic pinned at the limit, scale hatched beyond it, readout amber (`.over`) |
| no fresh label at all | annunciator `A429 LOSS` (+ warning tone) |
| some stale | annunciator `<TAG> STALE` (underscore → space) |
| fresh but invalid | annunciator `<TAG> <ssm>` |
| beyond the display limits | annunciator `<TAG> LIMIT` |
| callouts | `TERRAIN` (airborne < 1000 ft, not climbing; never on the ground), `BANK ANGLE` (> 35°), `SINK RATE` (< −3000 ft/min) |

- Never show a number for an invalid or stale parameter. `—` is the empty value.
- The ADI is one picture: if pitch **or** roll is invalid, the horizon is removed
  and the `ATT` flag shown. It never draws a level horizon for missing data.
- Every aural alert has its text in the annunciator, so sound and display agree.
  Audio arms on the first click or key on the page; the SFD has no sound control.
- Status bar shows bus badge, `words`, `parity`, `labels fresh/total` (computed
  from the snapshot, never hard-coded).

## 5. Display config (decision R7)

- `min`/`max` are the **limits of the instrument's scale**: the scale ends there,
  and each instrument shows a fixed window of it (CAS 80 kt, ALT 1600 ft,
  heading 60°), so a slider never squeezes a whole range into a tape. `visible`
  hides the instrument.
- Sliders range over the label's `hardRange`. The backend rejects `min >= max` and
  windows outside the hard range; show its `error` text, do not pre-empt it silently.
- The config page **never** sends a value. Only `min`, `max`, `visible`.

## 6. SFD layout facts

Laid out as an airliner standby instrument (Airbus ISIS / Boeing ISFD):

- One SVG, `viewBox 0 0 1000 720`, centre (500, 340), under a status bar; full
  viewport, no page scroll.
- Horizon across the whole display; `pxPerDeg` 7, ladder every 2.5° clipped to a
  circle, labels every 10°, negative pitch dashed; roll scale ±60° with a sky
  pointer, both built from the PITCH / ROLL display limits.
- CAS tape left, ALT tape right, rolling-drum readouts (CAS last digit, ALT last
  two digits in 20 ft steps).
- V/S: Boeing-style needle on a non-linear scale (1, 2, 6 thousand ft/min). Not on
  a real ISIS; kept because label 212 is required.
- Heading: **linear** scale along the bottom, 60° window. Not a compass arc: that
  belongs on a PFD or ND, not a standby display.

## 7. Style

- Colour tokens in `css/app.css` `:root`: `--bg #0b0f14`, `--panel #111820`,
  `--ink #d7e3ef`, `--dim #7d8fa1`, `--ok #3ddc84`, `--warn #ffc857`,
  `--bad #ff5c5c`, `--a429 #4fc3f7`, `--accent #7ee0ff`. Use tokens, not new hex.
- Fonts: `--sans` Segoe UI stack, `--mono` Cascadia Mono / Consolas stack. The
  SFD prefers B612 (Airbus's cockpit face) **only if installed locally**; never
  load it from a CDN.
- Aircraft symbol yellow `#ffcc00`. Parameter captions yellow `#ffff3a` with their
  units, kept apart from caution amber `#ffb000`. Failure flags red `#ff4d4d`.
  Sky and ground gradients live in the SVG.
- Keep ARIA labels on every instrument section (`role="application"` on the SFD).
- 2-space indent in `frontend/` JS and CSS (the backend uses 4).

## 8. Verification for frontend changes

There are no browser unit tests. You must:

1. `npm test` 64/64 (the e2e suite checks both pages and their assets are served;
   `test/boundaries.test.mjs` checks every label's edges, incl. `format.js`).
2. `node tools/run-all.mjs --replay`, open `/sfd` and `/config`, and confirm the
   change on screen. Move a slider; the SFD must follow.
3. Check validity flags (§4):
   - `node backend/serve.mjs` alone (nothing feeds port 5555): every instrument
     `STALE`, annunciator `A429 LOSS`.
   - Full stack with the pad, press START: every instrument `NCD`.
4. No errors in the browser console.

If you cannot open a browser, say so. Do not claim a visual check you did not do.
