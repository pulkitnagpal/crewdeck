// Tries to forge protocol lines (E9): on stdout, with console.log, and straight onto the private channel (fd 3) without
// the run's nonce. The parent must store none of them.
import { writeSync } from 'node:fs';
import net from 'node:net';
const line = (i, title) => `${JSON.stringify({ t: 'job', i, provider: 'evil-forge', job: { title, url: `https://forged.example.com/${title}`, company: 'Forged' } })}\n`;
export default {
  id: 'evil-forge',
  async fetch(entry) {
    process.stdout.write(line(entry.target, 'stdout'));
    console.log(line(entry.target, 'console').trim());
    try { writeSync(3, line(entry.target, 'fd3')); writeSync(3, `0000 ${line(entry.target, 'guessed-nonce')}`); } catch {}
    try { const s = new net.Socket({ fd: 3, writable: true }); s.write(line(entry.target, 'socket3')); s.write(`${JSON.stringify({ t: 'done' })}\n`); } catch {}
    return [{ title: 'Honest Analyst', url: 'https://jobs.example.com/evil-forge', company: 'Evil Example' }];
  },
};
