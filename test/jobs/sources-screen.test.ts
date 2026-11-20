// The Sources screen (design §24.3, D23, P9e): its view, checking a careers page from the page (resolve in the
// background), the screen rendered in Node, and Preferences keeping what the form doesn't show (P9d fix). The page's
// writes are the same `sources` action as before (bytes = CLI's: resolve.test.ts and sources-ui.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { Sources, filterCatalog, inRegion, lastLine, poss, splitLine } from '../../web/jobs/screens/sources.js';
import { dropLine } from '../../web/jobs/screens/today.js';
import { jobsServer, wait } from './api-helpers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { catalogEntry, loadCatalog } from '../../src/jobs/catalog.ts';
import { suggestSources } from '../../src/jobs/suggest.ts';
import { offerable } from '../../src/jobs/sources-view.ts';
import { resolveSource } from '../../src/jobs/resolve.ts';
import { sandboxSupport } from '../../src/jobs/sources.ts';
import { splitNote } from '../../src/jobs/notes.ts';
import { installedFixture } from './provider-helpers.ts';
import { serve, testHosts } from './net-helpers.ts';

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const until = async (fn: () => Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(25); } throw new Error('timed out'); };

function lastFetch(home: string, by_key: Record<string, unknown>) {
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'sources.json'), JSON.stringify({ started: '2026-11-19T08:00:00Z', finished: '2026-11-19T08:02:00Z', ok: true, new: 3, by_key }));
}

test('the Sources view: the list in order with each last fetch, an offerable catalog, suggestions, the coverage line, where it lives', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    lastFetch(s.w.jobsHome, { arbeitnow: { at: '2026-11-19T08:01:00Z', ok: true, jobs: 34, new: 3, kept: 12, refused: 0 }, 'example-gmbh': { at: '2026-11-19T08:01:00Z', ok: false, jobs: 0, new: 0, kept: 0, refused: 0, error: 'HTTP 404' } });
    const v = (await s.get('sources')).json;
    assert.deepEqual(v.rows.map((r: any) => r.key), ['arbeitnow', 'berlin-startup-jobs', 'example-gmbh'], 'v1 boards then watchlist, read in order');
    assert.deepEqual(v.rows.map((r: any) => r.kind_label), ['Job board', 'Feed', 'Employer']);
    assert.deepEqual([v.rows[0].last.jobs, v.rows[0].last.kept, v.rows[2].last.error], [34, 12, 'HTTP 404']);
    assert.equal(v.rows[0].last.history, undefined, 'the latest only');
    // The catalog: never a blocked, retired or unrunnable entry, never Crewdeck's own LinkedIn entry.
    const cat = loadCatalog();
    assert.equal(v.catalog.length, cat.sources.filter(offerable).length);
    for (const c of v.catalog) assert.ok(offerable(catalogEntry(c.id)!), c.id);
    for (const id of ['themuse', 'linkedin']) assert.ok(!v.catalog.some((c: any) => c.id === id), id);
    assert.ok(cat.sources.some((c) => !c.runnable) && cat.sources.some((c) => c.blocked), 'the catalog has entries to leave out');
    assert.equal(v.catalog.find((c: any) => c.id === 'arbeitnow').added, true);
    // Suggestions come from suggest, minus what's in the list; the coverage line is suggest's, word for word.
    const sg = suggestSources(notesOf(s.w.ctx), {}, { linkedinOn: false });
    assert.equal(v.coverage.line, sg.coverage.line);
    assert.deepEqual(v.suggested.map((x: any) => x.id), sg.sources.filter((x) => x.id !== 'arbeitnow').slice(0, 8).map((x) => x.id));
    assert.ok(v.suggested.every((x: any) => v.catalog.some((c: any) => c.id === x.id)));
    // Region options: the user's country first; containment ships with them.
    assert.equal(v.filters.regions[0].id, 'de');
    assert.equal(v.filters.regions[0].mine, true);
    assert.ok(v.filters.within.de.includes('europe'));
    assert.deepEqual([v.note.file, v.note.page], ['jobs/sources.md', 'jobs/sources']);
    assert.match(v.state_file, /state\/sources\.json$/);
    assert.deepEqual(v.linkedin, { in_list: false, risk: v.linkedin.risk, switches: { linkedin_search: false, linkedin_links: false, easy_apply: false } });
    assert.match(v.linkedin.risk, /terms/);
    assert.equal((await s.get('sources', { 'sec-fetch-site': 'cross-site' })).status, 403, 'never for another site');
  } finally { await s.close(); }
});

