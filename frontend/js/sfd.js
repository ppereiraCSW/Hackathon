/**
 * Secondary Flight Display.
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
 *     ends there, and a value beyond them pins the graphic at the limit and
 *     turns the readout amber. Each instrument shows a fixed window of its
 *     scale, so the sliders never squeeze a range into the tape.
 *   - invalid (INOP / NCD / STALE): graphic blanked, readout '—', flag shown.
 *   - hidden (slider page "show on SFD" off): graphic blanked, readout '—',
 *     instrument dimmed.
 */

import { formatValue } from './format.js';
import { setEnabled, isEnabled, updateAlerts } from './alerts.js';

/** Callout thresholds, on the decoded values. */
const BANK_ANGLE_DEG = 35;
const SINK_RATE_FPM = -3000;

const $ = (id) => document.getElementById(id);

/** Latest state snapshot, keyed by tag. */
const params = new Map();
/** Latest display config, keyed by tag. */
const display = new Map();
/** Value currently shown per tag, eased toward params each frame. */
const shown = new Map();
/** Easing time constant: short enough to feel direct, long enough to hide steps. */
const SMOOTH_TAU_MS = 60;

/** Eased value; falls back to the decoded value. */
function eased(tag) {
  const p = params.get(tag);
  if (!p) return null;
  return shown.has(tag) ? shown.get(tag) : p.value;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The one rule set every instrument draws from.
 * `g` is the value to draw (pinned to the limits), or null to blank the graphic.
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
    stale: !!(p && p.stale),
    g: show ? clamp(v, c.min, c.max) : null,
    over: show && (v < c.min || v > c.max),
    text: show ? formatValue(tag, v) : '—',
    flag: p && p.stale ? 'STALE' : p && p.ssm === 'NCD' ? 'NCD' : 'INOP',
  };
}

/** Apply failed / stale / hidden to an instrument element and its flag. */
function applyState(el, flag, v) {
  el.classList.toggle('failed', !v.valid);
  el.classList.toggle('stale', v.stale);
  el.classList.toggle('hidden-param', !v.visible);
  flag.textContent = v.flag;
}

/* ---------------------------------------------------------------- ADI (SVG) */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ADI = {
  pxPerDeg: 6.2,
  ladderKey: '',
  rollKey: '',
  /** Pitch ladder, drawn only between the PITCH display limits. */
  buildLadder(c) {
    const key = `${c.min}:${c.max}`;
    if (key === ADI.ladderKey) return;
    ADI.ladderKey = key;
    const g = $('ladder');
    g.replaceChildren();
    for (let deg = -90; deg <= 90; deg += 2.5) {
      if (deg === 0 || deg < c.min || deg > c.max) continue;
      const major = Math.abs(deg) % 10 < 0.01;
      const w = major ? 130 : 62;
      const y = 160 - deg * ADI.pxPerDeg;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(160 - w / 2));
      line.setAttribute('x2', String(160 + w / 2));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      if (deg < 0) line.setAttribute('stroke-dasharray', '6 4');
      g.append(line);
      if (major) {
        // Just outside the line ends, well inside the bezel clip; no stroke,
        // or the ladder's line stroke smears the digits.
        for (const [x, anchor] of [['89', 'end'], ['231', 'start']]) {
          const t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('stroke', 'none');
          t.setAttribute('x', x);
          t.setAttribute('y', String(y + 4));
          t.setAttribute('text-anchor', anchor);
          t.textContent = String(Math.abs(deg));
          g.append(t);
        }
      }
    }
  },
  /** Bezel roll scale, ticks only between the ROLL display limits. */
  buildRollScale(c) {
    const key = `${c.min}:${c.max}`;
    if (key === ADI.rollKey) return;
    ADI.rollKey = key;
    const g = $('roll-scale');
    g.replaceChildren();
    for (const deg of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      if (deg < c.min || deg > c.max) continue;
      const long = deg % 30 === 0;
      // A right bank (positive roll) moves the sky pointer left, so the tick
      // for roll `deg` sits at screen angle -deg from the top.
      const a = (-deg * Math.PI) / 180;
      const r0 = 150;
      const r1 = long ? 134 : 141;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', (160 + r0 * Math.sin(a)).toFixed(2));
      line.setAttribute('y1', (160 - r0 * Math.cos(a)).toFixed(2));
      line.setAttribute('x2', (160 + r1 * Math.sin(a)).toFixed(2));
      line.setAttribute('y2', (160 - r1 * Math.cos(a)).toFixed(2));
      g.append(line);
    }
  },
  render() {
    const vp = view('PITCH');
    const vr = view('ROLL');
    if (vp.c) ADI.buildLadder(vp.c);
    if (vr.c) ADI.buildRollScale(vr.c);

    // Attitude is one picture: if either axis is invalid, none of it is drawn.
    const panel = $('adi-panel');
    panel.classList.toggle('failed', !vp.valid || !vr.valid);
    panel.classList.toggle('stale', vp.stale || vr.stale);
    panel.classList.toggle('hidden-param', !vp.visible && !vr.visible);
    const bad = !vp.valid ? vp : vr;
    $('f-att').textContent = `ATT ${bad.flag}`;
    $('adi-att').style.display = vp.valid && vr.valid ? '' : 'none';

    const pitch = vp.g ?? 0;
    const roll = vr.g ?? 0;
    $('ladder').style.display = vp.g === null ? 'none' : '';
    $('roll-pointer').style.display = vr.g === null ? 'none' : '';
    $('roll-scale').style.display = vr.g === null ? 'none' : '';
    $('adi-roll').setAttribute('transform', `rotate(${(-roll).toFixed(2)} 160 160)`);
    $('adi-world').setAttribute('transform', `translate(0 ${(pitch * ADI.pxPerDeg).toFixed(2)})`);

    for (const [id, v] of [['r-pitch', vp], ['r-roll', vr]]) {
      const el = $(id);
      el.classList.toggle('hidden-param', !v.visible);
      const b = el.querySelector('b');
      b.textContent = v.text === '—' ? '—' : `${v.text}°`;
      b.classList.toggle('over', v.over);
    }
  },
};

