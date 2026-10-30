/**
 * End-to-end tests.
 *
 * These run the real backend process against a real A429 byte source and assert
 * what a browser would actually receive. Two scenarios matter:
 *
 *  1. Live-style: words arrive over TCP, exactly as QEMU delivers them.
 *  2. DECOUPLED: the backend replays shared/capture.a429 with QEMU and the
 *     gamepad both absent. This is the test that proves the requirement that
 *     the backend is decoupled from the embedded layer and the input device.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { startBackend } from '../backend/src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const capturePath = join(ROOT, 'shared', 'capture.a429');

const labelsDoc = JSON.parse(readFileSync(join(ROOT, 'shared', 'labels.json'), 'utf8'));

/** Free-ish ports so parallel test files do not collide. */
let portCursor = 18500;
const nextPorts = () => ({ httpPort: portCursor++, a429Port: portCursor++ });

/** Collect SSE events until `want` of them arrive or the timeout fires. */
function collectSse(url, eventName, want, timeoutMs = 4000) {
    return collectSseMatching(url, eventName, () => true, want, timeoutMs);
}

/**
 * Collect SSE events that satisfy `predicate`.
 *
 * Needed because each stream deliberately sends an initial snapshot on connect
 * (the SFD must render before the first change), so a test waiting for "the"
 * config event would otherwise latch onto that snapshot.
 */
function collectSseMatching(url, eventName, predicate, want, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const events = [];
        const ac = new AbortController();
        const timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`timed out waiting for ${want} ${eventName} events (got ${events.length})`));
        }, timeoutMs);

        fetch(url, { signal: ac.signal })
            .then(async (res) => {
                assert.equal(res.headers.get('content-type'), 'text/event-stream');
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let idx;
                    while ((idx = buf.indexOf('\n\n')) >= 0) {
                        const raw = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        const evLine = raw.split('\n').find((l) => l.startsWith('event: '));
                        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
                        if (!evLine || !dataLine) continue;
                        if (evLine.slice(7).trim() !== eventName) continue;
                        const parsed = JSON.parse(dataLine.slice(6));
                        if (!predicate(parsed)) continue;
                        events.push(parsed);
                        if (events.length >= want) {
                            clearTimeout(timer);
                            ac.abort();
                            resolve(events);
                            return;
                        }
                    }
                }
            })
            .catch((e) => {
                if (e.name === 'AbortError') return;
                reject(e);
            });
    });
}

