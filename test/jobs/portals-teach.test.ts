// ADR-0008 "Teach a portal": lightweight catalog entries (teach: true), the person's readers.yaml overlay (validated
// by the catalog's own rules, 0600), the inspect script over a fake page, `portals teach | reader | inspect-script`, the
// 12 KB page answer, a portal's last scan on the Sources list, and LinkedIn's guest search stepping aside for the
// signed-in portal. Fictional sites and people only; no real portal is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tempSetup, jobs, textFile, world } from './helpers.ts';
import { FIXTURE_YAML, INDIA_PROFILE, fixturePortal } from './portal-helpers.ts';
import { PORTAL_KINDS, canScan, loadPortals, parsePortals, portalIssues } from '../../src/jobs/portals/catalog.ts';
import { addPortal, checkReader, effectivePortals, idFromUrl, overlay, readersFile, removeAddedPortal, resetReader, saveReader } from '../../src/jobs/portals/readers.ts';
import { inspectScript, pageScript } from '../../src/jobs/portals/page-script.ts';
import { planPortals } from '../../src/jobs/portals/pane.ts';
import { readPortalsState, updatePortal } from '../../src/jobs/portals/state.ts';
import { portalsView, togglePortal } from '../../src/jobs/portals/view.ts';
import { listSources } from '../../src/jobs/sources-note.ts';
import { LINKEDIN_PORTAL_ON, linkedinPortalOn, runSources } from '../../src/jobs/sources.ts';

const TEACH_YAML = `${FIXTURE_YAML}
  - id: sample-jobs
    name: Sample Jobs
    teach: true
    home_url: https://www.sample-jobs.test/
    countries: [in]
    fields: [any]
    kind: portal
    access: signed-in
    importance: 2
    risk: Sample risk note.
    notes: A fictional teach entry.
`;
const teachCat = () => { const r = parsePortals(TEACH_YAML); assert.deepEqual(r.problems, []); return r.cat; };

/** A reader for the fictional teach entry: cards with a link, a search URL with the person's words. */
const READER = {
  search: { url: 'https://www.sample-jobs.test/search?q={q}&where={place}&age={recency}', recency: { 7: '7' } },
  job_url: { pattern: '^/job/[a-z0-9-]+-(\\d{6,})$' },
  cards: [{ item: 'li.job-card', title: 'a.title', company: '.company', location: '.place' }],
  sign_in_wall: ['^/login'], signed_in: { url_pattern: '^/home' },
};

test('the shipped catalog: full entries and teach entries; a teach entry carries only who it is and where it lives', () => {
  const cat = loadPortals();
  const teach = cat.portals.filter((p) => p.teach), full = cat.portals.filter((p) => !p.teach);
  assert.ok(full.length >= 10 && teach.length >= 40, `${full.length} full, ${teach.length} teach`);
  for (const p of teach) {
    assert.deepEqual(portalIssues(p), [], p.id);
    assert.ok(!canScan(p) && !p.search.url && !p.job_url.pattern && !p.cards && !p.json.length, p.id);
    assert.ok(p.home_url && p.hosts.includes(new URL(p.home_url).hostname), `${p.id}: hosts from its home address`);
    assert.ok(p.kind && (PORTAL_KINDS as readonly string[]).includes(p.kind) && p.access && [1, 2, 3].includes(p.importance!), p.id);
    assert.equal(p.login_url, p.home_url, `${p.id}: connect opens its home page`);
  }
  // Government notification sites are public-search, kind government; the odd guesses are gone.
  for (const id of ['upsc', 'ssc', 'ibps', 'freejobalert']) assert.equal(cat.byId.get(id)?.kind, 'government', id);
  assert.equal(cat.byId.get('upsc')!.access, 'public-search');
  for (const id of ['hirist-iimjobs-same', 'bossjobs-indeed-flex', 'kaggle-jobs', 'mediabistro-exchange4media', 'medicaljobs-india', 'nursingjobs-india', 'monster-india-foundit', 'naukri']) {
    assert.ok(!cat.byId.get(id)?.teach, `${id} is not a teach entry`);
  }
  // Notes from the research list merged into the existing entries.
  assert.match(cat.byId.get('foundit')!.notes!, /formerly Monster India/);
  assert.match(cat.byId.get('hirist')!.notes!, /iimjobs/);
  assert.equal(cat.byId.get('naukri')!.kind, 'portal');
});

