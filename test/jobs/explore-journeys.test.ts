// Four Jobs journeys: one-tap reasons (Not interested on For you, Hide on Explore) that reach memory and learning; Find more
// (the sheet opens with the last Find's settings, the picks ADD to today's, judged roles never come back); Pick from (`--from`
// on candidates and pick, the sheet's sources and "N available"); Check fit and Apply on Explore rows (a one-role judge request
// and its verdict on the row; Apply with check_first, and "Apply anyway"). Fictional data, a temp home, no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { REASONS } from '../../web/jobs/screens/reasons.js';
import { Explore } from '../../web/jobs/screens/explore.js';
import { FindSheet, availableFrom } from '../../web/jobs/screens/find.js';
import { Today } from '../../web/jobs/screens/today.js';
import { SKIP_REASONS, skipReasonText } from '../../src/jobs/pipeline/apply.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { personActions, refreshLearned, storedLearned } from '../../src/jobs/pipeline/learn.ts';
import { cleanFrom, fromMatches, budgetedCandidates, readFindRun, rankRoles } from '../../src/jobs/pipeline/rank.ts';
import { candidates, judge, pick } from '../../src/jobs/pipeline/pick.ts';
import { exploreRoles, markRole, poolSources } from '../../src/jobs/search/explore.ts';
import { parseTaskPrompt } from '../../src/session-link.ts';
import { jobs, REPO, role, world } from './helpers.ts';
import { jobsServer } from './api-helpers.ts';

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, (e) => ({ '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' }[e] ?? e)).replace(/\s+/g, ' ').trim();
const yes = (id: string, score = 80) => ({ role: id, eligible: 'yes' as const, score, evidence: 'SQL and dashboards', reason: 'fits' });
const memoryTexts = (ctx: ReturnType<typeof world>['ctx']) => notesOf(ctx).memory.data.items.map((i: any) => String(i.text));

// ---- 1. one-tap reasons ----

test('the chips: the page and the server keep the same eight, the reason text is the label (+ the words), Other is the words alone', () => {
  assert.deepEqual(REASONS, [...SKIP_REASONS].map((r) => ({ ...r })), 'web/jobs/screens/reasons.js and SKIP_REASONS agree');
  assert.deepEqual(REASONS.map((r) => r.label), ['Wrong location', 'Too junior', 'Too senior', 'Not my stack', "Don't like the company", 'Pay too low', 'Already applied elsewhere', 'Other']);
  assert.equal(skipReasonText('too_junior', ''), 'Too junior');
  assert.equal(skipReasonText('too_junior', '  it is an   intern role '), 'Too junior: it is an intern role');
  assert.equal(skipReasonText('other', 'too much travel'), 'too much travel');
  assert.equal(skipReasonText('other', ''), '');
  assert.throws(() => skipReasonText('nope', ''), /not one of the reasons/);
});

test('Not interested with one tap: skipped, the label remembered (memory), counted by learn.ts; chip + words; Other needs words; a bad chip is refused', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const [a, b, c, d] = ['Alpha Data', 'Bravo Data', 'Charlie Data', 'Delta Data'].map((company) => role(s.w.ctx, { company, title: 'Data Analyst', description: 'SQL', source_key: 'arbeitnow' }));
    const one = await s.action('notInterested', { role: a, chip: 'too_junior' });
    assert.equal(one.status, 200, one.body);
    assert.equal(s.w.ctx.db.prepare('select status from roles where id=?').get(a).status, 'skipped');
    assert.ok(memoryTexts(s.w.ctx).includes('Too junior'), 'the chip label is the remembered reason');
    assert.equal((s.w.ctx.db.prepare(`select detail from events where role_id=? and kind='skip'`).get(a) as any).detail, 'Too junior');
    const words = await s.action('notInterested', { role: b, chip: 'pay', note: 'below my floor' });
    assert.equal(words.status, 200, words.body);
    assert.ok(memoryTexts(s.w.ctx).includes('Pay too low: below my floor'));
    const other = await s.action('notInterested', { role: c, chip: 'other', note: 'too much travel', titleWords: ['Travel'] });
    assert.equal(other.status, 200, other.body);
    assert.ok(memoryTexts(s.w.ctx).includes('too much travel'), 'Other: the words alone');
    assert.deepEqual(other.json.title_words, ['Travel']);
    assert.equal((await s.action('notInterested', { role: d, chip: 'other' })).status, 400, 'Other with no words');
    assert.equal((await s.action('notInterested', { role: d, chip: 'rude' })).status, 400, 'not a reason');
    assert.equal((await s.action('notInterested', { role: d })).status, 400, 'no reason at all');
    assert.equal((await s.action('notInterested', { role: d, reason: 'old style free text' })).status, 200, 'the free-text path still works');
    // Learning: the person's own skips (Claude's verdicts never count).
    const acts = personActions(s.w.ctx).filter((x) => x.signal === 'not_interested').map((x) => x.company).sort();
    assert.deepEqual(acts, ['Alpha Data', 'Bravo Data', 'Charlie Data', 'Delta Data']);
    assert.ok(refreshLearned(s.w.ctx).companies.size >= 4);
  } finally { await s.close(); }
});

