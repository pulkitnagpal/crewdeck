// jobs/sources.md v2 (design D19–D22, §24.2): one ordered list with keys, read from v1 unchanged and merged on the first
// write; validated; changed through `crewdeck jobs sources …` (values from files); fetched and ranked in that order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobs, role, textFile, world } from './helpers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { sourceItems, validate } from '../../src/jobs/schema.ts';
import { type Plan, cleanJob, onlyNewSources, readSourcesState, runSources, sandboxSupport, sourcePlan, writeSourcesState } from '../../src/jobs/sources.ts';
import { changeSources, keysInUse, listSources, newKey } from '../../src/jobs/sources-note.ts';
import { loadManifest } from '../../src/jobs/providers.ts';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from '../../src/jobs/migrations.ts';
import { priorityBonus, rankRoles } from '../../src/jobs/pipeline/rank.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { installedFixture } from './provider-helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { CARD, DETAIL } from './linkedin-fixtures.ts';

const errs = (d: unknown) => validate('sources', d).filter((i) => i.level === 'error');
const warns = (d: unknown) => validate('sources', d).filter((i) => i.level === 'warning');
const note = (w: { vault: string }) => join(w.vault, 'jobs', 'sources.md');

test('v1 boards then watchlist are read as one ordered list with stable keys, without touching the note', () => {
  const w = world('berlin-analyst');
  const before = readFileSync(note(w), 'utf8');
  const items = notesOf(w.ctx).sources.data.items;
  assert.deepEqual(items.map((x) => [x.key, x.employer]), [['arbeitnow', false], ['berlin-startup-jobs', false], ['example-gmbh', true]]);
  assert.equal(notesOf(w.ctx).sources.data.version, 1);
  assert.equal(readFileSync(note(w), 'utf8'), before, 'reading never writes');
  // Same input, same keys; names that slug alike get -2.
  assert.deepEqual(sourceItems({ boards: [{ name: 'Ex Co', provider: 'remotive' }, { name: 'Ex-Co', provider: 'himalayas' }] }).items.map((x) => x.key), ['ex-co', 'ex-co-2']);
});

