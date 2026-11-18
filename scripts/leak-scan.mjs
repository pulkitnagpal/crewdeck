#!/usr/bin/env node
// Leak scan: fails when the repo (or the commits being pushed) contain personal data.
//
//   node scripts/leak-scan.mjs [--root <dir>]      scan tracked files (+ LEAK_SCAN_RANGE commits if set)
//   node scripts/leak-scan.mjs --add "<phrase>"    add a private phrase to the hashed denylist (needs LEAK_SCAN_KEY)
//
// Checks:
// - generic: email addresses (except placeholder/noreply domains), phone numbers, home-directory paths;
// - a private denylist stored only as HMAC-SHA256 digests (key in LEAK_SCAN_KEY, never in the repo), matched against every
//   1-3 word window; skipped with a notice when the key is absent (forks);
// - a local plaintext list, ${CREWDECK_HOME:-~/.crewdeck}/leak-denylist.txt, when present (the owner's machine only).
// Findings name the file, line and rule, never the private phrase.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const ROOT = opt('root') ?? process.cwd();
const KEY = process.env.LEAK_SCAN_KEY ?? '';
const DENY_FILE = join(ROOT, 'scripts', 'leak-denylist.hmac');
const ALLOW_FILE = join(ROOT, 'scripts', 'leak-allow.json');
const LOCAL_LIST = join(process.env.CREWDECK_HOME ?? join(homedir(), '.crewdeck'), 'leak-denylist.txt');

export const normalise = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
const hmac = (s) => createHmac('sha256', KEY).update(s).digest('hex');

if (opt('add') !== undefined) {
  if (!KEY) { console.error('LEAK_SCAN_KEY is not set'); process.exit(2); }
  const phrase = normalise(opt('add'));
  const words = phrase.split(' ').length;
  if (!phrase || words > 3) { console.error('a phrase is 1 to 3 words'); process.exit(2); }
  appendFileSync(DENY_FILE, hmac(phrase) + '\n');
  console.log('added one digest');
  process.exit(0);
}

const allow = existsSync(ALLOW_FILE) ? JSON.parse(readFileSync(ALLOW_FILE, 'utf8')) : {};
const publicIds = (allow.publicIdentifiers ?? []).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
const attributionFiles = new Set(allow.attributionFiles ?? []);

const digests = new Set(existsSync(DENY_FILE) ? readFileSync(DENY_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[a-f0-9]{64}$/.test(l)) : []);
const localPhrases = new Set(existsSync(LOCAL_LIST) ? readFileSync(LOCAL_LIST, 'utf8').split('\n').map(normalise).filter(Boolean) : []);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const OK_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com)$|^noreply@anthropic\.com$/i;
const PHONE = /(?<![\w.+/-])(\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{2,5}(?:[ .-]?\d{2,5}){1,3}|\(\d{3}\) ?\d{3}-\d{4})(?![\w.-]*\d)/g;
// Obviously fictional numbers are fine: 123 4567, 555-01xx, all zeros.
const FAKE_PHONE = /1234567|555[ .-]?01\d\d|0{6,}/;
const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const OK_HOME = new Set(['me', 'you', 'user', 'runner', 'example', 'someone', 'shared']);

const findings = [];
const report = (where, line, rule) => findings.push(`${where}:${line}: ${rule}`);

function scanText(where, text, { denylist = true } = {}) {
  for (const re of publicIds) text = text.replace(re, ' ');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) report(where, i + 1, 'email address');
    for (const m of line.matchAll(PHONE)) if (!FAKE_PHONE.test(m[0].replace(/\D/g, ''))) report(where, i + 1, 'phone number');
    for (const m of line.matchAll(HOME_PATH)) if (!OK_HOME.has(m[1].toLowerCase())) report(where, i + 1, 'home-directory path');
    if (!denylist || (!digests.size && !localPhrases.size)) return;
    const words = normalise(line).split(' ').filter(Boolean);
    for (let a = 0; a < words.length; a++) for (let n = 1; n <= 3 && a + n <= words.length; n++) {
      const w = words.slice(a, a + n).join(' ');
      if (localPhrases.has(w)) { report(where, i + 1, 'private phrase (local list)'); return; }
      if (KEY && digests.has(hmac(w))) { report(where, i + 1, 'private phrase (denylist)'); return; }
    }
  });
}

/** Text of a file; for binaries (images, PDFs) the printable runs, which is where metadata hides. */
function textOf(buf) {
  if (!buf.subarray(0, 8000).includes(0)) return buf.toString('utf8');
  return (buf.toString('latin1').match(/[\x20-\x7e]{6,}/g) ?? []).join('\n');
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
for (const f of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').toString('utf8').split('\0').filter(Boolean)) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  scanText(f, textOf(readFileSync(p)), { denylist: !attributionFiles.has(f) });
}

const range = process.env.LEAK_SCAN_RANGE;
if (range) {
  // Every commit being pushed: its patch and who wrote it.
  const log = git('log', '-p', '--no-color', '--format=commit %H%nauthor %an <%ae>%ncommitter %cn <%ce>', range).toString('utf8');
  scanText(`commits ${range}`, log);
}

if (!KEY && digests.size) console.log(`leak-scan: LEAK_SCAN_KEY not set: ${digests.size} private digests not checked (generic checks still ran)`);
if (findings.length) {
  console.error(`leak-scan: ${findings.length} finding(s):\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('leak-scan: clean');
