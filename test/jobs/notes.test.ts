import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { loadJobNotes, readNote, renderNote, setInDoc, splitNote, writeAtomic } from '../../src/jobs/notes.ts';
import { tempSetup } from './helpers.ts';

test('splitNote: frontmatter and body byte for byte; none; empty; unterminated', () => {
  assert.deepEqual(splitNote('---\na: 1\n---\n# Body\n\ntext\n'), { front: 'a: 1\n', body: '# Body\n\ntext\n' });
  assert.deepEqual(splitNote('# Just a body\n'), { front: null, body: '# Just a body\n' });
  assert.deepEqual(splitNote('---\n---\nbody'), { front: '', body: 'body' });
  assert.equal(splitNote('---\na: 1\nno end\n').unterminated, true);
  assert.deepEqual(splitNote('---\r\na: 1\r\n---\r\nbody'), { front: 'a: 1\r\n', body: 'body' });
});

test('round trip: changing one key keeps comments, key order, other values and the body', () => {
  const { vault } = tempSetup('berlin-analyst');
  const file = join(vault, 'jobs', 'search.md');
  const before = readFileSync(file, 'utf8');
  const n = readNote(file);
  setInDoc(n.doc, ['pay', 'floor'], 60000);
  setInDoc(n.doc, ['workplace'], ['remote', 'hybrid']);
  const after = renderNote(n.doc, n.body);
  assert.equal(splitNote(after).body, splitNote(before).body, 'body untouched');
  for (const c of ['# a title must contain one', '# ordering, not a filter', '# period: year | month | hour', '# your words for the judge']) assert.ok(after.includes(c), c);
  assert.match(after, /workplace: \[ remote, hybrid \] # remote \| hybrid \| onsite/, 'flow style and line comment survive a replaced value');
  assert.match(after, /floor: 60000/);
  const keys = (s: string) => [...splitNote(s).front!.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys(after), keys(before), 'top-level key order');
  assert.equal(readNote(file).doc.toJS().judge_notes, 'Prefer product companies over agencies.');
});

test('setInDoc creates missing maps; renderNote gives a note to a file without frontmatter', () => {
  const { vault } = tempSetup();
  const file = join(vault, 'plain.md');
  writeFileSync(file, '# Only text\n');
  const n = readNote(file);
  setInDoc(n.doc, ['pay', 'currency'], 'EUR');
  assert.equal(renderNote(n.doc, n.body), '---\npay:\n  currency: EUR\n---\n# Only text\n');
});

test('writeAtomic: no temp file left, new notes 0600, an existing note keeps its mode', () => {
  const { vault } = tempSetup();
  const file = join(vault, 'jobs', 'new.md');
  writeAtomic(file, 'one');
  assert.equal(readFileSync(file, 'utf8'), 'one');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o644);
  writeAtomic(file, 'two');
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(join(vault, 'jobs')), ['new.md']);
});

test('last valid: an invalid edit falls back to the cached version and reports the error', () => {
  const { vault, jobsHome } = tempSetup('berlin-analyst');
  const ok = loadJobNotes(vault, jobsHome);
  assert.equal(ok.search.source, 'note');
  assert.equal(ok.issues.filter((i) => i.level === 'error').length, 0);
  const cache = join(jobsHome, 'state', 'last-valid', 'search.json');
  assert.ok(existsSync(cache));
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  assert.equal(statSync(join(jobsHome, 'state')).mode & 0o777, 0o700);

  const file = join(vault, 'jobs', 'search.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('floor: 55000', 'floor: lots').replace('period: year', 'period: yearly'));
  const bad = loadJobNotes(vault, jobsHome);
  assert.equal(bad.search.source, 'last-valid');
  assert.equal(bad.search.data.pay?.floor, 55000, 'last valid values in effect');
  const period = bad.issues.find((i) => i.path === 'pay.period')!;
  assert.equal(period.note, 'jobs/search.md');
  assert.match(period.message, /"yearly" is not one of: year, month, week, day, hour/);
  assert.match(period.fix!, /did you mean "year"/);
  assert.ok(bad.issues.some((i) => i.path === 'pay.floor' && /should be a number/.test(i.message)));
  assert.ok(bad.issues.some((i) => /last valid version \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/.test(i.message)), 'the saved time says its zone');

  writeFileSync(file, '---\nroles: [unclosed\n---\n');
  const broken = loadJobNotes(vault, jobsHome);
  assert.equal(broken.search.source, 'last-valid');
  assert.ok(broken.issues.some((i) => i.note === 'jobs/search.md' && /^YAML/.test(i.message)));
});

test('no cache yet: a broken note counts as empty, with its errors; a missing note says how to fix it', () => {
  const { vault } = tempSetup('us-nurse');
  writeFileSync(join(vault, 'jobs', 'search.md'), '---\nworkplace: [remote, sometimes]\n---\n');
  const n = loadJobNotes(vault, null);
  assert.equal(n.search.source, 'empty');
  assert.deepEqual(n.search.data.workplace, []);
  assert.ok(n.issues.some((i) => i.path === 'workplace[1]'));
  const { vault: empty } = tempSetup();
  const m = loadJobNotes(empty, null);
  assert.ok(m.issues.some((i) => i.note === 'me/career.md' && i.message === 'is missing' && /vault-template/.test(i.fix!)));
});
