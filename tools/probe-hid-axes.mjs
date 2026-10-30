// Reads the pad's live HID values by running the reader in -Echo for a moment
// and parsing the hex reports, then reports the Generic Desktop values.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 5791;
if (!existsSync('build')) mkdirSync('build');

const listener = createServer();
let sock = null;
listener.on('connection', s => { sock = s; });
await new Promise(r => listener.listen(PORT, '127.0.0.1', r));

const reader = spawn('powershell.exe',
  ['-NoProfile','-ExecutionPolicy','Bypass','-File','host/pad-reader.ps1','-Port',String(PORT),'-Echo'],
  { stdio: ['ignore','pipe','pipe'] });

const lines = [];
reader.stdout.on('data', d => lines.push(...String(d).split('\n')));
reader.stderr.on('data', d => lines.push('[err] ' + String(d).trim()));

await new Promise(r => setTimeout(r, 3000));
// let it stream for a couple of seconds so reports arrive
await new Promise(r => setTimeout(r, 2500));

reader.kill();
sock?.destroy();
listener.close();

const reports = [...new Set(lines.filter(l => /report \d+B:/.test(l)).map(l => l.trim()))];
const frames  = lines.filter(l => /seq=/.test(l)).map(l => l.trim());

console.log(`distinct raw reports: ${reports.length}`);
for (const r of reports.slice(0, 8)) console.log('  ' + r);
console.log(`\nnormalised frames: ${frames.length}`);
for (const f of frames.slice(-6)) console.log('  ' + f);

const errs = lines.filter(l => l.startsWith('[err]'));
if (errs.length) { console.log('\nstderr:'); errs.slice(0,5).forEach(e=>console.log('  '+e)); }
process.exit(0);
