/**
 * Secondary Flight Display.
 *
 * Consumes two SSE streams from the backend:
 *   /events          engineering values + validity (50 Hz)
 *   /config-events   display configuration from the sliders (on change)
 *
 * The display never computes a flight quantity: every number shown is either a
 * value the backend decoded from ARINC 429 or the user's display configuration.
 * Only the graphics (horizon, tapes, heading arc) are eased between updates so
 * motion is smooth; the numeric readouts always show the decoded value.
 */

const $ = (id) => document.getElementById(id);

/** Latest state snapshot, keyed by tag. */
const params = new Map();
/** Latest display config, keyed by tag. */
const display = new Map();
/** Value the graphics currently show per tag, eased toward params each frame. */
const shown = new Map();
/** Easing time constant: short enough to feel direct, long enough to hide steps. */
const SMOOTH_TAU_MS = 60;

/** Eased value for drawing; falls back to the decoded value. */
function eased(tag) {
  const p = params.get(tag);
  if (!p) return null;
  return shown.has(tag) ? shown.get(tag) : p.value;
}

/* ------------------------------------------------------------------ helpers */

/** Map a value onto 0..1 across the configured display window, clamped. */
function norm(value, c) {
  if (!c) return 0.5;
  const span = c.max - c.min;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (value - c.min) / span));
}

function fmt(value, digits = 0) {
  if (value === null || value === undefined) return '—';
  return value.toFixed(digits);
}

/* ---------------------------------------------------------------- ADI (SVG) */

const ADI = {
  pxPerDeg: 6.2,
  buildLadder() {
    const g = $('ladder');
    if (!g || g.dataset.built) return;
    const ns = 'http://www.w3.org/2000/svg';
    for (let deg = -90; deg <= 90; deg += 2.5) {
      if (deg === 0) continue;
      const major = Math.abs(deg) % 10 < 0.01;
      const w = major ? 130 : 62;
      const y = 160 - deg * ADI.pxPerDeg;
      if (Math.abs(y - 160) > 260) continue;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(160 - w / 2));
      line.setAttribute('x2', String(160 + w / 2));
      line.setAttribute('y1', String(y));
      line.setAttribute('y2', String(y));
      if (deg < 0) line.setAttribute('stroke-dasharray', '6 4');
      g.append(line);
      if (major) {
        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x', '26');
        t.setAttribute('y', String(y + 4));
        t.setAttribute('text-anchor', 'end');
        t.textContent = String(Math.abs(deg));
        g.append(t);
        const t2 = document.createElementNS(ns, 'text');
        t2.setAttribute('x', '294');
        t2.setAttribute('y', String(y + 4));
        t2.setAttribute('text-anchor', 'start');
        t2.textContent = String(Math.abs(deg));
        g.append(t2);
      }
    }
    g.dataset.built = '1';
  },
  render() {
    ADI.buildLadder();
    const p = params.get('PITCH');
    const r = params.get('ROLL');
    const pitch = p && p.valid ? eased('PITCH') : 0;
    const roll = r && r.valid ? eased('ROLL') : 0;

    const world = $('adi-world');
    if (world) {
      // Shift the horizon by pitch, then rotate around the centre by roll.
      world.setAttribute(
        'transform',
        `rotate(${-roll.toFixed(2)} 160 160) translate(0 ${(pitch * ADI.pxPerDeg).toFixed(2)})`,
      );
    }
    $('r-pitch').innerHTML = `PITCH <b>${p && p.valid ? p.value.toFixed(1) + '°' : '—'}</b>`;
    $('r-roll').innerHTML = `ROLL <b>${r && r.valid ? r.value.toFixed(1) + '°' : '—'}</b>`;
  },
};

/* --------------------------------------------------------------- tape draw */

/**
 * Draw a linear tape on a canvas.
 * @param {HTMLCanvasElement} cv
 * @param {object} opts
 */
function drawTape(cv, { value, c, majorStep, minorStep, side = 'left', label = (v) => v }) {
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

  const centreY = h / 2;
  const pxPerUnit = h / (c.max - c.min);
  const gutter = side === 'left' ? w - 8 : 8;

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  // Visible window in engineering units.
  const topVal = c.max;
  const botVal = c.min;
  const first = Math.ceil(botVal / minorStep) * minorStep;
  for (let v = first; v <= topVal; v += minorStep) {
    const y = centreY - (v - value) * pxPerUnit;
    if (y < -10 || y > h + 10) continue;
    const isMajor = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
    ctx.strokeStyle = isMajor ? '#7d8fa1' : '#38495a';
    ctx.lineWidth = isMajor ? 1.2 : 1;
    ctx.beginPath();
    ctx.moveTo(side === 'left' ? w - (isMajor ? 22 : 12) : 0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    if (isMajor) {
      ctx.fillStyle = '#9fb2c4';
      ctx.textAlign = side === 'left' ? 'left' : 'right';
      ctx.fillText(label(v), side === 'left' ? 2 : w - 2, y);
    }
  }

  // Reference bug at the configured midpoint.
  const bugY = centreY - ((c.min + c.max) / 2 - value) * pxPerUnit;
  ctx.strokeStyle = '#4fc3f7';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, bugY);
  ctx.lineTo(w, bugY);
  ctx.stroke();

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

  // Smoothing lines from tick gutter to the value box.
  ctx.strokeStyle = '#2b3a49';
  ctx.beginPath();
  ctx.moveTo(0, centreY);
  ctx.lineTo(w, centreY);
  ctx.stroke();
  void gutter;
}