/* --------------------------------------------------------------- tape draw */

/** Fixed visible window per tape, in engineering units, and its tick spacing. */
const TAPES = {
  CAS: { el: 'tape-cas', cv: 'cv-cas', val: 'v-cas', flag: 'f-cas', window: 80, majorStep: 10, minorStep: 5, side: 'left' },
  VERT_SPEED: { el: 'tape-vs', cv: 'cv-vs', val: 'v-vs', flag: 'f-vs', window: 4000, majorStep: 500, minorStep: 250, side: 'left' },
  BARO_ALT: { el: 'tape-alt', cv: 'cv-alt', val: 'v-alt', flag: 'f-alt', window: 2000, majorStep: 500, minorStep: 100, side: 'right' },
};

/**
 * Draw a linear tape centred on `value`; ticks stop at the display limits.
 * A null value leaves the tape blank.
 * @param {HTMLCanvasElement} cv
 */
function drawTape(cv, { value, c, window: span, majorStep, minorStep, side }) {
  const dpr = window.devicePixelRatio || 1;
  // The canvas is stretched by CSS (flex: 1), so its client box is the truth.
  const w = cv.clientWidth || 120;
  const h = cv.clientHeight || 380;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (value === null || !c) return;

  const centreY = h / 2;
  const pxPerUnit = h / span;
  const yOf = (v) => centreY - (v - value) * pxPerUnit;

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  const lo = Math.max(c.min, value - span / 2);
  const hi = Math.min(c.max, value + span / 2);
  for (let v = Math.ceil(lo / minorStep) * minorStep; v <= hi; v += minorStep) {
    const y = yOf(v);
    const isMajor = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
    ctx.strokeStyle = isMajor ? '#7d8fa1' : '#38495a';
    ctx.lineWidth = isMajor ? 1.2 : 1;
    ctx.beginPath();
    ctx.moveTo(side === 'left' ? w - (isMajor ? 22 : 12) : 0, y);
    ctx.lineTo(side === 'left' ? w : isMajor ? 22 : 12, y);
    ctx.stroke();

    if (isMajor) {
      ctx.fillStyle = '#9fb2c4';
      ctx.textAlign = side === 'left' ? 'left' : 'right';
      ctx.fillText(String(Math.round(v)), side === 'left' ? 2 : w - 2, y);
    }
  }

  // Display limits: the scale ends here.
  ctx.strokeStyle = '#f5b400';
  ctx.lineWidth = 2;
  for (const lim of [c.min, c.max]) {
    if (lim < value - span / 2 || lim > value + span / 2) continue;
    ctx.beginPath();
    ctx.moveTo(0, yOf(lim));
    ctx.lineTo(w, yOf(lim));
    ctx.stroke();
  }

  // Centre pointer.
  ctx.fillStyle = '#ffcc00';
  ctx.beginPath();
  if (side === 'left') {
    ctx.moveTo(w - 2, centreY);
    ctx.lineTo(w - 12, centreY - 6);
    ctx.lineTo(w - 12, centreY + 6);
  } else {
    ctx.moveTo(2, centreY);
    ctx.lineTo(12, centreY - 6);
    ctx.lineTo(12, centreY + 6);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#2b3a49';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centreY);
  ctx.lineTo(w, centreY);
  ctx.stroke();
}

/* -------------------------------------------------------------- heading arc */

/** Heading ribbon: fixed 60 deg window, ticks only between the display limits. */
function drawHeading(heading, c) {
  const cv = $('cv-hdg');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.width;
  const h = cv.clientHeight || cv.height;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (heading === null || !c) return;

  const spanDeg = 60; // degrees visible across the arc
  const pxPerDeg = w / spanDeg;
  const centreX = w / 2;
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Scale tick geometry with the ribbon height so it works full-screen or small.
  const baseY = h - Math.max(18, h * 0.16);
  const majorH = Math.max(10, h * 0.17);
  const minorH = Math.max(5, h * 0.09);

  for (let d = -spanDeg; d <= spanDeg; d += 5) {
    const hdg = (Math.round(heading / 5) * 5 + d + 360) % 360;
    // 000 is also 360, so a 0..360 range keeps every tick.
    if (!((hdg >= c.min && hdg <= c.max) || (hdg === 0 && c.max >= 360))) continue;
    const x = centreX + ((hdg - heading + 540) % 360 - 180) * pxPerDeg;
    if (x < -30 || x > w + 30) continue;
    const major = hdg % 10 === 0;
    const tickH = major ? majorH : minorH;
    ctx.strokeStyle = major ? '#9fb2c4' : '#38495a';
    ctx.lineWidth = major ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, baseY - tickH);
    ctx.stroke();
    if (major) {
      const lbl = hdg === 0 ? 'N' : hdg === 90 ? 'E' : hdg === 180 ? 'S' : hdg === 270 ? 'W' : String(hdg / 10);
      ctx.fillStyle = hdg % 90 === 0 ? '#ffcc00' : '#9fb2c4';
      ctx.fillText(lbl, x, baseY - tickH - 12);
    }
  }

  // fixed index
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centreX, baseY + 2);
  ctx.lineTo(centreX, baseY + Math.max(10, h * 0.14));
  ctx.stroke();
}

