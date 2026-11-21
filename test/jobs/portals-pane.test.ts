// ADR-0008 pane mode: the in-page script (run here exactly as Claude runs it, with `new Function` over a fake page),
// the plan (the profile engine's limits), ingest (strict checks, the same stops and pauses as a scan, roles stored as
// portal:<id>), mark, the sources run leaving portals to Claude, and the CLI verbs. Fictional portal and people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, jobs, tempSetup, textFile, world } from './helpers.ts';
import { INDIA_PROFILE, fixturePortal } from './portal-helpers.ts';
import { PAGE_JOBS, minify, pageScript } from '../../src/jobs/portals/page-script.ts';
import { RX, canonUrl, pathValue as runtimePathValue } from '../../src/jobs/portals/page-runtime.js';
import { canonicalJobUrl, pathValue } from '../../src/jobs/portals/extract.ts';
import { ingestPage, markPortal, parsePageOutput, placeLike, planPortals } from '../../src/jobs/portals/pane.ts';
import { readPortalsState, updatePortal } from '../../src/jobs/portals/state.ts';
import { togglePortal } from '../../src/jobs/portals/view.ts';
import { runSources } from '../../src/jobs/sources.ts';
import { normaliseJobs } from '../../src/config.ts';
import type { Portal } from '../../src/jobs/portals/catalog.ts';
import { isJobsTaskLink, parseTaskPrompt, taskPrompt } from '../../src/session-link.ts';

// ---- the in-page script, over a fake page ----

type FakeEl = Record<string, unknown>;
const el = (o: FakeEl & { visible?: boolean } = {}): FakeEl => ({ getClientRects: () => (o.visible === false ? [] : [{}]), offsetWidth: o.visible === false ? 0 : 120, offsetHeight: o.visible === false ? 0 : 40, ...o });

