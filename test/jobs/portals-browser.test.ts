// ADR-0008, optional: the real portal profile (the person's own Chromium, headless) scanning a local fixture site
// through the guard proxy: all three layers, and a host outside the portal's list refused. Skipped with no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { statSync } from 'node:fs';
import { QUIET, findBrowser } from '../../src/jobs/browser.ts';
import { pageScript } from '../../src/jobs/portals/page-script.ts';
import { ingestPage } from '../../src/jobs/portals/pane.ts';
import { launchPortal, profileDir } from '../../src/jobs/portals/profile.ts';
import { scanPortal } from '../../src/jobs/portals/scan.ts';
import { updatePortal } from '../../src/jobs/portals/state.ts';
import { world } from './helpers.ts';
import { INDIA_PROFILE, fixture, fixturePortal } from './portal-helpers.ts';

const found = findBrowser();

test('a real headless scan of a local fixture portal: json, jsonld and links, other hosts refused', { skip: found ? false : 'no Chromium-based browser on this machine', timeout: 90_000 }, async () => {
  const site = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/search')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [{ link: '/job/Product-Analyst-Opal-Mobility-Zz123456', name: 'Product Analyst', org: { name: 'Opal Mobility' }, where: 'Bengaluru' }] }));
    }
    if (req.url?.startsWith('/jobs/')) {
      // The fixture page, plus the page's own data request and one to a host outside the portal's list.
      const html = fixture('jsonld-search.html').replaceAll('https://www.portal.test/', `http://www.portal.test:${port}/`).replace('</body>', `<script>fetch('/api/search?q=data').catch(()=>{});fetch('http://tracker.elsewhere.test/pixel').catch(()=>{});</script></body>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const port = (site.address() as net.AddressInfo).port;
  const w = world('berlin-analyst', { now: new Date().toISOString() });
  try {
    const base = fixturePortal();
    // The same portal on the local site over http (the shipped catalog's https URLs are validated; this one is a test's).
    const p = {
      ...base, signed_in: { url_pattern: '^/dashboard' },
      search: { ...base.search, url: `http://www.portal.test:${port}/jobs/{q_slug}-jobs?days={recency}`, url_place: `http://www.portal.test:${port}/jobs/{q_slug}-jobs-in-{place_slug}?days={recency}` },
    };
    updatePortal(w.jobsHome, p.id, () => ({ connected: true }));
    const netOpts = { testHosts: { 'www.portal.test': '127.0.0.1', 'tracker.elsewhere.test': '127.0.0.1' } };
    let blocked: string[] = [];
    const r = await scanPortal(w.ctx, p, {
      test: true, profile: INDIA_PROFILE,
      launch: async (portal, o) => { const b = await launchPortal(w.jobsHome, portal, { ...o, net: netOpts }); const close = b.close; return { ...b, close: async () => { blocked = b.blocked(); await close(); } }; },
    });
    assert.equal(r.ran, true, r.why);
    assert.equal(r.stopped, undefined);
    // The captured response gives one posting, the JSON-LD the fixture's two; its links repeat those (counted once).
    assert.deepEqual(r.by, { json: 1, jsonld: 2, links: 0 }, JSON.stringify(r));
    assert.equal(r.found, 3, JSON.stringify(r.sample));
    assert.ok(blocked.includes('tracker.elsewhere.test'), `refused: ${blocked.join(', ')}`);
    assert.equal(statSync(profileDir(w.jobsHome)).mode & 0o777, 0o700);
  } finally { site.close(); }
});