test('Hide on Explore is hide + reason: the same store (skipped, memory, learning), the role is hidden; a plain hide says nothing and learns nothing', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const [a, b, c] = ['Echo Data', 'Foxtrot Data', 'Golf Data'].map((company) => role(s.w.ctx, { company, title: 'Data Analyst', description: 'SQL', source_key: 'arbeitnow' }));
    const h = await s.action('hideRole', { role: a, chip: 'location' });
    assert.equal(h.status, 200, h.body);
    assert.equal(h.json.reason, 'Wrong location');
    assert.equal(s.w.ctx.db.prepare('select status from roles where id=?').get(a).status, 'skipped');
    assert.equal((s.w.ctx.db.prepare('select state from saved_roles where role_id=?').get(a) as any).state, 'hidden');
    assert.ok(memoryTexts(s.w.ctx).includes('Wrong location'));
    assert.ok((await s.get('explore')).json.rows.every((r: any) => r.id !== a), 'gone from Explore');
    const plain = await s.action('hideRole', { role: b });
    assert.deepEqual(plain.json, { ok: true, changed: true });
    assert.equal(s.w.ctx.db.prepare('select status from roles where id=?').get(b).status, 'new', 'no reason: only hidden');
    assert.deepEqual(personActions(s.w.ctx).filter((x) => x.signal === 'not_interested').map((x) => x.company), ['Echo Data']);
    assert.equal((await s.action('hideRole', { role: c, chip: 'other' })).status, 400);
    assert.equal((await s.action('hideRole', { role: c, chip: 'stack', note: 'COBOL' }, s.agent())).status, 403, 'an agent token is not the page');
    // A role hidden with a skip event whose status moved on is still the person's "not interested" (extended in learn.ts).
    s.w.ctx.db.prepare(`insert into events(role_id, kind, detail, at) values (?, 'skip', 'Pay too low', ?)`).run(c, new Date().toISOString());
    markRole(s.w.ctx, c, 'hidden');
    assert.deepEqual(personActions(s.w.ctx).filter((x) => x.signal === 'not_interested').map((x) => x.company).sort(), ['Echo Data', 'Golf Data']);
    refreshLearned(s.w.ctx);
    assert.ok(storedLearned(s.w.ctx).some((r) => r.kind === 'company' && r.label === 'Echo Data' && r.delta < 0), 'ranked lower from then on');
  } finally { await s.close(); }
});

// ---- 2. Find more ----

test('Find more: the payload carries { more: true } and the last Find\'s settings; checked like the rest', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const f = await s.action('find', { count: 3, portals: [], budget: 40, prepare: 3, from: ['linkedin', 'ats', 'LinkedIn'], more: true });
    assert.equal(f.status, 200, f.body);
    assert.deepEqual(s.q.get(f.json.request)!.payload, { count: 3, portals: [], budget: 40, prepare: 3, from: ['linkedin', 'ats'], more: true });
    s.q.cancel(f.json.request, 'jobs');
    const all = await s.action('find', { count: 3, from: [], more: false });
    assert.deepEqual(s.q.get(all.json.request)!.payload, { count: 3 }, 'no sources chosen and not "more": left out');
    s.q.cancel(all.json.request, 'jobs');
    for (const bad of [{ from: 'linkedin' }, { from: ['not a key'] }, { from: ['x'.repeat(81)] }, { from: Array.from({ length: 31 }, (_, i) => `k${i}`) }, { more: 'yes' }]) {
      assert.equal((await s.action('find', bad)).status, 400, JSON.stringify(bad));
    }
  } finally { await s.close(); }
});