/** A page global for the script: location, document, performance and fetch, all fictional. */
function fakePage(o: {
  url?: string; resources?: string[]; responses?: Record<string, unknown>; ld?: unknown[]; title?: string; text?: string;
  password?: boolean; iframes?: { src: string; visible?: boolean }[]; challengeEl?: boolean; nextData?: unknown; globals?: Record<string, unknown>;
} = {}) {
  const fetches: { url: string; init: any }[] = [];
  const G: Record<string, unknown> = {
    location: new URL(o.url ?? 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7'),
    performance: { getEntriesByType: (t: string) => (t === 'resource' ? (o.resources ?? []).map((name) => ({ name })) : []) },
    fetch: async (url: string, init: any) => {
      fetches.push({ url, init });
      const body = o.responses?.[url];
      return body === undefined ? { ok: false, text: async () => '' } : { ok: true, text: async () => JSON.stringify(body) };
    },
    document: {
      readyState: 'complete', title: o.title ?? 'Data Analyst jobs', body: { innerText: o.text ?? 'Data Analyst jobs in Bengaluru' },
      querySelectorAll(sel: string) {
        if (sel.startsWith('script[type="application/ld+json"]')) return (o.ld ?? []).map((j) => ({ textContent: typeof j === 'string' ? j : JSON.stringify(j) }));
        if (sel === 'input[type=password]') return o.password ? [el()] : [];
        if (sel.startsWith('iframe')) return (o.iframes ?? []).map((f) => el({ src: f.src, visible: f.visible }));
        return [];
      },
      querySelector: () => (o.challengeEl ? el() : null),
      getElementById: (id: string) => (id === '__NEXT_DATA__' && o.nextData ? { textContent: JSON.stringify(o.nextData) } : null),
    },
    ...(o.globals ?? {}),
  };
  return { G, fetches };
}

/** Run the script text as javascript_tool would: one expression, its Promise awaited. */
async function runScript(script: string, G: Record<string, unknown>): Promise<any> {
  // eslint-disable-next-line no-new-func
  return await new Function('globalThis', `return ${script}`)(G);
}

const API = 'https://www.portal.test/api/search?q=data';
const apiResults = (n: number, o: { off?: boolean } = {}) => ({
  results: [
    ...Array.from({ length: n }, (_, i) => ({ link: `/job/Data-Analyst-${i}-Ab${String(i).padStart(6, '0')}`, name: `  Data   Analyst ${i} `, org: { name: `Fictional Co ${i}` }, where: 'Bengaluru, India' })),
    ...(o.off ? [{ link: 'https://elsewhere.example.com/job/Fake-Job-AAAAAAAA', name: 'Off-site', org: { name: 'X' }, where: 'Pune' }, { link: '/about/team', name: 'Not a job', org: { name: 'Y' }, where: '' }] : []),
  ],
});

test('the script is one self-contained expression: no imports, no comments, the portal\'s config embedded, deterministic and small', () => {
  const p = fixturePortal();
  const s = pageScript(p);
  assert.match(s, /^\(\(\)=>\{/);
  assert.match(s, /\}\)\(\)$/);
  assert.doesNotMatch(s, /\bimport\b|\brequire\(|^\s*\/\//m);
  assert.equal(pageScript(p), s, 'the same entry gives the same text');
  assert.ok(s.includes('"www.portal.test"') && s.includes('/api/search'));
  assert.ok(s.length < 12_000, `${s.length} characters`);
  // It parses as an expression (javascript_tool evaluates it as one).
  assert.doesNotThrow(() => new Function(`return ${s}`));
});

test('the script reads the JSON the page loaded (same origin, the person\'s cookies), then JSON-LD; absolute canonical URLs, trimmed strings', async () => {
  const p = fixturePortal();
  const ld = [{ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [
    { '@type': 'ListItem', item: { '@type': 'JobPosting', title: 'BI Analyst', url: 'https://www.portal.test/job/bi-analyst-saffron-retail-e5f6g7h8?utm_source=list', hiringOrganization: { name: 'Saffron Retail', address: { addressCountry: 'IN' } }, jobLocationType: 'TELECOMMUTE', datePosted: '2026-11-18' } },
    // The same posting as the API's first: it fills only what is missing.
    { '@type': 'ListItem', item: { '@type': 'JobPosting', title: 'Data Analyst 0', url: 'https://www.portal.test/job/Data-Analyst-0-Ab000000', datePosted: '2026-11-17' } },
  ] }, '{ not json'];
  const { G, fetches } = fakePage({ resources: [API, 'https://tracker.elsewhere.test/api/search?x=1', 'https://www.portal.test/static/app.js'], responses: { [API]: apiResults(2, { off: true }) }, ld });
  const out = await runScript(pageScript(p, { settleMs: 0 }), G);
  assert.deepEqual(fetches.map((f) => f.url), [API], 'only the adapter\'s same-origin responses are fetched again');
  assert.equal(fetches[0]!.init.credentials, 'include');
  assert.deepEqual(out.signals, { sign_in_wall: false, challenge: false, empty: false });
  assert.equal(out.url, 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7');
  assert.deepEqual(out.jobs, [
    { url: 'https://www.portal.test/job/Data-Analyst-0-Ab000000', title: 'Data Analyst 0', company: 'Fictional Co 0', location: 'Bengaluru, India', posted_at: '2026-11-17' },
    { url: 'https://www.portal.test/job/Data-Analyst-1-Ab000001', title: 'Data Analyst 1', company: 'Fictional Co 1', location: 'Bengaluru, India' },
    { url: 'https://www.portal.test/job/bi-analyst-saffron-retail-e5f6g7h8', title: 'BI Analyst', company: 'Saffron Retail', location: 'Remote', posted_at: '2026-11-18', workplace: 'remote', company_country: 'IN' },
  ]);
  // The answer is what ingest accepts.
  assert.equal(parsePageOutput(out, p).out.jobs.length, 3);
});

test('the script reads window state the adapter names (__NEXT_DATA__ from its script tag when not on window)', async () => {
  const p = fixturePortal({ json: [{ url: '', state: '__NEXT_DATA__.props.pageProps', list: 'jobs', fields: { url: 'href', title: 'role', company: 'employer' } }] });
  const nextData = { props: { pageProps: { jobs: [{ href: '/job/Data-Engineer-Opal-Zz123456', role: 'Data Engineer', employer: 'Opal Mobility' }] } } };
  const viaTag = await runScript(pageScript(p, { settleMs: 0 }), fakePage({ nextData }).G);
  assert.deepEqual(viaTag.jobs.map((j: any) => [j.title, j.company]), [['Data Engineer', 'Opal Mobility']]);
  const viaWindow = await runScript(pageScript(p, { settleMs: 0 }), fakePage({ globals: { __NEXT_DATA__: nextData } }).G);
  assert.equal(viaWindow.jobs.length, 1);
});

test('signals: a sign-in path or a visible password form with no jobs; strong and weak challenge markers; nothing found', async () => {
  const p = fixturePortal();
  const run = (o: Parameters<typeof fakePage>[0]) => runScript(pageScript(p, { settleMs: 0 }), fakePage(o).G);
  assert.deepEqual((await run({ url: 'https://www.portal.test/login?next=/jobs' })).signals, { sign_in_wall: true, challenge: false, empty: true });
  assert.equal((await run({ password: true })).signals.sign_in_wall, true, 'a login form and no jobs');
  assert.equal((await run({ password: true, resources: [API], responses: { [API]: apiResults(1) } })).signals.sign_in_wall, false, 'a login box beside real results is not a wall');
  assert.equal((await run({ title: 'Just a moment...' })).signals.challenge, true);
  assert.equal((await run({ text: 'Please verify you are human to continue' })).signals.challenge, true);
  assert.equal((await run({ url: 'https://www.portal.test/checkpoint/challenge' })).signals.challenge, true);
  assert.equal((await run({ challengeEl: true })).signals.challenge, true);
  assert.equal((await run({ iframes: [{ src: 'https://www.google.com/recaptcha/api2/bframe?k=x' }] })).signals.challenge, true, 'a visible CAPTCHA and no jobs');
  assert.equal((await run({ iframes: [{ src: 'https://www.google.com/recaptcha/api2/anchor?size=invisible' }] })).signals.challenge, false, 'an invisible reCAPTCHA badge is not a check');
  assert.equal((await run({ iframes: [{ src: 'https://www.google.com/recaptcha/api2/bframe' }], resources: [API], responses: { [API]: apiResults(1) } })).signals.challenge, false);
  assert.deepEqual((await run({})).signals, { sign_in_wall: false, challenge: false, empty: true });
});

test('the answer stays small: at most 60 jobs and about 8 KB, however many the page has', async () => {
  const p = fixturePortal();
  const out = await runScript(pageScript(p, { settleMs: 0 }), fakePage({ resources: [API], responses: { [API]: apiResults(200) } }).G);
  assert.ok(out.jobs.length <= PAGE_JOBS && out.jobs.length >= 30, `${out.jobs.length} jobs`);
  assert.ok(JSON.stringify(out).length <= 8_500, `${JSON.stringify(out).length} characters`);
});

test('one set of rules on both sides: the profile engine\'s pathValue, canonical URLs and card words are the page script\'s', () => {
  assert.equal(pathValue, runtimePathValue);
  const p = fixturePortal();
  for (const u of ['/job/Data-Analyst-0-Ab000000?x=1#y', 'https://www.portal.test/job/a-b-ABCDEFGH', 'https://elsewhere.example.com/job/a-b-ABCDEFGH', 'javascript:alert(1)', '/about']) {
    assert.equal(canonicalJobUrl(u, 'https://www.portal.test/jobs/x', p), canonUrl(u, 'https://www.portal.test/jobs/x', p.job_url, p.hosts), u);
  }
  assert.equal(pathValue({ a: [{ type: 'location', label: 'Pune' }] }, 'a[type=location].label'), 'Pune');
  assert.ok(RX.button.test('Apply now') && RX.time.test('2 days ago') && RX.noise.test('3-6 yrs'));
});

// ---- plan ----

const connect = (home: string, id = 'fixture') => updatePortal(home, id, (p) => ({ ...p, connected: true, connected_at: '2026-11-01T00:00:00Z' }));

test('plan: the switched-on, connected portals\' pages within every limit, with the jittered wait before each; reading it counts nothing', () => {
  const w = world();
  const p = fixturePortal();
  const o = { portals: [p], profile: INDIA_PROFILE, rnd: () => 0.5 };
  assert.deepEqual(planPortals(w.ctx, o).pages, [], 'nothing switched on');
  connect(w.jobsHome);
  togglePortal(w.ctx, p, true);
  const plan = planPortals(w.ctx, o);
  assert.equal(plan.mode, 'pane');
  // 3 searches × 2 pages, the first at once and every later one after delay_ms (10 s here, jittered ±40%).
  assert.equal(plan.pages.length, 6);
  assert.deepEqual(plan.pages[0], { portal: 'fixture', url: 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7', query: 'Data Analyst', delay_ms: 0 });
  assert.equal(plan.pages[1]!.url, 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7&page=2');
  assert.deepEqual(plan.pages.slice(1).map((x) => x.delay_ms), [10000, 10000, 10000, 10000, 10000]);
  const spread = planPortals(w.ctx, { ...o, rnd: () => 0 }).pages[1]!.delay_ms;
  assert.equal(spread, 6000);
  assert.deepEqual(readPortalsState(w.jobsHome).portals.fixture!.day, undefined, 'the plan counts no pages');
  // The day's cap, a recent scan, a pause, a sign-in and the company-country verdict all hold.
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, day: { date: '2026-11-19', pages: 28 } }));
  assert.equal(planPortals(w.ctx, o).pages.length, 2);
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, day: undefined, last_scan: '2026-11-19T08:00:00Z' }));
  assert.match(planPortals(w.ctx, o).skipped[0]!.why, /at most one scan every 6 h/);
  assert.equal(planPortals(w.ctx, { ...o, only: 'fixture' }).pages.length, 1, '--portal: one page, a test, min_hours aside');
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, last_scan: undefined, pause: { until: '2026-11-19T12:00:00Z', level: 1, reason: 'a check' } }));
  assert.match(planPortals(w.ctx, o).skipped[0]!.why, /paused until/);
  assert.equal(planPortals(w.ctx, { ...o, only: 'fixture' }).pages.length, 0, 'a test waits for a pause too');
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, pause: undefined, needs_sign_in: true }));
  assert.match(planPortals(w.ctx, o).skipped[0]!.why, /needs you to sign in again: Jobs page → Sources → Portals → Sign in/);
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, needs_sign_in: undefined }));
  assert.match(planPortals(w.ctx, { ...o, profile: { ...INDIA_PROFILE, countries: ['de'], places: ['Berlin'] } }).skipped[0]!.why, /^skipped: it serves in/);
  assert.deepEqual(planPortals(w.ctx, { ...o, mode: 'profile' }).pages, [], 'profile mode: Crewdeck scans itself');
});