/* ------------------------------------------------------------------- render */

function renderAll() {
  ADI.render();

  for (const [tag, t] of Object.entries(TAPES)) {
    const v = view(tag);
    applyState($(t.el), $(t.flag), v);
    drawTape($(t.cv), { ...t, value: v.g, c: v.c });
    $(t.val).textContent = v.text;
    $(t.val).classList.toggle('over', v.over);
  }

  const vh = view('HEADING');
  applyState($('hdg-panel'), $('f-hdg'), vh);
  drawHeading(vh.g, vh.c);
  $('v-hdg').textContent = vh.text;
  $('v-hdg').classList.toggle('over', vh.over);
}

/* ------------------------------------------------------------------- status */

function renderStatus() {
  const list = [...params.values()];
  const fresh = list.filter((p) => !p.stale);
  const valid = list.filter((p) => p.valid);

  const bus = $('s-bus');
  if (fresh.length === 0) {
    bus.textContent = 'NO DATA';
    bus.className = 'badge stale';
  } else if (valid.length === list.length) {
    bus.textContent = 'VALID';
    bus.className = 'badge ok';
  } else {
    bus.textContent = 'DEGRADED';
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
  $('a-list').textContent = annuns.length ? annuns.join(' · ') : 'NONE';
  updateAlerts({ warning, callouts, cautions });
}

/** @param {boolean} [awaitingGesture] true until the page has had a click/key */
function renderSoundButton(awaitingGesture = false) {
  const b = $('s-sound');
  if (awaitingGesture) {
    b.textContent = 'CLICK PAGE TO ARM';
    b.className = 'badge sound inop';
    return;
  }
  b.textContent = isEnabled() ? 'ON' : 'MUTED';
  b.className = `badge sound ${isEnabled() ? 'ok' : ''}`;
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

  // Audio may only start from a user gesture. Sound is wanted on, so the first
  // click or key anywhere on the page arms it; the button then mutes/unmutes.
  const btn = $('s-sound');
  const arm = (ev) => {
    if (ev.target === btn) return; // the button's own click handler decides
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    if (!isEnabled()) setEnabled(true);
    renderSoundButton();
  };
  addEventListener('pointerdown', arm);
  addEventListener('keydown', arm);
  btn.addEventListener('click', () => {
    removeEventListener('pointerdown', arm);
    removeEventListener('keydown', arm);
    setEnabled(!isEnabled());
    renderSoundButton();
  });
  renderSoundButton(true);

  window.addEventListener('resize', renderAll);
  requestAnimationFrame(frame);
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${e}</pre>`);
});