test('pick --n is idempotent for the day; pick --add adds up to N NEW picks (once per Find), judged roles are never judged again', () => {
  const w = world('berlin-analyst');
  const ids = Array.from({ length: 8 }, (_, i) => role(w.ctx, { company: `Company ${String.fromCharCode(65 + i)}`, title: 'Senior Data Analyst', description: 'SQL and dashboards for reporting teams', source_key: 'arbeitnow' }));
  judge(w.ctx, ids.slice(0, 4).map((id, i) => yes(id, 90 - i)));
  const first = pick(w.ctx, 2);
  assert.equal(first.length, 2);
  assert.deepEqual(pick(w.ctx, 2), first, 'same N, same picks');
  assert.deepEqual(pick(w.ctx, 2), first);
  // A second Find that day: it starts (the day's count is kept in its run), judges further down, and adds up to 2 NEW picks.
  // 2 eligible are left on the bench, fewer than the 3 asked for: the Find goes on to read the roles nobody judged.
  const day = budgetedCandidates(w.ctx, { budget: 20, batch: 10, need: 3, start: true });
  assert.equal(readFindRun(w.ctx.home)!.base!.picked, 2);
  assert.equal(day.run.passed, 2);
  assert.ok(day.batch.every((c) => !ids.slice(0, 4).includes(c.id)), 'the four judged roles are never handed out again');
  assert.deepEqual(day.batch.map((c) => c.id).sort(), ids.slice(4).sort(), 'it reads further down: the four not judged yet');
  judge(w.ctx, ids.slice(4).map((id) => yes(id, 50)));
  const more = pick(w.ctx, 3, undefined, { add: true });
  assert.equal(more.length, 5, 'three more on top of the two');
  assert.ok(first.every((id) => more.includes(id)), 'the first picks stay');
  assert.deepEqual(pick(w.ctx, 3, undefined, { add: true }), more, 'run again in the same Find: nothing more is added');
  assert.deepEqual(pick(w.ctx, 5), more, 'and a plain pick of the new total agrees');
  // A third Find: three eligible roles wait already ("enough": nothing is read), and three more are added.
  const third = budgetedCandidates(w.ctx, { budget: 20, batch: 10, need: 3, start: true });
  assert.deepEqual([third.run.why, third.batch.length], ['enough', 0]);
  assert.equal(pick(w.ctx, 3, undefined, { add: true }).length, 8);
  // Fewer eligible than asked: never padded.
  budgetedCandidates(w.ctx, { budget: 20, batch: 10, need: 3, start: true });
  assert.equal(pick(w.ctx, 5, undefined, { add: true }).length, 8, 'only 8 roles exist: nothing more to add');
  assert.throws(() => pick(w.ctx, 51), /from 0 to 50/);
});

test('crewdeck jobs pick --add N [--from k]: prints how many were added; the CLI and the library agree', () => {
  const x = world('berlin-analyst');
  const ids = ['Hotel', 'India', 'Juliet', 'Kilo'].map((c) => role(x.ctx, { company: `${c} Data`, title: 'Senior Data Analyst', description: 'SQL', source_key: c === 'Kilo' ? 'api:himalayas' : 'arbeitnow' }));
  judge(x.ctx, ids.map((id) => yes(id)));
  x.ctx.db.close();
  const first = jobs(x.home, ['pick', '--n', '1']);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out.trim().split('\n').filter((l) => /^[a-f0-9]{12} /.test(l)).length, 1);
  assert.equal(jobs(x.home, ['candidates', '--budget', '20', '--start', '--need', '2']).code, 0);
  const add = jobs(x.home, ['pick', '--add', '--n', '2', '--from', 'api:himalayas']);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /added 1 \(2 picked today\)/, 'only Himalayas\' role is in the pool of this pick');
  assert.match(add.out, /Kilo Data/);
  const again = jobs(x.home, ['pick', '--add', '--n', '2', '--from', 'api:himalayas']);
  assert.match(again.out, /added 0 \(2 picked today\)/, 'the same Find: nothing more');
  const bad = jobs(x.home, ['pick', '--add', '--n', '2', '--from', 'Not A Key']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /is not a source key/);
});

// ---- 3. Pick from ----

test('--from: a role\'s source_key is the key or sits under it (ats takes every careers page); no keys is every source', () => {
  assert.equal(fromMatches('linkedin', ['linkedin']), true);
  assert.equal(fromMatches('portal:naukri', ['portal:naukri', 'api']), true);
  assert.equal(fromMatches('portal:naukri', ['portal']), true, 'a prefix up to the colon');
  assert.equal(fromMatches('ats:greenhouse:atlan', ['ats']), true);
  assert.equal(fromMatches('ats:greenhouse:atlan', ['ats:lever']), false);
  assert.equal(fromMatches('linkedinx', ['linkedin']), false, 'not a bare string prefix');
  assert.equal(fromMatches('api:himalayas', ['linkedin']), false);
  assert.equal(fromMatches(null, ['linkedin']), false, 'a pasted link has no source: never in a source filter');
  assert.equal(fromMatches('anything', undefined), true);
  assert.equal(fromMatches(null, []), true);
  assert.deepEqual(cleanFrom('linkedin, ATS ,linkedin'), ['linkedin', 'ats']);
  assert.throws(() => cleanFrom('a b'), /not a source key/);
  assert.throws(() => cleanFrom(7), /list of at most/);
});