// ---- ingest ----

const page = (jobs: unknown[], signals: Partial<Record<'sign_in_wall' | 'challenge' | 'empty', boolean>> = {}, url = 'https://www.portal.test/jobs/data-analyst-jobs?days=7') =>
  ({ url, signals: { sign_in_wall: false, challenge: false, empty: jobs.length === 0, ...signals }, jobs });
const J = (i: number, o: Record<string, string> = {}) => ({ url: `https://www.portal.test/job/Data-Analyst-${i}-Ab${String(i).padStart(6, '0')}`, title: `Data Analyst ${i}`, company: `Fictional Co ${i}`, location: 'Bengaluru', ...o });

test('ingest refuses what isn\'t a script answer: unknown keys, wrong types, too many, too long, a job on another host', () => {
  const p = fixturePortal();
  const bad: [unknown, RegExp][] = [
    [[], /not an object/], [{ ...page([]), extra: 1 }, /unknown key "extra"/], [{ ...page([]), signals: { sign_in_wall: 'no', challenge: false, empty: true } }, /signals\.sign_in_wall/],
    [{ ...page([]), signals: { sign_in_wall: false, challenge: false } }, /signals\.empty/], [page(Array.from({ length: 61 }, (_, i) => J(i))), /at most 60/],
    [page([{ ...J(1), title: 7 }]), /jobs\[0\]\.title: a string/], [page([{ ...J(1), note: 'x' }]), /unknown field "note"/], [page([{ ...J(1), title: 'x'.repeat(201) }]), /at most 200/],
    [page([{ ...J(1), url: 'https://elsewhere.example.com/job/Data-Analyst-1-Ab000001' }]), /elsewhere\.example\.com is not one of Fixture Portal's hosts/],
    [page([{ ...J(1), url: '/job/relative' }]), /an absolute web address/], [page([{ ...J(1), workplace: 'moon' }]), /remote, hybrid or onsite/],
  ];
  for (const [raw, re] of bad) assert.throws(() => parsePageOutput(raw, p), re, JSON.stringify(raw).slice(0, 80));
  // A job address that isn't a posting (another path) is dropped, not refused.
  assert.equal(parsePageOutput(page([J(1), { ...J(2), url: 'https://www.portal.test/about' }]), p).dropped, 1);
});

test('ingest stores roles as portal:<id> like a scan, adds up a scan\'s pages, counts the day; only a connected portal', () => {
  const w = world();
  const p = fixturePortal();
  assert.match(ingestPage(w.ctx, p, page([J(1)])).stopped!, /not connected/);
  connect(w.jobsHome);
  const r1 = ingestPage(w.ctx, p, page([J(1), J(2, { location: 'Python, SQL, Tableau', posted_at: '2 days ago' })]));
  assert.deepEqual([r1.found, r1.stored, r1.new, r1.stopped], [2, 2, 2, undefined]);
  const rows = w.ctx.db.prepare("select r.title, c.name as company, r.location, r.source from roles r join companies c on c.id = r.company_id where r.source_key='portal:fixture' order by r.title").all() as any[];
  assert.deepEqual(rows.map((x) => [x.title, x.company, x.location, x.source]), [['Data Analyst 1', 'Fictional Co 1', 'Bengaluru', 'portal'], ['Data Analyst 2', 'Fictional Co 2', '', 'portal']], 'card text that is no place is dropped');
  w.at('2026-11-19T10:05:00Z');
  const r2 = ingestPage(w.ctx, p, page([J(2), J(3)]));
  assert.deepEqual([r2.stored, r2.new], [2, 1]);
  const st = readPortalsState(w.jobsHome).portals.fixture!;
  assert.deepEqual([st.last_found, st.last_new, st.day], [4, 3, { date: '2026-11-19', pages: 2 }], 'one scan\'s pages add up');
  // The next scan starts its counts again; a test stores nothing and leaves last_scan alone.
  w.at('2026-11-19T18:00:00Z');
  ingestPage(w.ctx, p, page([J(4)]));
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.last_found, 1);
  const t = ingestPage(w.ctx, p, page([J(9)]), { test: true });
  assert.deepEqual([t.found, t.stored, t.sample!.length], [1, 0, 1]);
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.last_scan, '2026-11-19T18:00:00.000Z');
  // The daily cap.
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, day: { date: '2026-11-19', pages: 30 } }));
  assert.equal(ingestPage(w.ctx, p, page([J(5)])).stop_kind, 'limit');
});