/* -------------------------------------------------------------- heading arc */

function drawHeading() {
  const cv = $('cv-hdg');
  if (!cv) return;
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

  const p = params.get('HEADING');
  const c = display.get('HEADING');
  const heading = p && p.valid ? eased('HEADING') : null;
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

  // ---- CAS
  const casP = params.get('CAS');
  const casC = display.get('CAS');
  const casTape = $('tape-cas');
  const casOk = casP && casP.valid && casC && casC.visible;
  casTape.classList.toggle('failed', !(casP && casP.valid));
  casTape.classList.toggle('stale', !!(casP && casP.stale));
  casTape.classList.toggle('hidden-param', !(casC && casC.visible));
  $('f-cas').textContent = casP && casP.stale ? 'STALE' : casP && casP.ssm === 'NCD' ? 'NCD' : 'INOP';
  if (casC) {
    drawTape($('cv-cas'), {
      value: casOk ? eased('CAS') : (casC.min + casC.max) / 2,
      c: casC, majorStep: 20, minorStep: 10, digits: 0, side: 'left',
    });
  }
  $('v-cas').textContent = casOk ? fmt(casP.value, 1) : '—';

  // ---- altitude
  const altP = params.get('BARO_ALT');
  const altC = display.get('BARO_ALT');
  const altTape = $('tape-alt');
  const altOk = altP && altP.valid && altC && altC.visible;
  altTape.classList.toggle('failed', !(altP && altP.valid));
  altTape.classList.toggle('stale', !!(altP && altP.stale));
  altTape.classList.toggle('hidden-param', !(altC && altC.visible));
  $('f-alt').textContent = altP && altP.stale ? 'STALE' : altP && altP.ssm === 'NCD' ? 'NCD' : 'INOP';
  if (altC) {
    drawTape($('cv-alt'), {
      value: altOk ? eased('BARO_ALT') : (altC.min + altC.max) / 2,
      c: altC, majorStep: 5000, minorStep: 1000, digits: 0, side: 'right',
      label: (v) => (v >= 0 ? String(Math.round(v / 1000)) : String(Math.round(v))),
    });
  }
  $('v-alt').textContent = altOk ? Math.round(altP.value).toLocaleString() : '—';

  // ---- vertical speed
  const vsP = params.get('VERT_SPEED');
  const vsC = display.get('VERT_SPEED');
  const vsTape = $('tape-vs');
  const vsOk = vsP && vsP.valid && vsC && vsC.visible;
  vsTape.classList.toggle('failed', !(vsP && vsP.valid));
  vsTape.classList.toggle('stale', !!(vsP && vsP.stale));
  vsTape.classList.toggle('hidden-param', !(vsC && vsC.visible));
  $('f-vs').textContent = vsP && vsP.stale ? 'STALE' : vsP && vsP.ssm === 'NCD' ? 'NCD' : 'INOP';
  if (vsC) {
    drawTape($('cv-vs'), {
      value: vsOk ? eased('VERT_SPEED') : (vsC.min + vsC.max) / 2,
      c: vsC, majorStep: 500, minorStep: 250, digits: 0, side: 'left',
      label: (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v)),
    });
  }
  $('v-vs').textContent = vsOk ? Math.round(vsP.value) : '—';

  // ---- heading
  const hdgP = params.get('HEADING');
  const hdgC = display.get('HEADING');
  const hdgOk = hdgP && hdgP.valid && hdgC && hdgC.visible;
  $('f-hdg').style.display = hdgP && !hdgP.valid ? 'block' : 'none';
  $('f-hdg').textContent = hdgP && hdgP.stale ? 'STALE' : hdgP && hdgP.ssm === 'NCD' ? 'NCD' : 'INOP';
  $('f-hdg').className = 'tape-flag';
  drawHeading();
  $('v-hdg').textContent = hdgOk ? String(Math.round(hdgP.value) % 360).padStart(3, '0') : '—';
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

  const annuns = [];
  if (fresh.length === 0) annuns.push('A429 LOSS');
  for (const p of list) {
    if (p.stale && fresh.length > 0) annuns.push(`${p.tag.replace(/_/g, ' ')} STALE`);
    else if (!p.valid && !p.stale) annuns.push(`${p.tag.replace(/_/g, ' ')} ${p.ssm || 'INOP'}`);
  }
  $('a-list').textContent = annuns.length ? annuns.join(' · ') : 'NONE';
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

  window.addEventListener('resize', renderAll);
  requestAnimationFrame(frame);
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${e}</pre>`);
});
