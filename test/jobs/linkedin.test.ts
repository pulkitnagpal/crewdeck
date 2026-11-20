// LinkedIn guest pages (design §12): id shapes, card and detail parsing, the search plan from the notes, and the
// client's gate, pace, cap and stop rules, against a local fixture server injected as the base URL. Never LinkedIn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedinClient, LinkedinStop, canonicalJobUrl, fetchDetail, isClosed, linkedinJobId, parseDetail, parseSearch, searchLinkedin, searchPlan } from '../../src/jobs/linkedin.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { world } from './helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { CARD, DETAIL } from './linkedin-fixtures.ts';

test('linkedinJobId reads every LinkedIn job link shape and nothing else', () => {
  assert.equal(linkedinJobId('https://de.linkedin.com/jobs/view/senior-data-analyst-at-example-4000000001?position=1&pageNum=0'), '4000000001');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/4000000001/'), '4000000001');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/view/4000000001'), '4000000001');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4000000001'), '4000000001');
  assert.equal(linkedinJobId('https://www.linkedin.com/jobs/search/?currentJobId=4000000001&keywords=analyst'), '4000000001');
  assert.equal(linkedinJobId('https://www.linkedin.com/comm/jobs/view/4000000001'), '4000000001');
  assert.equal(linkedinJobId('https://linkedin.com/jobs/view/4000000001'), '4000000001');
  for (const no of ['https://www.linkedin.com/in/someone', 'https://www.linkedin.com/feed/', 'https://example.com/jobs/view/4000000001',
    'https://www.linkedin.com.evil.example/jobs/view/4000000001', 'ftp://www.linkedin.com/jobs/view/4000000001', 'not a url', '4000000001', 'https://www.linkedin.com/jobs/view/123'])
    assert.equal(linkedinJobId(no), null, no);
  assert.equal(canonicalJobUrl('4000000001'), 'https://www.linkedin.com/jobs/view/4000000001');
});

test('search cards and detail pages parse, including the apply kind and closed postings', () => {
  const cards = parseSearch(`<ul>${CARD('4000000011', 'Senior &amp; Lead Data Analyst', 'Example Co')}${CARD('4000000012', 'BI Analyst', 'Sample AG')}</ul>`);
  assert.deepEqual(cards.map((c) => [c.id, c.title, c.company, c.location]), [['4000000011', 'Senior & Lead Data Analyst', 'Example Co', 'Berlin, Germany'], ['4000000012', 'BI Analyst', 'Sample AG', 'Berlin, Germany']]);
  assert.equal(cards[0].posted_at, '2026-11-16T00:00:00.000Z');
  const easy = parseDetail('4000000013', DETAIL())!;
  assert.deepEqual([easy.title, easy.company, easy.location, easy.apply_kind, easy.closed], ['Senior Data Analyst', 'Example & Partners', 'Berlin, Germany', 'easy', false]);
  assert.match(easy.description, /Build Looker dashboards\.\nSQL\ndbt\nHybrid, Berlin\./);
  assert.equal(parseDetail('1', DETAIL({ kind: 'apply-link-offsite' }))!.apply_kind, 'external');
  assert.equal(parseDetail('1', DETAIL({ kind: 'something-else' }))!.apply_kind, 'unknown');
  assert.equal(parseDetail('1', DETAIL({ closed: true }))!.closed, true);
  assert.equal(parseDetail('1', '<html>Sign in to see this job</html>'), null);
  assert.equal(isClosed('<div>No longer accepting applications</div>'), true);
});

test('the search plan comes from the notes: titles, places, workplace, age', () => {
  const b = world('berlin-analyst');
  assert.deepEqual(searchPlan(notesOf(b.ctx), 7), { terms: ['data analyst', 'analytics engineer', 'Datenanalyst', 'BI analyst'], places: ['Berlin'], f_WT: '1,3', f_TPR: 'r604800' });
  const n = world('us-nurse');
  const p = searchPlan(notesOf(n.ctx), 1);
  assert.deepEqual([p.places, p.f_WT, p.f_TPR], [['Texas', 'Arizona'], '2', 'r86400']);
  assert.equal(searchPlan(notesOf(n.ctx), 30).f_TPR, 'r2592000');
});