// ADR-0008 pane mode: the exact `crewdeck jobs portals script` text, evaluated in a real page as javascript_tool does
// (an expression whose Promise is awaited), over a local fixture site named www.portal.test; then its answer through
// ingest. Every layer: the JSON the page loaded (fetched again), JSON-LD, job links with their card text; and signals.
test('pane mode: the page script in a real browser reads JSON, JSON-LD and cards; its answer is what ingest stores', { skip: found ? false : 'no Chromium-based browser on this machine', timeout: 90_000 }, async () => {
  const site = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (type: string, body: string) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (url.startsWith('/api/search')) return send('application/json', JSON.stringify({ results: [{ link: '/job/Product-Analyst-Opal-Mobility-Zz123456', name: 'Product Analyst', org: { name: 'Opal Mobility' }, where: 'Bengaluru' }] }));
    if (url.startsWith('/jobs/data')) return send('text/html; charset=utf-8', fixture('jsonld-search.html').replaceAll('https://www.portal.test/', `http://www.portal.test:${port}/`).replace('</body>', `<script>fetch('/api/search?q=data').catch(()=>{});</script></body>`));
    if (url.startsWith('/jobs/remote')) return send('text/html; charset=utf-8', fixture('cards-search.html'));
    if (url.startsWith('/challenge')) return send('text/html; charset=utf-8', fixture('challenge.html'));
    if (url.startsWith('/login')) return send('text/html; charset=utf-8', '<html><body><form><input name="u"><input type="password" name="p"></form></body></html>');
    res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const port = (site.address() as net.AddressInfo).port;
  const { chromium } = await import('playwright-core');
  // www.portal.test resolves to the local site; nothing else is reachable.
  const browser = await chromium.launch({ executablePath: found!.path, headless: true, args: ['--host-resolver-rules=MAP www.portal.test 127.0.0.1, MAP * ~NOTFOUND', ...QUIET] });
  const w = world('berlin-analyst', { now: new Date().toISOString() });
  try {
    const p = fixturePortal();
    const script = pageScript(p, { settleMs: 300 });
    const page = await browser.newPage();
    const at = (path: string) => `http://www.portal.test:${port}${path}`;
    const run = async (path: string): Promise<any> => { await page.goto(at(path), { waitUntil: 'load' }); return page.evaluate(script); };

    const a = await run('/jobs/data-analyst-jobs-in-bangalore?days=7');
    assert.deepEqual(a.signals, { sign_in_wall: false, challenge: false, empty: false });
    // The page's own API answer (fetched again), then the JSON-LD's two (their links repeat them: counted once).
    assert.deepEqual(a.jobs.map((j: any) => [j.title, j.company]), [['Product Analyst', 'Opal Mobility'], ['Data Analyst', 'Ember Logistics'], ['BI Analyst', 'Saffron Retail']]);
    assert.equal(a.jobs[0].url, `http://www.portal.test:${port}/job/Product-Analyst-Opal-Mobility-Zz123456`);
    // Its location already says Remote: the answer leaves `workplace` out (ingest reads it from the location).
    assert.equal(a.jobs[2].location, 'Remote');
    assert.equal(a.jobs[2].workplace, undefined);

    const b = await run('/jobs/remote-analytics-jobs');
    assert.deepEqual(b.jobs.map((j: any) => ({ title: j.title, company: j.company, location: j.location, posted_at: j.posted_at })), [
      { title: 'Analytics Engineer', company: 'Juniper Data', location: 'Remote', posted_at: '2 days ago' },
      { title: 'Senior & Lead Data Analyst', company: 'Cobalt Freight', location: 'Pune, India', posted_at: 'today' },
    ]);
    assert.ok(JSON.stringify(b).length < 8000);

    assert.deepEqual((await run('/challenge')).signals, { sign_in_wall: false, challenge: true, empty: true });
    assert.deepEqual((await run('/login?next=jobs')).signals, { sign_in_wall: true, challenge: false, empty: true });

    // The answer, as Claude writes it to a file, through ingest: stored as portal:fixture.
    updatePortal(w.jobsHome, p.id, () => ({ connected: true }));
    const r = ingestPage(w.ctx, p, JSON.parse(JSON.stringify(b)), { pageUrl: at('/jobs/remote-analytics-jobs') });
    assert.equal(r.stopped, undefined);
    assert.equal(r.stored, 2);
  } finally { await browser.close(); site.close(); }
});