test('the first write moves v1 into sources: (same order, same keys, options and quotes kept) and logs it', () => {
  const w = world('berlin-analyst');
  const r = changeSources(w.ctx, { op: 'add', source: { provider: 'remotive' } });
  assert.equal(r.migrated, true);
  const text = readFileSync(note(w), 'utf8');
  assert.doesNotMatch(text, /^(boards|watchlist):/m);
  assert.match(text, /# Where to look, in priority order/);
  assert.match(text, /- \{ key: example-gmbh, name: Example GmbH, careers_url: "https:\/\/jobs\.example\.com\/example-gmbh", employer: true \}/);
  assert.match(text, /- \d{4}-\d{2}-\d{2}: moved boards and watchlist into one ordered sources list\n- \d{4}-\d{2}-\d{2}: added Remotive at position 4\n/);
  const after = notesOf(w.ctx).sources.data;
  assert.equal(after.version, 2);
  assert.deepEqual(after.items.map((x) => x.key), ['arbeitnow', 'berlin-startup-jobs', 'example-gmbh', 'remotive']);
  assert.deepEqual(errs(notesOf(w.ctx).sources.raw), []);
});

test('validation: keys, one target, the LinkedIn mirror, unknown, excluded, retired and blocked providers', () => {
  assert.deepEqual(errs({ sources: [{ key: 'a', name: 'A', provider: 'remotive' }, { key: 'linkedin', name: 'LinkedIn', linkedin: 'search' }, { key: 'b', name: 'B', url: 'https://jobs.example.org', fetch: 'none', why: 'no provider reads it' }] }), []);
  const e = errs({ sources: [
    { key: 'a', name: 'A', provider: 'remotive' }, { key: 'a', name: 'A2', provider: 'himalayas' }, { key: 'c', name: 'C' },
    { key: 'd', name: 'D', url: 'https://x.example.org' }, { key: 'e', name: 'E', url: 'https://x.example.org', provider: 'remotive', fetch: 'none' },
    { key: 'f', name: 'F', provider: 'vdab' }, { key: 'g', name: 'G', provider: 'remotiv' }, { key: 'BAD KEY', name: 'H', provider: 'remotive' },
    { key: 'li', name: 'LinkedIn', linkedin: 'search' }, { key: 'li2', name: 'LinkedIn again', linkedin: 'search' }, { key: 'li3', name: 'L', linkedin: 'search', provider: 'remotive' },
  ] });
  const at = (p: string, re: RegExp) => assert.ok(e.some((i) => i.path === p && re.test(i.message + (i.fix ?? ''))), `${p} ${re}`);
  at('sources[1].key', /used twice/);
  at('sources[2]', /needs a provider, a careers_url or a url/);
  at('sources[3].fetch', /a url entry is not fetched/);
  at('sources[4].url', /without provider and careers_url/);
  at('sources[5].provider', /can't run in Crewdeck: .*js-yaml/);
  at('sources[6].provider', /did you mean "remotive"/);
  at('sources[7].key', /wrong form/);
  at('sources[9].linkedin', /listed twice/);
  at('sources[10]', /takes no provider/);
  const w = warns({ sources: [{ name: 'Nokey', provider: 'remotive' }, { key: 'li', name: 'LinkedIn', linkedin: 'search', enabled: true }, { key: 't', name: 'T', provider: 'torre' }, { key: 'm', name: 'M', provider: 'themuse' }, { key: 'n', name: 'N', careers_url: 'https://jobs.example.com/n', fetch: 'none' }], boards: [{ name: 'Old', provider: 'remotive' }] });
  const has = (p: string, re: RegExp) => assert.ok(w.some((i) => i.path === p && re.test(i.message + (i.fix ?? ''))), `${p} ${re}`);
  has('sources[0].key', /add key: nokey/);
  has('sources[1].enabled', /LinkedIn is switched in Jobs → Settings; this note only orders it/);
  has('sources[2].provider', /no longer works upstream/);
  has('sources[3].provider', /currently refuses automated reads/);
  has('sources[4].why', /says why/);
  has('boards', /ignored while sources: is there/);
});

test('CLI sources: add (provider, careers page, web address, LinkedIn), move, disable, enable, remove, list; values only from files', () => {
  const w = world('berlin-analyst');
  w.ctx.db.close();
  const ok = (args: string[]) => { const r = jobs(w.home, ['sources', ...args]); assert.equal(r.code, 0, r.err + r.out); return r.out; };
  const bad = (args: string[]) => { const r = jobs(w.home, ['sources', ...args]); assert.notEqual(r.code, 0, r.out); return r.err; };
  assert.match(ok(['add', '--provider', 'arbeitsagentur', '--at', '1']), /added Bundesagentur für Arbeit \(Jobsuche\) at position 1[\s\S]*key: arbeitsagentur/);
  const name = textFile(w.root, 'name.txt', 'Example Health\n'), url = textFile(w.root, 'url.txt', 'https://example.wd1.myworkdayjobs.com/External\n');
  assert.match(ok(['add', '--careers-url-file', url, '--name-file', name, '--employer']), /key: example-health/);
  const page = textFile(w.root, 'page.txt', 'https://jobs.example.org/board'), pname = textFile(w.root, 'pname.txt', 'Example local board');
  assert.match(ok(['add', '--url-file', page, '--name-file', pname]), /key: example-local-board/);
  assert.match(ok(['add', '--linkedin', '--at', '1']), /added LinkedIn \(its switch stays in Jobs → Settings\) at position 1/);
  assert.match(ok(['move', 'arbeitsagentur', 'down']), /moved Bundesagentur für Arbeit \(Jobsuche\) to position 3/);
  assert.match(ok(['move', 'example-health', '--to', '2']), /to position 2/);
  assert.match(ok(['move', 'example-health', 'first']), /to position 1/);
  assert.match(ok(['disable', 'arbeitnow']), /switched off Arbeitnow/);
  assert.match(ok(['disable', 'arbeitnow']), /unchanged/);
  assert.match(ok(['enable', 'arbeitnow']), /switched on Arbeitnow/);
  assert.match(ok(['remove', 'berlin-startup-jobs']), /removed Berlin Startup Jobs/);
  // Refusals: the LinkedIn switch, unknown and unrunnable providers, a careers-page provider without its page, bad keys,
  // a second LinkedIn row, duplicates, a non-web address, a name on the command line.
  assert.match(bad(['disable', 'linkedin']), /switched on or off in Jobs → Settings/);
  assert.match(bad(['add', '--provider', 'vdab']), /can't run in Crewdeck/);
  assert.match(bad(['add', '--provider', 'nosuch']), /is not a known provider/);
  assert.match(bad(['add', '--provider', 'workday']), /add it with --careers-url-file/);
  assert.match(bad(['add', '--linkedin']), /already in your list/);
  assert.match(bad(['add', '--provider', 'arbeitsagentur']), /already in your list/);
  assert.match(bad(['remove', 'Not A Key']), /a source key is lowercase/);
  assert.match(bad(['remove', 'gone']), /no source with key gone/);
  assert.match(bad(['add', '--url-file', textFile(w.root, 'js.txt', 'javascript:alert(1)'), '--name-file', pname]), /not a web address/);
  assert.match(bad(['add', '--careers-url-file', url, '--name-file', name]), /already in your list as example-health/);
  assert.match(bad(['add', '--name', 'X', '--provider']), /--provider is a provider id|usage/);
  const list = JSON.parse(ok(['list', '--json']));
  assert.deepEqual(list.map((r: any) => [r.position, r.key, r.kind]), [[1, 'example-health', 'employer'], [2, 'linkedin', 'linkedin'], [3, 'arbeitnow', 'board'], [4, 'arbeitsagentur', 'national'], [5, 'example-gmbh', 'employer'], [6, 'example-local-board', 'custom']]);
  assert.deepEqual(list[1].switches, { linkedin_search: false, linkedin_links: false, easy_apply: false });
  assert.equal(list[5].fetch, 'none');
  assert.match(ok(['list']), / 6\. Example local board \[example-local-board\] custom · not fetched/);
  assert.equal(jobs(w.home, ['check']).code, 0);
  const text = readFileSync(note(w), 'utf8');
  assert.match(text, /- \{ key: example-local-board, name: Example local board, url: https:\/\/jobs\.example\.org\/board, fetch: none, why: "not checked yet: crewdeck jobs sources resolve example-local-board", added: \d{4}-\d{2}-\d{2} \}/);
  assert.match(jobs(w.home, ['sources', '--help']).out, /usage: crewdeck jobs sources/);
});

test('CLI sources suggest prints the proposal and the coverage line; --json marks what is already listed', () => {
  const w = world('berlin-analyst');
  w.ctx.db.close();
  const r = JSON.parse(jobs(w.home, ['sources', 'suggest', '--json']).out);
  assert.ok(r.sources.some((s: any) => s.id === 'arbeitnow' && s.added === true));
  assert.ok(r.sources.some((s: any) => s.id === 'arbeitsagentur' && s.added === false));
  assert.match(r.coverage.line, /fit Germany/);
  assert.match(jobs(w.home, ['sources', 'suggest']).out, /✓ arbeitnow[\s\S]*\n\n.*fit Germany/);
});

test('keys are never reused: one the state file or the tracker has seen is taken by a new key', () => {
  const w = world('berlin-analyst');
  writeSourcesState(w.ctx.home, { started: '2026-11-19T00:00:00Z', ok: true, new: 0, by_key: { remotive: { at: '2026-11-19T00:00:00Z', ok: true, jobs: 1, new: 1, kept: 1, refused: 0 } } });
  role(w.ctx, { company: 'Example Co', source: 'board', source_key: 'himalayas' });
  assert.ok(keysInUse(w.ctx).has('himalayas') && keysInUse(w.ctx).has('remotive') && keysInUse(w.ctx).has('arbeitnow'));
  assert.equal(changeSources(w.ctx, { op: 'add', source: { provider: 'remotive' } }).key, 'remotive-2');
  assert.equal(changeSources(w.ctx, { op: 'add', source: { provider: 'himalayas' } }).key, 'himalayas-2');
  assert.equal(newKey('Ünïcode Co.', new Set()), 'unicode-co');
});

test('the plan: the user\'s order, LinkedIn\'s position, fills from the notes, and why a source is skipped', () => {
  const w = world('berlin-analyst');
  writeFileSync(note(w), `---\ntags: jobs\nsources:\n  - { key: example-gmbh, name: Example GmbH, careers_url: "https://jobs.example.com/example-gmbh", employer: true }\n  - { key: linkedin, name: LinkedIn, linkedin: search }\n  - { key: arbeitsagentur, name: BA, provider: arbeitsagentur }\n  - { key: off, name: Off, provider: remotive, enabled: false }\n  - { key: board, name: Local board, url: "https://jobs.example.org", fetch: none, why: "no provider reads it" }\n  - { key: occ, name: OCC, provider: occ }\n---\n`);
  const p = sourcePlan(notesOf(w.ctx), loadManifest());
  assert.deepEqual(p.entries.map((e) => [e.key, e.kind]), [['example-gmbh', 'ats'], ['arbeitsagentur', 'board'], ['occ', 'board']]);
  assert.equal(p.linkedinAt, 1, 'LinkedIn after the first provider entry');
  assert.deepEqual(p.entries[1].entry.arbeitsagentur, { keywords: ['data analyst', 'analytics engineer', 'Datenanalyst', 'BI analyst'] });
  assert.deepEqual(p.entries[1].filled, ['arbeitsagentur.keywords']);
  assert.ok(!('key' in p.entries[0].entry) && !('employer' in p.entries[0].entry), 'Crewdeck\'s own keys stay out of provider code');
  assert.deepEqual(p.skipped, [{ key: 'board', name: 'Local board', why: 'not fetched: no provider reads it' }]);
  // Without titles, a keyword-driven board can't run: the reason the Sources screen will show.
  const s = notesOf(w.ctx);
  s.search.data.roles.titles = [];
  assert.deepEqual(sourcePlan(s, loadManifest()).skipped.map((x) => [x.key, x.why]).slice(0, 2), [['arbeitsagentur', 'needs keywords (arbeitsagentur.keywords): they come from your job titles; add a title'], ['board', 'not fetched: no provider reads it']]);
  // --only-new-sources: what has state is left out, LinkedIn's position follows.
  const n = onlyNewSources(p, { started: '', ok: true, new: 0, by_key: { 'example-gmbh': { at: '', ok: true, jobs: 0, new: 0, kept: 0, refused: 0 } } });
  assert.deepEqual([n.entries.map((e) => e.key), n.linkedinAt, n.ids], [['arbeitsagentur', 'occ'], 0, ['arbeitsagentur', 'occ']]);
});

test('priority (D21): moving a source changes the candidate order; it never revives a role the rules dropped', () => {
  const w = world('berlin-analyst');
  const a = role(w.ctx, { company: 'Alpha Example', title: 'Data Analyst', source: 'board', source_key: 'arbeitnow', posted_at: '2026-11-18T10:00:00Z' });
  const g = role(w.ctx, { company: 'Gamma Example', title: 'Data Analyst', source: 'ats', source_key: 'example-gmbh', posted_at: '2026-11-18T10:00:00Z' });
  const d = role(w.ctx, { company: 'Delta Example', title: 'Sales Manager', source: 'ats', source_key: 'example-gmbh', posted_at: '2026-11-18T10:00:00Z' });
  runPrefilter(w.ctx);
  assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(d) as any).status, 'prefiltered_out');
  assert.deepEqual(rankRoles(w.ctx).map((r) => r.id), [a, g]);
  changeSources(w.ctx, { op: 'move', key: 'example-gmbh', to: 0 });
  assert.deepEqual(rankRoles(w.ctx).map((r) => r.id), [g, a]);
  assert.ok(!rankRoles(w.ctx).some((r) => r.id === d), 'still dropped');
  assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(d) as any).status, 'prefiltered_out');
  const bonus = priorityBonus(notesOf(w.ctx));
  assert.deepEqual([...bonus], [['example-gmbh', 12], ['arbeitnow', 8], ['berlin-startup-jobs', 4], ['linkedin', 0]]);
});

