// Explore (free, no Claude): the query over the roles that passed the rules (words, groups, strong title match, age, saved and
// hidden, other occupations, the order with and without search/hybrid.ts), its counts and paging; the page's endpoint and
// actions (Save, Hide, Unsave, Judge these N); the new `judge` request, its prompt on both sides (src/session-link.ts and the
// panel's plugin/hooks/register.tsx); the Find sheet's payload; and `candidates --roles-file` for the judge request. Fictional
// people and companies only; a temp home; no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_KINDS } from '../../src/requests.ts';
import { exploreParams } from '../../src/jobs/api.ts';
import { exploreCount, exploreRoles, judgeableSaved, markRole } from '../../src/jobs/search/explore.ts';
import { JOBS_SESSION_PROMPT, isJobsTaskLink, parseTaskPrompt, taskPrompt } from '../../src/session-link.ts';
import { openJobsDb } from '../../src/jobs/db.ts';
import { jobs, REPO, role, textFile, world } from './helpers.ts';
import { jobsServer } from './api-helpers.ts';

// ---- the query ----

const w = world('berlin-analyst');
const ctx = w.ctx; // the world's clock: 2026-11-19T10:00:00Z
const id: Record<string, string> = {};
before(() => {
  const mk = (key: string, company: string, over: Record<string, unknown>, status?: string) => { id[key] = role(ctx, { company, ...over } as any, status); };
  mk('A', 'Acme Analytics', { title: 'Senior Data Analyst', description: 'SQL, dashboards and 100% ownership', source_key: 'arbeitnow', posted_at: '2026-11-18T10:00:00Z', workplace: 'hybrid', location: 'Berlin' });
  mk('B', 'Beta Works', { title: 'Data Analyst', description: 'Reporting', source_key: 'portal:naukri', source: 'portal', posted_at: '2026-11-10T10:00:00Z' }, 'picked');
  mk('C', 'Cinder Labs', { title: 'BI Analyst', description: 'Dashboards for sales', source_key: 'linkedin', source: 'linkedin', posted_at: '2026-11-17T10:00:00Z' }, 'bench');
  mk('D', 'Dawn Care Home', { title: 'Registered Nurse', description: 'Night shifts', source_key: 'arbeitnow', posted_at: '2026-11-18T09:00:00Z' });
  mk('E', 'Echo Done Co', { title: 'Data Analyst', description: '', source_key: 'arbeitnow', posted_at: '2026-11-18T08:00:00Z' }, 'applied');
  mk('F', 'Foxtrot Gone Co', { title: 'Data Analyst', description: '', source_key: 'arbeitnow' }, 'expired');
  mk('G', 'Golf Filtered Co', { title: 'Data Analyst', description: '', source_key: 'arbeitnow' }, 'prefiltered_out');
  mk('H', 'Hotel Hidden Co', { title: 'Senior Data Analyst', description: 'Secret', source_key: 'arbeitnow', posted_at: '2026-11-18T07:00:00Z' });
  markRole(ctx, id.H, 'hidden');
});

const ids = (r: { rows: { id: string }[] }) => r.rows.map((x) => x.id);
const keys = (r: { rows: { id: string }[] }) => r.rows.map((x) => Object.keys(id).find((k) => id[k] === x.id));

test('the pool: roles that passed the rules; applied, expired, prefiltered and hidden ones stay out; counts by group', async () => {
  const r = await exploreRoles(ctx, {}, { scorer: null });
  assert.deepEqual(keys(r).sort(), ['A', 'B', 'C']);
  assert.equal(r.total, 3);
  assert.deepEqual(r.counts, { feeds: 2, accounts: 1, saved: 0, others: 1 });
  assert.equal(exploreCount(ctx.db), 4, 'the tab number counts every open role, other occupations included');
  const row = r.rows.find((x) => x.id === id.A)!;
  assert.deepEqual(Object.keys(row).sort(), ['company', 'group', 'id', 'location', 'posted_at', 'saved', 'source_label', 'status', 'title', 'url', 'workplace']);
  assert.equal(row.group, 'feeds');
  assert.equal(r.rows.find((x) => x.id === id.B)!.group, 'accounts');
  assert.equal(r.rows.find((x) => x.id === id.B)!.status, 'picked');
  // Labels: the person's own list names a feed; a portal's roles are labelled by the portal's id; LinkedIn by its key.
  assert.equal(row.source_label, 'Arbeitnow');
  assert.equal(r.rows.find((x) => x.id === id.B)!.source_label, 'Naukri');
  assert.equal(r.rows.find((x) => x.id === id.C)!.source_label, 'Linkedin', 'a key the list does not name: its words, capitalised');
  const more = await exploreRoles(ctx, { include: ['applied', 'expired', 'bogus'] }, { scorer: null });
  assert.deepEqual(keys(more).sort(), ['A', 'B', 'C', 'E', 'F']);
});

