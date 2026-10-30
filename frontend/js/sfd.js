/**
 * Secondary Flight Display, drawn as an airliner standby instrument
 * (Airbus ISIS / Boeing ISFD): horizon across the whole display, speed tape
 * left, altitude tape right, linear heading scale along the bottom, rolling
 * drum readouts. V/S (label 212) is not on a real ISIS; it is required here,
 * so it is a Boeing-style needle scale at the right edge.
 *
 * Consumes two SSE streams from the backend:
 *   /events          engineering values + validity (50 Hz)
 *   /config-events   display configuration from the sliders (on change)
 *
 * The display never computes a flight quantity: every number shown is either a
 * value the backend decoded from ARINC 429 or the user's display configuration.
 * Values are eased between updates so motion is smooth; graphics and readouts
 * use the same eased value, so a tape never trails its own number.
 *
 * Every instrument follows the same rules (see view()):
 *   - the display min/max are the LIMITS of the instrument's scale: the scale
 *     ends there (hatched beyond), and a value beyond them pins the graphic at
 *     the limit and turns the readout amber. Each instrument shows a fixed
 *     window of its scale, so the sliders never squeeze a range into the tape.
 *   - invalid (INOP / NCD / STALE): graphic blanked, red flag naming the
 *     instrument (ATT, SPD, ALT, V/S, HDG) with the reason under it.
 *   - hidden (slider page "show on SFD" off): graphic blanked, instrument dimmed.
 */

import { formatValue } from './format.js';
import { setEnabled, updateAlerts } from './alerts.js';

/** Callout thresholds, on the decoded values. */
const BANK_ANGLE_DEG = 35;
const SINK_RATE_FPM = -3000;
/** Below this, not climbing, is too close to the ground (sea level, firmware ALT_GROUND_FT). */
const TERRAIN_ALT_FT = 1000;

const $ = (id) => document.getElementById(id);

/** Latest state snapshot, keyed by tag. */
const params = new Map();
/** Latest display config, keyed by tag. */
const display = new Map();
/** Value currently shown per tag, eased toward params each frame. */
const shown = new Map();
/** Easing time constant: short enough to feel direct, long enough to hide steps. */
const SMOOTH_TAU_MS = 60;

/** Instrument centre in the SVG's 1000 x 720 frame. */
const CX = 500;
const CY = 340;