test('ingest applies a stop exactly like a scan: sign-in wall (needs_sign_in), challenge, another host, a quiet empty page; pauses 6, 24, 72 h', () => {
  const w = world();
  const p = fixturePortal();
  connect(w.jobsHome);
  const wall = ingestPage(w.ctx, p, page([], { sign_in_wall: true }));
  assert.equal(wall.stop_kind, 'sign_in');
  assert.equal(wall.needs_sign_in, true);
  assert.equal(wall.paused_until, '2026-11-19T16:00:00.000Z');
  assert.match(ingestPage(w.ctx, p, page([J(1)])).stopped!, /paused until/, 'nothing more while paused');
  // Signing in again (mark connected) clears the pause and the flag; the next stop pauses longer.
  markPortal(w.ctx, p, 'connected');
  w.at('2026-11-19T11:00:00Z');
  const ch = ingestPage(w.ctx, p, page([J(1)], { challenge: true }));
  assert.equal(ch.stop_kind, 'challenge');
  assert.equal(ch.stored, 0, 'nothing stored from a stopped page');
  assert.equal(ch.paused_until, '2026-11-19T17:00:00.000Z', 'mark connected cleared the level too');
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, pause: { ...s.pause!, until: '2026-11-19T11:30:00Z' } }));
  w.at('2026-11-19T12:00:00Z');
  const off = ingestPage(w.ctx, p, page([]), { pageUrl: 'https://accounts.elsewhere.test/signin' });
  assert.equal(off.stop_kind, 'challenge');
  assert.match(off.stopped!, /sent the page to accounts\.elsewhere\.test/);
  assert.equal(off.paused_until, '2026-11-20T12:00:00.000Z', 'the second stop in a row: 24 h');
  assert.equal(ingestPage(w.ctx, p, page([]), { pageUrl: 'https://www.portal.test/login' }).stop_kind, 'paused');
  // A quiet block: nothing where the last scan found many.
  const w2 = world();
  connect(w2.jobsHome);
  updatePortal(w2.jobsHome, 'fixture', (s) => ({ ...s, last_scan: '2026-11-19T01:00:00Z', last_found: 25 }));
  assert.equal(ingestPage(w2.ctx, p, page([])).stop_kind, 'empty');
  assert.throws(() => ingestPage(w2.ctx, p, page([]), { pageUrl: 'not a url' }), /--page-url/);
});

