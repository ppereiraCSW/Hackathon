/* Backend configuration page: one slider per received parameter. */

const $ = (id) => document.getElementById(id);

/** label -> DOM refs */
const rows = new Map();
/** label -> derived step (width / 200) */
const steps = new Map();

function fmt(v, unit) {
  if (v === null || v === undefined) return '—';
  const digits = Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${unit}`;
}

function makeRow(p) {
  const el = document.createElement('section');
  el.className = 'param';
  el.dataset.label = p.label;

  const name = document.createElement('div');
  name.className = 'param-name';
  name.innerHTML = `<strong>${p.tag.replace(/_/g, ' ')}</strong>
    <span class="dim">label ${p.label}<sub>8</sub> · ${p.unit}</span>`;

  const live = document.createElement('div');
  live.className = 'param-live';
  live.textContent = '—';

  const controls = document.createElement('div');
  controls.className = 'param-controls';

  // ---- min slider
  const minRow = document.createElement('label');
  minRow.className = 'ctl';
  minRow.innerHTML = `<span>display min</span>`;
  const minInput = document.createElement('input');
  minInput.type = 'range';
  minInput.min = String(p.hardRange.min);
  minInput.max = String(p.hardRange.max);
  minInput.step = 'any';
  minInput.value = String(p.config.min);
  const minOut = document.createElement('output');
  minRow.append(minInput, minOut);

  // ---- max slider
  const maxRow = document.createElement('label');
  maxRow.className = 'ctl';
  maxRow.innerHTML = `<span>display max</span>`;
  const maxInput = document.createElement('input');
  maxInput.type = 'range';
  maxInput.min = String(p.hardRange.min);
  maxInput.max = String(p.hardRange.max);
  maxInput.step = 'any';
  maxInput.value = String(p.config.max);
  const maxOut = document.createElement('output');
  maxRow.append(maxInput, maxOut);

  // ---- visible toggle
  const visRow = document.createElement('label');
  visRow.className = 'ctl ctl-check';
  const visInput = document.createElement('input');
  visInput.type = 'checkbox';
  visInput.checked = p.config.visible;
  visRow.append(visInput, document.createTextNode(' show on SFD'));

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'reset';
  reset.textContent = 'reset';

  controls.append(minRow, maxRow, visRow, reset);
  el.append(name, live, controls);

  // Step granularity: 1/1000 of the hard range, snapped on commit.
  const step = (p.hardRange.max - p.hardRange.min) / 1000;
  steps.set(p.label, step);

  const render = () => {
    minOut.textContent = Number(minInput.value).toFixed(2);
    maxOut.textContent = Number(maxInput.value).toFixed(2);
  };
  render();

  async function commit(patch) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: p.label, patch }),
    });
    const body = await res.json();
    if (!body.ok) {
      el.classList.add('rejected');
      el.title = body.error;
      setTimeout(() => el.classList.remove('rejected'), 600);
      return false;
    }
    el.classList.remove('rejected');
    el.title = '';
    return true;
  }

  // Live drag updates the label, commit on release keeps the bus quiet.
  minInput.addEventListener('input', render);
  maxInput.addEventListener('input', render);
  minInput.addEventListener('change', async () => {
    const ok = await commit({ min: Number(minInput.value) });
    if (!ok) minInput.value = String(p.config.min);
  });
  maxInput.addEventListener('change', async () => {
    const ok = await commit({ max: Number(maxInput.value) });
    if (!ok) maxInput.value = String(p.config.max);
  });
  visInput.addEventListener('change', async () => {
    const ok = await commit({ visible: visInput.checked });
    if (!ok) visInput.checked = p.config.visible;
  });
  reset.addEventListener('click', async () => {
    await fetch('/api/config/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: p.label }),
    });
    minInput.value = String(p.hardRange.min);
    maxInput.value = String(p.hardRange.max);
    render();
  });

  rows.set(p.label, { el, live, minInput, maxInput, visInput, def: p, render });
  return el;
}

async function init() {
  const res = await fetch('/api/config');
  const body = await res.json();
  const host = $('sliders');
  host.replaceChildren();
  for (const p of body.params) host.append(makeRow(p));

  // Values arrive over SSE so the sliders can show live data beside them.
  const es = new EventSource('/events');
  es.addEventListener('state', (ev) => {
    const snap = JSON.parse(ev.data);
    $('link-state').textContent = 'connected';
    $('link-state').className = 'ok';
    for (const p of snap.params) {
      const row = rows.get(p.label);
      if (!row) continue;
      row.live.textContent = p.stale
        ? 'STALE'
        : p.valid
          ? fmt(p.value, row.def.unit)
          : (p.ssm === 'NCD' ? 'NCD' : 'INOP');
      row.live.className = `param-live ${p.stale ? 'stale' : p.valid ? 'ok' : 'inop'}`;
    }
    $('h-words').textContent = snap.stats.words.toLocaleString();
    $('h-parity').textContent = String(snap.stats.parityErrors);
    $('h-unknown').textContent = String(snap.stats.unknownLabels);
    $('h-resync').textContent = String(snap.stats.resyncs);
    $('h-uptime').textContent = `${(snap.stats.uptimeMs / 1000).toFixed(0)} s`;

    const anyFresh = snap.params.some((p) => !p.stale);
    if (!anyFresh) {
      $('link-state').textContent = 'no data from the embedded layer';
      $('link-state').className = 'inop';
    }
  });
  es.onerror = () => {
    $('link-state').textContent = 'disconnected';
    $('link-state').className = 'stale';
  };

  // Another tab moving a slider keeps every view consistent.
  const cfgEvents = new EventSource('/config-events');
  cfgEvents.addEventListener('config', (ev) => {
    const { config } = JSON.parse(ev.data);
    for (const [tag, c] of Object.entries(config)) {
      const row = rows.get(c.label);
      if (!row) continue;
      if (document.activeElement !== row.minInput) row.minInput.value = String(c.min);
      if (document.activeElement !== row.maxInput) row.maxInput.value = String(c.max);
      row.visInput.checked = c.visible;
      row.render();
    }
  });
}

init().catch((e) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${e}</pre>`);
});