test('candidates --from filters the ranked pool (the library and the CLI); the funnel and "passed" follow the sources chosen', () => {
  const x = world('berlin-analyst');
  const mk = (company: string, key: string) => role(x.ctx, { company, title: 'Senior Data Analyst', description: 'SQL and dashboards', source_key: key });
  const li = mk('Lima Data', 'linkedin'), hi = mk('Mike Data', 'api:himalayas'), ats = mk('Nov Data', 'ats:greenhouse:novdata'), ats2 = mk('Oscar Data', 'ats:lever:oscar'), nk = mk('Papa Data', 'portal:naukri');
  assert.deepEqual(rankRoles(x.ctx).map((r) => r.id).sort(), [li, hi, ats, ats2, nk].sort());
  assert.deepEqual(rankRoles(x.ctx, { from: ['linkedin'] }).map((r) => r.id), [li]);
  assert.deepEqual(rankRoles(x.ctx, { from: ['ats'] }).map((r) => r.id).sort(), [ats, ats2].sort());
  assert.deepEqual(candidates(x.ctx, 40, ['api:himalayas', 'portal:naukri']).map((c) => c.id).sort(), [hi, nk].sort());
  const run = budgetedCandidates(x.ctx, { budget: 20, batch: 10, need: 2, start: true, from: ['ats'] });
  assert.deepEqual(run.batch.map((c) => c.id).sort(), [ats, ats2].sort());
  assert.equal(run.pool.unjudged, 2);
  // Eligible roles of another source don't count as "enough" for a Find limited to these sources.
  judge(x.ctx, [yes(li), yes(hi)]);
  assert.equal(budgetedCandidates(x.ctx, { budget: 20, batch: 10, need: 2, from: ['ats'] }).run.passed, 0);
  assert.equal(budgetedCandidates(x.ctx, { budget: 20, batch: 10, need: 2 }).run.passed, 2);
  // pick --from takes only from those sources.
  judge(x.ctx, [yes(ats)]);
  assert.deepEqual(pick(x.ctx, 3, undefined, { from: ['ats'] }), [ats], 'LinkedIn\'s and Himalayas\' eligible roles stay on the bench');
  x.ctx.db.close();
  const r = jobs(x.home, ['candidates', '--from', 'ats,portal:naukri', '--limit', '10']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).map((c: any) => c.id).sort(), [ats2, nk].sort(), 'Nov Data is picked already, so only the others are unjudged');
  const b = jobs(x.home, ['candidates', '--budget', '20', '--start', '--from', 'linkedin']);
  assert.equal(JSON.parse(b.out).batch.length, 0, 'LinkedIn\'s role was judged');
  assert.notEqual(jobs(x.home, ['candidates', '--from', '../etc']).code, 0);
});

test('the sheet\'s Pick from: GET find-pool lists the sources with unjudged roles (ats grouped, other occupations and judged roles not counted); the page can read it', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const mk = (company: string, key: string, over: Record<string, unknown> = {}) => role(s.w.ctx, { company, title: 'Senior Data Analyst', description: 'SQL', source_key: key, ...over } as any);
    mk('Quebec Data', 'linkedin'); mk('Romeo Data', 'linkedin'); mk('Sierra Data', 'api:himalayas'); mk('Tango Data', 'ats:greenhouse:tango'); mk('Uniform Data', 'ats:lever:uniform'); mk('Victor Data', 'portal:naukri', { source: 'portal' });
    mk('Whiskey Care', 'linkedin', { title: 'Registered Nurse' });
    const judged = mk('Xray Data', 'linkedin'); judge(s.w.ctx, [yes(judged)]);
    const r = await s.get('find-pool');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.total, 6, 'the nurse is another occupation, the judged role is done');
    assert.deepEqual(r.json.sources.map((x: any) => [x.key, x.unjudged]), [['ats', 2], ['linkedin', 2], ['api:himalayas', 1], ['portal:naukri', 1]]);
    assert.deepEqual(r.json.sources.find((x: any) => x.key === 'ats'), { key: 'ats', label: 'Company careers pages', group: 'feeds', unjudged: 2 });
    assert.equal(r.json.sources.find((x: any) => x.key === 'portal:naukri').group, 'accounts');
    assert.equal(r.json.sources.find((x: any) => x.key === 'api:himalayas').label, 'Himalayas');
    assert.deepEqual(poolSources(s.w.ctx).sources.map((x) => x.key), r.json.sources.map((x: any) => x.key));
    assert.equal((await s.get('find-pool', { 'sec-fetch-site': 'cross-site' })).status, 403);
  } finally { await s.close(); }
});

