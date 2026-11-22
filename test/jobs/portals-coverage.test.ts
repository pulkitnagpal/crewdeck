// ADR-0008 "Search coverage": every title of the person in the portal's searches. Several titles in one search where the
// portal takes a list (or / comma), packed into as few searches as fit; variants and, when not all fit, kinds of job
// rotate from one scan to the next; --portals limits a plan to the person's choice. Fictional portals and people only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, jobs, tempSetup } from './helpers.ts';
import { fixturePortal } from './portal-helpers.ts';
import { loadPortals } from '../../src/jobs/portals/catalog.ts';
import { joinTitles, mainTitles, packTitles, portalQueries, searchTitles, searchUrl, titleVariants, type PortalProfile } from '../../src/jobs/portals/queries.ts';
import { ingestPage, planPortals } from '../../src/jobs/portals/pane.ts';
import { readPortalsState, updatePortal } from '../../src/jobs/portals/state.ts';
import { togglePortal } from '../../src/jobs/portals/view.ts';

const ORIGINAL = ['Software Engineer', 'Platform Engineer', 'AI Engineer', 'Engineering Manager', 'Founding Engineer', 'Data Engineer'];
/** A fictional person with `n` kinds of job (1 to 6), working remotely from India (no on-site place: one search per group). */
const person = (n: number, skills = ['LLM', 'Platform', 'Python']): PortalProfile => ({
  targets: ORIGINAL.slice(0, n).map((t, i) => ({ name: `T${i}`, titles: i === 0 ? [t, 'Backend Engineer'] : [t] })),
  titles: [], countries: ['in'], workModes: ['remote'], places: [], skills,
});
const withSearch = (patch: Record<string, unknown>) => { const p = fixturePortal(); return { ...p, search: { ...p.search, ...patch } }; };
const OR = withSearch({ multi: 'or', multi_max_chars: 200, url: 'https://www.portal.test/jobs/search?keywords={q}&days={recency}&wfh={remote}&page={page}', url_place: undefined });
const COMMA = withSearch({ multi: 'comma', multi_max_chars: 150, url: 'https://www.portal.test/jobs/{q_slug}-jobs?k={q}&days={recency}&wfh={remote}' });
const NONE = fixturePortal();
const kw = (url: string, name = 'keywords') => decodeURIComponent(new URL(url).searchParams.get(name) ?? '');

test('joining: or quotes each phrase, comma lists them, one title stays as it is; quotes in a title cannot break out', () => {
  assert.equal(joinTitles(OR, ['Software Engineer', 'AI Engineer']), '"Software Engineer" OR "AI Engineer"');
  assert.equal(joinTitles(OR, ['Software Engineer']), 'Software Engineer');
  assert.equal(joinTitles(COMMA, ['Software Engineer', 'AI Engineer', 'Staff Platform Engineer']), 'Software Engineer, AI Engineer, Staff Platform Engineer');
  const evil = { ...person(1), targets: [{ name: 'x', titles: ['Dev "OR" & Ops #1', 'C++ Dev'] }] };
  const qs = portalQueries(evil, OR);
  assert.ok(qs.length);
  for (const q of qs) {
    assert.ok(!q.titles.some((t) => t.includes('"')), 'quotes are taken out of titles');
    const u = new URL(q.url);
    assert.equal(u.searchParams.get('keywords')!.split('"').length % 2, 1, 'quotes stay balanced');
    assert.match(q.url.split('keywords=')[1].split('&')[0], /^[A-Za-z0-9%._~-]+$/, 'every special character is URL-encoded');
  }
});

