// Ranking and the budgeted Find (design §2.4 steps 2-3): cheap scores from the notes, company rules drop, descriptions
// for the best roles from a local fixture site, and `candidates --budget` batches that never re-judge and stop in time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryFile } from '../../src/jobs/ctx.ts';
import { remember } from '../../src/jobs/memory.ts';
import { budgetedCandidates, fetchDescriptions, rankRoles, rankScore, readFindRun, recordJudged } from '../../src/jobs/pipeline/rank.ts';
import { judge } from '../../src/jobs/pipeline/pick.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { jobs, role, textFile, world } from './helpers.ts';
import { pages, serve, testHosts } from './net-helpers.ts';

test('rankScore: title, seniority, skills, freshness, source and pay each move a role up', () => {
  const w = world('berlin-analyst');
  const notes = notesOf(w.ctx);
  const at = new Date('2026-11-19T10:00:00Z');
  const base = { title: 'Data Analyst', description: '', source: 'board', posted_at: '2026-11-18T10:00:00Z', pay_status: 'unlisted' };
  const s = (o: Partial<typeof base>) => rankScore({ ...base, ...o }, notes, at);
  assert.ok(s({}) > s({ title: 'Office Manager' }), 'title match');
  assert.ok(s({ title: 'Senior Data Analyst' }) > s({}), 'seniority');
  assert.ok(s({ description: 'SQL, dbt and Looker every day' }) > s({}), 'skills overlap');
  assert.ok(s({}) > s({ posted_at: '2026-09-01T00:00:00Z' }), 'freshness');
  // Pasted links first, then the user's sources by position (Arbeitnow is first in berlin-analyst's list), unknown last.
  assert.ok(s({ source: 'pasted' }) > s({ source: 'board', source_key: 'arbeitnow' } as any), 'pasted first');
  assert.ok(s({ source: 'board', source_key: 'arbeitnow' } as any) > s({ source: 'ats', source_key: 'example-gmbh' } as any), 'the first source before the last');
  assert.ok(s({ source: 'ats', source_key: 'example-gmbh' } as any) > s({ source: 'linkedin', source_key: 'linkedin' } as any), 'no LinkedIn row: LinkedIn counts as last');
  assert.ok(s({ source: 'board', source_key: 'gone' } as any) > s({ source: 'linkedin', source_key: 'linkedin' } as any) && s({ source: 'board', source_key: 'gone' } as any) < s({ source: 'board', source_key: 'arbeitnow' } as any), 'an unknown key gets a small bonus');
  assert.ok(s({ pay_status: 'ok' }) > s({ pay_status: 'unlisted' }) && s({ pay_status: 'unlisted' }) > s({ pay_status: 'below_floor' }), 'pay');
  assert.ok(s({ description: 'x'.repeat(250) }) > s({}), 'a posting with a description can be judged');
});

test('rankRoles: best first; a remembered company rule drops that company\'s roles before ranking', () => {
  const w = world('berlin-analyst');
  const weak = role(w.ctx, { company: 'Weak Example', title: 'Analyst', source: 'board' });
  const strong = role(w.ctx, { company: 'Strong Example', title: 'Senior Data Analyst', source: 'ats', description: 'SQL and dbt and Looker' });
  const ruled = role(w.ctx, { company: 'Travel Example', title: 'Senior Data Analyst', source: 'ats' });
  remember(memoryFile(w.ctx), { kind: 'company_rule', scope: 'company', company: 'Travel Example', text: 'Every role travels weekly', quote: 'travel is 80% of the job' }, '2026-11-19');
  assert.deepEqual(rankRoles(w.ctx).map((r) => r.id), [strong, weak]);
  const row = w.ctx.db.prepare('select status, status_reason from roles where id=?').get(ruled) as any;
  assert.equal(row.status, 'prefiltered_out');
  assert.match(row.status_reason, /^company_rule: company rule \(m-\d+\): Every role travels weekly/);
});