/** A fake guest API: search pages and details by id, and a switch to start answering 429 / 999 / a redirect. */
async function fakeLinkedin(o: { cards: string; details?: Record<string, string>; refuse?: { after: number; status: number } } = { cards: '' }) {
  let n = 0;
  const s = await serve((req, res) => {
    n++;
    if (o.refuse && n > o.refuse.after) {
      res.writeHead(o.refuse.status, o.refuse.status === 302 ? { location: 'https://www.linkedin.com/authwall' } : {}).end();
      return;
    }
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname === '/jobs-guest/jobs/api/seeMoreJobPostings/search') { res.writeHead(200, { 'content-type': 'text/html' }).end(u.searchParams.get('start') === '0' ? o.cards : ''); return; }
    const id = /\/jobPosting\/(\d+)$/.exec(u.pathname)?.[1];
    if (id && o.details?.[id]) { res.writeHead(200, { 'content-type': 'text/html' }).end(o.details[id]); return; }
    res.writeHead(404).end();
  });
  return { ...s, base: `${s.base('li.example.test')}/jobs-guest/jobs/api`, net: { testHosts: testHosts('li.example.test') } };
}

test('search is off unless the user switched it on', async () => {
  const w = world('berlin-analyst');
  await assert.rejects(searchLinkedin(w.ctx), /LinkedIn search is off: only the user can switch it on/);
});