test('a new user without jobs/sources.md: no error, and the first source added from the screen creates the note', async () => {
  const s = await jobsServer();
  try {
    const file = join(s.w.vault, 'jobs', 'sources.md');
    rmSync(file);
    const v = (await s.get('sources')).json;
    assert.deepEqual([v.note.exists, v.note.errors, v.rows], [false, [], []]);
    assert.equal(v.coverage.unset, false, 'the example person has places');
    assert.match(text(render(html`<${Sources} data=${v} />`)), /No sources yet\. .*jobs\/sources\.md \(made when you add your first source\)/);
    assert.equal((await s.action('sources', { op: 'add', provider: 'remotive' })).status, 200);
    assert.match(readFileSync(file, 'utf8'), /sources:\n {2}- \{ key: remotive, name: Remotive, provider: remotive, added: [\d-]+ \}\n/);
  } finally { await s.close(); }
});

test('before setup (no places, no country) the screen says what the proposal needs instead of "boards fit anywhere"', async () => {
  const s = await jobsServer('template');
  try {
    const v = (await s.get('sources')).json;
    assert.deepEqual([v.coverage.unset, v.coverage.fits, v.suggested], [true, 0, []]);
    assert.match(text(render(html`<${Sources} data=${v} />`)), /Where to look starts with setup Crewdeck proposes job boards once it knows where you can work/);
    assert.ok(v.catalog.length > 50, 'the catalog is still there to add from');
  } finally { await s.close(); }
});

test('checking a page from the screen: page-only, in the background, its answer shown; refusals and limits said plainly', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = await jobsServer('berlin-analyst', { api: { resolve: async (key) => {
    calls.push(key);
    await gate;
    if (key === 'example-gmbh') return { key, name: 'Example GmbH', ok: true, provider: 'workday', provider_name: 'Workday', jobs: 20, changed: true, line: 'resolved' };
    throw new Error('job-board providers are not installed: crewdeck jobs providers install (pasted links work without them)');
  } } });
  try {
    assert.equal((await s.action('resolveSource', { key: 'example-gmbh' }, { 'content-type': 'application/json' })).status, 403, 'page-only');
    assert.equal((await s.action('resolveSource', { key: 'arbeitnow' })).status, 400, 'a board has no page to check');
    assert.equal((await s.action('resolveSource', { key: 'nope' })).status, 404);
    assert.equal((await s.action('resolveSource', { key: '../x' })).status, 400);
    const a = await s.action('resolveSource', { key: 'example-gmbh' });
    assert.equal(a.status, 200, a.body);
    assert.ok(a.json.started);
    assert.equal((await s.action('resolveSource', { key: 'example-gmbh' })).json.already, true, 'one check per source');
    const add = await s.action('sources', { op: 'add', name: 'Example Stores', url: 'https://careers.example.com/stores' });
    assert.equal(add.status, 200, add.body);
    const k = add.json.key;
    assert.equal((await s.action('resolveSource', { key: k })).status, 200);
    const third = await s.action('sources', { op: 'add', name: 'Example Clinic', careers_url: 'https://careers.example.com/clinic', employer: true });
    assert.equal((await s.action('resolveSource', { key: third.json.key })).status, 409, 'two at a time');
    let v = (await s.get('sources')).json;
    assert.ok(v.rows.find((r: any) => r.key === 'example-gmbh').resolving, 'shown as checking');
    release();
    await until(async () => { v = (await s.get('sources')).json; return !v.rows.some((r: any) => r.resolving); });
    assert.deepEqual(calls, ['example-gmbh', k]);
    const gm = v.rows.find((r: any) => r.key === 'example-gmbh');
    assert.deepEqual([gm.resolved.result.ok, gm.resolved.result.provider_name, gm.resolved.result.jobs], [true, 'Workday', 20]);
    assert.match(v.rows.find((r: any) => r.key === k).resolved.refused, /providers are not installed/);
  } finally { await s.close(); }
});

test('the default check runs `sources resolve` in a child, and on a home that can\'t run it says why without touching the note', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    const file = join(s.w.vault, 'jobs', 'sources.md');
    const before = readFileSync(file, 'utf8');
    assert.equal((await s.action('resolveSource', { key: 'example-gmbh' })).status, 200);
    let v: any;
    await until(async () => { v = (await s.get('sources')).json; return !!v.rows.find((r: any) => r.key === 'example-gmbh').resolved; }, 15_000);
    const why = sandboxSupport().ok ? /providers are not installed/ : /Node 25 or newer/;
    assert.match(v.rows.find((r: any) => r.key === 'example-gmbh').resolved.refused, why);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { await s.close(); }
});