test('mark: connected clears a pause and the sign-in flag; signed-out asks for a sign-in only on a connected portal', () => {
  const w = world();
  const p = fixturePortal();
  markPortal(w.ctx, p, 'signed-out');
  assert.equal(readPortalsState(w.jobsHome).portals.fixture?.needs_sign_in, undefined);
  updatePortal(w.jobsHome, 'fixture', () => ({ connected: true, needs_sign_in: true, pause: { until: '2026-11-20T00:00:00Z', level: 2, reason: 'x' }, last_error: 'x', day: { date: '2026-11-19', pages: 3 } }));
  const s = markPortal(w.ctx, p, 'connected');
  assert.deepEqual(Object.keys(s).sort(), ['connected', 'connected_at', 'day']);
  markPortal(w.ctx, p, 'signed-out');
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.needs_sign_in, true);
});

test('placeLike keeps places and workplace words, drops other card text', () => {
  for (const x of ['Bengaluru', 'Pune, India', 'Remote', 'Hybrid - Berlin', 'Berlin (Hybrid)']) assert.equal(placeLike(x), true, x);
  for (const x of ['', 'Python, SQL, Tableau', '3-6 yrs', '₹ 12-18 LPA']) assert.equal(placeLike(x), false, x);
});

// ---- config and the sources run ----