test('the Find sheet: Pick from (All sources by default, or choose), "N available", the estimate follows, Find more opens with the last settings', () => {
  const pool = { total: 40, sources: [{ key: 'linkedin', label: 'LinkedIn', group: 'accounts', unjudged: 12 }, { key: 'ats', label: 'Company careers pages', group: 'feeds', unjudged: 8 }, { key: 'api:himalayas', label: 'Himalayas', group: 'feeds', unjudged: 20 }] };
  assert.equal(availableFrom(pool, null), 40);
  assert.equal(availableFrom(pool, new Set(['linkedin', 'ats'])), 20);
  assert.equal(availableFrom(null, null), null);
  const plain = render(html`<${FindSheet} portals=${[]} pool=${pool} found=${40} />`);
  assert.match(text(plain), /Pick from All sources \(default\) 40 available Or choose/);
  assert.match(plain, /type="radio"[^>]*name="pick-from"[^>]*checked/);
  assert.doesNotMatch(text(plain), /Company careers pages/, 'the sources show once "Or choose" is on');
  assert.match(text(render(html`<${FindSheet} portals=${[]} />`)), /^((?!Pick from).)*$/, 'no pool known: no Pick from');
  // Opened by Find more: the last Find's settings, the sources chosen, a heading that says what it is.
  const more = render(html`<${FindSheet} portals=${[]} pool=${pool} found=${40} more=${true} initial=${{ portals: [], budget: 80, prepare: 5, from: ['linkedin', 'ats'] }} />`);
  const t = text(more);
  assert.match(t, /Find more like these Claude reads further down the ranking and adds new picks to today's/);
  assert.match(t, /LinkedIn 12 available Company careers pages 8 available Himalayas 20 available/);
  assert.match(more, /aria-checked="true"[^>]*>80</);
  assert.match(more, /<option value="5" selected>5<\/option>/);
  assert.match(t, /From 20 available in 2 chosen sources, best first\./);
  assert.match(t, /new picks, never padded/);
  // Fewer available than the budget: said, and the estimate counts what can be read.
  const few = text(render(html`<${FindSheet} portals=${[]} pool=${pool} found=${40} initial=${{ budget: 80, from: ['ats'] }} />`));
  assert.match(few, /From 8 available in 1 chosen source, best first\. Only 8 to read: Claude reads all of them\./);
  const costs = (m: string) => Number(/≈ (\d+)k/.exec(m)![1]);
  assert.ok(costs(few) < costs(text(render(html`<${FindSheet} portals=${[]} pool=${pool} found=${40} initial=${{ budget: 80, from: ['api:himalayas', 'linkedin'] }} />`))), 'fewer to read, fewer tokens');
  // For you: the link under the picks.
  const data = { queue: [{ id: 'aaaaaaaaaaaa', company: 'Example Co', title: 'Analyst', chip: { kind: 'ready', text: 'Ready to apply' } }], selected: 'aaaaaaaaaaaa', detail: null, proposals: null, find: null, progress: null, quick_apply: null };
  const today = render(html`<${Today} data=${data} state=${{}} />`);
  assert.match(today, /<button[^>]*class="linkbtn findmore"[^>]*><span class="spark">.*?<\/span>Find more like these<\/button>/);
});

// ---- 4. Check fit and Apply on Explore rows ----

test('Check fit: a one-role judge request (about 1.5k tokens, a Jobs chat in front), one at a time, only for a role nobody judged; Judge these N is separate', async () => {
  const opened: string[] = [];
  const s = await jobsServer('berlin-analyst', { api: { platform: 'darwin', autoOpenChat: true, openLink: async (l) => { opened.push(l); } } });
  try {
    const [a, b] = ['Yankee Data', 'Zulu Data'].map((company) => role(s.w.ctx, { company, title: 'Senior Data Analyst', description: 'SQL', source_key: 'arbeitnow' }));
    const r = await s.action('checkFit', { role: a });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.tokens, 1500);
    assert.equal(r.json.opened, true);
    const req = s.q.get(r.json.request)!;
    assert.deepEqual([req.lane, req.kind, req.status, req.payload], ['jobs', 'judge', 'new', { roles: [a], check: true }]);
    assert.deepEqual(parseTaskPrompt(decodeURIComponent(/&q=(.*)$/.exec(opened.at(-1)!)![1]!)), { kind: 'judge', request: r.json.request }, 'the same judge prompt shape: no new one');
    const again = await s.action('checkFit', { role: a });
    assert.deepEqual([again.json.request, again.json.already], [r.json.request, true]);
    // The row says so while it runs; a second role has its own request; Judge these N is a different request.
    let rows = (await s.get('explore')).json.rows;
    assert.deepEqual(rows.map((x: any) => [x.id === a, x.checking, x.applying]).sort(), [[false, false, false], [true, true, false]]);
    assert.equal((await s.action('checkFit', { role: b })).json.already, undefined);
    await s.action('saveRole', { role: b });
    s.q.cancel(s.q.ofLane('jobs', 'judge').find((x) => x.ref === undefined && (x.payload!.roles as string[])[0] === b)!.id, 'jobs');
    const saved = await s.action('judgeSaved', {});
    assert.equal(saved.status, 200, 'a Check fit in flight is not "Judge these N"');
    assert.equal(saved.json.already, undefined);
    s.q.cancel(saved.json.request, 'jobs');
    // What Claude reads: the role, and check: true in the payload (the skill stops after the verdict).
    const show = await s.call('POST', `/api/requests/${r.json.request}/show`, s.agent(), { cwd: s.workspace });
    assert.equal(show.json.payload.check, true);
    assert.deepEqual(show.json.context.roles.map((x: any) => x.id), [a]);
    // The verdict is stored by `judge`: the row shows yes / no / unclear, the reason and the quote.
    judge(s.w.ctx, [{ role: a, eligible: 'no', score: 12, evidence: 'Fluent German (C1) required', reason: 'needs German C1' }]);
    rows = (await s.get('explore?include=expired')).json.rows;
    const row = rows.find((x: any) => x.id === a);
    assert.deepEqual(row.verdict, { eligible: 'no', reason: 'needs German C1', quote: 'Fluent German (C1) required', score: 12 });
    assert.equal(row.status, 'judged_out');
    assert.equal(rows.find((x: any) => x.id === b).verdict, null);
    s.q.cancel(r.json.request, 'jobs');
    assert.equal((await s.action('checkFit', { role: a })).status, 400, 'judged already: the verdict is on the row');
    assert.equal((await s.action('checkFit', { role: a }, s.agent())).status, 403);
    assert.equal((await s.action('checkFit', { role: 'abcdefabcdef' })).status, 404);
    s.w.ctx.db.prepare(`update roles set status='picked' where id=?`).run(b);
    assert.equal((await s.action('checkFit', { role: b })).status, 400, 'a pick is not checked');
  } finally { await s.close(); }
});