async function waitFor(fn, timeoutMs = 4000, label = 'condition') {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

/* ------------------------------------------------------------------ live TCP */

test('live: A429 words over TCP reach the browser as engineering values', async () => {
    const ports = nextPorts();
    const backend = startBackend(ports);
    try {
        await waitFor(async () => {
            try {
                return (await fetch(`http://127.0.0.1:${ports.httpPort}/api/health`)).ok;
            } catch {
                return false;
            }
        }, 4000, 'backend listening');

        // Replay the capture over TCP: same bytes QEMU produces.
        const capture = readFileSync(capturePath);
        const sock = connect(ports.a429Port, '127.0.0.1');
        await new Promise((r) => sock.on('connect', r));
        // Send in realistic chunks of 6 words, to exercise the stream decoder.
        for (let off = 0; off + 24 <= capture.length; off += 24) sock.write(capture.subarray(off, off + 24));
        sock.end();

        await waitFor(async () => {
            const h = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/health`)).json();
            return h.words > 100;
        }, 4000, 'words ingested');

        const snap = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/state`)).json();
        assert.equal(snap.params.length, 6);
        for (const p of snap.params) {
            assert.equal(p.stale, false, `${p.tag} should be fresh`);
            assert.equal(p.valid, true, `${p.tag} should be valid`);
            assert.equal(typeof p.value, 'number', `${p.tag} should have a value`);
        }
        // Values must be inside the label's own range.
        for (const p of snap.params) {
            const def = labelsDoc.labels.find((d) => d.tag === p.tag);
            assert.ok(p.value >= def.min - def.lsbPerBit && p.value <= def.max + def.lsbPerBit,
                `${p.tag}=${p.value} outside ${def.min}..${def.max}`);
        }
    } finally {
        backend.close();
    }
});

test('live: SSE pushes state frames and a config change reaches the SFD stream', async () => {
    const ports = nextPorts();
    const backend = startBackend(ports);
    try {
        await waitFor(async () => {
            try {
                return (await fetch(`http://127.0.0.1:${ports.httpPort}/api/health`)).ok;
            } catch {
                return false;
            }
        });

        const capture = readFileSync(capturePath);
        const sock = connect(ports.a429Port, '127.0.0.1');
        await new Promise((r) => sock.on('connect', r));
        sock.write(capture.subarray(0, 600));

        // Two state frames is enough to prove the 20 Hz push works.
        const states = await collectSse(`http://127.0.0.1:${ports.httpPort}/events`, 'state', 2);
        assert.equal(states.length, 2);
        assert.equal(states[0].params.length, 6);

        // A slider change must be broadcast on the config stream. The stream
        // also sends an initial snapshot, so wait specifically for the change.
        const cfgPromise = collectSseMatching(
            `http://127.0.0.1:${ports.httpPort}/config-events`,
            'config',
            (ev) => ev.config?.PITCH?.min === -5,
            1,
            3000,
        );
        const post = await fetch(`http://127.0.0.1:${ports.httpPort}/api/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: '324', patch: { min: -5, max: 5, visible: false } }),
        });
        assert.equal(post.status, 200);
        const [cfg] = await cfgPromise;

        assert.equal(cfg.config.PITCH.min, -5);
        assert.equal(cfg.config.PITCH.max, 5);
        assert.equal(cfg.config.PITCH.visible, false);
        // Untouched parameters keep their defaults.
        assert.equal(cfg.config.CAS.min, 0);
        sock.destroy();
    } finally {
        backend.close();
    }
});

test('live: a silent bus drives every parameter stale and annunciates A429 LOSS', async () => {
    const ports = nextPorts();
    const backend = startBackend(ports);
    try {
        await waitFor(async () => {
            try {
                return (await fetch(`http://127.0.0.1:${ports.httpPort}/api/health`)).ok;
            } catch {
                return false;
            }
        });

        assert.equal(
            (await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/state`)).json()).params.every((p) => p.stale),
            true,
            'with no A429 source every parameter must be stale',
        );

        // Feed briefly, then stop: the watchdog must trip.
        const capture = readFileSync(capturePath);
        const sock = connect(ports.a429Port, '127.0.0.1');
        await new Promise((r) => sock.on('connect', r));
        sock.write(capture.subarray(0, 600));
        await waitFor(async () => {
            const s = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/state`)).json();
            return s.params.every((p) => !p.stale);
        }, 3000, 'all fresh while the bus is alive');

        sock.destroy();
        // STALE_MS is 250 ms; wait comfortably past it.
        await new Promise((r) => setTimeout(r, 450));
        const s = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/state`)).json();
        assert.equal(s.params.every((p) => p.stale), true, 'watchdog must trip after silence');
        assert.equal(s.params.every((p) => p.value === null), true, 'stale values must not be shown');
    } finally {
        backend.close();
    }
});

/* --------------------------------------------------------------- DECOUPLING */

test('DECOUPLED: backend replays a capture with QEMU and gamepad absent', async () => {
    const ports = nextPorts();
    // No A429 TCP server at all: replayPath is the only source. Nothing here
    // knows that the words originally came from an ARM firmware driven by a pad.
    const backend = startBackend({ ...ports, replayPath: capturePath });
    try {
        await waitFor(async () => {
            const h = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/health`)).json();
            return h.words > 60;
        }, 4000, 'replayed words');

        const snap = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/state`)).json();
        const fresh = snap.params.filter((p) => !p.stale && p.valid);
        assert.equal(fresh.length, 6, 'all six labels must decode from the recording alone');

        // And the display config still works with no embedded layer at all.
        const r = await fetch(`http://127.0.0.1:${ports.httpPort}/api/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: '206', patch: { min: 40, max: 200 } }),
        });
        assert.equal(r.status, 200);
        const cfg = await (await fetch(`http://127.0.0.1:${ports.httpPort}/api/config`)).json();
        assert.deepEqual(cfg.params.find((p) => p.tag === 'CAS').config, { min: 40, max: 200, visible: true });
    } finally {
        backend.close();
    }
});

test('DECOUPLED: no A429 port is opened in replay mode', async () => {
    const ports = nextPorts();
    const backend = startBackend({ ...ports, replayPath: capturePath });
    try {
        assert.equal(backend.a429Server, null, 'replay mode must not listen for a live bus');
        await assert.rejects(
            new Promise((res, rej) => {
                const s = connect(ports.a429Port, '127.0.0.1');
                s.on('connect', () => { s.destroy(); res(); });
                s.on('error', rej);
            }),
            'nothing should accept a live A429 connection in replay mode',
        );
    } finally {
        backend.close();
    }
});

/* ---------------------------------------------------------------- static UI */

test('both pages and their assets are served', async () => {
    const ports = nextPorts();
    const backend = startBackend({ ...ports, replayPath: capturePath });
    const base = `http://127.0.0.1:${ports.httpPort}`;
    try {
        await waitFor(async () => {
            try {
                return (await fetch(`${base}/api/health`)).ok;
            } catch {
                return false;
            }
        });

        for (const [path, needle] of [
            ['/config', 'display configuration'],
            ['/sfd', 'Secondary Flight Display'],
            ['/js/config.js', '/api/config'],
            ['/js/sfd.js', 'drawTape'],
            ['/css/app.css', '--a429'],
            ['/css/sfd.css', 'sfd-page'],
        ]) {
            const res = await fetch(base + path);
            assert.equal(res.status, 200, `${path} status`);
            const text = await res.text();
            assert.ok(text.length > 100, `${path} body`);
            assert.ok(text.includes(needle), `${path} should contain ${needle}`);
        }

        const nf = await fetch(base + '/nope');
        assert.equal(nf.status, 404);
    } finally {
        backend.close();
    }
});
