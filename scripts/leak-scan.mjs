#!/usr/bin/env node
// Leak scan: fails when the repo (or the commits being pushed) contain personal data.
//
//   node scripts/leak-scan.mjs [--root <dir>]      scan tracked files (+ LEAK_SCAN_RANGE commits if set)
//
// LEAK_SCAN_RANGE is `<before>..<after>`. A new branch's push has an all-zero <before>: it is scanned against the
// default branch (LEAK_SCAN_DEFAULT_BRANCH, else origin/HEAD, else main/master), or every commit when there is none.
//   node scripts/leak-scan.mjs --add "<phrase>"    add a private phrase to the hashed denylist (needs LEAK_SCAN_KEY)
//
// Checks:
// - generic: email addresses (except placeholder/noreply domains), phone numbers (international, and North American
//   without +1), home-directory paths;
// - in the pushed range: every commit's patch, message (subject and body) and author/committer, and every blob the range
//   adds (so a file added then removed, or one git shows as binary, is still read);
// - UTF-16 text (with or without a BOM) is decoded first; other binaries are read as their printable runs (ASCII and
//   UTF-16LE), which is where metadata hides;
// - a private denylist stored only as HMAC-SHA256 digests (key in LEAK_SCAN_KEY, never in the repo), matched against every
//   1-3 word window; skipped with a notice when the key is absent (forks);
// - a local plaintext list, ${CREWDECK_HOME:-~/.crewdeck}/leak-denylist.txt, when present (the owner's machine only).
// Findings name the file, line and rule, never the private phrase.
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
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
// North American numbers without +1 (NANP: area code and exchange start with 2-9), shaped like "212-555-0142",
// "(212) 555-0142", "212.555.0142" or "1-212-555-0142" (555-01xx is the fictional block). One separator style throughout, nothing digit-like glued to either end, so versions
// (10.15.7), dates, SSN-shaped ids (123-45-6789), bare 10-digit ids and port ranges don't match.
const NANP = /(?<![\w.+/(-])(?:1([ .-]))?(?:\(([2-9]\d{2})\) ?|([2-9]\d{2})([ .-]))([2-9]\d{2})([ .-])(\d{4})(?![\w]|[.-]\w)/g;
const nanpOk = (m) => {
  const [, lead, , bare, s1, , s2] = m;
  if (bare !== undefined && s1 !== s2) return false; // "415-867.5309"
  if (lead !== undefined && bare !== undefined && lead !== s1) return false;
  return true;
};
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
    let phone = false;
    for (const m of line.matchAll(PHONE)) if (!FAKE_PHONE.test(m[0].replace(/\D/g, ''))) { report(where, i + 1, 'phone number'); phone = true; }
    if (!phone) for (const m of line.matchAll(NANP)) if (nanpOk(m) && !FAKE_PHONE.test(m[0].replace(/\D/g, ''))) { report(where, i + 1, 'phone number'); break; }
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

/** UTF-16 without a BOM: in text, most characters are ASCII, so every other byte is zero. */
function utf16Order(buf) {
  const n = Math.min(buf.length, 8000) & ~1;
  if (n < 8) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
  const half = n / 2;
  if (odd > half * 0.4 && even < half * 0.05) return 'le';
  if (even > half * 0.4 && odd < half * 0.05) return 'be';
  return null;
}

/** Text of a file: UTF-8, UTF-16 (BOM or not); for other binaries (images, PDFs) the printable runs, ASCII and UTF-16LE. */
export function textOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le');
  if (!buf.subarray(0, 8000).includes(0)) return buf.toString('utf8');
  const order = utf16Order(buf);
  if (order === 'le') return buf.subarray(0, buf.length & ~1).toString('utf16le');
  if (order === 'be') return Buffer.from(buf.subarray(0, buf.length & ~1)).swap16().toString('utf16le');
  const latin = buf.toString('latin1');
  const ascii = latin.match(/[\x20-\x7e]{6,}/g) ?? [];
  const wide = (latin.match(/(?:[\x20-\x7e]\x00){6,}/g) ?? []).map((s) => s.replace(/\x00/g, ''));
  return [...ascii, ...wide].join('\n');
}

const git = (...a) => {
  const o = typeof a[a.length - 1] === 'object' ? a.pop() : {};
  return execFileSync('git', a, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...o });
};
for (const f of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').toString('utf8').split('\0').filter(Boolean)) {
  const p = join(ROOT, f);
  if (!existsSync(p) || statSync(p).isDirectory()) continue; // a nested checkout (a worktree) is listed as a folder
  scanText(f, textOf(readFileSync(p)), { denylist: !attributionFiles.has(f) });
}

const ZERO = /^0{40}$/;
const hasRef = (ref) => { try { git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; } };

/** The range to scan: a new branch (all-zero <before>) is compared with the default branch, or scanned whole. */
function resolveRange(raw) {
  const m = /^([^.]*)\.\.(.+)$/.exec(raw);
  if (!m || !ZERO.test(m[1])) return raw;
  const candidates = [process.env.LEAK_SCAN_DEFAULT_BRANCH, (() => { try { return git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').toString().trim(); } catch { return ''; } })(), 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean);
  const base = candidates.find(hasRef);
  return base ? `${base}..${m[2]}` : m[2];
}

const range = process.env.LEAK_SCAN_RANGE ? resolveRange(process.env.LEAK_SCAN_RANGE) : '';
if (range) {
  console.log(`leak-scan: commits ${range}`);
  // Every commit being pushed: its patch, its whole message and who wrote it.
  const log = git('log', '-p', '--no-color', '--format=commit %H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%B', range).toString('utf8');
  scanText(`commits ${range}`, log);
  // Every blob those commits add, whatever git thinks of it (binary, UTF-16) and even if a later commit removed it.
  const objects = git('rev-list', '--objects', '--no-object-names', range).toString('utf8').split('\n').filter(Boolean);
  const named = new Map(git('rev-list', '--objects', range).toString('utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, 40), l.slice(41)]));
  const kinds = objects.length ? git('cat-file', '--batch-check=%(objectname) %(objecttype)', { input: objects.join('\n') }).toString('utf8').split('\n') : [];
  for (const line of kinds) {
    const [sha, type] = line.split(' ');
    if (type !== 'blob') continue;
    const path = named.get(sha) || sha;
    scanText(`${path}@${sha.slice(0, 7)}`, textOf(git('cat-file', 'blob', sha)), { denylist: !attributionFiles.has(path) });
  }
}

if (!KEY && digests.size) console.log(`leak-scan: LEAK_SCAN_KEY not set: ${digests.size} private digests not checked (generic checks still ran)`);
if (findings.length) {
  console.error(`leak-scan: ${findings.length} finding(s):\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('leak-scan: clean');