test('Apply on an Explore row: ONE apply request with check_first for an unjudged role; Apply anyway after a no re-queues without it; judged (yes) and picked roles go straight on', async () => {
  const opened: string[] = [];
  const s = await jobsServer('berlin-analyst', { api: { platform: 'darwin', autoOpenChat: true, openLink: async (l) => { opened.push(l); } } });
  try {
    const mk = (company: string, over: Record<string, unknown> = {}) => role(s.w.ctx, { company, title: 'Senior Data Analyst', description: 'SQL', source_key: 'arbeitnow', ...over } as any);
    const fresh = mk('Alpha Apply'), no = mk('Bravo Apply'), maybe = mk('Charlie Apply'), pickedId = mk('Delta Apply');
    const r = await s.action('exploreApply', { role: fresh });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.check_first, true);
    assert.equal(r.json.tokens, 1500);
    const req = s.q.get(r.json.request)!;
    assert.deepEqual([req.lane, req.kind, req.ref, req.payload], ['jobs', 'apply', fresh, { role: fresh, check_first: true }]);
    assert.deepEqual(parseTaskPrompt(decodeURIComponent(/&q=(.*)$/.exec(opened.at(-1)!)![1]!)), { kind: 'apply', role: fresh, request: r.json.request }, 'the apply prompt shape is unchanged');
    assert.equal((await s.action('exploreApply', { role: fresh })).json.already, true, 'one request, however often it is clicked');
    assert.equal(s.q.ofLane('jobs', 'apply').filter((x) => x.status === 'new').length, 1);
    let row = (await s.get('explore')).json.rows.find((x: any) => x.id === fresh);
    assert.deepEqual([row.checking, row.applying], [true, true], 'the row shows it is being checked');
    // What Claude reads: the payload with check_first, and the role as it stands.
    const show = await s.call('POST', `/api/requests/${r.json.request}/show`, s.agent(), { cwd: s.workspace });
    assert.equal(show.json.payload.check_first, true);
    assert.equal(show.json.context.role.status, 'new');
    s.q.cancel(r.json.request, 'jobs');
    // A clear no: the skill stops; the page offers Apply anyway, which is refused without the person's click, and queues WITHOUT check_first.
    judge(s.w.ctx, [{ role: no, eligible: 'no', score: 5, evidence: 'On-site in Mumbai only', reason: 'not remote' }]);
    assert.equal((await s.action('exploreApply', { role: no })).status, 400, 'a no is never applied to by a plain click');
    const anyway = await s.action('exploreApply', { role: no, anyway: true });
    assert.equal(anyway.status, 200, anyway.body);
    assert.equal(anyway.json.check_first, undefined);
    assert.deepEqual(s.q.get(anyway.json.request)!.payload, { role: no }, 'no check_first');
    s.q.cancel(anyway.json.request, 'jobs');
    // Judged yes / unclear: no second judge, the skill picks it, prepares it, fills it.
    judge(s.w.ctx, [{ role: maybe, eligible: 'unclear', score: 40, evidence: 'Hybrid, city not named', reason: 'unclear place' }]);
    const m = await s.action('exploreApply', { role: maybe });
    assert.deepEqual(s.q.get(m.json.request)!.payload, { role: maybe });
    s.q.cancel(m.json.request, 'jobs');
    // Already picked: exactly the Apply button's behaviour (an unprepared pick is prepared first).
    s.w.ctx.db.prepare(`update roles set status='picked' where id=?`).run(pickedId);
    const p = await s.action('exploreApply', { role: pickedId });
    assert.equal(p.status, 200, p.body);
    assert.equal(p.json.preparing, true);
    assert.equal(s.q.get(p.json.request)!.kind, 'prepare');
    s.q.cancel(p.json.request, 'jobs');
    // Not for an applied or skipped role, nor from an agent.
    s.w.ctx.db.prepare(`update roles set status='applied' where id=?`).run(fresh);
    assert.equal((await s.action('exploreApply', { role: fresh })).status, 400);
    assert.equal((await s.action('exploreApply', { role: maybe }, s.agent())).status, 403);
    row = (await s.get('explore?include=applied')).json.rows.find((x: any) => x.id === no);
    assert.equal(row.verdict.eligible, 'no');
  } finally { await s.close(); }
});