const support = sandboxSupport();
test('add a company → checked in the sandbox → "Workday · 20 open roles", and an unreadable page offers Claude\'s help', { skip: support.ok ? false : support.why }, async () => {
  const WD = 'example-health.wd1.myworkdayjobs.example.test', OTHER = 'careers.example.test';
  const srv = await serve((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/wday/cxs/example-health/External/jobs' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { const { offset } = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ total: 34, jobPostings: Array.from({ length: Math.min(20, 34 - offset) }, (_, i) => ({ title: `Registered Nurse ${offset + i}`, externalPath: `/job/RN_${offset + i}`, locationsText: 'Columbus, OH' })) })); });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<p>Visit a store</p>');
  });
  const { dir, manifest } = installedFixture();
  let s!: Awaited<ReturnType<typeof jobsServer>>;
  s = await jobsServer('us-nurse', { api: { resolve: (key) => resolveSource(s.w.ctx, key, { dir, manifest, net: { testHosts: testHosts(WD, OTHER) } }) } });
  try {
    const add = await s.action('sources', { op: 'add', name: 'Example Health', careers_url: `${srv.base(WD)}/External`, employer: true });
    assert.equal((await s.action('resolveSource', { key: add.json.key })).status, 200);
    const bad = await s.action('sources', { op: 'add', name: 'Example Stores', careers_url: `${srv.base(OTHER)}/careers`, employer: true });
    assert.equal((await s.action('resolveSource', { key: bad.json.key })).status, 200);
    let v: any;
    await until(async () => { v = (await s.get('sources')).json; return v.rows.every((r: any) => !r.resolving) && v.rows.filter((r: any) => r.resolved).length === 2; }, 60_000);
    const ok = v.rows.find((r: any) => r.key === add.json.key);
    assert.deepEqual([ok.provider, ok.resolved.result.provider_name, ok.resolved.result.jobs], ['workday', 'Workday', 20]);
    const no = v.rows.find((r: any) => r.key === bad.json.key);
    assert.deepEqual([no.fetch, no.resolved.result.ok], ['none', false]);
    // What the screen says for each.
    const t = text(render(html`<${Sources} data=${v} />`));
    assert.match(t, /Example Health Employer .*Workday: 20 roles on a test · fetched next run.*Details Runs on Workday/);
    assert.match(t, /Not fetched: no provider reads this page: paste its postings, or ask Claude to find its jobs page Ask Claude to find the jobs page/);
    assert.equal((await s.action('findJobsPage', { key: bad.json.key })).status, 200);
  } finally { await s.close(); await srv.close(); }
});