test('fetchDescriptions: every rule-passing role without a full description (not only the top 50), through netguard; closed set aside; 5xx retried; once a day', async () => {
  const LD = (d: string) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Senior Data Analyst', hiringOrganization: { name: 'Example Co' }, description: d })}</script>`;
  const LONG = `<p>${'We use SQL, dbt and Looker to answer questions for the whole company, every day, in Berlin. '.repeat(4)}</p>`;
  const srv = await serve(pages({
    '/a': `<html>${LD(LONG)}</html>`,
    '/b': '<html><body>This position has been filled.</body></html>',
    '/c': { status: 500, body: 'oops' },
    '/e': `<html>${LD(LONG)}</html>`,
  }));
  try {
    const w = world('berlin-analyst');
    const host = 'jobs.example.test';
    const net = { testHosts: testHosts(host) };
    const a = role(w.ctx, { company: 'A Example', title: 'Senior Data Analyst', url: `http://${host}:${srv.port}/a` });
    const b = role(w.ctx, { company: 'B Example', title: 'Senior Data Analyst', url: `http://${host}:${srv.port}/b` });
    const c = role(w.ctx, { company: 'C Example', title: 'Senior Data Analyst', url: `http://${host}:${srv.port}/c` });
    const low = role(w.ctx, { company: 'D Example', title: 'Office Helper', url: `http://${host}:${srv.port}/d` });
    role(w.ctx, { company: 'E Example', title: 'Senior Data Analyst', url: `http://${host}:${srv.port}/e`, description: 'x '.repeat(300) });
    role(w.ctx, { company: 'F Example', title: 'Senior Data Analyst', url: 'https://www.linkedin.com/jobs/view/1234567890' });
    const waits: number[] = [];
    const o = { net, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0.5, backoffMs: 100, paceMs: 0 };
    const r = await fetchDescriptions(w.ctx, o);
    assert.deepEqual(r, { tried: 4, found: 1, closed: 2, errors: 1, retried: 2, deferred: 0, backed_off: [] });
    assert.match((w.ctx.db.prepare('select description from roles where id=?').get(a) as any).description, /SQL, dbt and Looker/);
    assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(b) as any).status, 'expired');
    assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(low) as any).status, 'expired', 'the lowest-ranked role is read too: 404, the posting is gone');
    assert.ok(!srv.hits.includes('/e'), 'a role with a full description is not fetched');
    assert.equal(srv.hits.filter((h) => h === '/c').length, 3, '500: two retries');
    assert.deepEqual(waits, [150, 250], 'jittered backoff: 100 × 2^n + up to 100');
    assert.deepEqual({ ...(w.ctx.db.prepare('select detail_status, detail_at from roles where id=?').get(c) as any) }, { detail_status: 'http_500', detail_at: '2026-11-19T10:00:00.000Z' });
    // Later the same day: nothing is tried again. The next day the failed role is tried once more.
    w.at('2026-11-19T20:00:00Z');
    assert.equal((await fetchDescriptions(w.ctx, o)).tried, 0);
    w.at('2026-11-20T10:30:00Z');
    assert.equal((await fetchDescriptions(w.ctx, o)).tried, 1);
    assert.equal(srv.hits.filter((h) => h === '/c').length, 6);
    assert.equal((await fetchDescriptions(w.ctx, { ...o, top: 0 })).tried, 0, 'top/limit 0 skips the step');
  } finally { await srv.close(); }
});

