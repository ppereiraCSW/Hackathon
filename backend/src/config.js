/**
 * Display configuration -- one slider per received parameter.
 *
 * Decided 2026-10-30: the sliders CONFIGURE THE DISPLAY (the min/max range the
 * SFD maps onto its instrument, and whether the parameter is shown at all).
 * They never override the value arriving from the bus -- the embedded layer
 * stays the only source of truth.
 */

export class DisplayConfig {
    /** @param {object} labelsDoc parsed shared/labels.json */
    constructor(labelsDoc) {
        this.defs = new Map();
        for (const def of labelsDoc.labels) this.defs.set(def.label, def);

        /** @type {Map<string, {min:number, max:number, visible:boolean}>} */
        this.config = new Map();
        for (const def of labelsDoc.labels) {
            this.config.set(def.label, {
                min: def.display.min,
                max: def.display.max,
                visible: def.display.visible,
            });
        }
    }

    /** Full config, shaped for the config page. */
    list() {
        return [...this.defs].map(([label, def]) => ({
            label,
            tag: def.tag,
            unit: def.unit,
            hardRange: { min: def.min, max: def.max },
            config: { ...this.config.get(label) },
        }));
    }

    /** Shaped for the SFD: tag -> {min,max,visible}. */
    forDisplay() {
        const out = {};
        for (const [label, def] of this.defs) {
            const c = this.config.get(label);
            out[def.tag] = { label, min: c.min, max: c.max, visible: c.visible, unit: def.unit };
        }
        return out;
    }

    /**
     * Apply one validated change.
     * @param {string} label
     * @param {{min?:number, max?:number, visible?:boolean}} patch
     * @returns {{ok:true, config:object}|{ok:false, error:string}}
     */
    set(label, patch) {
        const def = this.defs.get(label);
        if (!def) return { ok: false, error: `unknown label ${label}` };
        if (patch === null || typeof patch !== 'object') {
            return { ok: false, error: 'patch must be an object' };
        }

        const cur = this.config.get(label);
        const next = { ...cur };

        if (patch.min !== undefined) {
            if (typeof patch.min !== 'number' || !Number.isFinite(patch.min)) {
                return { ok: false, error: 'min must be a finite number' };
            }
            next.min = patch.min;
        }
        if (patch.max !== undefined) {
            if (typeof patch.max !== 'number' || !Number.isFinite(patch.max)) {
                return { ok: false, error: 'max must be a finite number' };
            }
            next.max = patch.max;
        }
        if (patch.visible !== undefined) {
            if (typeof patch.visible !== 'boolean') {
                return { ok: false, error: 'visible must be a boolean' };
            }
            next.visible = patch.visible;
        }
        if (next.min >= next.max) {
            return { ok: false, error: 'min must be less than max' };
        }
        // Keep the display window inside the label's own resolution range.
        if (next.min < def.min || next.max > def.max) {
            return {
                ok: false,
                error: `display range must stay within the label range ${def.min}..${def.max}`,
            };
        }

        this.config.set(label, next);
        return { ok: true, config: { ...next } };
    }

    reset(label) {
        const def = this.defs.get(label);
        if (!def) return { ok: false, error: `unknown label ${label}` };
        this.config.set(label, {
            min: def.display.min,
            max: def.display.max,
            visible: def.display.visible,
        });
        return { ok: true, config: { ...this.config.get(label) } };
    }
}
