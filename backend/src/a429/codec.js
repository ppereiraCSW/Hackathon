/**
 * ARINC 429 word codec -- bit-exact, zero dependencies.
 *
 * Word layout (bit 1 transmitted first), per ARINC 429-19:
 *   bit  1- 8  label, transmitted least-significant bit first
 *   bit  9-10  SDI (source/destination identifier)
 *   bit 11-29  19-bit data field, BNR magnitude
 *   bit 30-31  SSM (sign/status matrix)
 *   bit 32     parity, odd
 *
 * Two things trip people up and are handled explicitly here:
 *
 *  1. The label is transmitted LSB-first into bits 1-8, which *looks like* a
 *     bit-reversed byte when you write the word down as a number. The label
 *     stored in a word is therefore the bit-reversal of its octal value.
 *
 *  2. BNR data is a magnitude plus a sign that lives in the SSM, not two's
 *     complement. SSM 00 = +valid, 11 = -valid, 01 = no computed data,
 *     10 = functional test.
 */

export const SSM = Object.freeze({
  PLUS: 0b00,
  NCD: 0b01,
  TEST: 0b10,
  MINUS: 0b11,
});

export const SSM_NAME = Object.freeze({
  0b00: 'PLUS',
  0b01: 'NCD',
  0b10: 'TEST',
  0b11: 'MINUS',
});

export const A429 = Object.freeze({
  LABEL_BITS: 8,
  DATA_BITS: 19,
  DATA_MAX: (1 << 19) - 1,
  WORD_BITS: 32,
});

/** Reverse the bit order of the low 8 bits of a byte. */
export function reverseByte(b) {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r & 0xff;
}

/** Odd parity over a 32-bit word's low 31 bits -> the value of bit 32. */
export function oddParityBit(word31) {
  let ones = 0;
  for (let i = 0; i < 31; i++) ones += (word31 >>> i) & 1;
  // Odd total parity: the parity bit must make the count of ones odd.
  return ones % 2 === 0 ? 1 : 0;
}

/**
 * Encode one A429 word.
 *
 * @param {object} p
 * @param {number} p.label      octal label value, e.g. 0o324 (as a JS number or string '324')
 * @param {number} [p.sdi]      0..3
 * @param {number} p.magnitude  raw BNR magnitude, 0 .. 2^19-1 (already divided by LSB)
 * @param {number} p.ssm        one of SSM
 * @returns {number} unsigned 32-bit word
 */
export function encodeWord({ label, sdi = 0, magnitude, ssm }) {
  const labelOct = typeof label === 'string' ? parseInt(label, 8) : label;
  if (!Number.isInteger(labelOct) || labelOct < 0 || labelOct > 0o377) {
    throw new RangeError(`label out of range: ${label}`);
  }
  if (magnitude === undefined && ssm !== SSM.NCD) {
    throw new TypeError('magnitude is required unless SSM is NCD');
  }
  const mag = magnitude ?? 0;
  if (!Number.isInteger(mag) || mag < 0 || mag > A429.DATA_MAX) {
    throw new RangeError(`magnitude out of range: ${mag}`);
  }
  if (![0, 1, 2, 3].includes(sdi)) throw new RangeError(`sdi out of range: ${sdi}`);
  if (![0, 1, 2, 3].includes(ssm)) throw new RangeError(`ssm out of range: ${ssm}`);

  // Bits are numbered from 1; here they are packed from 0.
  let w = 0;
  w |= reverseByte(labelOct) << 0; // bits  1- 8
  w |= (sdi & 0x3) << 8;           // bits  9-10
  w |= (mag & A429.DATA_MAX) << 10; // bits 11-29
  w |= (ssm & 0x3) << 29;          // bits 30-31
  w |= oddParityBit(w) << 31;      // bit  32
  return w >>> 0;
}

/**
 * Decode one A429 word. Never throws on bad data: returns ok:false with a reason,
 * because a real receiver must keep running through corrupt words.
 *
 * @param {number} word unsigned 32-bit word
 * @returns {{ok:boolean, reason?:string, label?:string, labelValue?:number, sdi?:number,
 *            magnitude?:number, ssm?:number, ssmName?:string, sign?:number}}
 */
export function decodeWord(word) {
  const w = word >>> 0;

  let ones = 0;
  for (let i = 0; i < 32; i++) ones += (w >>> i) & 1;
  if (ones % 2 !== 1) return { ok: false, reason: 'parity' };

  const labelValue = reverseByte(w & 0xff);
  const sdi = (w >>> 8) & 0x3;
  const magnitude = (w >>> 10) & A429.DATA_MAX;
  const ssm = (w >>> 29) & 0x3;

  return {
    ok: true,
    label: labelValue.toString(8).padStart(3, '0'),
    labelValue,
    sdi,
    magnitude,
    ssm,
    ssmName: SSM_NAME[ssm],
    sign: ssm === SSM.MINUS ? -1 : 1,
  };
}

/**
 * Engineering value -> magnitude + SSM for a given label definition.
 * Values outside the definition's range are clamped; a non-finite value is NCD.
 *
 * @param {number} value engineering value in the label's unit
 * @param {{min:number,max:number,lsbPerBit:number}} def
 * @returns {{magnitude:number, ssm:number}}
 */
export function encodeValue(value, def) {
  if (!Number.isFinite(value)) return { magnitude: 0, ssm: SSM.NCD };
  const clamped = Math.min(def.max, Math.max(def.min, value));
  const ssm = clamped < 0 ? SSM.MINUS : SSM.PLUS;
  let magnitude = Math.round(Math.abs(clamped) / def.lsbPerBit);
  if (magnitude > A429.DATA_MAX) magnitude = A429.DATA_MAX;
  return { magnitude, ssm };
}

/**
 * Magnitude + SSM -> engineering value. NCD and TEST are reported as not-valid
 * rather than silently converted to a number.
 *
 * @param {number} magnitude
 * @param {number} ssm
 * @param {{lsbPerBit:number}} def
 * @returns {{value:number|null, valid:boolean}}
 */
export function decodeValue(magnitude, ssm, def) {
  if (ssm === SSM.NCD || ssm === SSM.TEST) return { value: null, valid: false };
  const sign = ssm === SSM.MINUS ? -1 : 1;
  return { value: sign * magnitude * def.lsbPerBit, valid: true };
}

/** Pack a word into the 4-byte little-endian transport frame. */
export function wordToBytes(word) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(word >>> 0, 0);
  return b;
}

/** Unpack 4 little-endian bytes into a word. */
export function bytesToWord(buf, offset = 0) {
  return buf.readUInt32LE(offset) >>> 0;
}