test('DB migration v2: a v1 tracker gains source_key, language, visa_text and employment_type, keeping its rows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATIONS[0].sql);
  db.exec(`insert into companies(id, name, key) values (1, 'Example Co', 'example co');
    insert into roles(id, company_id, title, url, source, first_seen, updated_at) values ('aaaaaaaaaaaa', 1, 'Analyst', 'https://jobs.example.com/1', 'board', '2026-11-01', '2026-11-01')`);
  assert.equal(migrate(db), SCHEMA_VERSION);
  const r = db.prepare('select title, source, source_key, language, visa_text, employment_type from roles').get() as any;
  assert.deepEqual({ ...r }, { title: 'Analyst', source: 'board', source_key: null, language: null, visa_text: null, employment_type: null });
  assert.equal(migrate(db), SCHEMA_VERSION, 'safe to run again');
});

test('a provider\'s language, visa line and employment type are kept, bounded, and stored with the source key', () => {
  const at = new Date('2026-11-19T10:00:00Z');
  const c = cleanJob({ url: 'https://jobs.example.com/1', title: 'Analyst', company: 'Example Co', language: 'de', visa_text: 'Visa sponsorship available', employment_type: 'FULL_TIME' }, { features: { linkedin_links: false }, at });
  assert.ok(c.ok);
  assert.deepEqual([c.role.language, c.role.visa_text, c.role.employment_type], ['de', 'Visa sponsorship available', 'FULL_TIME']);
  const d = cleanJob({ url: 'https://jobs.example.com/2', title: 'Analyst', language: 'not a language code at all', employment_type: 'x'.repeat(100) }, { features: { linkedin_links: false }, at });
  assert.ok(d.ok);
  assert.equal(d.role.language, null);
  assert.equal(d.role.employment_type!.length, 60);
});