test('Explore rows: the verdict (yes / no / unclear, the reason, the quote), Check fit with 1.5k tokens, Apply, Apply anyway; the spark on the Claude buttons only', () => {
  const base = { id: 'aaaaaaaaaaaa', title: 'Data Analyst', company: 'Alpha Data', location: 'Berlin', workplace: null, source_label: 'Arbeitnow', group: 'feeds', posted_at: null, url: 'https://jobs.example.com/a', saved: false, status: 'new', verdict: null };
  const row = (over: Record<string, unknown>) => ({ ...base, ...over });
  const data = { total: 4, counts: { feeds: 4, accounts: 0, saved: 0, others: 0 }, judgeable: 0, rows: [
    row({}),
    row({ id: 'bbbbbbbbbbbb', title: 'BI Analyst', company: 'Bravo', status: 'judged_out', verdict: { eligible: 'no', reason: 'needs German C1', quote: 'Fluent German (C1)', score: 10 } }),
    row({ id: 'cccccccccccc', title: 'Data Lead', company: 'Charlie', status: 'bench', verdict: { eligible: 'unclear', reason: 'place not named', quote: '', score: 40 } }),
    row({ id: 'dddddddddddd', title: 'Reporting Analyst', company: 'Delta', status: 'picked', verdict: { eligible: 'yes', reason: 'fits', quote: 'SQL', score: 90 } }),
  ] };
  const out = render(html`<${Explore} data=${data} />`);
  const t = text(out);
  assert.match(t, /Data Analyst Alpha Data .*Check fit ~1\.5k tokens Apply/);
  assert.match(out, /aria-label="Check fit: Data Analyst at Alpha Data, ~1\.5k tokens"/);
  assert.match(t, /BI Analyst Bravo Fit: no needs German C1 Fluent German \(C1\) Apply anyway/);
  assert.match(out, /<q class="vquote">Fluent German \(C1\)<\/q>/);
  assert.match(t, /Data Lead Charlie Fit: unclear place not named Apply/);
  assert.doesNotMatch(t, /Data Lead Charlie Fit: unclear place not named Check fit/, 'judged roles are not checked again');
  assert.match(t, /Reporting Analyst Delta Fit: yes fits SQL/);
  assert.doesNotMatch(t, /Delta[^|]*Apply/, 'a pick has no Apply here: it is in For you');
  // While it runs: "Checking…" and the button waits.
  const busy = render(html`<${Explore} data=${{ ...data, rows: [row({ checking: true, applying: true })] }} />`);
  assert.match(busy, /disabled[^>]*>.*?Checking…/);
});

