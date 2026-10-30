/**
 * Aural alerts for the SFD, synthesised with Web Audio (no sound files) plus
 * spoken callouts through the browser's speech synthesis.
 *
 * Three levels, as on a flight deck:
 *   warning  repeating two-tone alarm while the condition holds (A429 LOSS)
 *   callout  spoken phrase, repeated every few seconds while it holds
 *            (BANK ANGLE, SINK RATE)
 *   caution  single chime when a condition appears (a parameter going INOP /
 *            NCD / STALE, or a value leaving its display limits)
 *
 * Browsers only allow audio after a user gesture, so sound starts disabled
 * and is armed by the SOUND button (setEnabled from a click handler).
 */

const WARNING_PERIOD_MS = 1500;
const CALLOUT_PERIOD_MS = 3500;
/** A caution that clears and comes back within this window does not re-chime. */
const CAUTION_COOLDOWN_MS = 4000;

let ctx = null;
let enabled = false;
let lastWarning = 0;
const lastCallout = new Map();
const lastCaution = new Map();
let activeCautions = new Set();

function tone(freq, startS, durS, type = 'sine', gain = 0.18) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startS;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + durS - 0.03);
  g.gain.linearRampToValueAtTime(0, t0 + durS);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durS + 0.02);
}

/** Master warning: urgent alternating hi-lo tone. */
function warningSound() {
  for (let i = 0; i < 2; i++) {
    tone(960, i * 0.4, 0.18, 'square', 0.12);
    tone(720, i * 0.4 + 0.2, 0.18, 'square', 0.12);
  }
}

/** Caution: single soft two-note chime. */
function cautionSound() {
  tone(880, 0, 0.25, 'sine', 0.2);
  tone(660, 0.22, 0.4, 'sine', 0.2);
}

function speak(text) {
  if (!('speechSynthesis' in window)) {
    cautionSound();
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.pitch = 0.9;
  window.speechSynthesis.speak(u);
}

/** Arm or silence the alerts; call from a click handler to unlock audio. */
export function setEnabled(on) {
  enabled = on;
  if (on) {
    ctx ??= new AudioContext();
    ctx.resume();
    cautionSound(); // audible confirmation that sound is armed
    // Conditions already showing when sound is armed are announced once,
    // instead of counting as already heard.
    activeCautions = new Set();
    lastCallout.clear();
    lastCaution.clear();
    lastWarning = 0;
  } else if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

export function isEnabled() {
  return enabled;
}

/**
 * Feed the current alert conditions, once per state update.
 * @param {{warning:boolean, callouts:string[], cautions:string[]}} c
 */
export function updateAlerts({ warning, callouts, cautions }) {
  const now = performance.now();
  const fresh = cautions.filter((k) => !activeCautions.has(k));
  activeCautions = new Set(cautions);
  if (!enabled) return;

  if (warning) {
    // The warning covers everything else while it sounds.
    if (now - lastWarning >= WARNING_PERIOD_MS) {
      lastWarning = now;
      warningSound();
    }
    return;
  }

  for (const phrase of callouts) {
    if (now - (lastCallout.get(phrase) ?? -Infinity) >= CALLOUT_PERIOD_MS) {
      lastCallout.set(phrase, now);
      speak(phrase);
    }
  }

  const chime = fresh.filter((k) => now - (lastCaution.get(k) ?? -Infinity) >= CAUTION_COOLDOWN_MS);
  for (const k of chime) lastCaution.set(k, now);
  if (chime.length) cautionSound();
}