test('groups: portal:* is your accounts, everything else is feeds; the counts stay put under the group chip', async () => {
  const feeds = await exploreRoles(ctx, { group: 'feeds' }, { scorer: null });
  assert.deepEqual(keys(feeds).sort(), ['A', 'C']);
  assert.equal(feeds.total, 2);
  assert.deepEqual(feeds.counts, { feeds: 2, accounts: 1, saved: 0, others: 1 });
  const accounts = await exploreRoles(ctx, { group: 'accounts' }, { scorer: null });
  assert.deepEqual(keys(accounts), ['B']);
});

test('words: every word in the title, company or description (any order, case-insensitive); % and _ are plain characters', async () => {
  assert.deepEqual(keys(await exploreRoles(ctx, { q: 'acme' }, { scorer: null })), ['A']);
  assert.deepEqual(keys(await exploreRoles(ctx, { q: 'DASHBOARDS' }, { scorer: null })).sort(), ['A', 'C']);
  assert.deepEqual(keys(await exploreRoles(ctx, { q: 'dashboards sales' }, { scorer: null })), ['C']);
  assert.deepEqual(keys(await exploreRoles(ctx, { q: 'analyst reporting' }, { scorer: null })), ['B']);
  assert.deepEqual(keys(await exploreRoles(ctx, { q: '100%' }, { scorer: null })), ['A'], 'a literal %');
  assert.equal((await exploreRoles(ctx, { q: '%' }, { scorer: null })).total, 1, 'only the role that has one');
  assert.equal((await exploreRoles(ctx, { q: '_' }, { scorer: null })).total, 0);
  // The counts follow the words.
  const c = (await exploreRoles(ctx, { q: 'dashboards' }, { scorer: null })).counts;
  assert.deepEqual([c.feeds, c.accounts], [2, 0]);
});

test('last 7 days, strong title match, other occupations, saved', async () => {
  assert.deepEqual(keys(await exploreRoles(ctx, { days: 7 }, { scorer: null })).sort(), ['A', 'C']);
  const strong = await exploreRoles(ctx, { strong: true, others: true }, { scorer: null });
  assert.ok(keys(strong).includes('A') && keys(strong).includes('B'), 'a title that holds one of the person\'s own');
  assert.ok(!keys(strong).includes('D'), 'a nurse is never a strong match');
  // Other occupations: counted apart, shown only when asked, always after the rest.
  const others = await exploreRoles(ctx, { others: true }, { scorer: null });
  assert.equal(keys(others).at(-1), 'D');
  assert.equal(others.total, 4);
  assert.equal(others.counts.others, 1);
  // Saved.
  markRole(ctx, id.A, 'saved'); markRole(ctx, id.C, 'saved'); markRole(ctx, id.B, 'saved');
  const saved = await exploreRoles(ctx, { saved: true }, { scorer: null });
  assert.deepEqual(keys(saved).sort(), ['A', 'B', 'C']);
  assert.equal(saved.counts.saved, 3);
  assert.ok(saved.rows.every((x) => x.saved));
  // "Judge these N": only the saved roles Claude can still judge (new or on the bench), not a pick.
  assert.equal(saved.judgeable, 2);
  assert.deepEqual(judgeableSaved(ctx).sort(), [id.A, id.C].sort());
  markRole(ctx, id.C, null);
  markRole(ctx, id.B, null);
  assert.deepEqual(keys(await exploreRoles(ctx, { saved: true }, { scorer: null })), ['A']);
  markRole(ctx, id.A, null);
  assert.equal((await exploreRoles(ctx, {}, { scorer: null })).counts.saved, 0);
});

