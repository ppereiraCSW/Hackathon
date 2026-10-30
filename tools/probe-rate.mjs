// Measure the firmware's real A429 frame rate through a TCP serial socket.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { qemuPath } from '../firmware/build.mjs';

const port = 5555;
const seconds = Number(process.argv[2] || 4);
let bytes = 0; let start = 0;
const srv = createServer((sock) => {
  start = Date.now();
  sock.on('data', (d) => { bytes += d.length; });
});
srv.listen(port, '127.0.0.1', () => {
  const q = spawn(qemuPath(), [
    '-M', 'mps2-an385', '-cpu', 'cortex-m3', '-nographic', '-monitor', 'none',
    '-chardev', `socket,id=u0,host=127.0.0.1,port=${port},server=off`,
    '-serial', 'chardev:u0',
    '-kernel', 'firmware/build/firmware-main.elf',
  ], { stdio: 'ignore' });
  setTimeout(() => {
    q.kill();
    const el = (Date.now() - start) / 1000;
    const frames = Math.max(0, (bytes - 12)) / 24;
    console.log(`bytes=${bytes} frames=${frames} elapsed=${el.toFixed(2)}s rate=${(frames / el).toFixed(2)} Hz`);
    srv.close(); process.exit(0);
  }, seconds * 1000 + 300);
});