test('teach entries are checked too: no search parts, a kind, access and importance, never verified', () => {
  const bad = TEACH_YAML.replace('    kind: portal\n    access: signed-in\n    importance: 2\n    risk: Sample', '    kind: website\n    access: open\n    importance: 7\n    verified: true\n    job_url: { pattern: "^/j/" }\n    risk: Sample');
  const { problems } = parsePortals(bad);
  for (const re of [/kind is one of/, /access is signed-in or public-search/, /importance is 1, 2 or 3/, /never verified/, /has no search, job_url/]) assert.ok(problems.some((p) => re.test(p)), `${re}: ${problems.join(' | ')}`);
  assert.ok(parsePortals(TEACH_YAML.replace('    home_url: https://www.sample-jobs.test/\n', '')).problems.some((p) => /needs its home url/.test(p)));
});

test('readers.yaml overlays the catalog by id (0600), validated by the catalog\'s rules; reset brings the catalog back', () => {
  const w = world('example');
  const cat = teachCat();
  assert.equal(canScan(cat.byId.get('sample-jobs')!), false);
  assert.throws(() => checkReader({ ...READER, hosts: ['evil.example.com'] }), /unknown reader key "hosts"/);
  // A reader with a job link off the pattern's rules is refused with the catalog's words.
  assert.match(overlay(cat, 'sample-jobs', { ...READER, job_url: { pattern: '(' } }).problems.join(), /job_url.pattern is missing or not a regex/);
  assert.match(overlay(cat, 'sample-jobs', { ...READER, search: { url: 'https://elsewhere.example.com/s?q={q}' } }).problems.join(), /not on the portal's hosts/);
  const saved = saveReader(w.ctx.home, 'sample-jobs', READER, cat);
  assert.ok(canScan(saved) && saved.reader && saved.teach === false);
  assert.equal(statSync(readersFile(w.ctx.home)).mode & 0o777, 0o600);
  const eff = effectivePortals(w.ctx.home, cat);
  assert.equal(eff.byId.get('sample-jobs')!.search.url, READER.search.url);
  assert.equal(eff.byId.get('sample-jobs')!.kind, 'portal', 'the catalog\'s facts stay');
  // A reader that stops validating (hand-edited) is ignored, with its problems kept for `portals reader`.
  saveReader(w.ctx.home, 'fixture', { job_url: { pattern: '^/job/x$' } }, cat);
  const raw = readFileSync(readersFile(w.ctx.home), 'utf8');
  require0600Write(w.ctx.home, raw.replace('^/job/x$', '('));
  const eff2 = effectivePortals(w.ctx.home, cat);
  assert.equal(eff2.byId.get('fixture')!.job_url.pattern, cat.byId.get('fixture')!.job_url.pattern);
  assert.ok(eff2.readerProblems.fixture?.length);
  assert.equal(resetReader(w.ctx.home, 'sample-jobs'), true);
  assert.equal(resetReader(w.ctx.home, 'sample-jobs'), false);
  assert.equal(canScan(effectivePortals(w.ctx.home, cat).byId.get('sample-jobs')!), false);
});

/** A hand edit of the person's readers file (Crewdeck reads it as data). */
function require0600Write(home: string, text: string) {
  writeFileSync(readersFile(home), text, { mode: 0o600 });
}

test('a teach portal is never planned or listed as scannable until it has a reader', () => {
  const w = world('example');
  const cat = teachCat();
  updatePortal(w.ctx.home, 'sample-jobs', () => ({ connected: true }));
  const plan = planPortals(w.ctx, { only: 'sample-jobs', portals: effectivePortals(w.ctx.home, cat).portals, profile: INDIA_PROFILE });
  assert.equal(plan.pages.length, 0);
  assert.match(plan.skipped[0].why, /needs a reader: Claude sets it up on first connect/);
  const v = portalsView(w.ctx, effectivePortals(w.ctx.home, cat).portals).portals.find((p) => p.id === 'sample-jobs')!;
  assert.equal(v.needs_reader, true);
  saveReader(w.ctx.home, 'sample-jobs', READER, cat);
  const plan2 = planPortals(w.ctx, { only: 'sample-jobs', portals: effectivePortals(w.ctx.home, cat).portals, profile: INDIA_PROFILE });
  assert.equal(plan2.pages.length, 1);
  assert.match(plan2.pages[0].url, /^https:\/\/www\.sample-jobs\.test\/search\?q=/);
});

// ---- the inspect script, over a small fake page ----

class El {
  parentElement: El | null = null; children: El[] = []; attributes: { name: string; value: string }[] = [];
  tagName: string; classList: string[]; own: string;
  constructor(tagName: string, classList: string[] = [], own = '', attrs: Record<string, string> = {}) {
    this.tagName = tagName; this.classList = classList; this.own = own;
    for (const [name, value] of Object.entries(attrs)) this.attributes.push({ name, value });
  }
  add(...c: El[]) { for (const x of c) { x.parentElement = this; this.children.push(x); } return this; }
  getAttribute(n: string) { return this.attributes.find((a) => a.name === n)?.value ?? null; }
  get innerText(): string { return [this.own, ...this.children.map((c) => c.innerText)].filter(Boolean).join('\n'); }
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel: string): El[] {
    const all = this.all();
    if (sel === 'body *') return all;
    return all.filter((e) => sel.split(',').some((one) => {
      const s = one.trim();
      if (s === 'a[href]') return e.tagName === 'A' && e.getAttribute('href') !== null;
      if (s.startsWith('[')) return false;
      const [tag, ...cls] = s.split('.');
      return e.tagName.toLowerCase() === tag && cls.every((c) => e.classList.includes(c));
    }));
  }
}