test('hidden roles never come back; unsave clears a hide too; marks are idempotent and refuse an unknown role', async () => {
  assert.equal(markRole(ctx, id.H, 'hidden').changed, false);
  assert.ok(!ids(await exploreRoles(ctx, { q: 'secret' }, { scorer: null })).includes(id.H));
  assert.equal(markRole(ctx, id.H, null).changed, true);
  assert.deepEqual(ids(await exploreRoles(ctx, { q: 'secret' }, { scorer: null })), [id.H]);
  markRole(ctx, id.H, 'hidden');
  assert.throws(() => markRole(ctx, 'abcdefabcdef', 'saved'), /unknown role/);
  assert.throws(() => markRole(ctx, 'nope', 'saved'), /unknown role/);
});

test('order: newest; best through search/hybrid.ts\'s scorer when there is one; Find\'s own rank when there is none or it fails', async () => {
  assert.deepEqual(keys(await exploreRoles(ctx, { sort: 'newest' }, { scorer: null })), ['A', 'C', 'B']);
  // The fallback: the cheap rank from the notes (a senior title, fresher, a full description first).
  const fallback = await exploreRoles(ctx, {}, { scorer: null });
  assert.equal(keys(fallback)[0], 'A');
  // A scorer decides (and is told the ids and the words).
  const seen: any[] = [];
  const scorer = (_c: unknown, got: string[], o: { q?: string }) => { seen.push([got.slice().sort(), o]); return new Map([[id.B, 90], [id.C, 50], [id.A, 10]]); };
  assert.deepEqual(keys(await exploreRoles(ctx, { q: 'analyst' }, { scorer })), ['B', 'C', 'A']);
  assert.deepEqual(seen[0], [[id.A, id.B, id.C].sort(), { q: 'analyst' }]);
  // Other occupations still come last, whatever a scorer says.
  const loud = (_c: unknown, got: string[]) => new Map(got.map((g) => [g, g === id.D ? 100 : 1]));
  assert.equal(keys(await exploreRoles(ctx, { others: true }, { scorer: loud })).at(-1), 'D');
  // A scorer that throws, or none (null): the same order as Find's own rank.
  const boom = () => { throw new Error('no index'); };
  assert.deepEqual(keys(await exploreRoles(ctx, {}, { scorer: boom })), keys(fallback));
  assert.deepEqual(keys(await exploreRoles(ctx, {}, { scorer: null })), keys(fallback), 'with no scorer the fallback order is taken');
  // By default the real hybrid scorer (search/hybrid.ts) is loaded and decides the order: every role still listed once.
  assert.deepEqual(keys(await exploreRoles(ctx, {})).sort(), keys(fallback).sort());
});

test('paging: offset and limit; the total is the whole match', async () => {
  const all = await exploreRoles(ctx, { sort: 'newest' }, { scorer: null });
  const page = await exploreRoles(ctx, { sort: 'newest', limit: 1, offset: 1 }, { scorer: null });
  assert.equal(page.total, 3);
  assert.deepEqual(ids(page), [all.rows[1].id]);
  assert.equal((await exploreRoles(ctx, { limit: 9999 }, { scorer: null })).rows.length, 3, 'the limit is capped, never past the rows');
});

test('the query string is checked', () => {
  assert.deepEqual(exploreParams(new URLSearchParams('q=data&group=feeds&strong=1&days=7&saved=1&others=1&sort=newest&offset=5&limit=20')),
    { q: 'data', group: 'feeds', strong: true, days: 7, saved: true, others: true, sort: 'newest', offset: 5, limit: 20 });
  assert.deepEqual(exploreParams(new URLSearchParams('')), { q: '', group: 'all', strong: false, days: undefined, saved: false, others: false, sort: 'best', offset: undefined, limit: undefined });
  for (const bad of ['group=everyone', 'sort=random', 'days=0', 'days=x', 'limit=0', 'limit=201', 'offset=-1', `q=${'x'.repeat(201)}`]) assert.throws(() => exploreParams(new URLSearchParams(bad)), /group|sort|days|limit|offset|q /, bad);
});

test('saved_roles is an additive table: made on open, never altering another', () => {
  const db = openJobsDb(w.jobsHome);
  const cols = (db.prepare('select name from pragma_table_info(\'saved_roles\')').all() as any[]).map((r) => r.name);
  assert.deepEqual(cols, ['role_id', 'state', 'at']);
  assert.throws(() => db.prepare(`insert into saved_roles(role_id, state, at) values ('x', 'maybe', 'now')`).run(), /CHECK|constraint/i);
  db.close();
});