const support = sandboxSupport();
const sandbox = { skip: support.ok ? false : support.why };

test('a fetch in priority order: providers before LinkedIn\'s row, LinkedIn, the rest; per-source state with kept counts; --only-new-sources', sandbox, async () => {
  const order: string[] = [];
  const srv = await serve((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    order.push(u.pathname.includes('jobs-guest') ? 'linkedin' : u.pathname);
    if (u.pathname.endsWith('/seeMoreJobPostings/search')) { res.writeHead(200, { 'content-type': 'text/html' }).end(u.searchParams.get('start') === '0' ? CARD('4000000071', 'Senior Data Analyst', 'Example Co') : ''); return; }
    if (u.pathname.endsWith('/jobPosting/4000000071')) { res.writeHead(200, { 'content-type': 'text/html' }).end(DETAIL({ company: 'Example Co' })); return; }
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/first') res.end(JSON.stringify({ jobs: [{ title: 'Data Analyst', url: 'https://jobs.example.com/f/1', company: 'First Example', location: 'Berlin, Germany' }, { title: 'Sales Manager', url: 'https://jobs.example.com/f/2', company: 'First Example', location: 'Berlin, Germany' }] }));
    else if (u.pathname === '/second') res.end(JSON.stringify({ jobs: [{ title: 'BI Analyst', url: 'https://jobs.example.com/s/1', company: 'Second Example', location: 'Berlin, Germany' }] }));
    else res.writeHead(404).end();
  });
  try {
    const w = world('berlin-analyst', { features: { linkedin_search: true }, now: new Date().toISOString() });
    const { dir, manifest } = installedFixture();
    const B = 'board.example.test', L = 'li.example.test';
    const plan: Plan = {
      entries: [
        { i: 0, key: 'first', name: 'First', kind: 'board', entry: { provider: 'fixture-board', api: `${srv.base(B)}/first` } },
        { i: 1, key: 'second', name: 'Second', kind: 'board', entry: { provider: 'fixture-board', api: `${srv.base(B)}/second` } },
      ],
      ids: ['fixture-board'], skipped: [{ key: 'local', name: 'Local', why: 'not fetched: no provider reads it' }], linkedinAt: 1, linkedinKey: 'linkedin',
    };
    const linkedin = { base: `${srv.base(L)}/jobs-guest/jobs/api`, net: { testHosts: testHosts(L) }, sleep: async () => {} };
    const s = await runSources(w.ctx, { dir, manifest, plan, linkedin, net: { testHosts: testHosts(B) }, details: 0 });
    assert.deepEqual(order.filter((x, i) => x !== order[i - 1]).slice(0, 3), ['/first', 'linkedin', '/second'], 'first, LinkedIn, then the rest');
    const st = readSourcesState(w.ctx.home)!;
    assert.deepEqual([st.by_key!.first.jobs, st.by_key!.first.new, st.by_key!.first.kept], [2, 2, 1], 'Sales Manager dropped by the rules');
    assert.deepEqual([st.by_key!.second.jobs, st.by_key!.second.kept], [1, 1]);
    assert.equal(st.by_key!.linkedin.new, 1);
    assert.equal(st.by_key!.local.why, 'not fetched: no provider reads it');
    assert.equal(s.new, 4);
    const keys = w.ctx.db.prepare('select source_key k, count(*) n from roles group by source_key order by k').all().map((r: any) => [r.k, r.n]);
    assert.deepEqual(keys, [['first', 2], ['linkedin', 1], ['second', 1]]);
    // Setup's first fetch: only sources with no state yet.
    order.length = 0;
    const plan2: Plan = { ...plan, entries: [...plan.entries, { i: 2, key: 'third', name: 'Third', kind: 'board', entry: { provider: 'fixture-board', api: `${srv.base(B)}/second` } }] };
    const again = await runSources(w.ctx, { dir, manifest, plan: plan2, linkedin, net: { testHosts: testHosts(B) }, details: 0, onlyNew: true });
    assert.deepEqual(order, ['/second'], 'only the new source ran; LinkedIn was fetched before');
    assert.equal(again.linkedin?.why, 'fetched before (only new sources this time)');
    const st2 = readSourcesState(w.ctx.home)!;
    assert.equal(st2.by_key!.third.jobs, 1);
    assert.equal(st2.by_key!.linkedin.new, 1, 'LinkedIn\'s last state kept');
    assert.equal(st2.by_key!.first.history?.length ?? 0, 0);
    await runSources(w.ctx, { dir, manifest, plan, linkedin, net: { testHosts: testHosts(B) }, details: 0 });
    assert.equal(readSourcesState(w.ctx.home)!.by_key!.first.history!.length, 1, 'the earlier run is kept in history');
    assert.deepEqual(listSources(w.ctx).map((r) => r.key), ['arbeitnow', 'berlin-startup-jobs', 'example-gmbh']);
  } finally { await srv.close(); }
});
