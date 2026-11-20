// Find's funnel (design §24.7, D28): the numbers add up, they are stored with the Find run, `candidates` and `pick`
// print them (Claude's close line), and Today shows "Why so few?" when a finished Find picked fewer than asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetedCandidates, readFindRun, recordJudged, refreshFunnel } from '../../src/jobs/pipeline/rank.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { judge, pick } from '../../src/jobs/pipeline/pick.ts';
import { findFunnel } from '../../src/jobs/funnel.ts';
import { seedOwner } from './owner-fixture.ts';
import { jobs, role, world } from './helpers.ts';
import { setRoleStatus } from '../../src/jobs/pipeline/roles.ts';
import { jobsServer } from './api-helpers.ts';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { Today } from '../../web/jobs/screens/today.js';

/** The owner's pool through one Find: rules, ten judged (one fits), one picked. */
function findOnce(w: ReturnType<typeof world>) {
  seedOwner(w.ctx, w.vault);
  runPrefilter(w.ctx);
  const b = budgetedCandidates(w.ctx, { budget: 40, batch: 10, need: 5, start: true });
  assert.equal(b.batch.length, 10);
  const why = (i: number) => (i < 6 ? 'requires US work authorisation' : 'needs ten years of Go');
  judge(w.ctx, b.batch.map((c, i) => ({ role: c.id, eligible: i === 0 ? 'yes' : 'no', score: i === 0 ? 80 : 0, evidence: 'from the posting', reason: i === 0 ? undefined : why(i - 1) })) as any);
  recordJudged(w.ctx, b.batch.map((c) => c.id));
  assert.equal(pick(w.ctx, 5).length, 1);
  return refreshFunnel(w.ctx)!;
}

test('the funnel adds up: fetched = rule drops + passed; passed = judged + waiting + other; judged = fits + no + unclear', () => {
  const w = world('example');
  const f = findOnce(w);
  assert.equal(f.fetched, 1480);
  assert.equal(f.rules.reduce((a, r) => a + r.n, 0) + f.passed_rules, f.fetched);
  assert.equal(f.other_occupations + f.judged + f.waiting + f.other, f.passed_rules);
  assert.equal(f.fits + f.no + f.unclear, f.judged);
  assert.deepEqual([f.judged, f.fits, f.fit_companies, f.no, f.picked, f.need], [10, 1, 1, 9, 1, 5]);
  // Titles are never a drop (ADR-0003): other occupations are counted apart, not as a "title" rule.
  assert.ok(!f.rules.some((r) => r.rule === 'title_gate'), JSON.stringify(f.rules));
  assert.ok(f.other_occupations > 900, `${f.other_occupations} other occupations`);
  assert.equal(f.line, `1,480 fetched → ${f.passed_rules.toLocaleString('en-US')} passed your rules (${f.other_occupations} other occupations set aside) → 10 judged → 1 fit from 1 company`);
  assert.match(f.rules_line, /^Most went at your rules: only for other places \d{3}/);
  assert.deepEqual(f.judge_reasons[0], { text: 'requires US work authorisation', n: 6 });
  assert.equal(f.coverage, null, 'a big pool needs no coverage line');
  // The same counts straight from the tracker (nothing is counted during the Find).
  assert.deepEqual({ ...findFunnel(w.ctx, 5), at: f.at }, f);
});

test('stored with the run: candidates prints run.funnel, pick prints the funnel line when short', () => {
  const w = world('example');
  findOnce(w);
  assert.equal(readFindRun(w.jobsHome)!.funnel!.picked, 1);
  w.ctx.db.close();
  const c = jobs(w.home, ['candidates', '--budget', '40', '--need', '5']);
  assert.equal(c.code, 0, c.err);
  const run = JSON.parse(c.out).run;
  assert.match(run.funnel.line, /^1,480 fetched → [\d,]+ passed your rules \([\d,]+ other occupations set aside\) → 10 judged → 1 fit from 1 company$/);
  const p = jobs(w.home, ['pick', '--n', '5']);
  assert.match(p.out, /funnel: 1,480 fetched → .* → 1 fit from 1 company\. Most went at your rules: only for other places/);
});

test('a small pool brings the coverage line (D42) and never names a source that does not exist', () => {
  const w = world('us-nurse');
  const f = findFunnel(w.ctx, 4);
  assert.equal(f.fetched, 0);
  assert.equal(f.line, '0 fetched → 0 passed your rules → 0 judged → 0 fits');
  assert.ok(f.coverage && f.coverage.length > 20, String(f.coverage));
});