// ---- the skills ----

const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

test('the skills: Find\'s from / more / --add, Check fit judges only, Apply with check_first judges on Haiku, picks, prepares on Sonnet, stops before Submit; Apply anyway', () => {
  const daily = read('plugin', 'skills', 'jobs-daily-run', 'SKILL.md');
  assert.match(daily, /- `from`: "Pick from"/);
  assert.match(daily, /candidates --budget 40 --batch 10 --need N --start`, with the request's `budget`[\s\S]*`--from <keys>`/);
  assert.match(daily, /`more: true`[\s\S]*`pick --add N`/);
  assert.match(daily, /crewdeck jobs pick --add N`[\s\S]*added K \(M picked today\)/);
  assert.match(daily, /payload has `check: true` is \*\*Check fit\*\* on one Explore row[\s\S]*\*\*No pick and no prepare\*\*/);
  const ws = read('plugin', 'skills', 'jobs-workspace', 'SKILL.md');
  const apply = /### A role that is not picked yet \(Apply from Explore\)([\s\S]*?)### The hard rule/.exec(ws)![1]!;
  assert.match(apply, /`check_first: true`/);
  assert.match(apply, /`model: "haiku"`/, 'judging is Haiku wherever it happens');
  assert.match(apply, /`model: "sonnet"`/, 'preparing is Sonnet wherever it happens');
  assert.match(apply, /On \*\*`no`\*\*: stop, do not open the posting or the form[\s\S]*`Not applied: judged no:/);
  assert.match(apply, /\*\*Apply anyway\*\*[\s\S]*without `check_first`/);
  assert.match(apply, /crewdeck jobs pick --role <role id>/);
  assert.match(apply, /never submitted/);
  assert.match(ws, /`payload\.check: true` is Explore's Check fit on one role[\s\S]*No pick, no prepare/);
  // Every `crewdeck …` line in both skills is a real command with real flags (the skills test lints all of them; --add and --from are in USAGE).
  const usage = read('src', 'jobs', 'commands.ts');
  assert.match(usage, /pick \[--n N\] \[--day D\] \[--from k1,k2\] \[--add\]/);
  assert.match(usage, /candidates … --from k1,k2/);
});

// ---- Explore's rows on the server: nothing else changed shape ----

test('GET explore rows carry verdict, checking and applying; the pool and counts are as before', async () => {
  const w = world('berlin-analyst');
  const a = role(w.ctx, { company: 'Alpha Row', title: 'Senior Data Analyst', description: 'SQL', source_key: 'arbeitnow' });
  const b = role(w.ctx, { company: 'Bravo Row', title: 'Senior Data Analyst', description: 'SQL', source_key: 'arbeitnow' });
  judge(w.ctx, [{ role: b, eligible: 'yes', score: 70, evidence: 'SQL', reason: 'fits' }]);
  const x = await exploreRoles(w.ctx, {}, { scorer: null });
  assert.deepEqual(x.rows.find((r) => r.id === a)!.verdict, null);
  assert.deepEqual(x.rows.find((r) => r.id === b)!.verdict, { eligible: 'yes', reason: 'fits', quote: 'SQL', score: 70 });
});

test('I applied (Explore): a job applied to on its own site goes to Applied, leaves Explore at once, and never comes back', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const [a, b] = ['Hotel Data', 'India Data'].map((company) => role(s.w.ctx, { company, title: 'Data Analyst', description: 'SQL', source_key: 'arbeitnow' }));
    const before = (await s.get('state')).json.counts.explore;
    const r = await s.action('markApplied', { role: a });
    assert.equal(r.status, 200, r.body);
    assert.equal(s.w.ctx.db.prepare('select status from roles where id=?').get(a).status, 'applied');
    const x = (await s.get('explore')).json;
    assert.ok(x.rows.every((row: any) => row.id !== a) && x.rows.some((row: any) => row.id === b), 'gone from Explore, the other stays');
    assert.equal((await s.get('state')).json.counts.explore, before - 1, 'the tab number drops at once');
    assert.ok(JSON.stringify((await s.get('applications')).json).includes(a), 'listed in Applied');
    // The button is on every not-picked row, without Claude's spark (it costs nothing).
    const out = render(html`<${Explore} data=${x} query=${{}} />`);
    assert.match(out, /aria-label="I applied to Data Analyst at India Data myself"[^>]*>I applied</);
  } finally { await s.close(); }
});
