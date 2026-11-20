// v1 roles.titles → v0.4 roles.targets (ADR-0007, jobs v2 §14 P1): automatic on `crewdeck jobs check` and on start,
// additive, comment-preserving, logged under Changes with the old list, idempotent; the same postings stay relevant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { migrateTitles } from '../../src/jobs/edit.ts';
import { splitNote } from '../../src/jobs/notes.ts';
import { compileRules, isOtherOccupation } from '../../src/jobs/rules.ts';
import { normalise, validate } from '../../src/jobs/schema.ts';
import { jobs, tempSetup } from './helpers.ts';

const front = (file: string) => parse(splitNote(readFileSync(file, 'utf8')).front!);
const rules = (data: unknown) => compileRules({ search: { data: normalise.search(data) } as any, memory: { data: { items: [] } } as any });

test('migrateTitles: one target per occupation family, synonyms added, comments kept, a dated Changes line, idempotent', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'search.md');
  const before = front(file);
  assert.deepEqual(before.roles.titles, ['data analyst', 'analytics engineer', 'Datenanalyst', 'BI analyst']);
  const r = migrateTitles(file, '2026-11-20');
  assert.equal(r.changed, true);
  const after = front(file);
  assert.deepEqual(after.roles.titles, []);
  // data analyst, Datenanalyst and BI analyst are one family (data-analytics); analytics engineer another.
  assert.deepEqual(after.roles.targets.map((t: any) => t.name), ['Data analyst', 'Analytics engineer']);
  assert.deepEqual(after.roles.targets[0].titles.slice(0, 1), ['data analyst']);
  assert.ok(after.roles.targets[0].titles.includes('Datenanalyst') && after.roles.targets[0].titles.includes('BI analyst'));
  assert.ok(after.roles.targets[1].titles.includes('analytics developer'), 'with a synonym wording');
  assert.deepEqual(validate('search', after).filter((i) => i.level === 'error'), []);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /# cities \(commute area is a judge note\)/, 'comments kept');
  assert.match(text, /\n- 2026-11-20: roles\.titles → roles\.targets \(automatic update to v0\.4 kinds of job, with synonyms\): was data analyst, analytics engineer, Datenanalyst, BI analyst; now Data analyst \(/);
  // Idempotent: nothing to do the second time, the file byte for byte the same.
  assert.equal(migrateTitles(file, '2026-11-21').changed, false);
  assert.equal(readFileSync(file, 'utf8'), text);
  // Nothing that was relevant before is lost.
  const old = rules(before), now = rules(after);
  for (const t of ['Senior Data Analyst (m/w/d)', 'Datenanalystin', 'BI Analyst', 'Analytics Engineer', 'Data Analyst, Marketing']) {
    assert.equal(isOtherOccupation(old, { title: t }), false, t);
    assert.equal(isOtherOccupation(now, { title: t }), false, t);
  }
});

test('migrateTitles keeps existing targets first and untouched, skips titles already in them, and never writes a broken note', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'search.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/  titles: \[[^\]]*\][^\n]*\n/, '  targets:\n    - { name: Analyst, titles: [data analyst], skills: [SQL] } # mine\n  titles: [data analyst, registered nurse]\n'));
  assert.equal(migrateTitles(file, '2026-11-20').changed, true);
  const t = front(file).roles.targets;
  assert.deepEqual(t[0], { name: 'Analyst', titles: ['data analyst'], skills: ['SQL'] });
  assert.deepEqual(t.slice(1).map((x: any) => x.name), ['Registered nurse']);
  assert.match(readFileSync(file, 'utf8'), /# mine/);
  // A note with a YAML error is left alone.
  writeFileSync(file, '---\nroles: { titles: [a\n---\n');
  assert.equal(migrateTitles(file, '2026-11-20').changed, false);
  assert.equal(readFileSync(file, 'utf8'), '---\nroles: { titles: [a\n---\n');
});

test('crewdeck jobs check runs it once and says so', () => {
  const s = tempSetup('us-nurse');
  const first = jobs(s.home, ['check']);
  assert.equal(first.code, 0, first.out + first.err);
  const file = join(s.vault, 'jobs', 'search.md');
  assert.match(first.out, /updated jobs\/search\.md: your titles are now kinds of job \(roles\.targets\): Registered nurse \(registered nurse, RN, /);
  assert.deepEqual(front(file).roles.titles, []);
  assert.match(first.out, /0 errors/);
  assert.doesNotMatch(jobs(s.home, ['check']).out, /updated jobs\/search\.md/);
});
