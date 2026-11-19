import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitNote } from '../../src/jobs/notes.ts';
import { jobs, tempSetup, textFile } from './helpers.ts';

const front = (file: string) => parse(splitNote(readFileSync(file, 'utf8')).front!);
const todayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

test('jobs check: clean notes pass; a broken note fails with the path and the fix; jobs.home is private', () => {
  const s = tempSetup('berlin-analyst');
  const ok = jobs(s.home, ['check']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /✓ jobs\/search\.md/);
  assert.match(ok.out, /0 errors, 0 warnings/);
  assert.equal(statSync(s.jobsHome).mode & 0o777, 0o700);
  const file = join(s.vault, 'jobs', 'search.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('workplace: [onsite, hybrid]', 'workplace: [onsite, hybird]'));
  const bad = jobs(s.home, ['check']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /✗ jobs\/search\.md {2}\(using its last valid version\)/);
  assert.match(bad.out, /error\s+workplace\[1\]: "hybird" is not one of: remote, hybrid, onsite\. Fix: did you mean "hybrid"\?/);
});

test('jobs rules and judge-brief print what the notes compile to', () => {
  const s = tempSetup('us-nurse');
  const r = jobs(s.home, ['rules']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /title_gate/);
  assert.match(r.out, /remote from: Texas, Arizona/);
  const b = jobs(s.home, ['judge-brief']);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /# Judging brief for Riley/);
  assert.match(b.out, /RN \(Arizona\)/);
});

test('pref set: updates the frontmatter, keeps comments, logs the change in the user\'s words', () => {
  const s = tempSetup('berlin-analyst');
  const because = textFile(s.root, 'because.txt', "I'm OK with remote now,\nas long as it's in Germany.\n");
  const r = jobs(s.home, ['pref', 'set', 'search.workplace', 'onsite,hybrid,remote', '--because-file', because]);
  assert.equal(r.code, 0, r.err);
  const file = join(s.vault, 'jobs', 'search.md');
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(front(file).workplace, ['onsite', 'hybrid', 'remote']);
  assert.match(text, /workplace: \[ onsite, hybrid, remote \] # remote \| hybrid \| onsite/);
  assert.match(text, /# a title must contain one/);
  const line = `- ${todayIn('Europe/Berlin')}: workplace: onsite, hybrid → onsite, hybrid, remote. "I'm OK with remote now, as long as it's in Germany."`;
  assert.ok(text.includes(`## Changes\n- 2026-11-18: created during setup.\n${line}\n`), text);

  assert.equal(jobs(s.home, ['pref', 'set', 'pay.floor', '60000', '--because-file', because]).code, 0);
  assert.equal(front(file).pay.floor, 60000);
  assert.equal(jobs(s.home, ['pref', 'set', 'places.remote_from', 'Germany', '--because-file', because]).code, 0);
  assert.deepEqual(front(file).places.remote_from, ['Germany']);
  const langs = textFile(s.root, 'langs.txt', '[{ name: English, level: fluent }, { name: German, level: professional }]');
  assert.equal(jobs(s.home, ['pref', 'set', 'languages', '--value-file', langs, '--because-file', because]).code, 0);
  assert.equal(front(file).languages[1].level, 'professional');
});

test('pref set refuses invalid values, unknown paths and a missing because, leaving the note untouched', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'search.md');
  const before = readFileSync(file, 'utf8');
  const because = textFile(s.root, 'b.txt', 'because');
  const bad = jobs(s.home, ['pref', 'set', 'workplace', 'remote,sometimes', '--because-file', because]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /workplace\[1\]: "sometimes" is not one of/);
  const typo = jobs(s.home, ['pref', 'set', 'pay.flor', '1', '--because-file', because]);
  assert.match(typo.err, /did you mean "pay.floor"/);
  assert.match(jobs(s.home, ['pref', 'set', 'pay.floor', 'lots', '--because-file', because]).err, /not a number/);
  assert.match(jobs(s.home, ['pref', 'set', 'pay.floor', '1']).err, /--because-file/);
  assert.match(jobs(s.home, ['pref', 'set', 'rules.other_only', '\\bonly\\b', '--because-file', because]).err, /places/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('me set: profile and career fields, typed and validated', () => {
  const s = tempSetup('berlin-analyst');
  const profile = join(s.vault, 'me', 'profile.md'), career = join(s.vault, 'me', 'career.md');
  assert.equal(jobs(s.home, ['me', 'set', 'identity.email', 'ada.new@example.com']).code, 0);
  assert.equal(front(profile).identity.email, 'ada.new@example.com');
  assert.match(readFileSync(profile, 'utf8'), /# your words for recurring questions/);
  const answer = textFile(s.root, 'answer.txt', 'Two months, negotiable\n');
  assert.equal(jobs(s.home, ['me', 'set', 'standard_answers.notice_period', '--value-file', answer]).code, 0);
  assert.equal(front(profile).standard_answers.notice_period, 'Two months, negotiable');
  assert.equal(jobs(s.home, ['me', 'set', 'resume.paper', 'Letter']).code, 0);
  assert.equal(front(career).resume.paper, 'Letter');
  assert.equal(jobs(s.home, ['me', 'set', 'skills', 'SQL, Python, R']).code, 0);
  assert.deepEqual(front(career).skills, ['SQL', 'Python', 'R']);
  assert.match(jobs(s.home, ['me', 'set', 'identity.email', 'not-an-email']).err, /not an email address/);
  assert.match(jobs(s.home, ['me', 'set', 'facts.0.id', 'nowhere.x']).err, /not a summary, experience or list section/);
  assert.match(jobs(s.home, ['me', 'set', 'identiy.email', 'x@example.com']).err, /did you mean "identity"/);
  assert.equal(front(profile).identity.email, 'ada.new@example.com');
});

test('remember: ids m-N, answers supersede the same key, duplicates are recognised, retire keeps the item', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'memory.md');
  const t = (n: string, v: string) => textFile(s.root, n, v);
  const add = (args: string[]) => jobs(s.home, ['remember', ...args]);
  const r1 = add(['--kind', 'answer', '--key', 'notice_period', '--text-file', t('a.txt', 'Two months'), '--quote-file', t('q.txt', 'two months now')]);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /remembered m-4 \(answer\); replaces m-1/);
  let items = front(file).items;
  assert.equal(items.find((m: any) => m.id === 'm-1').superseded_by, 'm-4');
  assert.deepEqual(items.find((m: any) => m.id === 'm-4'), { id: 'm-4', kind: 'answer', key: 'notice_period', text: 'Two months', quote: 'two months now', scope: 'all', created: todayIn('Europe/Berlin') });
  assert.match(add(['--kind', 'answer', '--key', 'notice_period', '--text-file', t('a.txt', 'Two months'), '--quote-file', t('q.txt', 'two months now')]).out, /already remembered as m-4/);

  const words = t('w.txt', 'consultant\nagency\n');
  const r2 = add(['--kind', 'avoid', '--text-file', t('a2.txt', 'No consulting firms'), '--quote-file', t('q2.txt', 'no consultancies'), '--title-words-file', words]);
  assert.match(r2.out, /remembered m-5/);
  const company = t('c.txt', 'Example Travel GmbH');
  const r3 = add(['--kind', 'company_rule', '--scope', 'company', '--company-file', company, '--text-file', t('a3.txt', 'Weekly travel'), '--quote-file', t('q3.txt', 'they travel every week')]);
  assert.match(r3.out, /remembered m-6/);
  assert.match(jobs(s.home, ['rules']).out, /consultant\|agency/);
  assert.match(jobs(s.home, ['rules']).out, /Example Travel GmbH \(m-6\)/);

  assert.match(add(['--retire', 'm-2']).out, /m-2 retired/);
  items = front(file).items;
  assert.equal(items.find((m: any) => m.id === 'm-2').superseded_by, 'retired');
  assert.equal(items.length, 6, 'never deleted');
  assert.match(add(['--retire', 'm-2']).err, /already replaced/);
  const r4 = add(['--kind', 'fact', '--text-file', t('a4.txt', 'Led a team of five'), '--quote-file', t('q4.txt', 'I led five people'), '--supersedes', 'm-3']);
  assert.match(r4.out, /remembered m-7 \(fact\); replaces m-3/);
  assert.match(readFileSync(file, 'utf8'), /^ {2}- \{ id: m-7, kind: fact/m, 'one line per item');

  assert.match(add(['--kind', 'answer', '--text-file', t('x.txt', 'x'), '--quote-file', t('y.txt', 'y')]).err, /needs --key/);
  assert.match(add(['--kind', 'company_rule', '--text-file', t('x.txt', 'x'), '--quote-file', t('y.txt', 'y')]).err, /company/);
  assert.match(add(['--kind', 'fact', '--text-file', t('e.txt', '  '), '--quote-file', t('y.txt', 'y')]).err, /text is empty/);
  assert.match(add(['--kind', 'opinion', '--text-file', t('x.txt', 'x'), '--quote-file', t('y.txt', 'y')]).err, /--kind must be one of/);
});

test('remember creates jobs/memory.md from the template when the vault has none', () => {
  const s = tempSetup();
  const r = jobs(s.home, ['remember', '--kind', 'style', '--text-file', textFile(s.root, 't', 'Short answers'), '--quote-file', textFile(s.root, 'q', 'keep it short')]);
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(join(s.vault, 'jobs', 'memory.md'), 'utf8');
  assert.match(text, /^---\ntags: jobs\n/);
  assert.match(text, /# What Claude learned\n$/);
  assert.equal(front(join(s.vault, 'jobs', 'memory.md')).items[0].id, 'm-1');
});

test('remember refuses to write into a memory note the user broke', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'memory.md');
  writeFileSync(file, '---\nitems: [ { id: m-1 } ]\n---\n');
  const r = jobs(s.home, ['remember', '--kind', 'style', '--text-file', textFile(s.root, 't', 'x'), '--quote-file', textFile(s.root, 'q', 'y')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /fix it in Notes first/);
  assert.equal(readFileSync(file, 'utf8'), '---\nitems: [ { id: m-1 } ]\n---\n');
});

test('features: printed for anyone, changed only from a real terminal (an agent\'s shell is not one)', () => {
  const s = tempSetup();
  const list = jobs(s.home, ['features']);
  assert.equal(list.code, 0);
  assert.match(list.out, /easy_apply\s+off/);
  assert.match(list.out, /daily_quick_apply\s+0/);
  const config = readFileSync(join(s.home, 'config.yaml'), 'utf8');
  for (const args of [['easy_apply', 'on'], ['daily_quick_apply', '5'], ['linkedin_search', 'off']]) {
    const r = jobs(s.home, ['features', ...args], 'yes\n');
    assert.equal(r.code, 1);
    assert.match(r.err, /Only you can change feature switches/);
  }
  assert.equal(readFileSync(join(s.home, 'config.yaml'), 'utf8'), config);
  assert.match(jobs(s.home, ['features', 'auto_submit', 'on']).err, /unknown feature/);
});

test('E5: file flags read only inside Jobs\' home or workspace, never the token or config (links resolved)', async () => {
  const { mkdirSync, mkdtempSync, symlinkSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { REPO } = await import('./helpers.ts');
  const s = tempSetup('berlin-analyst');
  const quote = textFile(s.root, 'quote.txt', 'I said so');
  const outside = join(mkdtempSync(join(tmpdir(), 'cd-outside-')), 'notes.txt');
  writeFileSync(outside, 'private notes');
  const r1 = jobs(s.home, ['remember', '--kind', 'fact', '--text-file', outside, '--quote-file', quote]);
  assert.equal(r1.code, 1);
  assert.match(r1.err, /--text-file: files must be inside .*jobs/);
  assert.match(jobs(s.home, ['me', 'set', 'identity.first_name', '--value-file', outside]).err, /files must be inside/);
  assert.match(jobs(s.home, ['pref', 'set', 'roles.titles', '[x]', '--because-file', join(s.vault, 'me', 'profile.md')]).err, /files must be inside/, 'not even the vault');
  // A link inside the jobs home that points out is followed, then refused.
  const link = join(s.jobsHome, 'out', 'tmp', 'sneaky.txt');
  symlinkSync(outside, link);
  assert.match(jobs(s.home, ['remember', '--kind', 'fact', '--text-file', link, '--quote-file', quote]).err, /files must be inside/);
  // Even with jobs.home set to Crewdeck's own home, the token and config are refused, also through a link.
  writeFileSync(join(s.home, 'token'), 'f'.repeat(64), { mode: 0o600 });
  writeFileSync(join(s.home, 'config.yaml'), `vault: ${s.vault}\njobs:\n  home: ${s.home}\n`, { mode: 0o600 });
  mkdirSync(join(s.home, 'out', 'tmp'), { recursive: true });
  symlinkSync(join(s.home, 'token'), join(s.home, 'out', 'tmp', 't.txt'));
  for (const f of [join(s.home, 'token'), join(s.home, 'config.yaml'), join(s.home, 'out', 'tmp', 't.txt')]) {
    const r = jobs(s.home, ['remember', '--kind', 'fact', '--text-file', f, '--quote-file', quote]);
    assert.equal(r.code, 1, f);
    assert.match(r.err, /token and config are never read/, f);
  }
  // draft --brief writes only inside Jobs' folders too.
  assert.match(jobs(s.home, ['draft', 'aaaaaaaaaaaa', '--brief', join(tmpdir(), 'cd-brief.json')]).err, /--brief: files must be inside/);
  // crewdeck progress / request done: in the jobs workspace the same rule; anywhere, never Crewdeck's own files.
  const cli = (cwd: string, args: string[]) => spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), ...args], { cwd, env: { ...process.env, CREWDECK_HOME: s.home }, encoding: 'utf8' });
  assert.match(cli(s.home, ['progress', '1', '--text-file', outside]).stderr, /--text-file: files must be inside/);
  assert.match(cli(tmpdir(), ['progress', '1', '--text-file', join(s.home, 'token')]).stderr, /Crewdeck's own files are never read|token and config/);
  assert.match(cli(tmpdir(), ['request', 'done', '1', '--result-file', join(s.home, 'config.yaml')]).stderr, /Crewdeck's own files are never read|token and config/);
});

test('E5: the checker itself: roots, an explicit extra root for tests, files to write', async () => {
  const { checkedPath, readChecked } = await import('../../src/files.ts');
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cd-files-'))), other = realpathSync(mkdtempSync(join(tmpdir(), 'cd-files-')));
  writeFileSync(join(other, 'a.txt'), 'hello');
  assert.throws(() => readChecked(join(other, 'a.txt'), '--text-file', { roots: [root] }), /files must be inside/);
  assert.equal(readChecked(join(other, 'a.txt'), '--text-file', { roots: [root], extraRoots: [other] }), 'hello');
  assert.equal(checkedPath(join(root, 'new.json'), '--brief', { roots: [root] }, 'write'), join(root, 'new.json'));
  assert.throws(() => checkedPath(join(root, 'missing', 'new.json'), '--brief', { roots: [root] }, 'write'), /does not exist/);
  assert.throws(() => readChecked(root, '--text-file', { roots: [root] }), /not a regular file/);
});
