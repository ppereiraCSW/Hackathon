#!/usr/bin/env node
/**
 * Boundary values for every parameter, through the REAL firmware in QEMU:
 *
 *     pad frame -> firmware model -> A429 encode -> backend decode -> value
 *
 * Each parameter is driven into both of its limits and held there, sampling
 * every frame, to prove the value stops exactly at the limit, never overshoots,
 * and that the parameters derived from it stay consistent at the limit
 * (e.g. V/S reads 0 while altitude is held at the ground).
 *
 * Codec, backend and display-format boundaries are in test/boundaries.test.mjs.
 *
 * Usage: node tools/test-boundaries.mjs      (about 70 s)
 */
import { readFileSync } from 'node:fs';
import { startFirmware, checker, BTN, AXIS } from './fw-harness.mjs';

const PAD_PORT = 5588;
const A429_PORT = 5587;

const labels = JSON.parse(readFileSync('shared/labels.json', 'utf8')).labels;
const LSB = Object.fromEntries(labels.map((d) => [d.tag, d.lsbPerBit]));

/** Firmware model limits (firmware/src/flight.h). */
const LIM = {
    ROLL: 45, PITCH: 20, CAS_MAX: 250, VS: 6000, ALT_GROUND: 0, ALT_CEILING: 100000,
};

const POV_UP = 0;
const POV_DOWN = 18000;

const max = (s, tag) => Math.max(...s.map((v) => v[tag]).filter((x) => x !== null));
const min = (s, tag) => Math.min(...s.map((v) => v[tag]).filter((x) => x !== null));
const last = (s) => s[s.length - 1];