test('search: cards are prefiltered before any detail request; details stored with their apply kind; known roles skipped', async (t) => {
  const cards = CARD('4000000021', 'Senior Data Analyst', 'Example Co') + CARD('4000000022', 'Sales Data Analyst', 'Example Sales') // excluded title word
    + CARD('4000000023', 'Data Analyst', 'Example Agency GmbH') // excluded company
    + CARD('4000000024', 'Registered Nurse', 'Sample AG') // another occupation: not worth a request
    + CARD('4000000025', 'BI Analyst', 'Sample Retail', 'Munich, Germany') // elsewhere, on-site person
    + CARD('4000000026', 'Analytics Engineer', 'Example Closed');
  const li = await fakeLinkedin({ cards, details: { 4000000021: DETAIL({ company: 'Example Co' }), 4000000026: DETAIL({ title: 'Analytics Engineer', company: 'Example Closed', closed: true }) } });
  t.after(() => li.close());
  const w = world('berlin-analyst', { features: { linkedin_search: true } });
  const waits: number[] = [];
  const r = await searchLinkedin(w.ctx, { base: li.base, net: li.net, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.cards, 6);
  assert.equal(r.stored, 1);
  assert.equal(r.skipped, 5);
  const details = li.hits.filter((h) => h.includes('/jobPosting/'));
  assert.deepEqual(details.sort(), ['/jobs-guest/jobs/api/jobPosting/4000000021', '/jobs-guest/jobs/api/jobPosting/4000000026']);
  const row = w.ctx.db.prepare('select url, apply_kind, source, posted_at from roles').get() as any;
  assert.deepEqual({ ...row }, { url: canonicalJobUrl('4000000021'), apply_kind: 'easy', source: 'linkedin', posted_at: '2026-11-16T00:00:00.000Z' });
  // Every request after the first waited for the pace.
  assert.ok(waits.length >= r.requests - 1 && waits.every((ms) => ms > 2000 && ms <= 2500), JSON.stringify(waits));
  // The search URL carries the plan's filters.
  const first = new URL(li.hits[0], 'http://x');
  assert.deepEqual([first.searchParams.get('keywords'), first.searchParams.get('location'), first.searchParams.get('f_WT'), first.searchParams.get('f_TPR')], ['data analyst', 'Berlin', '1,3', 'r604800']);
  // A second run: the stored role is known, no detail for it.
  const before = li.hits.length;
  const again = await searchLinkedin(w.ctx, { base: li.base, net: li.net, sleep: async () => {} });
  assert.equal(again.known, 1);
  assert.ok(!li.hits.slice(before).includes('/jobs-guest/jobs/api/jobPosting/4000000021'));
});

for (const status of [429, 999, 302]) {
  test(`the run stops for good at the first ${status}`, async (t) => {
    const li = await fakeLinkedin({ cards: CARD('4000000031', 'Data Analyst', 'Example One'), refuse: { after: 1, status } });
    t.after(() => li.close());
    const w = world('berlin-analyst', { features: { linkedin_search: true } });
    const r = await searchLinkedin(w.ctx, { base: li.base, net: li.net, sleep: async () => {} });
    assert.match(r.stopped ?? '', new RegExp(`HTTP ${status}.*stopped`));
    const n = li.hits.length;
    assert.equal(n, 2, 'one search page, then one refused request, then nothing');
    assert.equal(r.stored, 0);
    assert.equal(r.stop_status, status);
    // P1b: the card found before the stop is kept as a role without a description (it was discarded before).
    assert.equal(r.partial, 1);
    const kept = w.ctx.db.prepare('select url, title, location, description, source, source_key, posted_at, status from roles').all().map((x: any) => ({ ...x }));
    assert.deepEqual(kept, [{ url: canonicalJobUrl('4000000031'), title: 'Data Analyst', location: 'Berlin, Germany', description: '', source: 'linkedin', source_key: 'linkedin', posted_at: '2026-11-16T00:00:00.000Z', status: 'new' }]);
    const client = new LinkedinClient({ base: li.base, net: li.net, sleep: async () => {} });
    await client.get('seeMoreJobPostings/search?start=1').catch(() => {});
    await assert.rejects(client.get('jobPosting/4000000031'), LinkedinStop);
    assert.equal(li.hits.length, n + 1, 'a stopped client sends nothing more');
  });
}

test('the request cap holds, and no setting can raise it past 60', async (t) => {
  const li = await fakeLinkedin({ cards: '' });
  t.after(() => li.close());
  const c = new LinkedinClient({ base: li.base, net: li.net, maxRequests: 3, sleep: async () => {} });
  for (let i = 0; i < 3; i++) await c.get('jobPosting/4000000041');
  await assert.rejects(c.get('jobPosting/4000000041'), /request cap reached \(3 per run\)/);
  assert.equal(li.hits.length, 3);
  assert.equal(new LinkedinClient({ maxRequests: 1000 }).cap, 60);
  assert.equal(await fetchDetail(new LinkedinClient({ base: li.base, net: li.net, sleep: async () => {} }), '4000000042'), null, '404 is "not shown"');
  await assert.rejects(fetchDetail(c, '../../etc'), /not a LinkedIn job id/);
});

test('the guest client is guarded too: a base on this machine is refused', async (t) => {
  const s = await serve(() => {});
  t.after(() => s.close());
  await assert.rejects(new LinkedinClient({ base: `${s.base()}/api`, sleep: async () => {} }).get('jobPosting/4000000051'), /private or local/);
  assert.deepEqual(s.hits, []);
});

test('cards kept on a stop get their details on a later run; every card past the detail cap is kept too', async (t) => {
  const cards = CARD('4000000061', 'Senior Data Analyst', 'Example One') + CARD('4000000062', 'Data Analyst', 'Example Two') + CARD('4000000063', 'BI Analyst', 'Example Three');
  const details = { 4000000061: DETAIL({ company: 'Example One' }), 4000000062: DETAIL({ title: 'Data Analyst', company: 'Example Two' }), 4000000063: DETAIL({ title: 'BI Analyst', company: 'Example Three' }) };
  const ok = await fakeLinkedin({ cards, details });
  t.after(() => ok.close());
  // The detail cap: cards past it are kept, not dropped.
  const w2 = world('berlin-analyst', { features: { linkedin_search: true } });
  const c = await searchLinkedin(w2.ctx, { base: ok.base, net: ok.net, sleep: async () => {}, maxDetails: 1 });
  assert.deepEqual([c.stored, c.partial, c.stopped], [1, 2, undefined]);
  const searches = ok.hits.filter((h) => h.includes('/seeMoreJobPostings/')).length;
  // A stop after the searches and one detail: the two cards not yet read are kept.
  const stopped = await fakeLinkedin({ cards, details, refuse: { after: searches + 1, status: 429 } });
  t.after(() => stopped.close());
  const w = world('berlin-analyst', { features: { linkedin_search: true } });
  const a = await searchLinkedin(w.ctx, { base: stopped.base, net: stopped.net, sleep: async () => {} });
  assert.deepEqual([a.stored, a.partial, a.roles.length, a.stop_status], [1, 2, 3, 429]);
  const b = await searchLinkedin(w.ctx, { base: ok.base, net: ok.net, sleep: async () => {} });
  assert.deepEqual([b.known, b.stored, b.partial], [1, 2, 0], 'the card-only roles are read now; the full one is known');
  assert.equal((w.ctx.db.prepare("select count(*) n from roles where description = ''").get() as any).n, 0);
});
