/**
 * Backend server: A429 ingest, decode, display config, HTTP + SSE.
 *
 * Two surfaces, as decided:
 *   /config  -- one slider per received parameter (display min/max + visible)
 *   /sfd     -- the Secondary Flight Display
 *
 * Decoupling: this process knows nothing about QEMU, the gamepad or the
 * firmware. It accepts A429 bytes on a TCP socket and can be pointed at a
 * recorded capture file instead (see --replay), which is how the decoupling
 * is tested.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFile, readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { extname, join, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParamState } from './state.js';
import { DisplayConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

const SSE_HZ = 20;

/** @returns {{state:ParamState, config:DisplayConfig, close:()=>void, server:object}} */
export function startBackend({
    labelsPath = join(ROOT, 'shared', 'labels.json'),
    httpPort = 8090,
    a429Port = 5555,
    sseHz = SSE_HZ,
    replayPath = null,
    now = () => Date.now(),
} = {}) {
    const labelsDoc = JSON.parse(readFileSync(labelsPath, 'utf8'));
    const state = new ParamState(labelsDoc, { now });
    const config = new DisplayConfig(labelsDoc);

    /** @type {Set<import('node:http').ServerResponse>} */
    const stateClients = new Set();
    /** @type {Set<import('node:http').ServerResponse>} */
    const configClients = new Set();

    // ---------------------------------------------------------- SSE plumbing
    function sseWrite(res, event, data) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    const sseTimer = setInterval(() => {
        if (stateClients.size === 0) return;
        const snap = state.snapshot();
        for (const res of stateClients) sseWrite(res, 'state', snap);
    }, Math.round(1000 / sseHz));
    sseTimer.unref?.();

    function broadcastConfig() {
        const payload = { config: config.forDisplay(), at: now() };
        for (const res of configClients) sseWrite(res, 'config', payload);
    }

    // ------------------------------------------------------------ HTTP server
    const http = createHttpServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;

        const cors = {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
            'access-control-allow-headers': 'content-type',
        };
        if (req.method === 'OPTIONS') {
            res.writeHead(204, cors).end();
            return;
        }

        try {
            if (path === '/api/state') {
                const body = JSON.stringify(state.snapshot());
                res.writeHead(200, { ...cors, 'content-type': MIME['.json'] }).end(body);
                return;
            }

            if (path === '/api/config' && req.method === 'GET') {
                const body = JSON.stringify({
                    params: config.list(),
                    display: config.forDisplay(),
                    labels: labelsDoc,
                });
                res.writeHead(200, { ...cors, 'content-type': MIME['.json'] }).end(body);
                return;
            }

            if (path === '/api/config' && req.method === 'POST') {
                const raw = await readBody(req);
                let body;
                try {
                    body = JSON.parse(raw);
                } catch {
                    res.writeHead(400, { ...cors, 'content-type': MIME['.json'] });
                    res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
                    return;
                }
                const result = config.set(String(body.label), body.patch ?? body);
                if (!result.ok) {
                    res.writeHead(400, { ...cors, 'content-type': MIME['.json'] });
                    res.end(JSON.stringify(result));
                    return;
                }
                broadcastConfig();
                res.writeHead(200, { ...cors, 'content-type': MIME['.json'] });
                res.end(JSON.stringify({ ok: true, label: body.label, config: result.config }));
                return;
            }

            if (path === '/api/config/reset' && req.method === 'POST') {
                const raw = await readBody(req);
                const body = JSON.parse(raw || '{}');
                const result = config.reset(String(body.label));
                if (!result.ok) {
                    res.writeHead(400, { ...cors, 'content-type': MIME['.json'] });
                    res.end(JSON.stringify(result));
                    return;
                }
                broadcastConfig();
                res.writeHead(200, { ...cors, 'content-type': MIME['.json'] });
                res.end(JSON.stringify({ ok: true }));
                return;
            }

            if (path === '/api/health') {
                const snap = state.snapshot();
                const body = JSON.stringify({
                    ok: true,
                    uptimeMs: snap.stats.uptimeMs,
                    words: snap.stats.words,
                    parityErrors: snap.stats.parityErrors,
                    unknownLabels: snap.stats.unknownLabels,
                    resyncs: snap.stats.resyncs,
                    staleTags: snap.params.filter((p) => p.stale).map((p) => p.tag),
                    sseClients: stateClients.size,
                    configClients: configClients.size,
                });
                res.writeHead(200, { ...cors, 'content-type': MIME['.json'] }).end(body);
                return;
            }

            if (path === '/events' || path === '/api/events') {
                res.writeHead(200, {
                    ...cors,
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.write('retry: 1000\n\n');
                stateClients.add(res);
                sseWrite(res, 'state', state.snapshot());
                sseWrite(res, 'config', { config: config.forDisplay(), at: now() });
                const drop = () => stateClients.delete(res);
                req.on('close', drop);
                res.on('close', drop);
                return;
            }

            if (path === '/config-events') {
                res.writeHead(200, {
                    ...cors,
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.write('retry: 1000\n\n');
                configClients.add(res);
                sseWrite(res, 'config', { config: config.forDisplay(), at: now() });
                const drop = () => configClients.delete(res);
                req.on('close', drop);
                res.on('close', drop);
                return;
            }

            // -------------------------------------------------- static files
            // Friendly URLs: /config and /sfd map to their .html files.
            const FRIENDLY = {
                '/': '/config.html',
                '/config': '/config.html',
                '/sfd': '/sfd.html',
            };
            const rel = FRIENDLY[path] ?? path;
            const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
            const filePath = join(ROOT, 'frontend', safe);
            if (!filePath.startsWith(join(ROOT, 'frontend'))) {
                res.writeHead(403).end('forbidden');
                return;
            }
            const data = await readFileAsync(filePath);
            const type = MIME[extname(filePath)] ?? 'application/octet-stream';
            res.writeHead(200, { ...cors, 'content-type': type }).end(data);
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { ...cors, 'content-type': 'text/plain' }).end('not found');
                return;
            }
            res.writeHead(500, { ...cors, 'content-type': 'text/plain' }).end(String(err));
        }
    });

    // --------------------------------------------------------------- A429 in
    /** @type {import('node:net').Server|null} */
    let a429Server = null;
    let replayTimer = null;
    let pending = Buffer.alloc(0);

    if (replayPath) {
        // Decoupled mode: no QEMU, no pad. Feed a recorded capture at 50 Hz.
        const bytes = readFileSync(replayPath);
        let off = 0;
        const wordsPerTick = 6;
        replayTimer = setInterval(() => {
            if (off + 4 > bytes.length) {
                off = 0; // loop the capture
                return;
            }
            for (let i = 0; i < wordsPerTick && off + 4 <= bytes.length; i++) {
                state.ingestWord(bytes.readUInt32LE(off));
                off += 4;
            }
        }, 1000 / 50);
        replayTimer.unref?.();
    } else {
        a429Server = createTcpServer((sock) => {
            sock.on('data', (chunk) => {
                pending = Buffer.concat([pending, chunk]);
                pending = Buffer.from(state.ingestChunk(pending));
            });
            sock.on('error', () => {});
        });
        a429Server.listen(a429Port, '127.0.0.1');
    }

    const server = http.listen(httpPort, '127.0.0.1');

    return {
        state,
        config,
        labelsDoc,
        httpServer: server,
        a429Server,
        get ports() {
            return {
                http: httpPort,
                a429: a429Port,
            };
        },
        close() {
            clearInterval(sseTimer);
            if (replayTimer) clearInterval(replayTimer);
            for (const r of stateClients) r.end();
            for (const r of configClients) r.end();
            server.close();
            a429Server?.close();
        },
    };
}

function readBody(req) {
    return new Promise((res, rej) => {
        let s = '';
        req.on('data', (d) => {
            s += d;
            if (s.length > 1e6) rej(new Error('body too large'));
        });
        req.on('end', () => res(s));
        req.on('error', rej);
    });
}