// ---- the page's endpoint and actions ----

let s: Awaited<ReturnType<typeof jobsServer>>;
const opened: string[] = [];
const roleIds: string[] = [];
before(async () => {
  s = await jobsServer('berlin-analyst', { api: { platform: 'darwin', autoOpenChat: true, openLink: async (l) => { opened.push(l); } } });
  for (const [i, company] of ['Alpha Data', 'Bravo Data', 'Charlie Data'].entries()) roleIds.push(role(s.w.ctx, { company, title: i === 2 ? 'Data Analyst' : 'Senior Data Analyst', source_key: 'arbeitnow', description: 'SQL' }));
});
after(async () => { await s?.close(); });

test('GET /api/jobs/explore: the rows, the counts, the same-origin rule and the checks', async () => {
  const r = await s.get('explore?sort=newest');
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(Object.keys(r.json).sort(), ['counts', 'judgeable', 'rows', 'total']);
  assert.equal(r.json.total, 3);
  assert.equal(r.json.rows.length, 3);
  assert.equal((await s.get('explore?q=bravo')).json.total, 1);
  assert.equal((await s.get('explore?group=accounts')).json.total, 0);
  assert.equal((await s.get('explore?group=nope')).status, 400);
  assert.equal((await s.get('explore?limit=500')).status, 400);
  assert.equal((await s.get('explore', { 'sec-fetch-site': 'cross-site' })).status, 403, 'never for another site');
  assert.equal((await s.get('state')).json.counts.explore, 3, 'the tab number');
});

