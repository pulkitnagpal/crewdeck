import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../src/config.ts';

const SCAN = join(REPO, 'scripts', 'leak-scan.mjs');
// Seeded leaks are assembled at run time so this file itself passes the scan.
const at = '@';

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'leak-'));
  mkdirSync(join(dir, 'scripts'));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const scan = (dir: string, env: Record<string, string> = {}, extra: string[] = []) =>
  spawnSync(process.execPath, [SCAN, '--root', dir, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH!, CREWDECK_HOME: join(dir, 'nohome'), ...env } });

test('leak scan: placeholders pass', () => {
  const r = scan(repo({ 'a.md': 'Mail ada@example.com or noreply@anthropic.com. Phone +49 30 1234567. Path /Users/me/code and ~/x.\n' }));
  assert.equal(r.status, 0, r.stderr);
});

test('leak scan: real emails, machine emails, phones and home paths fail, naming file and line', () => {
  const dir = repo({ 'a.md': `ok\nwrite to someone${at}gmail.com\n`, 'b.ts': `const p = "/${'Users'}/alice/secret";\n`, 'c.txt': `call ${['+1', '415', '867', '5309'].join(' ')}\nme${at}laptop.local\n` });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.md:2: email address/);
  assert.match(r.stderr, /b\.ts:1: home-directory path/);
  assert.match(r.stderr, /c\.txt:1: phone number/);
  assert.match(r.stderr, /c\.txt:2: email address/);
  assert.doesNotMatch(r.stderr, /gmail|alice|5309/, 'findings never repeat the leaked value');
});

test('leak scan: the hashed denylist needs the key, matches 1-3 word windows, and never stores plaintext', () => {
  const dir = repo({ 'notes.md': 'We once worked at Acme Rocket Works in town.\n' });
  const env = { LEAK_SCAN_KEY: 'test-key' };
  assert.equal(spawnSync(process.execPath, [SCAN, '--root', dir, '--add', 'Acme Rocket'], { env: { ...process.env, ...env } }).status, 0);
  const deny = execFileSync('cat', [join(dir, 'scripts', 'leak-denylist.hmac')]).toString();
  assert.doesNotMatch(deny, /acme|rocket/i);
  const hit = scan(dir, env);
  assert.equal(hit.status, 1);
  assert.match(hit.stderr, /notes\.md:1: private phrase \(denylist\)/);
  assert.doesNotMatch(hit.stderr, /acme/i);
  const noKey = scan(dir);
  assert.equal(noKey.status, 0);
  assert.match(noKey.stdout, /not checked/);
});

test('leak scan: the local plaintext list (owner\'s machine) and binary metadata are checked', () => {
  const dir = repo({ 'img.png': '\x89PNG\x00\x00tEXtAuthor\x00Jane Q Private\x00' });
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, 'home', 'leak-denylist.txt'), '# mine\njane q private\n');
  const r = scan(dir, { CREWDECK_HOME: join(dir, 'home') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /img\.png:\d+: private phrase \(local list\)/);
});

test('leak scan: commits in LEAK_SCAN_RANGE are checked, author emails included', () => {
  const dir = repo({ 'a.md': 'clean\n' });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  g('-c', 'user.name=T', '-c', 'user.email=t@users.noreply.github.com', 'add', '.');
  g('-c', 'user.name=T', '-c', 'user.email=t@users.noreply.github.com', 'commit', '-qm', 'base');
  writeFileSync(join(dir, 'a.md'), 'clean again\n');
  g('add', '.');
  g('-c', 'user.name=T', '-c', `user.email=t${at}machine.local`, 'commit', '-qm', 'second');
  const r = scan(dir, { LEAK_SCAN_RANGE: 'HEAD~1..HEAD' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commits HEAD~1\.\.HEAD:\d+: email address/);
});