test('URLs: or on LinkedIn, comma on Naukri (path slug from the first title), none = one title per search, all URL-encoded', () => {
  const cat = loadPortals();
  const li = portalQueries(person(3), cat.byId.get('linkedin')!);
  assert.ok(li.length <= 3 && li[0].titles.slice(0, 3).join() === 'Software Engineer,Platform Engineer,AI Engineer', 'three kinds of job share the first LinkedIn search');
  assert.ok(li[0].url.startsWith('https://www.linkedin.com/jobs/search/?keywords=%22Software%20Engineer%22%20OR%20%22Platform%20Engineer%22%20OR%20%22AI%20Engineer%22'), li[0].url);
  assert.equal(kw(li[0].url), li[0].keywords);
  assert.ok(li[0].url.includes('&location=India&f_TPR=r604800&f_WT=2'));
  const nk = portalQueries({ ...person(3), places: ['Bengaluru'], workModes: ['onsite'] }, cat.byId.get('naukri')!);
  assert.ok(nk.length >= 1);
  assert.ok(nk[0].url.startsWith('https://www.naukri.com/software-engineer-jobs-in-bangalore?k=Software%20Engineer%2C%20Platform%20Engineer%2C%20AI%20Engineer'), nk[0].url);
  assert.deepEqual(nk[0].titles.slice(0, 3), ['Software Engineer', 'Platform Engineer', 'AI Engineer']);
  const none = portalQueries(person(3), NONE);
  assert.ok(none.length >= 1 && none.every((q) => q.titles.length === 1 && q.keywords === q.titles[0]), 'a portal without multi searches one title at a time');
  assert.equal(none[0].url, 'https://www.portal.test/jobs/software-engineer-jobs?days=7&wfh=yes');
  // Titles with punctuation are encoded in the query value and slugged in the path.
  const odd = { ...person(1), targets: [{ name: 'x', titles: ['R&D, Lead / Staff'] }] };
  assert.equal(portalQueries(odd, COMMA)[0].url, 'https://www.portal.test/jobs/r-d-lead-staff-jobs?k=R%26D%2C%20Lead%20%2F%20Staff&days=7&wfh=yes');
});

test('length caps: no keywords string is longer than multi_max_chars, whatever the titles; a lone long title is cut at a word', () => {
  const long = ['Principal Distributed Systems Reliability Engineering Lead', 'Senior Staff Machine Learning Platform Infrastructure Engineer', 'Director of Engineering Operations'];
  for (const cap of [40, 80, 150, 200]) {
    for (const portal of [withSearch({ multi: 'or', multi_max_chars: cap }), withSearch({ multi: 'comma', multi_max_chars: cap })]) {
      const groups = packTitles(portal, [...long, ...ORIGINAL], 10);
      for (const g of groups) assert.ok(joinTitles(portal, g).length <= cap, `${cap}: ${joinTitles(portal, g)}`);
    }
  }
  const [g] = packTitles(withSearch({ multi: 'comma', multi_max_chars: 40 }), [long[0]], 3);
  assert.deepEqual(g, ['Principal Distributed Systems']);
  // And the real catalog's caps hold on a big profile.
  const cat = loadPortals();
  assert.equal(cat.byId.get('linkedin')!.search.multi_max_chars, 200);
  assert.equal(cat.byId.get('naukri')!.search.multi_max_chars, 150);
  for (const id of ['linkedin', 'naukri']) for (const q of portalQueries(person(6), cat.byId.get(id)!, { max: 10 })) assert.ok(q.keywords.length <= cat.byId.get(id)!.search.multi_max_chars!, q.keywords);
});

test('packing 1 to 6 targets: every kind of job is in a search of the run when it fits, in as few searches as fit', () => {
  for (let n = 1; n <= 6; n++) {
    const p = person(n);
    const mains = mainTitles(p);
    assert.equal(mains.length, n);
    for (const portal of [OR, COMMA]) {
      const qs = portalQueries(p, portal);
      const covered = qs.flatMap((q) => q.titles);
      for (const m of mains) assert.ok(covered.some((t) => t.toLowerCase() === m.toLowerCase()), `${n} targets: ${m} is searched`);
      assert.ok(qs.length <= portal.limits.searches_per_run);
      // Fewest searches: only a full group opens another one.
      const groups = packTitles(portal, searchTitles(p), 3);
      for (let i = 0; i + 1 < groups.length; i++) assert.ok(joinTitles(portal, [...groups[i], groups[i + 1][0]]).length > (portal.search.multi_max_chars ?? 150));
    }
    // One title per search: the main titles come first, and a search budget of 3 is never exceeded.
    const none = portalQueries(p, NONE);
    assert.equal(none.length, 3);
    assert.deepEqual(none.map((q) => q.titles[0]), searchTitles(p).slice(0, 3));
  }
  // One target alone: its title and variants share one search.
  assert.equal(portalQueries(person(1), OR).length, 1);
  assert.deepEqual(portalQueries(person(1), OR)[0].titles.slice(0, 3), ['Software Engineer', 'Backend Engineer', 'Senior Software Engineer']);
});