function fakeSearchPage() {
  const body = new El('BODY');
  const list = new El('UL', ['results']);
  for (let i = 0; i < 6; i++) {
    const card = new El('LI', ['job-card']).add(
      new El('A', ['title'], `Data Analyst ${i}`, { href: `/job/data-analyst-${i}-10000${i}` }),
      new El('SPAN', ['company'], `Fictional Co ${i}`), new El('SPAN', ['place'], 'Pune'),
    );
    if (i === 0) (card as any)['__reactFiber$abc'] = { memoizedProps: { jobData: { title: 'Data Analyst 0', jdURL: '/job/data-analyst-0-100000', companyName: 'Fictional Co 0' } }, return: null };
    list.add(card);
  }
  body.add(new El('NAV').add(new El('A', [], 'Home', { href: '/' })), list);
  const doc = { title: 'Data Analyst jobs', body, querySelectorAll: (s: string) => (s.startsWith('script') || s.startsWith('input') ? [] : body.querySelectorAll(s)), getElementById: () => null };
  return { document: doc, location: new URL('https://www.sample-jobs.test/search?q=data+analyst') };
}

test('inspect-script: candidate cards with samples, link shapes and React records, small and never the page', () => {
  const script = inspectScript();
  assert.ok(script.length < 5000, `${script.length} characters`);
  // eslint-disable-next-line no-new-func
  const out = new Function('globalThis', `return ${script}`)(fakeSearchPage());
  assert.equal(out.cards[0].selector, 'li.job-card');
  assert.equal(out.cards[0].siblings, 6);
  assert.deepEqual(out.cards[0].samples[0].lines, ['Data Analyst 0', 'Fictional Co 0', 'Pune']);
  assert.deepEqual(out.cards[0].samples[0].links, ['/job/data-analyst-0-100000']);
  assert.deepEqual(out.cards[0].samples[0].react, { prop: 'jobData', keys: ['title', 'jdURL', 'companyName'] });
  assert.ok(out.links.includes('/job/{slug}-{n} ×6'), out.links.join());
  assert.ok(JSON.stringify(out).length < 4000);
});

// ---- the CLI ----