test('pane script, job cards in a real page: paragraphs with the id on the card (LinkedIn\'s shape) and job records in the page\'s own data (Naukri signed in)', { skip: found ? false : 'no Chromium-based browser on this machine', timeout: 90_000 }, async () => {
  const lines = `<html><body>
    <div role="button" componentkey="job-card-component-ref-Zz100001"><p>Selected, Data Analyst<br>Data Analyst</p><p>Ember Logistics</p><p>Bengaluru (Remote)</p><p>Posted 2 days ago<br>2 days ago</p></div>
    <div role="button" componentkey="job-card-component-ref-not-an-id"><p>Sneaky</p><p>Elsewhere</p></div>
    <div role="button" componentkey="job-card-component-ref-Zz100002"><p>BI Analyst</p><p>Saffron Retail</p><p>Pune</p></div>
  </body></html>`;
  // A component framework keeps each card's record on the element (React's fiber); the page script sets it like one.
  const records = `<html><body><div id="list"><div class="card">one</div><div class="card">two</div></div><script>
    const recs = [{ jdURL: '/job/Insights-Analyst-Opal-Mobility-Zz100003', title: 'Insights Analyst', companyName: 'Opal Mobility', placeholders: [{ type: 'location', label: 'Remote' }], createdDate: 1795000000000 },
                  { jdURL: 'https://elsewhere.test/job/x-Zz100004', title: 'Off site', companyName: 'Nope' }];
    document.querySelectorAll('.card').forEach((el, i) => { el['__reactFiber$test'] = { memoizedProps: {}, return: { memoizedProps: { jobData: recs[i] } } }; });
  </script></body></html>`;
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url?.startsWith('/records') ? records : lines); });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const port = (site.address() as net.AddressInfo).port;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: found!.path, headless: true, args: ['--host-resolver-rules=MAP www.portal.test 127.0.0.1, MAP * ~NOTFOUND', ...QUIET] });
  try {
    const p = fixturePortal({ json: [], cards: [
      { item: 'div[role=button][componentkey^="job-card-component-ref-"]', id_attr: 'componentkey', id_pattern: '^job-card-component-ref-(Zz\\d{6})$', url_template: `http://www.portal.test:${port}/job/Card-{id}`, lines: { selector: 'p', title: 0, company: 1, location: 2 } },
      { item: '#list .card', react: 'jobData', fields: { url: 'jdURL', title: 'title', company: 'companyName', location: 'placeholders[type=location].label', posted_at: 'createdDate' } },
    ] });
    const page = await browser.newPage();
    const run = async (path: string): Promise<any> => { await page.goto(`http://www.portal.test:${port}${path}`, { waitUntil: 'load' }); return page.evaluate(pageScript(p, { settleMs: 200 })); };
    const a = await run('/search');
    assert.deepEqual(a.jobs.map((j: any) => [j.url, j.title, j.company, j.location, j.posted_at ?? null, j.workplace ?? null]), [
      [`http://www.portal.test:${port}/job/Card-Zz100001`, 'Data Analyst', 'Ember Logistics', 'Bengaluru (Remote)', '2 days ago', null],
      [`http://www.portal.test:${port}/job/Card-Zz100002`, 'BI Analyst', 'Saffron Retail', 'Pune', null, null],
    ]);
    const b = await run('/records');
    assert.deepEqual(b.jobs.map((j: any) => [j.url, j.title, j.company, j.location, j.posted_at]), [
      [`http://www.portal.test:${port}/job/Insights-Analyst-Opal-Mobility-Zz100003`, 'Insights Analyst', 'Opal Mobility', 'Remote', '1795000000000'],
    ], 'a record pointing off the portal is dropped');
  } finally { await browser.close(); site.close(); }
});