test('variants: the person\'s own titles first, then Senior / Staff / Founding, then skills; none put on a levelled or skill-named title', () => {
  assert.deepEqual(titleVariants('Software Engineer', ['Backend Engineer'], ['LLM', 'Platform', 'Rust']),
    ['Backend Engineer', 'Senior Software Engineer', 'Staff Software Engineer', 'Founding Software Engineer', 'LLM Software Engineer', 'Platform Software Engineer']);
  assert.deepEqual(titleVariants('Founding Engineer', [], ['LLM']), []);
  assert.deepEqual(titleVariants('AI Engineer', [], ['LLM', 'AI']), ['Senior AI Engineer', 'Staff AI Engineer', 'Founding AI Engineer']);
  assert.deepEqual(titleVariants('Nurse', ['RN'], []), ['RN', 'Senior Nurse', 'Staff Nurse', 'Founding Nurse'], 'no skills: only wordings');
  // Titles are de-duplicated, case-insensitively, across kinds of job.
  assert.deepEqual(mainTitles({ targets: [{ name: 'a', titles: ['Nurse'] }, { name: 'b', titles: ['nurse', 'RN'] }], titles: [] }), ['Nurse']);
  // The notes' titles alone (no targets) stand for one kind of job.
  assert.deepEqual(mainTitles({ targets: [], titles: ['Cook', 'Chef'] }), ['Cook']);
});

test('rotation: consecutive scans cover different variants, deterministically, and come back round', () => {
  const p = person(2);
  const run = (r: number) => portalQueries(p, OR, { rotation: r })[0].titles;
  for (const r of [0, 1, 2, 3]) assert.deepEqual(run(r).slice(0, 2), ['Software Engineer', 'Platform Engineer'], 'mains are in every run');
  const variantsOf = (r: number) => run(r).filter((t) => !mainTitles(p).includes(t)).join(' | ');
  const seen = [0, 1, 2, 3, 4, 5].map(variantsOf);
  assert.equal(new Set(seen.slice(0, 3)).size, 3, `three different variant sets: ${seen.join(' // ')}`);
  assert.equal(seen[3], seen[0], 'and round again');
  assert.deepEqual([0, 1, 2, 3].map(variantsOf), [0, 1, 2, 3].map(variantsOf), 'deterministic');
  assert.deepEqual(portalQueries(p, OR, { rotation: 2 }), portalQueries(p, OR, { rotation: 2 }));
  // Every variant of the pool turns up within a full cycle.
  const all = new Set(Array.from({ length: 6 }, (_, r) => run(r)).flat());
  for (const v of titleVariants('Software Engineer', ['Backend Engineer'], p.skills)) assert.ok(all.has(v), `${v} appears across runs`);
  // One title per search: the variants rotate too.
  const noneRuns = [0, 1, 2].map((r) => portalQueries(p, NONE, { rotation: r }).map((q) => q.keywords).join(' | '));
  assert.equal(new Set(noneRuns).size, 3, noneRuns.join(' // '));
});

test('rotation when the kinds of job do not all fit one run: each run starts further on, so all get their turn', () => {
  const tight = withSearch({ multi: 'comma', multi_max_chars: 40 }); // a group holds about two titles; budget 3 groups
  const p = person(6, []);
  const mains = mainTitles(p);
  const per = (r: number) => portalQueries(p, tight, { rotation: r, max: 2 }).flatMap((q) => q.titles).filter((t) => mains.includes(t));
  const first = per(0);
  assert.ok(first.length > 0 && first.length < mains.length, `${first.length} of ${mains.length} mains fit a run`);
  const covered = new Set<string>();
  for (let r = 0; r < mains.length; r++) per(r).forEach((t) => covered.add(t));
  assert.deepEqual([...covered].sort(), [...mains].sort(), 'every kind of job is searched within a few runs');
  assert.notDeepEqual(per(1), per(0));
  // When they all fit, the main titles never move.
  assert.deepEqual(portalQueries(person(3), OR, { rotation: 0 })[0].titles.slice(0, 3), portalQueries(person(3), OR, { rotation: 7 })[0].titles.slice(0, 3));
});

