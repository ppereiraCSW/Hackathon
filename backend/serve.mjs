#!/usr/bin/env node
/**
 * Starts the backend.
 *
 *   node backend/serve.mjs                     # live: A429 on TCP :5555
 *   node backend/serve.mjs --replay shared/capture.a429   # decoupled, no QEMU
 */
import { startBackend } from './src/server.js';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
};

const httpPort = Number(opt('--http-port', 8090));
const a429Port = Number(opt('--a429-port', 5555));
const replay = opt('--replay', null);

const backend = startBackend({
    httpPort,
    a429Port,
    replayPath: replay ? resolve(replay) : null,
});

console.log(`[backend] config page  http://127.0.0.1:${httpPort}/config`);
console.log(`[backend] SFD           http://127.0.0.1:${httpPort}/sfd`);
if (replay) {
    console.log(`[backend] DECOUPLED replay of ${replay} (no QEMU, no pad)`);
} else {
    console.log(`[backend] awaiting A429 words on tcp://127.0.0.1:${a429Port}`);
}

const shut = () => {
    console.log('\n[backend] shutting down');
    backend.close();
    process.exit(0);
};
process.on('SIGINT', shut);
process.on('SIGTERM', shut);