test('jobs.portals_mode: pane by default, profile allowed, anything else refused', () => {
  assert.equal(normaliseJobs({}).portals_mode, 'pane');
  assert.equal(normaliseJobs({ portals_mode: 'profile' }).portals_mode, 'profile');
  assert.throws(() => normaliseJobs({ portals_mode: 'browser' }), /jobs\.portals_mode: use pane .* or profile/);
});

test('a sources run in pane mode leaves portals to Claude: no browser launched, the reason in the run state', async () => {
  const w = world();
  connect(w.jobsHome);
  const p: Portal = fixturePortal();
  togglePortal(w.ctx, p, true);
  let launched = 0;
  const launch = async () => { launched++; throw new Error('no browser in this test'); };
  const r = await runSources(w.ctx, { details: 0, plan: { entries: [], ids: [], skipped: [] }, portalsMode: 'pane', portals: { launch, portals: [p], profile: INDIA_PROFILE } });
  assert.equal(launched, 0);
  assert.deepEqual(r.portals, { ran: false, why: 'pane mode: Claude scans portals in its browser pane during Find (crewdeck jobs portals plan)' });
});

// ---- the CLI ----

test('portals plan, script, ingest and mark from the command line (a temp home, pane mode by default)', () => {
  const s = tempSetup('example');
  const help = jobs(s.home, ['portals', '--help']).out;
  for (const v of ['plan [--json] [--portal <id>]', 'script <id>', 'ingest <id> --file <f.json> [--page-url <u>] [--test]', 'mark <id> connected|signed-out']) assert.ok(help.includes(v), v);
  const script = jobs(s.home, ['portals', 'script', 'naukri']);
  assert.equal(script.code, 0, script.err);
  assert.match(script.out, /^\(\(\)=>\{/);
  assert.ok(script.out.includes('jobapi'), 'the Naukri adapter is embedded');
  const plan = JSON.parse(jobs(s.home, ['portals', 'plan', '--json']).out);
  assert.equal(plan.mode, 'pane');
  assert.deepEqual(plan.pages, []);
  // Pane mode: no profile window; mark is the connect.
  assert.match(jobs(s.home, ['portals', 'connect', 'naukri']).err, /pane mode .* Jobs page → Sources → Portals → Connect/);
  assert.match(jobs(s.home, ['portals', 'mark', 'linkedin', 'connected']).out, /LinkedIn is connected/);
  assert.equal(jobs(s.home, ['portals', 'mark', 'linkedin', 'maybe']).code, 1);
  // Naukri serves India only, where this person doesn't look: the plan says so.
  jobs(s.home, ['portals', 'mark', 'naukri', 'connected']);
  assert.match(JSON.parse(jobs(s.home, ['portals', 'plan', '--json', '--portal', 'naukri']).out).skipped[0].why, /where you don't look for work/);
  const one = JSON.parse(jobs(s.home, ['portals', 'plan', '--json', '--portal', 'linkedin']).out);
  assert.equal(one.pages.length, 1, JSON.stringify(one));
  assert.match(one.pages[0].url, /^https:\/\/www\.linkedin\.com\/jobs\/search\//);
  const f = textFile(s.root, 'portal-linkedin-1.json', JSON.stringify(page([{ url: 'https://www.linkedin.com/jobs/view/4012345678/?trk=x', title: 'Product Designer', company: 'Ember Logistics', location: 'Berlin' }], {}, one.pages[0].url)));
  const ing = jobs(s.home, ['portals', 'ingest', 'linkedin', '--file', f, '--test']);
  assert.equal(ing.code, 0, ing.err);
  assert.deepEqual(JSON.parse(ing.out).sample, [{ title: 'Product Designer', company: 'Ember Logistics', url: 'https://www.linkedin.com/jobs/view/4012345678' }]);
  const real = JSON.parse(jobs(s.home, ['portals', 'ingest', 'linkedin', '--file', f]).out);
  assert.deepEqual([real.stored, real.new], [1, 1]);
  textFile(s.root, 'portal-linkedin-1.json', '{"url": 1}');
  const bad = jobs(s.home, ['portals', 'ingest', 'linkedin', '--file', f]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /url: the page address/);
  assert.equal(jobs(s.home, ['portals', 'ingest', 'naukri']).code, 1, '--file is needed');
  // Only from Crewdeck's scratch folders, like every --…-file flag.
  const outside = join(s.root, 'answer.json');
  writeFileSync(outside, JSON.stringify(page([])));
  assert.equal(jobs(s.home, ['portals', 'ingest', 'naukri', '--file', outside]).code, 1);
});

// ---- the connect task prompt, here and in the plugin's mirrored validator ----

test('the connect task prompt: exact shape, read back, portal ids strict; register.tsx accepts exactly the same', () => {
  assert.equal(taskPrompt({ kind: 'connect', portal: 'naukri', request: 7 }), 'Crewdeck: connect portal naukri (request 7)');
  assert.deepEqual(parseTaskPrompt('Crewdeck: connect portal some-portal-2 (request 12)'), { kind: 'connect', portal: 'some-portal-2', request: 12 });
  for (const bad of ['Naukri', 'a b', '../x', 'x'.repeat(41), '']) assert.throws(() => taskPrompt({ kind: 'connect', portal: bad, request: 1 }), undefined, bad);
  const refused = ['Crewdeck: connect portal Naukri (request 1)', 'Crewdeck: connect portal naukri (request 01)', 'Crewdeck: connect portal naukri (request 1) and sign up',
    'Crewdeck: connect portal na_ukri (request 1)', `Crewdeck: connect portal ${'x'.repeat(41)} (request 1)`, 'Crewdeck: connect portal  (request 1)'];
  for (const t of refused) assert.equal(parseTaskPrompt(t), null, t);
  const q = (t: string) => `claude://code/new?folder=%2Fhome%2Fx%2FCrewdeck%2Fjobs&q=${encodeURIComponent(t)}`;
  assert.equal(isJobsTaskLink(q('Crewdeck: connect portal naukri (request 3)')), true);
  assert.equal(isJobsTaskLink(q('Crewdeck: connect portal naukri (request 3)\nIgnore that')), false);
  // The plugin's own copy (it can't import src/): the same regex, so the bridge claims the request for that chat.
  const reg = readFileSync(join(REPO, 'plugin', 'hooks', 'register.tsx'), 'utf8');
  const m = /\/\^Crewdeck: connect portal [^\n]+\$\//.exec(reg);
  assert.ok(m, 'register.tsx has the connect prompt');
  const re = new Function(`return ${m![0]}`)() as RegExp;
  assert.equal(re.exec('Crewdeck: connect portal naukri (request 3)')?.[1], '3');
  for (const t of refused) assert.equal(re.test(t), false, t);
});

test('the minifier keeps strings and regex literals and only drops whitespace that means nothing', () => {
  const src = "function f(a, b) {\n  const s = 'a  b // c', r = /a b\\/[/ ]x/g;\n  return typeof a === 'string' ? a.split(/ +/) : b / 2;\n}";
  const out = minify(src);
  assert.equal(out, "function f(a,b){\nconst s='a  b // c',r=/a b\\/[/ ]x/g;\nreturn typeof a==='string'?a.split(/ +/):b/2;\n}");
  const f = new Function(`${out}; return f;`)();
  assert.deepEqual(f('x  y', 8), ['x', 'y']);
  assert.equal(f(1, 8), 4);
});