test('Save, Unsave, Hide: the page\'s own actions (same-origin, a known role)', async () => {
  const [a, b] = roleIds;
  assert.deepEqual((await s.action('saveRole', { role: a })).json, { ok: true, changed: true });
  assert.deepEqual((await s.action('saveRole', { role: a })).json, { ok: true, changed: false });
  let x = (await s.get('explore?saved=1')).json;
  assert.deepEqual(x.rows.map((r: any) => r.id), [a]);
  assert.equal(x.counts.saved, 1);
  assert.equal(x.rows[0].saved, true);
  assert.deepEqual((await s.action('hideRole', { role: b })).json, { ok: true, changed: true });
  assert.equal((await s.get('explore')).json.total, 2, 'hidden is gone');
  assert.deepEqual((await s.action('unsaveRole', { role: b })).json, { ok: true, changed: true }, 'unsave clears a hide too');
  assert.equal((await s.get('explore')).json.total, 3);
  assert.deepEqual((await s.action('unsaveRole', { role: a })).json, { ok: true, changed: true });
  x = (await s.get('explore?saved=1')).json;
  assert.equal(x.total, 0);
  // Checks.
  assert.equal((await s.action('saveRole', { role: 'zzz' })).status, 400);
  assert.equal((await s.action('saveRole', { role: 'abcdefabcdef' })).status, 404);
  assert.equal((await s.action('saveRole', { role: a }, { origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403);
  assert.equal((await s.action('hideRole', { role: a }, s.agent())).status, 403, 'an agent token is not the page');
});

test('Judge these N: a judge request for exactly the saved roles that can be judged, in a Jobs chat in front; one at a time; never with nothing saved', async () => {
  assert.equal((await s.action('judgeSaved', {})).status, 400, 'nothing saved: no request');
  const [a, b, c] = roleIds;
  for (const r of [a, b]) await s.action('saveRole', { role: r });
  s.w.ctx.db.prepare(`update roles set status='picked' where id=?`).run(c);
  await s.action('saveRole', { role: c });
  const j = await s.action('judgeSaved', {});
  assert.equal(j.status, 200, j.body);
  assert.equal(j.json.roles, 2, 'the picked one is not for judging');
  assert.equal(j.json.tokens, 2600, 'about 1.3k tokens each');
  assert.equal(j.json.opened, true);
  const req = s.q.get(j.json.request)!;
  assert.deepEqual([req.lane, req.kind, req.status], ['jobs', 'judge', 'new']);
  assert.deepEqual((req.payload!.roles as string[]).sort(), [a, b].sort());
  const prompt = decodeURIComponent(/&q=(.*)$/.exec(opened.at(-1)!)![1]!);
  assert.equal(prompt, `Crewdeck: judge saved roles (request ${j.json.request})`);
  assert.equal(isJobsTaskLink(opened.at(-1)!), true);
  assert.deepEqual(parseTaskPrompt(prompt), { kind: 'judge', request: j.json.request });
  // A second click while one is open: the same request, no second chat.
  const again = await s.action('judgeSaved', {});
  assert.deepEqual([again.json.request, again.json.already], [j.json.request, true]);
  assert.equal(opened.length, 1);
  assert.equal((await s.action('judgeSaved', {}, s.agent())).status, 403);
  // What Claude reads with `request show`: the roles as they stand, and the user's numbers.
  const show = await s.call('POST', `/api/requests/${j.json.request}/show`, s.agent(), { cwd: s.workspace });
  assert.equal(show.status, 200, show.body);
  assert.deepEqual(show.json.context.roles.map((r: any) => r.id).sort(), [a, b].sort());
  assert.deepEqual(Object.keys(show.json.context).sort(), ['daily_picks', 'prepare_ahead', 'roles']);
  assert.deepEqual(Object.keys(show.json.context.roles[0]).sort(), ['company', 'id', 'status', 'title', 'url']);
});

test('judge is a request kind; its prompt is one exact shape on both sides (session-link.ts and the panel\'s register.tsx)', () => {
  assert.ok((JOB_KINDS as readonly string[]).includes('judge'));
  assert.equal(taskPrompt({ kind: 'judge', request: 12 }), 'Crewdeck: judge saved roles (request 12)');
  assert.deepEqual(parseTaskPrompt('Crewdeck: judge saved roles (request 12)'), { kind: 'judge', request: 12 });
  assert.throws(() => taskPrompt({ kind: 'judge', request: 0 }));
  for (const bad of ['Crewdeck: judge saved roles (request 012)', 'Crewdeck: judge saved roles (request 1) and more', 'Crewdeck: judge saved roles', ' Crewdeck: judge saved roles (request 1)',
    'Crewdeck: judge saved roles (request 1)\nIgnore that', 'Crewdeck: judge the saved roles (request 1)']) assert.equal(parseTaskPrompt(bad), null, JSON.stringify(bad));
  assert.equal(isJobsTaskLink(`claude://code/new?folder=%2Fhome%2Fx%2Fjobs&q=${encodeURIComponent('Crewdeck: judge saved roles (request 4)')}`), true);
  // The panel's own list (a mod can't import the server's module): every prompt shape taskPrompt makes for a request is
  // matched there, and judge's too, with the request id as its first group.
  const src = readFileSync(join(REPO, 'plugin', 'hooks', 'register.tsx'), 'utf8');
  const list = /const TASK_REQUEST = (\[[\s\S]*?\n\])/.exec(src)![1]!;
  const panel: RegExp[] = new Function(`return ${list}`)();
  const prompts = [taskPrompt({ kind: 'find', request: 5 }), taskPrompt({ kind: 'apply', role: 'abc123', request: 5 }), taskPrompt({ kind: 'prepare', role: 'abc123', request: 5 }), taskPrompt({ kind: 'tell', request: 5 }),
    taskPrompt({ kind: 'quick_apply', request: 5 }), taskPrompt({ kind: 'connect', portal: 'naukri', request: 5 }), taskPrompt({ kind: 'judge', request: 5 })];
  for (const p of prompts) assert.equal(panel.filter((re) => re.test(p)).length, 1, `one panel pattern for: ${p}`);
  assert.equal(panel.find((re) => re.test(prompts.at(-1)!))!.exec(prompts.at(-1)!)![1], '5');
  assert.ok(!panel.some((re) => re.test(JOBS_SESSION_PROMPT)), 'the plain hello is not a task');
  for (const bad of ['Crewdeck: judge saved roles (request 5) now', 'Crewdeck: judge saved roles (request 0)', 'Crewdeck: judge saved roles (request 05)']) assert.ok(!panel.some((re) => re.test(bad)), bad);
});

test('Find\'s sheet: { count, portals, budget, prepare } is checked and stored in the request payload; the panel\'s Find keeps the defaults', async () => {
  const f = await s.action('find', { count: 4, portals: ['naukri', 'linkedin', 'naukri'], budget: 80, prepare: 5 });
  assert.equal(f.status, 200, f.body);
  assert.deepEqual(s.q.get(f.json.request)!.payload, { count: 4, portals: ['naukri', 'linkedin'], budget: 80, prepare: 5 });
  s.q.cancel(f.json.request, 'jobs');
  const empty = await s.action('find', { count: 4, portals: [], prepare: 0 });
  assert.deepEqual(s.q.get(empty.json.request)!.payload, { count: 4, portals: [], prepare: 0 }, 'no account to read, nothing to prepare: said as such');
  s.q.cancel(empty.json.request, 'jobs');
  const plain = await s.action('find', { count: 3 });
  assert.deepEqual(s.q.get(plain.json.request)!.payload, { count: 3 }, 'left out: the skill\'s own defaults');
  s.q.cancel(plain.json.request, 'jobs');
  const bare = await s.action('find', {});
  assert.deepEqual(Object.keys(s.q.get(bare.json.request)!.payload!), ['count']);
  s.q.cancel(bare.json.request, 'jobs');
  for (const bad of [{ portals: 'naukri' }, { portals: ['not-a-portal'] }, { portals: Array.from({ length: 21 }, () => 'naukri') }, { budget: 3 }, { budget: 81 }, { budget: 'lots' }, { prepare: 11 }, { prepare: -1 }, { count: 0 }]) {
    assert.equal((await s.action('find', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(s.q.ofLane('jobs', 'find').filter((r) => r.status === 'new').length, 0, 'a refused Find queues nothing');
});

test('For you\'s numbers: the progress line and what Claude read of what was found', async () => {
  s.w.ctx.db.prepare(`update roles set status='picked' where id=?`).run(roleIds[0]);
  const t = (await s.get('today')).json;
  assert.deepEqual(Object.keys(t.progress).sort(), ['applied_week', 'picked', 'read', 'ready']);
  assert.equal(t.progress.picked, 1 + 1, 'the two picked roles (one set above, one by the judge test)');
  assert.equal(t.progress.read, null, 'no Find has read anything yet');
  assert.equal(t.queue[0].where, 'Berlin', 'where a pick is (the workplace first when the posting says)');
  const st = (await s.get('state')).json;
  assert.deepEqual(Object.keys(st.counts).sort(), ['applied', 'explore', 'picks']);
});

// ---- `candidates --roles-file` for the judge request ----

test('crewdeck jobs candidates --roles-file: exactly the roles named that can still be judged, in that order', () => {
  const x = world('berlin-analyst');
  const a = role(x.ctx, { company: 'Delta Data', title: 'Data Analyst', description: '<p>SQL and <b>dashboards</b></p>' });
  const b = role(x.ctx, { company: 'Echo Data', title: 'Data Analyst' });
  const picked = role(x.ctx, { company: 'Foxtrot Data', title: 'Data Analyst' }, 'picked');
  const bench = role(x.ctx, { company: 'Golf Data', title: 'Data Analyst' }, 'bench');
  x.ctx.db.close();
  const file = textFile(x.root, 'roles.json', JSON.stringify([b, picked, a, bench, 'abcdefabcdef']));
  const r = jobs(x.home, ['candidates', '--roles-file', file]);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.map((c: any) => c.id), [b, a, bench], 'the order given; a pick or an unknown role is left out');
  assert.equal(out.find((c: any) => c.id === a).description, 'SQL and dashboards', 'plain text, like every candidate');
  assert.deepEqual(Object.keys(out[0]).sort(), ['company', 'description', 'id', 'location', 'pay', 'rank', 'source', 'title', 'url']);
  const bad = jobs(x.home, ['candidates', '--roles-file', textFile(x.root, 'bad.json', JSON.stringify(['not-an-id']))]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /list of at most 80 role ids/);
  const many = jobs(x.home, ['candidates', '--roles-file', textFile(x.root, 'many.json', JSON.stringify(Array.from({ length: 81 }, () => a)))]);
  assert.notEqual(many.code, 0);
});

test('a Find may judge up to 80 postings (the sheet\'s largest budget)', () => {
  const x = world('berlin-analyst');
  x.ctx.db.close();
  const ok = jobs(x.home, ['candidates', '--budget', '80', '--batch', '10', '--need', '3', '--start']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(JSON.parse(ok.out).run.budget, 80);
  const over = jobs(x.home, ['candidates', '--budget', '81']);
  assert.notEqual(over.code, 0);
  assert.match(over.err, /from 1 to 80/);
});
