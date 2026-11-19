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

// E4: the gaps the review found.
const commit = (dir: string, msg: string, email = 't@users.noreply.github.com') => execFileSync('git', ['-c', 'user.name=T', '-c', `user.email=${email}`, 'commit', '-qm', msg], { cwd: dir });
const add = (dir: string) => execFileSync('git', ['add', '-A'], { cwd: dir });

test('E4: commit message bodies in the pushed range are scanned', () => {
  const dir = repo({ 'a.md': 'clean\n' });
  add(dir); commit(dir, 'base');
  writeFileSync(join(dir, 'a.md'), 'clean too\n');
  add(dir); commit(dir, `Fix the form\n\nReported by someone${at}gmail.com on the call.`);
  const r = scan(dir, { LEAK_SCAN_RANGE: 'HEAD~1..HEAD' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commits HEAD~1\.\.HEAD:\d+: email address/);
});

test('E4: UTF-16 files (with or without a BOM, either byte order) are decoded and scanned', () => {
  const text = `Contact: someone${at}gmail.com\n`;
  const le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
  const dir = repo({});
  writeFileSync(join(dir, 'bom-le.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
  writeFileSync(join(dir, 'bom-be.txt'), Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
  writeFileSync(join(dir, 'no-bom.txt'), le);
  writeFileSync(join(dir, 'meta.bin'), Buffer.concat([Buffer.from([0, 1, 2, 3, 0, 0]), Buffer.from(`Author: someone${at}gmail.com`, 'utf16le'), Buffer.from([0, 0, 9])]));
  const r = scan(dir);
  assert.equal(r.status, 1);
  for (const f of ['bom-le.txt', 'bom-be.txt', 'no-bom.txt', 'meta.bin']) assert.match(r.stderr, new RegExp(`${f.replace('.', '\\.')}:\\d+: email address`), f);
});

test('E4: North American numbers without +1 are phones; versions, dates, ids and fictional numbers are not', () => {
  // Assembled at run time so this file passes the scan.
  const [x, y, z] = ['415', '867', '5309'];
  const nums = [`${x}-${y}-${z}`, `(${x}) ${y}-${z}`, `${x}.${y}.${z}`, `1-${x}-${y}-${z}`, `${x} ${y} ${z}`];
  const dir = repo({ 'p.md': nums.map((n) => `call ${n} today`).join('\n') + '\n' });
  const r = scan(dir);
  assert.equal(r.status, 1);
  for (let i = 1; i <= nums.length; i++) assert.match(r.stderr, new RegExp(`p\\.md:${i}: phone number`), nums[i - 1]);
  const fine = ['v1.2.3 and 10.15.7', 'on 2026-11-19 at 12:30:45', 'build 4158675309', 'ssn-like 123-45-6789', 'placeholder 123-456-7890', 'ports 4747-4949',
    'fictional 800-555-0199', 'fictional (312) 555-0142', 'isbn 978-3-16-148410-0', 'semver 415.867.5309-rc.1', 'ip 192.168.100.200', 'mixed 415-867.5309', 'ours 415-123-4567'];
  const ok = scan(repo({ 'q.md': fine.join('\n') + '\n' }));
  assert.equal(ok.status, 0, ok.stderr);
});

test('E4: a new branch (range from the all-zero sha) is scanned against the default branch; blobs in the range too', () => {
  const dir = repo({ 'a.md': 'clean\n' });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  add(dir); commit(dir, 'base');
  g('branch', '-M', 'main');
  g('checkout', '-qb', 'feature');
  // Added and removed again inside the pushed commits: the tree is clean, the history is not (UTF-16, so no text diff).
  writeFileSync(join(dir, 'tmp.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`call someone${at}gmail.com\n`, 'utf16le')]));
  add(dir); commit(dir, 'add notes');
  g('rm', '-q', 'tmp.txt'); commit(dir, 'remove notes');
  assert.equal(scan(dir).status, 0, 'the tree alone is clean');
  const r = scan(dir, { LEAK_SCAN_RANGE: `${'0'.repeat(40)}..feature`, LEAK_SCAN_DEFAULT_BRANCH: 'main' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /tmp\.txt@[0-9a-f]{7,}:\d+: email address/);
  assert.match(r.stdout + r.stderr, /main\.\.feature/);
  // No default branch to compare with (a first push): every commit of the branch.
  const r2 = scan(dir, { LEAK_SCAN_RANGE: `${'0'.repeat(40)}..feature`, LEAK_SCAN_DEFAULT_BRANCH: 'nowhere' });
  assert.equal(r2.status, 1);
});

test('E7: CI pins every action by commit SHA; only the leak-scan step gets the key; the tests run without it, on Node 22, 24 and 25', async () => {
  const { parse } = await import('yaml');
  const { readFileSync } = await import('node:fs');
  const wf = parse(readFileSync(join(REPO, '.github', 'workflows', 'test.yml'), 'utf8'));
  const job = wf.jobs.test;
  assert.deepEqual(job.strategy.matrix.node, ['22.x', '24.x', '25.x']);
  const steps: any[] = job.steps;
  for (const s of steps.filter((x) => x.uses)) assert.match(s.uses, /^actions\/[\w-]+@[0-9a-f]{40}$/, s.uses);
  const keyed = steps.filter((s) => JSON.stringify(s).includes('LEAK_SCAN_KEY'));
  assert.deepEqual(keyed.map((s) => s.name), ['leak scan']);
  assert.match(keyed[0].run, /node scripts\/leak-scan\.mjs/);
  const tests = steps.find((s) => s.name === 'tests');
  assert.equal(tests.env, undefined);
  assert.match(tests.run, /^node --test /, 'not npm test, which would run the scan again');
  assert.equal(wf.env, undefined);
  assert.equal(job.env, undefined, 'no job-wide secrets');
  assert.ok(!('pull_request_target' in (Array.isArray(wf.on) ? Object.fromEntries(wf.on.map((x: string) => [x, 1])) : wf.on)));
});