/** Eased value; falls back to the decoded value. */
function eased(tag) {
  const p = params.get(tag);
  if (!p) return null;
  return shown.has(tag) ? shown.get(tag) : p.value;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The one rule set every instrument draws from.
 * `g` is the value to draw (pinned to the limits), or null to blank the graphic;
 * `v` is the eased value itself, for readouts.
 */
function view(tag) {
  const p = params.get(tag);
  const c = display.get(tag);
  const valid = !!(p && p.valid);
  const visible = !!(c && c.visible);
  const v = valid ? eased(tag) : null;
  const show = valid && visible && !!c;
  return {
    c,
    valid,
    visible,
    show,
    stale: !!(p && p.stale),
    v: show ? v : null,
    g: show ? clamp(v, c.min, c.max) : null,
    // Judged on the decoded value, not the eased one: easing runs on animation
    // frames, which the browser pauses in a background tab, and the LIMIT
    // caution must not depend on the page being drawn.
    over: show && (p.value < c.min || p.value > c.max),
    text: show ? formatValue(tag, v) : '—',
    flag: p && p.stale ? 'STALE' : p && p.ssm === 'NCD' ? 'NCD' : 'INOP',
  };
}

/** Apply failed / hidden to an instrument group and set its flag's reason. */
function applyState(el, why, v) {
  el.classList.toggle('failed', !v.valid);
  el.classList.toggle('hidden-param', !v.visible);
  $(why).textContent = v.flag;
}

const svgText = (x, y, s, extra = '') => `<text x="${x}" y="${y}"${extra}>${s}</text>`;
const svgLine = (x1, y1, x2, y2, extra = '') =>
  `<line x1="${x1}" y1="${y1.toFixed(1)}" x2="${x2}" y2="${y2.toFixed(1)}"${extra}/>`;

/* ---------------------------------------------------------------- attitude */

const ADI = {
  pxPerDeg: 7,
  ladderKey: '',
  rollKey: '',
  /** Pitch ladder, drawn only between the PITCH display limits. */
  buildLadder(c) {
    const key = `${c.min}:${c.max}`;
    if (key === ADI.ladderKey) return;
    ADI.ladderKey = key;
    let s = '';
    for (let deg = -90; deg <= 90; deg += 2.5) {
      if (deg === 0 || deg < c.min || deg > c.max) continue;
      const major = Math.abs(deg) % 10 < 0.01;
      const half = major ? 60 : Math.abs(deg) % 5 < 0.01 ? 30 : 15;
      const y = CY - deg * ADI.pxPerDeg;
      s += svgLine(CX - half, y, CX + half, y, deg < 0 ? ' stroke-dasharray="6 4"' : '');
      if (major) {
        s += svgText(CX - half - 8, y + 5, Math.abs(deg), ' text-anchor="end"');
        s += svgText(CX + half + 8, y + 5, Math.abs(deg));
      }
    }
    $('ladder').innerHTML = s;
  },
  /** Bezel roll scale (arc and ticks), only between the ROLL display limits. */
  buildRollScale(c) {
    const key = `${c.min}:${c.max}`;
    if (key === ADI.rollKey) return;
    ADI.rollKey = key;
    const R = 190;
    // A right bank (positive roll) moves the sky pointer left, so roll `deg`
    // sits at screen angle -deg from the top.
    const at = (deg, r) => {
      const a = (-deg * Math.PI) / 180;
      return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
    };
    const hi = Math.min(60, c.max);
    const lo = Math.max(-60, c.min);
    let s = '';
    if (hi > lo) {
      const [x1, y1] = at(hi, R);
      const [x2, y2] = at(lo, R);
      s += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
    }
    for (const deg of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      if (deg < c.min || deg > c.max) continue;
      const long = deg % 30 === 0;
      const [x1, y1] = at(deg, R);
      const [x2, y2] = at(deg, R + (long ? 18 : 10));
      s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
    }
    $('roll-scale').innerHTML = s;
  },
  render() {
    const vp = view('PITCH');
    const vr = view('ROLL');
    if (vp.c) ADI.buildLadder(vp.c);
    if (vr.c) ADI.buildRollScale(vr.c);

    // Attitude is one picture: if either axis is invalid, none of it is drawn.
    const att = $('att');
    const ok = vp.valid && vr.valid;
    att.classList.toggle('failed', !ok);
    att.classList.toggle('hidden-param', !vp.visible && !vr.visible);
    $('f-att-why').textContent = (!vp.valid ? vp : vr).flag;
    $('att-picture').style.display = ok ? '' : 'none';

    const pitch = vp.g ?? 0;
    const roll = vr.g ?? 0;
    $('ladder').style.display = vp.g === null ? 'none' : '';
    $('roll-scale').style.display = vr.g === null ? 'none' : '';
    $('sky-pointer').style.display = vr.g === null ? 'none' : '';
    const rot = `rotate(${(-roll).toFixed(2)} ${CX} ${CY})`;
    const shift = `translate(0 ${(pitch * ADI.pxPerDeg).toFixed(2)})`;
    $('adi-roll').setAttribute('transform', rot);
    $('adi-world').setAttribute('transform', shift);
    $('ladder-roll').setAttribute('transform', rot);
    $('ladder').setAttribute('transform', shift);
    $('sky-pointer').setAttribute('transform', rot);

    // Corner readouts, in words a pilot reads: UP / DN, L / R.
    const word = (v, pos, neg) => {
      if (v.v === null) return '—';
      const dir = v.v >= 0.05 ? pos : v.v <= -0.05 ? neg : '';
      return `${dir}${formatValue(v === vp ? 'PITCH' : 'ROLL', Math.abs(v.v))}°`;
    };
    for (const [id, box, v, pos, neg] of [['r-pitch', 'ro-pitch', vp, 'UP ', 'DN '], ['r-roll', 'ro-roll', vr, 'R ', 'L ']]) {
      $(id).textContent = word(v, pos, neg);
      $(id).classList.toggle('over', v.over);
      $(box).classList.toggle('hidden-param', !v.visible);
    }
  },
};

/* ------------------------------------------------------------------- tapes */

/** Fixed visible window per tape, in engineering units, and its tick spacing. */
const TAPES = {
  CAS: {
    el: 'ins-cas', ticks: 'cas-ticks', box: 'cas-box', why: 'f-cas-why',
    top: 120, h: 440, side: 'left', edge: 180, window: 80, majorStep: 20, minorStep: 10,
  },
  BARO_ALT: {
    el: 'ins-alt', ticks: 'alt-ticks', box: 'alt-box', why: 'f-alt-why',
    top: 120, h: 440, side: 'right', edge: 790, window: 1600, majorStep: 200, minorStep: 100,
  },
};

/**
 * Draw a vertical tape centred on `value`; ticks stop at the display limits
 * and the scale beyond a limit is hatched. A null value leaves it blank.
 */
function drawTape(t, value, c) {
  const g = $(t.ticks);
  if (value === null || !c) {
    g.innerHTML = '';
    return;
  }
  const k = t.h / t.window;
  const y = (v) => CY - (v - value) * k;
  const top = value + t.window / 2;
  const bot = value - t.window / 2;
  const left = t.side === 'left';
  const x0 = left ? t.edge - 110 : t.edge;
  const w = left ? 110 : 120;
  let s = '';

  // Beyond a display limit the scale ends: hatched, with an amber limit line.
  if (c.max < top) s += `<rect x="${x0}" y="${t.top}" width="${w}" height="${(y(c.max) - t.top).toFixed(1)}" fill="url(#hatch)"/>`;
  if (c.min > bot) s += `<rect x="${x0}" y="${y(c.min).toFixed(1)}" width="${w}" height="${(t.top + t.h - y(c.min)).toFixed(1)}" fill="url(#hatch)"/>`;

  const lo = Math.max(c.min, bot);
  const hi = Math.min(c.max, top);
  for (let v = Math.ceil(lo / t.minorStep) * t.minorStep; v <= hi; v += t.minorStep) {
    const yy = y(v);
    const major = Math.abs(v / t.majorStep - Math.round(v / t.majorStep)) < 1e-6;
    const len = major ? 18 : 10;
    s += left ? svgLine(t.edge - len, yy, t.edge, yy) : svgLine(t.edge, yy, t.edge + len, yy);
    if (major) {
      s += left
        ? svgText(t.edge - len - 6, yy.toFixed(1), Math.round(v), ' text-anchor="end"')
        : svgText(t.edge + len + 6, yy.toFixed(1), Math.round(v));
    }
  }
  for (const lim of [c.min, c.max]) {
    if (lim >= bot && lim <= top) s += svgLine(x0, y(lim), x0 + w, y(lim), ' class="limit"');
  }
  g.innerHTML = s;
}

/**
 * Rolling drum: the low digits scroll continuously like an odometer.
 * `step` is the drum increment (1 kt, 20 ft), `cells` how many steps make one
 * turn (10 digits, 5 x 20 ft), `pitch` the row height in SVG units.
 */
function drum(id, value, { step, cells, pad, x, baseline, pitch }) {
  const g = $(id);
  if (value === null) {
    g.innerHTML = '';
    return;
  }
  const pos = (Math.abs(value) % (step * cells)) / step;
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  let s = '';
  for (let i = -1; i <= 2; i++) {
    const n = (((i0 + i) % cells) + cells) % cells;
    s += svgText(x, (baseline - (i - frac) * pitch).toFixed(1), String(n * step).padStart(pad, '0'));
  }
  g.innerHTML = s;
}

function renderTape(tag) {
  const t = TAPES[tag];
  const v = view(tag);
  applyState($(t.el), t.why, v);
  drawTape(t, v.g, v.c);
  $(t.box).classList.toggle('over', v.over);
  if (tag === 'CAS') {
    const lead = v.v === null ? null : Math.floor(Math.max(0, v.v) / 10);
    $('cas-lead').textContent = lead === null ? '—' : lead === 0 ? '' : String(lead);
    drum('cas-drum', v.v === null ? null : Math.max(0, v.v), { step: 1, cells: 10, pad: 1, x: 155, baseline: 352, pitch: 32 });
  } else {
    const lead = v.v === null ? null : Math.floor(Math.abs(v.v) / 100);
    $('alt-lead').textContent = lead === null ? '—' : `${v.v < 0 ? '-' : ''}${lead}`;
    drum('alt-drum', v.v, { step: 20, cells: 5, pad: 2, x: 883, baseline: 351, pitch: 26 });
  }
}

/* ---------------------------------------------------------- vertical speed */

/** Boeing-style non-linear V/S scale: |fpm| -> offset from centre. */
const VS_SCALE = [[0, 0], [500, 50], [1000, 90], [2000, 130], [6000, 160]];
function vsOffset(fpm) {
  const a = Math.min(Math.abs(fpm), 6000);
  for (let i = 1; i < VS_SCALE.length; i++) {
    const [v0, y0] = VS_SCALE[i - 1];
    const [v1, y1] = VS_SCALE[i];
    if (a <= v1) return Math.sign(fpm) * (y0 + ((a - v0) / (v1 - v0)) * (y1 - y0));
  }
  return Math.sign(fpm) * 160;
}

let vsKey = '';
function renderVs() {
  const v = view('VERT_SPEED');
  applyState($('ins-vs'), 'f-vs-why', v);
  if (v.c && `${v.c.min}:${v.c.max}` !== vsKey) {
    vsKey = `${v.c.min}:${v.c.max}`;
    let s = svgLine(924, CY, 946, CY);
    for (const [fpm, label] of [[500, ''], [1000, '1'], [2000, '2'], [6000, '6']]) {
      for (const sgn of [1, -1]) {
        if (sgn * fpm < v.c.min || sgn * fpm > v.c.max) continue;
        const yy = CY - vsOffset(sgn * fpm);
        s += svgLine(924, yy, label ? 938 : 932, yy);
        if (label) s += svgText(944, (yy + 4).toFixed(1), label, ' stroke="none" fill="#c9d6e2" font-size="12"');
      }
    }
    $('vs-scale').innerHTML = s;
  }
  const needle = $('vs-needle');
  const val = $('vs-value');
  if (v.g === null) {
    needle.innerHTML = '';
    val.textContent = '';
    return;
  }
  const yy = CY - vsOffset(v.g);
  const col = v.over ? '#ffb000' : '#ffffff';
  needle.innerHTML =
    `<line x1="985" y1="${CY}" x2="926" y2="${yy.toFixed(1)}" stroke="#000" stroke-width="6" stroke-linecap="round"/>` +
    `<line x1="985" y1="${CY}" x2="926" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="3" stroke-linecap="round"/>`;
  // As on a Boeing PFD: the number appears beyond 400 ft/min, at the end the
  // needle is moving toward.
  const big = Math.abs(v.v) >= 400;
  val.textContent = big ? `${v.v > 0 ? '+' : ''}${v.text}` : '';
  val.setAttribute('y', v.v > 0 ? '160' : '528');
  val.classList.toggle('over', v.over);
}

/* ---------------------------------------------------------------- heading */

/** Linear heading scale (as on ISIS and Airbus PFDs): fixed 60 deg window. */
function drawHeading(heading, c) {
  const g = $('hdg-ticks');
  if (heading === null || !c) {
    g.innerHTML = '';
    return;
  }
  const k = 460 / 60;
  let s = '';
  for (let d = -35; d <= 35; d += 5) {
    const hdg = (Math.round(heading / 5) * 5 + d + 360) % 360;
    // 000 is also 360, so a 0..360 range keeps every tick.
    if (!((hdg >= c.min && hdg <= c.max) || (hdg === 0 && c.max >= 360))) continue;
    const x = CX + (((hdg - heading + 540) % 360) - 180) * k;
    const major = hdg % 10 === 0;
    s += svgLine(x.toFixed(1), 610, x.toFixed(1), major ? 624 : 618);
    if (major) {
      const lbl = hdg === 0 ? 'N' : hdg === 90 ? 'E' : hdg === 180 ? 'S' : hdg === 270 ? 'W' : String(hdg / 10);
      s += svgText(x.toFixed(1), 642, lbl, ` text-anchor="middle"${hdg % 90 === 0 ? ' fill="#ffcc00"' : ''}`);
    }
  }
  g.innerHTML = s;
}

function renderHeading() {
  const v = view('HEADING');
  applyState($('ins-hdg'), 'f-hdg-why', v);
  drawHeading(v.g, v.c);
  $('hdg-value').textContent = v.text;
  $('hdg-value').parentElement.classList.toggle('over', v.over);
}

/* ------------------------------------------------------------------- render */

function renderAll() {
  ADI.render();
  renderTape('CAS');
  renderTape('BARO_ALT');
  renderVs();
  renderHeading();
}

/* ------------------------------------------------------------------- status */

function renderStatus() {
  const list = [...params.values()];
  const fresh = list.filter((p) => !p.stale);
  const valid = list.filter((p) => p.valid);

  const bus = $('s-bus');
  if (fresh.length === 0) {
    bus.textContent = 'A429 NO DATA';
    bus.className = 'badge stale';
  } else if (valid.length === list.length) {
    bus.textContent = 'A429 VALID';
    bus.className = 'badge ok';
  } else {
    bus.textContent = 'A429 DEGRADED';
    bus.className = 'badge inop';
  }

  $('s-labels').textContent = `${fresh.length}/${list.length}`;
  $('s-words').textContent = (window.__words ?? 0).toLocaleString();
  $('s-parity').textContent = String(window.__parity ?? 0);

  // Every aural alert has its text here, so sound and display always agree.
  const warning = list.length > 0 && fresh.length === 0;
  const callouts = [];
  const roll = params.get('ROLL');
  const vs = params.get('VERT_SPEED');
  const alt = params.get('BARO_ALT');
  // TERRAIN first: it has the highest priority of the callouts. Inhibited on
  // the ground (0 ft), as real terrain warnings are, or a parked aircraft
  // would call TERRAIN forever.
  const airborne = alt?.valid && alt.value > 0;
  if (airborne && vs?.valid && alt.value < TERRAIN_ALT_FT && vs.value <= 0) callouts.push('TERRAIN');
  if (roll?.valid && Math.abs(roll.value) > BANK_ANGLE_DEG) callouts.push('BANK ANGLE');
  if (vs?.valid && vs.value < SINK_RATE_FPM) callouts.push('SINK RATE');

  const cautions = [];
  if (!warning) {
    for (const p of list) {
      const name = p.tag.replace(/_/g, ' ');
      if (p.stale) cautions.push(`${name} STALE`);
      else if (!p.valid) cautions.push(`${name} ${p.ssm || 'INOP'}`);
      else if (view(p.tag).over) cautions.push(`${name} LIMIT`);
    }
  }

  const annuns = [...(warning ? ['A429 LOSS'] : []), ...callouts, ...cautions];
  $('a-list').textContent = annuns.length ? annuns.join(' · ') : '';
  updateAlerts({ warning, callouts, cautions });
}

/* ------------------------------------------------------------------ easing */

let lastFrame = 0;

/** Ease every shown value toward its latest decoded value, once per frame. */
function frame(now) {
  const dt = lastFrame ? Math.min(now - lastFrame, 200) : 0;
  lastFrame = now;
  const k = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
  let moving = false;
  for (const [tag, p] of params) {
    if (!p.valid || typeof p.value !== 'number') {
      shown.delete(tag);
      continue;
    }
    const cur = shown.has(tag) ? shown.get(tag) : p.value;
    // Heading wraps: ease the short way round 360/0.
    let delta = p.value - cur;
    if (tag === 'HEADING') delta = ((delta % 360) + 540) % 360 - 180;
    let next = Math.abs(delta) < 1e-3 ? p.value : cur + delta * k;
    if (tag === 'HEADING') next = (next + 360) % 360;
    if (next !== cur) moving = true;
    shown.set(tag, next);
  }
  if (moving) renderAll();
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------- wire */

async function init() {
  const res = await fetch('/api/config');
  const body = await res.json();
  for (const [tag, c] of Object.entries(body.display)) display.set(tag, c);

  const es = new EventSource('/events');
  es.addEventListener('state', (ev) => {
    const snap = JSON.parse(ev.data);
    params.clear();
    for (const p of snap.params) params.set(p.tag, p);
    window.__parity = snap.stats.parityErrors;
    window.__words = snap.stats.words;
    renderAll();
    renderStatus();
  });

  const cfg = new EventSource('/config-events');
  cfg.addEventListener('config', (ev) => {
    const { config } = JSON.parse(ev.data);
    display.clear();
    for (const [tag, c] of Object.entries(config)) display.set(tag, c);
    renderAll();
  });

  // Audio may only start from a user gesture, so the first click or key
  // anywhere on the page arms the aural alerts. The SFD has no sound control.
  const arm = () => {
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    setEnabled(true);
  };
  addEventListener('pointerdown', arm);
  addEventListener('keydown', arm);

  renderAll();
  requestAnimationFrame(frame);
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${e}</pre>`);
});
