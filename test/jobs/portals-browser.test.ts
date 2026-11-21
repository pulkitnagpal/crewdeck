// ADR-0008, optional: the real portal profile (the person's own Chromium, headless) scanning a local fixture site
// through the guard proxy: all three layers, and a host outside the portal's list refused. Skipped with no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { statSync } from 'node:fs';
import { findBrowser } from '../../src/jobs/browser.ts';
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
