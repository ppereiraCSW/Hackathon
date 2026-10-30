/**
 * One number format per parameter, shared by the SFD and the config page so the
 * same decoded value never reads differently on the two surfaces.
 */

const FORMATS = {
  PITCH: (v) => v.toFixed(1),
  ROLL: (v) => v.toFixed(1),
  // 359.6 rounds to 360, which a heading shows as 000.
  HEADING: (v) => String(((Math.round(v) % 360) + 360) % 360).padStart(3, '0'),
  BARO_ALT: (v) => String(Math.round(v)),
  CAS: (v) => String(Math.round(v)),
  VERT_SPEED: (v) => String(Math.round(v)),
};

/** Format a value for `tag`; '—' when there is no value. */
export function formatValue(tag, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const f = FORMATS[tag];
  const s = f ? f(value) : value.toFixed(1);
  // -0.02 rounds to "-0.0"; a sign on zero is noise, not information.
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** Unit as shown next to a value. */
export function unitText(unit) {
  return unit === 'deg' ? '°' : ` ${unit}`;
}