test('budgeted candidates: batches in rank order, never re-judged, stop once N companies pass or the budget is spent', () => {
  const w = world('berlin-analyst');
  const ids = Array.from({ length: 12 }, (_, i) => role(w.ctx, { company: `Example ${String.fromCharCode(65 + i)}`, title: i < 6 ? 'Senior Data Analyst' : 'Data Analyst' }));
  const first = budgetedCandidates(w.ctx, { budget: 8, batch: 5, need: 2, start: true });
  assert.equal(first.batch.length, 5);
  assert.deepEqual(first.run, { started: first.run.started, budget: 8, judged: 0, remaining: 8, need: 2, passed: 0, done: false, why: null, funnel: first.run.funnel });
  assert.equal(first.run.funnel.need, 2, 'the funnel is stored with the run');
  assert.equal(first.pool.unjudged, 12);
  assert.ok(first.batch.every((c) => ids.slice(0, 6).includes(c.id)), 'the senior roles rank first');
  // Judge the batch: one passes.
  const stored = judge(w.ctx, first.batch.map((c, i) => ({ role: c.id, eligible: i === 0 ? 'yes' : 'no', score: 70, evidence: 'from the posting' })));
  recordJudged(w.ctx, stored.filter((s) => s.stored).map((s) => s.role));
  const second = budgetedCandidates(w.ctx, { budget: 8, batch: 5, need: 2 });
  assert.equal(second.run.judged, 5);
  assert.equal(second.run.remaining, 3);
  assert.equal(second.run.passed, 1);
  assert.equal(second.batch.length, 3, 'never past the budget');
  assert.ok(second.batch.every((c) => !first.batch.some((f) => f.id === c.id)), 'never re-judged');
  recordJudged(w.ctx, judge(w.ctx, second.batch.map((c) => ({ role: c.id, eligible: 'no', score: 10, evidence: 'no' }))).map((s) => s.role));
  const spent = budgetedCandidates(w.ctx, { budget: 8, batch: 5, need: 2 });
  assert.deepEqual([spent.run.done, spent.run.why, spent.batch.length], [true, 'budget', 0]);
  // A new Find starts fresh, and stops at once when enough companies already passed.
  const fresh = budgetedCandidates(w.ctx, { budget: 40, batch: 10, need: 1, start: true });
  assert.deepEqual([fresh.run.judged, fresh.run.done, fresh.run.why], [0, true, 'enough']);
  assert.throws(() => budgetedCandidates(w.ctx, { budget: 41, batch: 10, need: 1 }), /at most 40/);
  assert.throws(() => budgetedCandidates(w.ctx, { budget: 10, batch: 0, need: 1 }), /--batch/);
});

test('budgeted candidates: an empty pool is done; a run older than 6 hours starts over', () => {
  const w = world('berlin-analyst');
  assert.equal(budgetedCandidates(w.ctx, { budget: 10, batch: 10, need: 1, start: true }).run.why, 'pool');
  role(w.ctx, { company: 'Example Z', title: 'Data Analyst' });
  recordJudged(w.ctx, ['000000000000']);
  assert.equal(readFindRun(w.ctx.home)!.judged.length, 1);
  w.at('2026-11-19T17:00:00Z');
  const r = budgetedCandidates(w.ctx, { budget: 10, batch: 10, need: 1 });
  assert.equal(r.run.judged, 0);
  assert.equal(r.batch.length, 1);
});

test('CLI: candidates --budget/--batch/--need/--start and judge counting into the run', () => {
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Q', title: 'Senior Data Analyst' });
  w.ctx.db.close();
  const out = jobs(w.home, ['candidates', '--budget', '5', '--batch', '2', '--need', '1', '--start']);
  assert.equal(out.code, 0, out.err);
  const r = JSON.parse(out.out);
  assert.deepEqual(r.batch.map((c: any) => c.id), [id]);
  const f = textFile(w.root, 'v.json', JSON.stringify([{ role: id, eligible: 'yes', score: 80, evidence: 'Berlin, SQL' }]));
  assert.equal(jobs(w.home, ['judge', '--results-file', f]).code, 0);
  const after = JSON.parse(jobs(w.home, ['candidates', '--budget', '5', '--batch', '2', '--need', '1']).out);
  assert.deepEqual([after.run.judged, after.run.passed, after.run.done, after.run.why], [1, 1, true, 'enough']);
  assert.match(jobs(w.home, ['candidates', '--budget', '50']).err, /at most 40/);
});