test('portals teach: validates, prints the page script; --save needs a trial answer with 5 jobs; reader shows and resets', () => {
  const s = tempSetup('example');
  const help = jobs(s.home, ['portals', '--help']).out;
  for (const v of ['inspect-script', 'teach <id> --file <reader.json>', '--answer <f.json> --save', 'reader <id> [--reset]']) assert.ok(help.includes(v), v);
  const list = jobs(s.home, ['portals', 'list']).out;
  assert.match(list, /^iimjobs\s+iimjobs\s+not connected\s+\[in\] niche\s+needs a reader \(Claude sets it up on first connect\)$/m);
  assert.match(jobs(s.home, ['portals', 'script', 'iimjobs']).err, /needs a reader first/);
  assert.match(jobs(s.home, ['portals', 'inspect-script']).out, /^\(\(\)=>\{/);

  const reader = { search: { url: 'https://www.iimjobs.com/search?q={q}' }, job_url: { pattern: '^/j/[a-z0-9-]+-(\\d{5,})\\.html$' }, cards: [{ item: '.job-row', title: 'a.job-title', company: '.org' }], signed_in: { url_pattern: '^/user/' } };
  const bad = textFile(s.root, 'reader-bad.json', JSON.stringify({ ...reader, job_url: { pattern: '(' } }));
  const r1 = jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', bad]);
  assert.equal(r1.code, 1);
  assert.match(r1.out, /the reader is not ready:\n {2}· job_url.pattern is missing or not a regex/);
  const f = textFile(s.root, 'reader-iimjobs.json', JSON.stringify(reader));
  const dry = jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', f]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /the reader checks out/);
  assert.ok(dry.out.includes('"item":".job-row"'), 'the printed script carries the reader');
  assert.match(jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', f, '--save']).err, /--save needs --answer/);
  const job = (i: number) => ({ url: `https://www.iimjobs.com/j/head-of-sales-fictional-co-${10000 + i}.html`, title: `Head of Sales ${i}`, company: `Fictional Co ${i}`, location: 'Mumbai' });
  const ans = (n: number, signals = {}) => JSON.stringify({ url: 'https://www.iimjobs.com/search?q=head+of+sales', signals: { sign_in_wall: false, challenge: false, empty: n === 0, ...signals }, jobs: Array.from({ length: n }, (_, i) => job(i)) });
  const three = textFile(s.root, 'ans3.json', ans(3));
  assert.match(jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', f, '--answer', three, '--save']).err, /gave 3 jobs; a reader is kept once it finds at least 5/);
  const wall = textFile(s.root, 'ans-wall.json', ans(6, { sign_in_wall: true }));
  assert.match(jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', f, '--answer', wall, '--save']).err, /sign-in wall: nothing kept/);
  const six = textFile(s.root, 'ans6.json', ans(6));
  const ok = jobs(s.home, ['portals', 'teach', 'iimjobs', '--file', f, '--answer', six, '--save']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /iimjobs: reader saved \(6 jobs on the trial page, e\.g\. Head of Sales 0 at Fictional Co 0/);
  assert.match(jobs(s.home, ['portals', 'list']).out, /^iimjobs\s+iimjobs\s+not connected\s+\[in\]\s+\(your reader\)$/m);
  assert.equal(jobs(s.home, ['portals', 'script', 'iimjobs']).code, 0);
  const shown = JSON.parse(jobs(s.home, ['portals', 'reader', 'iimjobs']).out);
  assert.equal(shown.needs_reader, false);
  assert.equal(shown.reader.search.url, reader.search.url);
  assert.match(jobs(s.home, ['portals', 'reader', 'iimjobs', '--reset']).out, /your reader is removed/);
  assert.equal(JSON.parse(jobs(s.home, ['portals', 'reader', 'iimjobs']).out).needs_reader, true);
});

// ---- the page answer's budget ----

test('a 40-card Naukri-sized page fits the 12 KB answer whole; workplace only when the location doesn\'t say it', async () => {
  const p = fixturePortal({ json: [{ url: '/api/search', list: 'results', fields: { url: 'link', title: 'name', company: 'org.name', location: 'where', posted_at: 'age', workplace: 'mode' } }] });
  const API = 'https://www.portal.test/api/search?q=x';
  const results = Array.from({ length: 40 }, (_, i) => ({
    link: `/job/Senior-Data-Analyst-Fictional-Analytics-${i}-Ab${String(i).padStart(6, '0')}`,
    name: `Senior Data Analyst, Business Intelligence and Reporting ${i}`, org: { name: `Fictional Analytics Private Limited ${i}` },
    where: i % 2 ? 'Remote' : 'Bengaluru, Hyderabad, Pune', age: '3 days ago', mode: i % 2 ? 'Work from home' : 'Hybrid',
  }));
  const G: any = {
    location: new URL('https://www.portal.test/jobs/data-analyst-jobs?days=7'),
    performance: { getEntriesByType: (t: string) => (t === 'resource' ? [{ name: API }] : []) },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ results }) }),
    document: { readyState: 'complete', title: 'Jobs', body: { innerText: 'Jobs' }, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
  };
  // eslint-disable-next-line no-new-func
  const out = await new Function('globalThis', `return ${pageScript(p, { settleMs: 0 })}`)(G);
  assert.equal(out.jobs.length, 40);
  assert.ok(JSON.stringify(out).length <= 12_000, `${JSON.stringify(out).length} characters`);
  assert.equal(out.jobs[1].location, 'Remote');
  assert.equal(out.jobs[1].workplace, undefined, 'the location already says Remote');
  assert.equal(out.jobs[0].workplace, 'hybrid', 'Bengaluru doesn\'t say hybrid: kept');
  assert.ok(!('company_country' in out.jobs[0]));
});

// ---- Sources: a portal's last scan; LinkedIn's guest search steps aside ----

test('jobs sources list shows a portal row\'s last scan from the portals state, not "not fetched yet"', () => {
  const w = world('example');
  updatePortal(w.ctx.home, 'naukri', () => ({ connected: true }));
  togglePortal(w.ctx, loadPortals().byId.get('naukri')!, true);
  assert.equal(listSources(w.ctx).find((r) => r.portal === 'naukri')!.last, undefined);
  updatePortal(w.ctx.home, 'naukri', (p) => ({ ...p, last_scan: '2026-11-19T09:00:00.000Z', last_found: 23, last_new: 9 }));
  const row = listSources(w.ctx).find((r) => r.portal === 'naukri')!;
  assert.deepEqual({ at: row.last!.at, ok: row.last!.ok, jobs: row.last!.jobs, new: row.last!.new }, { at: '2026-11-19T09:00:00.000Z', ok: true, jobs: 23, new: 9 });
  updatePortal(w.ctx.home, 'naukri', (p) => ({ ...p, last_error: 'Naukri asked to sign in again', pause: { until: '2026-11-19T20:00:00.000Z', level: 1, reason: 'x' } }));
  const bad = listSources(w.ctx).find((r) => r.portal === 'naukri')!.last!;
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'Naukri asked to sign in again');
  assert.equal(bad.paused_until, '2026-11-19T20:00:00.000Z');
});

test('the LinkedIn portal connected and on: the sources run skips LinkedIn\'s guest search and says why', async () => {
  const w = world('example', { features: { linkedin_search: true } });
  assert.equal(await linkedinPortalOn(w.ctx), false);
  updatePortal(w.ctx.home, 'linkedin', () => ({ connected: true }));
  assert.equal(await linkedinPortalOn(w.ctx), false, 'connected but not switched on');
  togglePortal(w.ctx, loadPortals().byId.get('linkedin')!, true);
  assert.equal(await linkedinPortalOn(w.ctx), true);
  const r = await runSources(w.ctx, { details: 0, plan: { entries: [], ids: [], skipped: [] }, portalsMode: 'pane' });
  assert.deepEqual(r.linkedin, { ran: false, why: LINKEDIN_PORTAL_ON });
  assert.equal(w.ctx.features.linkedin_search, true, 'the switch itself is untouched');
  togglePortal(w.ctx, loadPortals().byId.get('linkedin')!, false);
  assert.equal(await linkedinPortalOn(w.ctx), false);
  assert.ok(readPortalsState(w.ctx.home).portals.linkedin.connected);
});

// ---- person-added portals (portal_add) ----

test('added portals: a teach entry in readers.yaml, an id from the host, removed again', () => {
  const w = world('example');
  assert.equal(idFromUrl('https://www.example-careers.co.in/jobs'), 'example-careers');
  assert.equal(idFromUrl('https://jobs.samplehire.com/'), 'samplehire');
  const p = addPortal(w.ctx.home, { id: 'samplehire', name: 'Sample Hire', home_url: 'https://jobs.samplehire.com/', countries: ['in'], fields: [] });
  assert.equal(p.teach, true);
  const eff = effectivePortals(w.ctx.home);
  assert.equal(eff.byId.get('samplehire')!.added, true);
  assert.equal(eff.byId.get('samplehire')!.login_url, 'https://jobs.samplehire.com/');
  assert.throws(() => addPortal(w.ctx.home, { id: 'naukri', name: 'Naukri copy', home_url: 'https://example.com/', countries: [], fields: [] }), /already there/);
  assert.equal(removeAddedPortal(w.ctx.home, 'samplehire'), true);
  assert.equal(effectivePortals(w.ctx.home).byId.has('samplehire'), false);
});
