import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobs, tempSetup, textFile } from './helpers.ts';

const todayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const ok = (r: { code: number | null; out: string; err: string }) => { assert.equal(r.code, 0, r.out + r.err); return r.out; };

test('the pipeline end to end through the CLI: add, prefilter, judge, pick, form, draft, answer, plan, applied', () => {
  const s = tempSetup('berlin-analyst');
  const file = (name: string, v: unknown) => textFile(s.root, name, typeof v === 'string' ? v : JSON.stringify(v));
  const add = (n: number, extra: object) => /: ([a-f0-9]{12})$/m.exec(ok(jobs(s.home, ['add-role', '--role-file', file(`r${n}.json`, { url: `https://jobs.example.com/${n}`, company: `Example ${n}`, title: 'Senior Data Analyst', location: 'Berlin', ...extra })])))![1];
  const a = add(1, { description: 'We build forecasting tools with SQL and dbt.', pay_text: '€65,000 – €75,000 per year' });
  const b = add(2, { title: 'Sales Analyst' });
  assert.match(ok(jobs(s.home, ['add-role', '--role-file', file('r1b.json', { url: 'https://jobs.example.com/1', company: 'Example 1', title: 'Senior Data Analyst' })])), /already known/);

  assert.deepEqual(JSON.parse(ok(jobs(s.home, ['prefilter']))).kept, 1);
  const cands = JSON.parse(ok(jobs(s.home, ['candidates', '--limit', '5'])));
  assert.deepEqual(cands.map((c: any) => c.id), [a]);
  ok(jobs(s.home, ['judge', '--results-file', file('v.json', [{ role: a, eligible: 'yes', score: 88, evidence: 'Berlin, hybrid' }])]));
  assert.match(ok(jobs(s.home, ['pick', '--n', '3'])), new RegExp(`^${a}  Example 1 — Senior Data Analyst$`, 'm'));

  ok(jobs(s.home, ['form', a, '--fields-file', file('f.json', [{ label: 'Full name', kind: 'text', required: true }, { label: 'Email', kind: 'text', required: true }, { label: 'Experience with Looker', kind: 'radio', required: true, options: ['Some', 'A lot'] }])]));
  const brief = textFile(s.root, 'brief.json', '');
  assert.match(ok(jobs(s.home, ['draft', a, '--brief', brief])), /2 answered from your profile and memory; 0 need you; brief written: 1 for Claude \(Q3\)/);
  assert.match(JSON.parse(readFileSync(brief, 'utf8')).prompt, /for Ada Example \(the user\)/);
  const ans = JSON.parse(ok(jobs(s.home, ['answer', a, '--question', 'Q3', '--text-file', file('t.txt', 'A lot'), '--quote-file', file('q.txt', 'I use Looker every day')])));
  assert.equal(ans.answer, 'A lot');

  const plan = JSON.parse(ok(jobs(s.home, ['fill-plan', a, '--fields-file', file('p.json', [{ label: 'Full name', type: 'text' }, { label: 'Experience with Looker', type: 'radio', options: ['Some', 'A lot'] }, { label: 'Submit', type: 'submit' }])])));
  assert.deepEqual(plan.items.map((i: any) => [i.action, i.value]), [['fill', 'Ada Example'], ['choose', 'A lot'], ['skip', undefined]]);

  const today = JSON.parse(ok(jobs(s.home, ['view', 'today'])));
  assert.equal(today.detail.approvable, true);
  assert.match(ok(jobs(s.home, ['applied', a])), /applied; cooldown until .*; noted in journal\//);
  const day = todayIn('Europe/Berlin');
  assert.match(readFileSync(join(s.vault, 'journal', `${day}.md`), 'utf8'), /- Applied: Example 1 — Senior Data Analyst/);
  assert.equal(JSON.parse(ok(jobs(s.home, ['view', 'applications']))).rows[0].status, 'Applied');
  assert.match(ok(jobs(s.home, ['view', 'knowledge', '--tab', 'memory'])), /I use Looker every day/);
  assert.match(ok(jobs(s.home, ['knowledge', 'looker'])), /A lot/);
  assert.ok(b);
});

test('not interested, preference change and refilter through the CLI; remember applies to open forms', () => {
  const s = tempSetup('berlin-analyst');
  const file = (name: string, v: unknown) => textFile(s.root, name, typeof v === 'string' ? v : JSON.stringify(v));
  const add = (n: number, extra: object) => /: ([a-f0-9]{12})$/m.exec(ok(jobs(s.home, ['add-role', '--role-file', file(`r${n}.json`, { url: `https://jobs.example.com/${n}`, company: `Example ${n}`, title: 'Data Analyst', location: 'Berlin', ...extra })])))![1];
  const remote = add(1, { location: 'Remote' });
  const ads = add(2, { title: 'Data Analyst, Werbung' });
  ok(jobs(s.home, ['prefilter']));
  assert.match(ok(jobs(s.home, ['not-interested', ads, '--reason-file', file('why.txt', 'No ad-tech for me'), '--title-words-file', file('w.txt', 'Werbung')])), /skipped; remembered as m-4; titles with Werbung are now excluded/);
  assert.match(readFileSync(join(s.vault, 'jobs', 'search.md'), 'utf8'), /exclude_title_words: \[ intern, Praktikum, Werkstudent, sales, Werbung \]/);
  ok(jobs(s.home, ['pref', 'set', 'workplace', 'onsite,hybrid,remote', '--because-file', file('b.txt', 'remote is fine now')]));
  ok(jobs(s.home, ['pref', 'set', 'places.remote_from', 'Germany', '--because-file', file('b.txt', 'remote is fine now')]));
  const r = JSON.parse(ok(jobs(s.home, ['refilter', '--days', '14'])).split('\n').filter((l) => !/back for judging/.test(l)).join('\n'));
  assert.deepEqual(r.roles.map((x: any) => x.id), [remote]);

  ok(jobs(s.home, ['form', remote, '--fields-file', file('f.json', [{ label: 'Earliest start date', kind: 'text' }])]));
  ok(jobs(s.home, ['draft', remote, '--brief', textFile(s.root, 'b.json', '')]));
  const remembered = ok(jobs(s.home, ['remember', '--kind', 'answer', '--key', 'earliest_start_date', '--text-file', file('t.txt', 'January 2027'), '--quote-file', file('q.txt', 'I can start in January')]));
  assert.match(remembered, /remembered m-5 \(answer\)\napplied to 1 open question/);
  assert.match(ok(jobs(s.home, ['undo'])), /memory m-5/);
});

test('switches and the D11 rule hold on the command line', () => {
  const s = tempSetup('berlin-analyst');
  const file = (name: string, v: unknown) => textFile(s.root, name, JSON.stringify(v));
  const li = jobs(s.home, ['add-role', '--role-file', file('li.json', { url: 'https://www.linkedin.com/jobs/view/42', company: 'Example', title: 'Data Analyst' })]);
  assert.equal(li.code, 1);
  assert.match(li.err, /pasted LinkedIn links are off/);
  const id = /: ([a-f0-9]{12})$/m.exec(ok(jobs(s.home, ['add-role', '--role-file', file('r.json', { url: 'https://jobs.example.com/9', company: 'Example', title: 'Data Analyst' })])))![1];
  const contact = ok(jobs(s.home, ['contact', 'add', '--file', file('c.json', { company: 'Example', name: 'Pat Example', email: 'pat@example.com', email_verified: true })])).trim();
  const body = textFile(s.root, 'body.txt', 'Hello');
  const email = jobs(s.home, ['message', 'add', id, '--contact', contact, '--channel', 'email', '--body-file', body]);
  assert.equal(email.code, 1);
  assert.match(email.err, /email drafts are off/);
  assert.match(jobs(s.home, ['status', 'not-a-role', 'bench']).err, /not a role id/);
  assert.match(jobs(s.home, ['knowledge', '$(touch x)']).err, /--query-file/);
  assert.match(jobs(s.home, ['pick', '--day', '19-11-2026']).err, /YYYY-MM-DD/);
  // A URL is never an argument: add-role takes a file.
  assert.match(jobs(s.home, ['add-role', '--url', 'https://jobs.example.com/1']).err, /--role-file/);
  assert.match(jobs(s.home, ['add-role', '--role-file', textFile(s.root, 'bad.json', '{ not json')]).err, /not valid JSON/);
});