test('the screen in Node: rows, last fetches, LinkedIn\'s row, the coverage line when nothing fits, the catalog filters', async () => {
  const s = await jobsServer('berlin-analyst');
  try {
    lastFetch(s.w.jobsHome, { arbeitnow: { at: new Date(Date.now() - 2 * 3600e3).toISOString(), ok: true, jobs: 34, new: 3, kept: 12, refused: 0 } });
    assert.equal((await s.action('sources', { op: 'add', linkedin: true, at: 1 })).status, 200);
    assert.equal((await s.action('sources', { op: 'disable', key: 'berlin-startup-jobs' })).status, 200);
    const v = (await s.get('sources')).json;
    const out = render(html`<${Sources} data=${v} />`);
    const t = text(out);
    assert.match(t, /Sources Where Jobs looks, top first\..*How it works The first source is fetched first/);
    assert.match(t, /What's covered/);
    assert.match(t, /Yours · 4 sources/);
    assert.match(t, /LinkedIn LinkedIn .*Off · only you can switch it on Switch on… LinkedIn details .*Pasted LinkedIn links: off · Easy Apply: off/);
    assert.match(t, /Arbeitnow Job board .*34 roles · 3 new · 12 match your rules · 2 h ago/);
    assert.match(t, /Berlin Startup Jobs .*Off · not fetched/);
    assert.match(out, /data-move="linkedin:up" disabled aria-label="Move LinkedIn up"/, 'the first row can\'t move up');
    assert.match(out, /data-move="example-gmbh:down" disabled aria-label="Move Example GmbH down"/);
    assert.match(out, /role="switch" aria-checked="false" aria-label="Fetch Berlin Startup Jobs"/);
    assert.doesNotMatch(out, /aria-label="Fetch LinkedIn"/, 'LinkedIn\'s switch is not a note flag');
    assert.match(t, /Where this lives Your list is a note you can edit\. Details Your list In your notes, in jobs\/sources\.md.*What each fetch found In Crewdeck's own state/);
    assert.match(out, /<ol class="slist" aria-label="Your sources, in priority order">/);
    assert.match(out, /role="status" aria-live="polite"/);
    // Nothing fits (D42): the line is the heading's subject, with what still works.
    const bare = { ...v, rows: [], linkedin: { ...v.linkedin, in_list: false }, coverage: { ...v.coverage, fits: 0, line: 'Crewdeck has no job board that fits Columbus for healthcare. Paste any posting you find.' } };
    const b = text(render(html`<${Sources} data=${bare} />`));
    assert.match(b, /No job board covers you yet Crewdeck has no job board that fits Columbus for healthcare\. What else works Paste any posting you find\. .*Add a company .*Place LinkedIn in your list .*Paste a job link/);
    // Filters: region (covers or inside), field, kind, and careers-page entries off by default.
    const all = filterCatalog(v.catalog, { region: '', family: '', kind: '', careers: true }, v.filters.within);
    assert.equal(all.length, v.catalog.length);
    const def = filterCatalog(v.catalog, { region: '', family: '', kind: '', careers: false }, v.filters.within);
    assert.ok(def.every((c: any) => c.needs !== 'careers_url') && def.length < all.length);
    const de = filterCatalog(v.catalog, { region: 'de', family: '', kind: '', careers: false }, v.filters.within);
    assert.ok(de.some((c: any) => c.id === 'arbeitsagentur') && de.some((c: any) => c.id === 'arbeitnow'));
    assert.ok(!de.some((c: any) => c.regions.length === 1 && c.regions[0] === 'world'), 'worldwide boards are their own option');
    assert.ok(filterCatalog(v.catalog, { region: 'europe', family: '', kind: '', careers: false }, v.filters.within).some((c: any) => c.id === 'arbeitsagentur'), 'a board inside Europe shows for Europe');
    assert.ok(filterCatalog(v.catalog, { region: '', family: 'education', kind: '', careers: false }, v.filters.within).every((c: any) => c.families.includes('education')));
    assert.ok(filterCatalog(v.catalog, { region: '', family: '', kind: 'national', careers: false }, v.filters.within).every((c: any) => c.kind === 'national'));
    assert.equal(inRegion({ regions: ['world'] }, 'world', {}), true);
    // Last-fetch lines.
    assert.equal(lastLine({ resolving: 'x' }).kind, 'busy');
    // P1b: LinkedIn paused after a stop says until when; a fetch says how many roles have a full description.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const paused = lastLine({ kind: 'linkedin', enabled: true, fetch: 'auto', last: { ok: false, at: new Date().toISOString(), why: 'x', paused_until: later } });
    assert.equal(paused.kind, 'warn');
    assert.match(paused.text, /^LinkedIn paused until \d{1,2}:\d\d/);
    assert.match(lastLine({ enabled: true, fetch: 'auto', last: { ok: true, at: new Date().toISOString(), jobs: 40, new: 3, kept: 12, descriptions: { full: 10, total: 12 } } }).text, /12 match your rules · 10 of 12 with full descriptions · just now$/);
    assert.match(lastLine({ enabled: true, fetch: 'auto', last: { ok: false, at: new Date().toISOString(), why: 'needs keywords: they come from your titles; add a title' } }).text, /^needs keywords: they come from your titles; add a title · just now$/);
    assert.match(lastLine({ enabled: true, fetch: 'auto', resolved: { refused: 'need Node 25 or newer' } }).text, /Couldn't check this page here: need Node 25 or newer/);
    // The coverage line: its first sentence shown, what else works behind More.
    assert.deepEqual(splitLine('2 job boards fit Berlin (no job board for nursing in Germany). Employers\' careers pages work; paste any posting you find.'),
      ['2 job boards fit Berlin (no job board for nursing in Germany).', 'Employers\' careers pages work; paste any posting you find.']);
    assert.deepEqual(splitLine('One sentence only.'), ['One sentence only.', '']);
    assert.equal(poss('Example Stores'), 'Example Stores\'');
    assert.equal(poss('Example Health'), 'Example Health\'s');
  } finally { await s.close(); }
});

test('Not interested says how many roles the title words drop before saving (§24.6); Today carries the words to add to', async () => {
  const s = await jobsServer();
  try {
    assert.deepEqual((await s.get('today')).json.exclude_title_words, ['intern', 'junior']);
    assert.equal(dropLine({ ok: true, pool: 40, days: 14, was: 12, pass: 9 }, ['Sales']), 'Skipping titles with "Sales" drops 3 of the 12 roles that pass your rules now (last 14 days).');
    assert.equal(dropLine({ ok: true, pool: 40, days: 14, was: 12, pass: 12 }, ['Sales', 'Lead']), 'Skipping titles with "Sales", "Lead" drops none of the 12 roles that pass your rules now.');
    assert.equal(dropLine({ ok: true, pool: 0, days: 14, was: 0, pass: 0 }, ['Sales']), '');
    assert.equal(dropLine({ ok: false, issues: [] }, ['Sales']), '');
  } finally { await s.close(); }
});

test('Preferences Save keeps what the form doesn\'t show on a target: hand-written keys and comments, by the target\'s place', async () => {
  const s = await jobsServer();
  try {
    const file = join(s.w.vault, 'jobs', 'search.md');
    const text0 = readFileSync(file, 'utf8').replace(/  # One kind of job[^\n]*\n  targets:\n    - \{[^\n]*\}\n/, `  titles: [product designer]
  # Two kinds of job; the second has a note of mine.
  targets:
    - name: Product designer   # what I'd call it
      titles: [product designer, UX designer]
      families: [design]
      why: my strongest work   # hand-written: Jobs doesn't read it
      seniority_note: { prefer: senior }
    - name: Design lead
      titles: [design lead]
      families: [design]
      remark: keep this too
`);
    writeFileSync(file, text0);
    const p = (await s.get('preferences')).json;
    const t = p.values['roles.targets'];
    assert.deepEqual(t.map((x: any) => x.at), [0, 1], 'each target carries its place in the note');
    // Edit the first target's titles, swap the order, add a new one: the hand-written keys follow their target.
    const changes = { 'roles.targets': [
      { ...t[1], titles: ['design lead', 'head of design'] },
      { ...t[0], titles: ['product designer', 'UX designer', 'interaction designer'], skills: ['Figma'] },
      { name: 'Researcher', titles: ['UX researcher'], families: ['design'], skills: [] },
    ] };
    const pv = await s.call('POST', '/api/jobs/preview', s.page(), { search: changes });
    assert.equal(pv.json.ok, true, pv.body);
    const r = await s.action('prefs', { changes });
    assert.equal(r.json.ok, true, r.body);
    const after = readFileSync(file, 'utf8');
    const front = parse(splitNote(after).front!);
    assert.deepEqual(front.roles.targets, [
      { name: 'Design lead', titles: ['design lead', 'head of design'], families: ['design'], remark: 'keep this too' },
      { name: 'Product designer', titles: ['product designer', 'UX designer', 'interaction designer'], families: ['design'], why: 'my strongest work', seniority_note: { prefer: 'senior' }, skills: ['Figma'] },
      { name: 'Researcher', titles: ['UX researcher'], families: ['design'] },
    ]);
    assert.match(after, /name: Product designer +# what I'd call it/, 'a comment on a target stays');
    assert.match(after, /why: my strongest work +# hand-written: Jobs doesn't read it/);
    assert.match(after, /- name: Researcher\n {6}titles: \[ UX researcher \]\n {6}families: \[ design \]\n/, 'a new target written like the others');
    assert.match(after, /# Two kinds of job; the second has a note of mine\./, 'the list\'s comment stays');
    assert.match(after, /\n- \d{4}-\d{2}-\d{2}: roles\.targets: Product designer \(product designer, UX designer\); Design lead \(design lead\) → Design lead \(design lead, head of design\); Product designer \(product designer, UX designer, interaction designer\); Researcher \(UX researcher\)\. "\(set on the Jobs page\)"\n/, 'one line under Changes');
    // A form without places (an old page) still saves, as whole targets.
    const plain = await s.action('prefs', { changes: { 'roles.targets': [{ name: 'Only', titles: ['product designer'] }] } });
    assert.equal(plain.json.ok, true, plain.body);
    assert.deepEqual(parse(splitNote(readFileSync(file, 'utf8')).front!).roles.targets, [{ name: 'Only', titles: ['product designer'] }]);
    assert.equal((await s.action('prefs', { changes: { 'roles.targets': [{ name: 'X', titles: ['a'], at: 'zero' }] } })).json.ok, true, 'a bad place is just a new target');
  } finally { await s.close(); }
});
