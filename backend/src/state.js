/**
 * Live parameter state: the backend's memory of what the bus last said.
 *
 * Responsibility boundary (decided 2026-10-30): the backend decodes, converts
 * to engineering units and judges validity/freshness. It does NOT filter,
 * smooth, or derive anything -- that was explicitly out of scope.
 */
import { decodeWord, decodeValue } from './a429/codec.js';

/** A label not heard within this window is reported stale. */
export const STALE_MS = 250;

export class ParamState {
    /**
     * @param {object} labelsDoc parsed shared/labels.json
     * @param {{now?: () => number, staleMs?: number}} [opts]
     */
    constructor(labelsDoc, opts = {}) {
        this.now = opts.now ?? (() => Date.now());
        this.staleMs = opts.staleMs ?? STALE_MS;
        this.defs = new Map();
        for (const def of labelsDoc.labels) this.defs.set(def.label, def);

        /** @type {Map<string, {value:number|null, valid:boolean, ssm:string, magnitude:number,
         *                     lastSeen:number, count:number, sdi:number}>} */
        this.params = new Map();
        for (const def of labelsDoc.labels) {
            this.params.set(def.label, {
                value: null,
                valid: false,
                ssm: 'NONE',
                magnitude: 0,
                lastSeen: 0,
                count: 0,
                sdi: 0,
            });
        }

        this.stats = {
            words: 0,
            parityErrors: 0,
            unknownLabels: 0,
            resyncs: 0,
            startedAt: this.now(),
        };
    }

    /**
     * Feed one 32-bit word.
     * @returns {'ok'|'parity'|'unknown'}
     */
    ingestWord(word) {
        this.stats.words++;
        const d = decodeWord(word);
        if (!d.ok) {
            this.stats.parityErrors++;
            return 'parity';
        }
        const def = this.defs.get(d.label);
        if (!def) {
            this.stats.unknownLabels++;
            return 'unknown';
        }
        const p = this.params.get(d.label);
        const conv = decodeValue(d.magnitude, d.ssm, def);
        p.magnitude = d.magnitude;
        p.ssm = d.ssmName;
        p.sdi = d.sdi;
        p.value = conv.value;
        p.valid = conv.valid;
        p.lastSeen = this.now();
        p.count++;
        return 'ok';
    }

    /** Byte-stream ingest with resynchronisation on bad words. */
    ingestChunk(buf) {
        let consumed = 0;
        while (buf.length - consumed >= 4) {
            const word = buf.readUInt32LE(consumed);
            const r = this.ingestWord(word);
            consumed += 4;
            if (r !== 'ok' && r !== 'parity') {
                // unknown label: skip one byte and retry, to re-find alignment
                consumed -= 3;
                this.stats.resyncs++;
                continue;
            }
            if (r === 'parity') this.stats.resyncs++;
        }
        return buf.subarray(consumed);
    }

    /** Snapshot for the frontend: engineering values + validity + freshness. */
    snapshot() {
        const t = this.now();
        const out = [];
        for (const [label, def] of this.defs) {
            const p = this.params.get(label);
            const ageMs = p.lastSeen === 0 ? null : t - p.lastSeen;
            const fresh = ageMs !== null && ageMs <= this.staleMs;
            out.push({
                label,
                tag: def.tag,
                unit: def.unit,
                value: fresh && p.valid ? p.value : null,
                valid: fresh && p.valid,
                stale: !fresh,
                ageMs,
                ssm: p.ssm,
                sdi: p.sdi,
                range: { min: def.min, max: def.max },
            });
        }
        return {
            t,
            params: out,
            stats: {
                ...this.stats,
                uptimeMs: t - this.stats.startedAt,
            },
        };
    }
}