test('Today: "Why so few?" after a finished Find that picked fewer than asked; gone while it runs or when it filled', async () => {
  const s = await jobsServer('example');
  try {
    findOnce(s.w);
    const r = (await s.action('find', { count: 5 })).json;
    let today = (await s.get('today')).json;
    assert.equal(today.find, null, 'not while the Find is open');
    s.q.finish(r.request, '1 picked');
    today = (await s.get('today')).json;
    assert.equal(today.find.funnel.need, 5);
    assert.match(today.find.summary, /^Find 5 jobs: 1 picked\. 1,480 fetched → /);
    const pv = (await s.call('POST', '/api/jobs/preview', s.page(), {})).json;
    const out = render(html`<${Today} data=${today} state=${(await s.get('state')).json} preview=${pv} />`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.match(out, /Why so few\? Find 5 jobs: 1 picked/);
    assert.match(out, /1,480 fetched → [\d,]+ passed your rules \([\d,]+ other occupations set aside\) → 10 judged → 1 fit from 1 company/);
    assert.match(out, /[\d,]+ of the 1,\d{3} that passed your rules are other occupations: set aside, not judged/);
    assert.match(out, /The judge's most common reasons: requires US work authorisation \(6\)/);
    assert.match(out, /Add 5 title variants: \d+ rank higher/);
    assert.match(out, /See the preview/);
    const loading = render(html`<${Today} data=${today} state=${(await s.get('state')).json} />`);
    assert.match(loading, /Checking what one change would bring back/);

    // A fix saved from the card says where it came from.
    const fix = pv.suggestions.find((x: any) => x.kind === 'variants');
    const saved = await s.action('prefs', { changes: fix.change, from: 'find' });
    assert.equal(saved.json.ok, true, saved.body);
    assert.match(readFileSync(`${s.w.vault}/jobs/search.md`, 'utf8'), /roles\.titles: backend engineer, ai engineer → .*"added from Find's suggestions \(set on the Jobs page\)"/);

    // Filled: no card.
    const f = readFindRun(s.w.jobsHome)!;
    s.w.ctx.db.prepare(`update roles set eligibility='yes', status='picked', picked_on=(select picked_on from roles where picked_on is not null limit 1) where id in (select id from roles where status='new' limit 4)`).run();
    refreshFunnel(s.w.ctx);
    assert.ok(readFindRun(s.w.jobsHome)!.funnel!.picked >= 5, JSON.stringify(f.funnel?.picked));
    assert.equal((await s.get('today')).json.find, null);
  } finally { await s.close(); }
});

test('the daily-run skill closes a short Find with the server\'s funnel', () => {
  const skill = readFileSync(new URL('../../plugin/skills/jobs-daily-run/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /run\.funnel/);
  assert.match(skill, /never your own count/);
});

test('sources that returned nothing on their last fetch are named in the funnel', async () => {
  const { writeSourcesState } = await import('../../src/jobs/sources.ts');
  const w = world('example');
  seedOwner(w.ctx, w.vault);
  writeSourcesState(w.jobsHome, { started: '2026-11-19T09:00:00Z', finished: '2026-11-19T09:05:00Z', ok: true, new: 0, trigger: 'command',
    by_key: { remotive: { at: '2026-11-19T09:01:00Z', ok: true, jobs: 0, new: 0, kept: 0, refused: 0 }, himalayas: { at: '2026-11-19T09:01:00Z', ok: false, jobs: 0, new: 0, kept: 0, refused: 0, error: 'needs keywords: they come from your job titles' }, jobicy: { at: '2026-11-19T09:01:00Z', ok: true, jobs: 40, new: 3, kept: 1, refused: 0 } } } as any);
  const f = findFunnel(w.ctx, 5);
  assert.deepEqual(f.sources, { total: 9, empty: 2, why: ['no postings', 'needs keywords'] });
});

test('honest counts: fits by company ("3 fits from 2 companies"); a fit set aside at Prepare is no longer a fit', () => {
  const w = world('berlin-analyst');
  const a1 = role(w.ctx, { company: 'Example Data' }), a2 = role(w.ctx, { company: 'Example Data', title: 'BI Analyst' });
  const b = role(w.ctx, { company: 'Sample Insights', title: 'Data Analyst' });
  runPrefilter(w.ctx);
  judge(w.ctx, [a1, a2, b].map((id) => ({ role: id, eligible: 'yes', score: 80, evidence: 'from the posting' })) as any);
  let f = findFunnel(w.ctx, 2);
  assert.deepEqual([f.fits, f.fit_companies], [3, 2]);
  assert.match(f.line, /→ 3 judged → 3 fits from 2 companies$/);
  // Prepare reads one pick in full and it doesn't fit: by hand (status judged_out) or a "no" through judge.
  const picked = pick(w.ctx, 2);
  assert.equal(picked.length, 2);
  setRoleStatus(w.ctx, picked[0], 'judged_out', 'needs a licence the user lacks');
  assert.equal((w.ctx.db.prepare('select eligibility from roles where id=?').get(picked[0]) as any).eligibility, 'no');
  judge(w.ctx, [{ role: picked[1], eligible: 'no', score: 10, evidence: 'requires relocation to Munich', reason: 'on-site in Munich only' }] as any);
  assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(picked[1]) as any).status, 'judged_out');
  f = findFunnel(w.ctx, 2);
  assert.equal(f.fits + f.no + f.unclear, f.judged);
  assert.deepEqual([f.fits, f.no], [1, 2]);
});

test('coverage whenever fewer than 3 × N passed the rules, not only when the pool is small', () => {
  const w = world('berlin-analyst');
  for (let i = 0; i < 6; i++) role(w.ctx, { company: `Example Munich ${i}`, location: 'Munich, Germany' });
  role(w.ctx, { company: 'Example Berlin 1' }); role(w.ctx, { company: 'Example Berlin 2' });
  runPrefilter(w.ctx);
  const f = findFunnel(w.ctx, 2);
  assert.equal(f.fetched, 8, 'fetched ≥ 4 × need');
  assert.equal(f.passed_rules, 2, 'passed < 3 × need');
  assert.ok(f.coverage && f.coverage.length > 20, String(f.coverage));
});
