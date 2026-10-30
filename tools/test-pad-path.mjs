#!/usr/bin/env node
/**
 * Pad path test WITHOUT a physical stick movement.
 *
 * The pad reader listens for QEMU; here we stand in for it and inject synthetic
 * pad frames into the *firmware* over a TCP socket, then read the resulting
 * A429 words from the backend. This proves the whole chain
 *
 *     pad frame -> firmware model -> A429 encode -> backend decode -> value
 *
 * and is what a demo run cannot show on a machine with no hands on the stick.
 *
 * Usage: node tools/test-pad-path.mjs
 */
import { startFirmware, sleep } from './fw-harness.mjs';

const PAD_PORT = 5586;
const A429_PORT = 5585;

async function main() {
    const { send, hold, values, state, close } = await startFirmware({ padPort: PAD_PORT, a429Port: A429_PORT });
    try {
        const expect = (label, actual, want, tol) => {
            const ok = actual !== null && Math.abs(actual - want) <= tol;
            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} got ${actual === null ? 'null' : actual.toFixed(2)}  want ~${want}`);
            return ok;
        };

        let failures = 0;
        const results = [];

        // The axes are rate commands (firmware/src/flight.h): deflection moves
        // the value, a centred stick holds it.

        // ---- neutral: the model's defaults, unchanged
        let v = await hold({}, 400);
        results.push(expect('neutral roll', v.ROLL, 0, 0.5));
        results.push(expect('neutral pitch', v.PITCH, 0, 0.5));
        results.push(expect('neutral CAS', v.CAS, 120, 1));

        // ---- full right roll for 2 s at 30 deg/s -> saturates at +45
        v = await hold({ x: 65535 }, 2000);
        results.push(expect('roll full right -> limit', v.ROLL, 45, 1));

        // ---- centre the stick: roll HOLDS, and the held bank keeps turning
        const hdgBefore = v.HEADING;
        v = await hold({}, 1000);
        results.push(expect('roll holds when centred', v.ROLL, 45, 1));
        const turned = ((v.HEADING - hdgBefore) + 360) % 360;
        const hdgOk = turned > 2 && turned < 180;
        console.log(`  ${hdgOk ? 'PASS' : 'FAIL'}  held bank keeps turning    ${hdgBefore.toFixed(1)} -> ${v.HEADING.toFixed(1)} (+${turned.toFixed(1)} deg)`);
        results.push(hdgOk);

        // ---- B pulsing at 5 Hz (a pad with turbo on) must NOT reset heading
        const hdgTurbo = values().HEADING;
        for (let i = 0; i < 5; i++) {
            await hold({ buttons: 0x0002 }, 100);
            await hold({}, 100);
        }
        const hdgAfterTurbo = values().HEADING;
        const turboOk = hdgAfterTurbo > hdgTurbo + 1;
        console.log(`  ${turboOk ? 'PASS' : 'FAIL'}  B pulses ignored           ${hdgTurbo.toFixed(1)} -> ${hdgAfterTurbo.toFixed(1)} (still turning)`);
        results.push(turboOk);

        // ---- B held for 1 s resets heading (the 45 deg bank keeps turning at
        // ~5 deg/s afterwards, so allow for the time since the reset)
        v = await hold({ buttons: 0x0002 }, 1100);
        const resetOk = v.HEADING < 4;
        console.log(`  ${resetOk ? 'PASS' : 'FAIL'}  B held 1 s resets heading  got ${v.HEADING.toFixed(2)}  want 0..4`);
        results.push(resetOk);

        // ---- half a second of left stick takes off ~15 deg, not all of it
        v = await hold({ x: 0 }, 500);
        const partial = v.ROLL > 20 && v.ROLL < 40;
        console.log(`  ${partial ? 'PASS' : 'FAIL'}  roll is incremental        got ${v.ROLL.toFixed(2)}  want 20..40`);
        results.push(partial);

        // ---- A levels the wings
        await hold({ buttons: 0x0001 }, 80);
        v = await hold({}, 200);
        results.push(expect('A -> wings level (roll)', v.ROLL, 0, 0.5));

        // ---- stick back for 2.5 s at 10 deg/s -> +20; forward 4.5 s -> -20
        v = await hold({ y: 65535 }, 2500);
        results.push(expect('pitch full back -> limit', v.PITCH, 20, 1));
        v = await hold({ y: 0 }, 4500);
        results.push(expect('pitch full forward -> limit', v.PITCH, -20, 1));

        // ---- throttle forward 1 s at 25 kt/s -> CAS rises by ~25 kt
        const casBefore = values().CAS;
        v = await hold({ z: 65535 }, 1000);
        const casUp = v.CAS - casBefore;
        const casOk = casUp > 15 && casUp < 35;
        console.log(`  ${casOk ? 'PASS' : 'FAIL'}  CAS rate                   +${casUp.toFixed(1)} kt in 1 s  want ~25`);
        results.push(casOk);

        // ---- V/S follows pitch and airspeed, altitude follows V/S
        const vsWant = (p) => p.CAS * 101.2686 * Math.sin((p.PITCH * Math.PI) / 180);
        v = await hold({}, 200);
        results.push(expect('nose down -> V/S = CAS*sin', v.VERT_SPEED, Math.round(vsWant(v)), 30));
        const altBefore = v.BARO_ALT;
        v = await hold({}, 1000);
        const altOk = v.BARO_ALT < altBefore - 30;
        console.log(`  ${altOk ? 'PASS' : 'FAIL'}  nose down -> altitude falls ${altBefore.toFixed(0)} -> ${v.BARO_ALT.toFixed(0)} ft`);
        results.push(altOk);
        v = await hold({ y: 65535 }, 4500);
        results.push(expect('nose up -> V/S = CAS*sin', v.VERT_SPEED, Math.round(vsWant(v)), 30));
        const climbOk = v.VERT_SPEED > 1000;
        console.log(`  ${climbOk ? 'PASS' : 'FAIL'}  nose up climbs             V/S ${v.VERT_SPEED.toFixed(0)} ft/min`);
        results.push(climbOk);
        await hold({ buttons: 0x0001 }, 80);
        v = await hold({}, 200);
        results.push(expect('wings level -> V/S 0', v.VERT_SPEED, 0, 5));

        // ---- D-pad up held 1 s steps altitude ONCE, not every tick
        const altHeld = v.BARO_ALT;
        v = await hold({ pov: 0 }, 1000);
        results.push(expect('D-pad up held -> +500 once', v.BARO_ALT - altHeld, 500, 8));
        await hold({}, 100);

        // ---- START button toggles NCD on every label
        for (let i = 0; i < 4; i++) { send({ buttons: 0x0010 }); await sleep(20); }
        for (let i = 0; i < 12; i++) { send({}); await sleep(20); }
        await sleep(150);
        const snapNcd = state.snapshot();
        const allNcd = snapNcd.params.every((p) => p.valid === false && p.ssm === 'NCD');
        console.log(`  ${allNcd ? 'PASS' : 'FAIL'}  START freeze -> NCD        ${snapNcd.params.map((p) => p.ssm).join(',')}`);
        results.push(allNcd);

        // ---- START again clears NCD
        for (let i = 0; i < 4; i++) { send({ buttons: 0x0010 }); await sleep(20); }
        for (let i = 0; i < 12; i++) { send({}); await sleep(20); }
        await sleep(150);
        const cleared = state.snapshot().params.every((p) => p.ssm !== 'NCD');
        console.log(`  ${cleared ? 'PASS' : 'FAIL'}  START again clears NCD`);
        results.push(cleared);

        failures = results.filter((r) => !r).length;
        console.log('');
        console.log(`pad frame -> firmware -> A429 -> backend: ${results.length - failures}/${results.length} checks passed`);
        console.log(`A429 words decoded by the backend: ${state.snapshot().stats.words}`);
        if (failures) process.exitCode = 1;
    } finally {
        close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