test('--portals: the plan lists only those portals; a switched-off one is reported, an unknown id is an error; --portal is unchanged', () => {
  const w = world();
  const a = fixturePortal();
  const b = { ...fixturePortal(), id: 'fixture2', name: 'Fixture Two' };
  const o = { portals: [a, b], profile: person(2), rnd: () => 0.5 };
  for (const id of ['fixture', 'fixture2']) updatePortal(w.jobsHome, id, (s) => ({ ...s, connected: true }));
  togglePortal(w.ctx, a, true);
  togglePortal(w.ctx, b as any, true);
  const all = planPortals(w.ctx, o);
  assert.deepEqual([...new Set(all.pages.map((x) => x.portal))], ['fixture', 'fixture2']);
  const one = planPortals(w.ctx, { ...o, ids: ['fixture2'] });
  assert.deepEqual([...new Set(one.pages.map((x) => x.portal))], ['fixture2']);
  assert.deepEqual(one.pages, all.pages.filter((x) => x.portal === 'fixture2').map((x, i) => ({ ...x, delay_ms: i === 0 ? 0 : x.delay_ms })));
  togglePortal(w.ctx, b as any, false);
  const off = planPortals(w.ctx, { ...o, ids: ['fixture', 'fixture2'] });
  assert.deepEqual([...new Set(off.pages.map((x) => x.portal))], ['fixture']);
  assert.deepEqual(off.skipped, [{ portal: 'fixture2', name: 'Fixture Two', why: 'switched off (Jobs page → Sources → Portals)' }]);
  assert.throws(() => planPortals(w.ctx, { ...o, ids: ['fixture', 'nope'] }), /no portal "nope"/);
  assert.throws(() => planPortals(w.ctx, { ...o, ids: ['fixture'], only: 'fixture' }), /not both/);
  assert.equal(planPortals(w.ctx, { ...o, only: 'fixture' }).pages.length, 1, '--portal: one test page, as before');
  // Entries say what each search covers.
  assert.ok(all.pages.every((x) => Array.isArray(x.titles) && x.titles.length >= 1 && x.titles.join(' ') !== ''));
});

test('limits unchanged: packing adds no pages; the daily cap, pages per search and the budget still bound the plan', () => {
  const w = world();
  const p = { ...fixturePortal(), search: { ...OR.search }, limits: { ...fixturePortal().limits, searches_per_run: 3, pages_per_search: 2, pages_per_day: 30 } };
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, connected: true }));
  togglePortal(w.ctx, p, true);
  const profile = { ...person(6), places: ['Bengaluru'], workModes: ['onsite' as const, 'remote' as const] };
  const packed = planPortals(w.ctx, { portals: [p], profile, rnd: () => 0.5 });
  const plain = planPortals(w.ctx, { portals: [{ ...p, search: NONE.search }], profile, rnd: () => 0.5 });
  assert.ok(packed.pages.length <= 6 && packed.pages.length === plain.pages.length, `${packed.pages.length} vs ${plain.pages.length} pages`);
  assert.ok(new Set(packed.pages.map((x) => x.url)).size === packed.pages.length);
  assert.ok(packed.pages.flatMap((x) => x.titles).length > plain.pages.flatMap((x) => x.titles).length, 'but each page covers more titles');
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, day: { date: '2026-11-19', pages: 29 } }));
  assert.equal(planPortals(w.ctx, { portals: [p], profile, rnd: () => 0.5 }).pages.length, 1, 'one page left today: one page');
  // The shipped limits are still 3 × 1 on LinkedIn and 4 × 1 on Naukri.
  const cat = loadPortals();
  assert.deepEqual([cat.byId.get('linkedin')!.limits.searches_per_run, cat.byId.get('linkedin')!.limits.pages_per_search, cat.byId.get('linkedin')!.limits.pages_per_day, cat.byId.get('linkedin')!.limits.min_hours], [3, 1, 25, 12]);
  assert.deepEqual([cat.byId.get('naukri')!.limits.searches_per_run, cat.byId.get('naukri')!.limits.pages_per_search, cat.byId.get('naukri')!.limits.pages_per_day], [4, 1, 40]);
  // A later page of a packed search uses the same keywords.
  const q = portalQueries(profile, loadPortals().byId.get('linkedin')!)[0];
  assert.equal(kw(searchUrl(loadPortals().byId.get('linkedin')!, q, 1)!), q.keywords);
});