async function main() {
    const fw = await startFirmware({ padPort: PAD_PORT, a429Port: A429_PORT });
    const { report, near, summary } = checker();
    /** Every sample seen, for the global "never outside the label range" check. */
    const all = [];
    const trace = async (opts, ms) => {
        const s = await fw.trace(opts, ms);
        all.push(...s);
        return s;
    };
    const level = async () => { await fw.press({ buttons: BTN.A }); };

    try {
        await fw.hold({}, 300);

        // ------------------------------------------------------------- ROLL
        console.log('ROLL  (limit ±45°)');
        let s = await trace({ x: AXIS.MAX }, 3000);
        near('full right, held past the limit', last(s).ROLL, LIM.ROLL, LSB.ROLL);
        report('never above +45', max(s, 'ROLL') <= LIM.ROLL + LSB.ROLL, `max ${max(s, 'ROLL').toFixed(2)}`);
        s = await trace({ x: AXIS.MIN }, 4500);
        near('full left, held past the limit', last(s).ROLL, -LIM.ROLL, LSB.ROLL);
        report('never below -45', min(s, 'ROLL') >= -LIM.ROLL - LSB.ROLL, `min ${min(s, 'ROLL').toFixed(2)}`);
        await level();

        // ------------------------------------------------------------ PITCH
        console.log('PITCH  (limit ±20°)');
        s = await trace({ y: AXIS.MAX }, 3000);
        near('full back, held past the limit', last(s).PITCH, LIM.PITCH, LSB.PITCH);
        report('never above +20', max(s, 'PITCH') <= LIM.PITCH + LSB.PITCH, `max ${max(s, 'PITCH').toFixed(2)}`);
        s = await trace({ y: AXIS.MIN }, 5000);
        near('full forward, held past the limit', last(s).PITCH, -LIM.PITCH, LSB.PITCH);
        report('never below -20', min(s, 'PITCH') >= -LIM.PITCH - LSB.PITCH, `min ${min(s, 'PITCH').toFixed(2)}`);
        await level();

        // -------------------------------------------------------------- CAS
        console.log('CAS  (limit 0..250 kt)');
        let v = await fw.press({ buttons: BTN.LB }, 14);
        near('LB x14 from 120 stops at 0', v.CAS, 0, 0);
        s = await trace({ z: AXIS.MIN }, 1000);
        near('throttle back at 0 stays 0', last(s).CAS, 0, 0);
        report('never negative', min(s, 'CAS') >= 0, `min ${min(s, 'CAS').toFixed(2)}`);
        v = await fw.hold({ y: AXIS.MAX }, 2500);
        near('CAS 0, nose up 20° -> V/S 0', v.VERT_SPEED, 0, 0);
        await level();
        v = await fw.press({ buttons: BTN.RB }, 27);
        near('RB x27 from 0 stops at 250', v.CAS, LIM.CAS_MAX, 0);
        s = await trace({ z: AXIS.MAX }, 1000);
        near('throttle forward at 250 stays 250', last(s).CAS, LIM.CAS_MAX, 0);
        report('never above 250', max(s, 'CAS') <= LIM.CAS_MAX, `max ${max(s, 'CAS').toFixed(2)}`);

        // -------------------------------------------------------------- V/S
        // 250 kt at 20° is 8,660 ft/min: past the limit, so it must clamp.
        console.log('V/S  (limit ±6000 ft/min)');
        s = await trace({ y: AXIS.MAX }, 3000);
        near('250 kt, nose up 20° clamps', last(s).VERT_SPEED, LIM.VS, 0);
        report('never above +6000', max(s, 'VERT_SPEED') <= LIM.VS, `max ${max(s, 'VERT_SPEED')}`);
        s = await trace({ y: AXIS.MIN }, 5000);
        near('250 kt, nose down 20° clamps', last(s).VERT_SPEED, -LIM.VS, 0);
        report('never below -6000', min(s, 'VERT_SPEED') >= -LIM.VS, `min ${min(s, 'VERT_SPEED')}`);
        await level();
        v = await fw.hold({}, 200);
        near('wings level -> V/S 0', v.VERT_SPEED, 0, 0);

        // ---------------------------------------------------------- ALTITUDE
        console.log('BARO ALT  (limit ground 0 .. ceiling 100000 ft)');
        v = await fw.press({ pov: POV_DOWN }, 16);
        near('D-pad down to the ground stops at 0', v.BARO_ALT, LIM.ALT_GROUND, 0);
        s = await trace({ y: AXIS.MIN }, 3000);
        report('nose down on the ground: never below 0', min(s, 'BARO_ALT') >= LIM.ALT_GROUND, `min ${min(s, 'BARO_ALT')}`);
        report('nose down on the ground: V/S never < 0', min(s, 'VERT_SPEED') >= 0, `min ${min(s, 'VERT_SPEED')}`);
        near('held at the ground: V/S reads 0', last(s).VERT_SPEED, 0, 0);
        s = await trace({ y: AXIS.MAX }, 5000);
        report('nose up lifts off the ground', last(s).BARO_ALT > 0 && last(s).VERT_SPEED > 0,
            `alt ${last(s).BARO_ALT}  V/S ${last(s).VERT_SPEED}`);
        await level();
        v = await fw.press({ pov: POV_UP }, 205);
        near('D-pad up to the ceiling stops at 100000', v.BARO_ALT, LIM.ALT_CEILING, 0);
        s = await trace({ y: AXIS.MAX }, 3000);
        report('nose up at the ceiling: never above', max(s, 'BARO_ALT') <= LIM.ALT_CEILING, `max ${max(s, 'BARO_ALT')}`);
        near('held at the ceiling: V/S reads 0', last(s).VERT_SPEED, 0, 0);
        s = await trace({ y: AXIS.MIN }, 5000);
        report('nose down leaves the ceiling', last(s).BARO_ALT < LIM.ALT_CEILING && last(s).VERT_SPEED < 0,
            `alt ${last(s).BARO_ALT}  V/S ${last(s).VERT_SPEED}`);
        await level();

        // ----------------------------------------------------------- HEADING
        console.log('HEADING  (0 .. <360, wraps)');
        v = await fw.hold({ buttons: BTN.B }, 1200);
        near('B held 1 s, wings level -> 000', v.HEADING, 0, LSB.HEADING);
        await fw.hold({}, 100);
        s = await trace({ x: AXIS.MIN }, 5000);
        report('left turn through north wraps to 35x', s.some((x) => x.HEADING > 350), `last ${last(s).HEADING.toFixed(1)}`);
        report('left turn: never negative', min(s, 'HEADING') >= 0, `min ${min(s, 'HEADING').toFixed(2)}`);
        s = await trace({ x: AXIS.MAX }, 14000);
        const crossed = s.findIndex((x) => x.HEADING > 350);
        const wrapped = crossed >= 0 && s.slice(crossed).some((x) => x.HEADING < 10);
        report('right turn through north wraps to 00x', wrapped, `last ${last(s).HEADING.toFixed(1)}`);
        report('heading never reaches 360', max(s, 'HEADING') < 360, `max ${max(s, 'HEADING').toFixed(2)}`);
        await level();

        // -------------------------------------------------------------- ALL
        console.log('ALL PARAMETERS');
        for (const d of labels) {
            const out = all.filter((x) => x[d.tag] !== null && (x[d.tag] < d.min || x[d.tag] > d.max));
            report(`${d.tag} never outside its label range`, out.length === 0,
                `${all.length} samples, range ${d.min}..${d.max}`);
        }
        const invalid = all.filter((x) => Object.values(x).some((y) => y === null)).length;
        report('every sample valid (no NCD/stale)', invalid === 0, `${invalid} invalid of ${all.length}`);

        summary('boundaries: pad frame -> firmware -> A429 -> backend');
    } finally {
        fw.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