test('state: a finished scan (not a test, not another page of the same scan) moves the rotation on and remembers the groups', () => {
  const w = world();
  const p = { ...fixturePortal(), countries: ['world'] };
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, connected: true }));
  const J = (i: number) => ({ url: `https://www.portal.test/job/Data-Analyst-${i}-Ab${String(i).padStart(6, '0')}`, title: `Data Analyst ${i}`, company: 'Fictional Co', location: 'Bengaluru' });
  const ans = (jobsList: unknown[]) => ({ url: 'https://www.portal.test/jobs/x', signals: { sign_in_wall: false, challenge: false, empty: false }, jobs: jobsList });
  ingestPage(w.ctx, p, ans([J(1)]), { test: true });
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.rotation, undefined, 'a test moves nothing');
  ingestPage(w.ctx, p, ans([J(1)]));
  const s1 = readPortalsState(w.jobsHome).portals.fixture!;
  assert.equal(s1.rotation, 1);
  assert.ok(Array.isArray(s1.last_titles));
  ingestPage(w.ctx, p, ans([J(2)]));
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.rotation, 1, 'the second page of one scan is the same scan');
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, last_scan: '2026-01-01T00:00:00Z' }));
  ingestPage(w.ctx, p, ans([J(3)]));
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.rotation, 2, 'a later scan moves on');
  // A stop (sign-in wall) searched nothing: no move.
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, last_scan: '2026-01-01T00:00:00Z', pause: undefined }));
  ingestPage(w.ctx, p, { ...ans([]), signals: { sign_in_wall: true, challenge: false, empty: true } });
  assert.equal(readPortalsState(w.jobsHome).portals.fixture!.rotation, 2);
});

test('the command line: plan --portals filters, an unknown id errors, --portal with --portals errors, entries carry titles', () => {
  const s = tempSetup('example');
  jobs(s.home, ['portals', 'mark', 'linkedin', 'connected']);
  const bad = jobs(s.home, ['portals', 'plan', '--json', '--portals', 'linkedin,nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no portal "nope"/);
  const both = jobs(s.home, ['portals', 'plan', '--json', '--portal', 'linkedin', '--portals', 'linkedin']);
  assert.equal(both.code, 1);
  assert.match(both.err, /not both/);
  const off = JSON.parse(jobs(s.home, ['portals', 'plan', '--json', '--portals', 'linkedin']).out);
  assert.deepEqual(off.pages, []);
  assert.match(off.skipped[0].why, /switched off/);
  jobs(s.home, ['portals', 'on', 'linkedin']);
  const plan = JSON.parse(jobs(s.home, ['portals', 'plan', '--json', '--portals', 'linkedin']).out);
  assert.ok(plan.pages.length >= 1, JSON.stringify(plan));
  for (const pg of plan.pages) {
    assert.deepEqual(Object.keys(pg).sort(), ['delay_ms', 'portal', 'query', 'titles', 'url']);
    assert.equal(pg.portal, 'linkedin');
    assert.ok(pg.titles.length >= 1 && pg.titles.every((t: string) => typeof t === 'string'));
  }
  assert.equal(JSON.parse(jobs(s.home, ['portals', 'plan', '--json']).out).pages.length, plan.pages.length, 'without --portals: the same');
  assert.equal(jobs(s.home, ['portals', 'plan', '--json', '--portals', 'naukri,instahyre']).code, 0, 'known ids that are not on are skipped, not an error');
});
