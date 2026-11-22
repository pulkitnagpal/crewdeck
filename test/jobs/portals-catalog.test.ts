// ADR-0008: the portals catalog (shipped file valid, validation catches mistakes), the guard proxy's portal host list,
// and the searches built for a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { allowedHosts, delayMs, loadPortals, parsePortals, portalIssues } from '../../src/jobs/portals/catalog.ts';
import { hostAllowed } from '../../src/jobs/net/netguard.ts';
import { startGuardProxy } from '../../src/jobs/net/guard-proxy.ts';
import { portalQueries, portalWheres, queryTitles, recencyValue, searchUrl, slug } from '../../src/jobs/portals/queries.ts';
import { FIXTURE_YAML, INDIA_PROFILE, fixturePortal } from './portal-helpers.ts';

test('the shipped catalog loads with no problems and has the portals the ADR names', () => {
  const cat = loadPortals();
  for (const id of ['linkedin', 'naukri', 'instahyre', 'wellfound', 'cutshort', 'weekday', 'foundit', 'hirist', 'indeed', 'glassdoor']) assert.ok(cat.byId.has(id), id);
  for (const p of cat.portals) {
    assert.deepEqual(portalIssues(p), [], p.id);
    assert.ok(p.limits.searches_per_run <= 10 && p.limits.pages_per_day <= 100, p.id);
    if (!p.verified) assert.ok(p.notes && p.notes.length > 20, `${p.id}: an unverified portal says what wasn't checked`);
  }
  // The ADR's LinkedIn limits: 3 searches × 1 page, 12–20 s apart, 25 pages a day, 12 h between scans.
  const li = cat.byId.get('linkedin')!;
  assert.deepEqual(li.limits, { searches_per_run: 3, pages_per_search: 1, delay_ms: [12000, 20000], min_hours: 12, pages_per_day: 25 });
  assert.equal(li.signed_in.cookie, 'li_at');
  // Indeed covers three countries through one parameterised entry.
  assert.deepEqual(Object.keys(cat.byId.get('indeed')!.search.country_hosts!).sort(), ['gb', 'in', 'us']);
});

test('validation names each mistake: hosts, URLs off the portal, unknown placeholders, limits, missing notes', () => {
  const bad = FIXTURE_YAML
    .replace('hosts: [www.portal.test, portal.test]', 'hosts: [www.portal.test, "not a host"]')
    .replace('login_url: https://www.portal.test/login', 'login_url: https://evil.example.com/login')
    .replace('days={recency}&wfh', 'days={recency}&who={who}&wfh')
    .replace("delay_ms: 10000, min_hours: 6, pages_per_day: 30 }\n    risk", "delay_ms: 500, min_hours: 0, pages_per_day: 500 }\n    risk")
    .replace('verified: true', 'verified: false')
    .replace("signed_in: { cookie: fx_session, url_pattern: '^/dashboard' }", 'signed_in: {}');
  const { problems } = parsePortals(bad);
  for (const re of [/host not a host/, /login_url is not on the portal's hosts/, /unknown placeholder \{who\}/, /delay_ms is at least 3000/, /min_hours/, /pages_per_day/, /needs a note/, /signed_in needs/]) {
    assert.ok(problems.some((p) => re.test(p)), `${re} in ${problems.join(' | ')}`);
  }
  assert.deepEqual(parsePortals(FIXTURE_YAML).problems, []);
  assert.match(parsePortals(`${FIXTURE_YAML}\n${FIXTURE_YAML.split('portals:')[1].replace(/^/, '')}`.replace(/portals:\n([\s\S]*)portals:/, 'portals:\n$1')).problems.join(), /|/);
});

test('a portal listed twice is a problem', () => {
  const twice = FIXTURE_YAML + FIXTURE_YAML.slice(FIXTURE_YAML.indexOf('  - id: fixture'));
  assert.ok(parsePortals(twice).problems.some((p) => /listed twice/.test(p)));
});

test('delays: delay_ms jittered ±40%, or uniform in [min, max]', () => {
  assert.equal(delayMs({ delay_ms: 10000 }, () => 0), 6000);
  assert.equal(delayMs({ delay_ms: 10000 }, () => 1), 14000);
  assert.equal(delayMs({ delay_ms: [12000, 20000] }, () => 0.5), 16000);
});

test('the guard admits only a portal\'s hosts (and subdomains); LinkedIn only when listed', () => {
  const p = fixturePortal();
  const list = allowedHosts(p);
  assert.ok(hostAllowed('www.portal.test', list) && hostAllowed('api.portal.test', list) && hostAllowed('cdn.portal-static.test', list));
  assert.ok(!hostAllowed('evilportal.test', list) && !hostAllowed('portal.test.evil.com', list) && !hostAllowed('', list));
  assert.ok(allowedHosts(p, { signIn: true }).length > list.length, 'the sign-in window also gets its sign-in helpers');
});

test('the guard proxy refuses every host outside the portal list, and passes a listed one to its checked address', async () => {
  const site = http.createServer((_q, r) => r.end('ok'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const port = (site.address() as net.AddressInfo).port;
  const proxy = await startGuardProxy({ net: { testHosts: { 'www.portal.test': '127.0.0.1', 'other.test': '127.0.0.1' } }, allowHosts: ['portal.test'] });
  const connect = (host: string) => new Promise<string>((ok) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    s.once('data', (d) => { ok(String(d).split('\r\n')[0]); s.destroy(); });
  });
  try {
    assert.match(await connect('www.portal.test'), / 200 /);
    assert.match(await connect('other.test'), / 403 /);
    assert.match(await connect('www.linkedin.com'), / 403 /);
    assert.ok(proxy.blocked.some((b) => b.host === 'other.test' && /portal's hosts/.test(b.reason)));
  } finally { await proxy.close(); site.close(); }
});

test('queries: first title + up to two variants per kind of job; first three titles without targets', () => {
  assert.deepEqual(queryTitles(INDIA_PROFILE), ['Data Analyst', 'BI Analyst', 'Analytics Engineer']);
  assert.deepEqual(queryTitles({ targets: [{ name: 'A', titles: ['Nurse', 'RN'] }, { name: 'B', titles: ['Midwife', 'nurse'] }], titles: [] }), ['Nurse', 'RN', 'Midwife']);
  assert.deepEqual(queryTitles({ targets: [], titles: ['a', 'b', 'c', 'd'] }), ['a', 'b', 'c']);
  assert.equal(slug('Data Analyst / BI'), 'data-analyst-bi');
  assert.equal(slug('Señor Développeur'), 'senor-developpeur');
});

test('queries: covered places and remote, along the diagonal, capped at searches_per_run, in the portal\'s URL format', () => {
  const p = fixturePortal();
  const q = portalQueries(INDIA_PROFILE, p);
  assert.equal(q.length, 3);
  assert.deepEqual(q.map((x) => x.url), [
    'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7',
    'https://www.portal.test/jobs/data-analyst-jobs?days=7&wfh=yes',
    'https://www.portal.test/jobs/bi-analyst-jobs-in-bangalore?days=7',
  ]);
  assert.deepEqual(q[1], { keywords: 'Data Analyst', titles: ['Data Analyst'], workplace: 'remote', country: 'in', url: q[1].url });
  // Deterministic.
  assert.deepEqual(portalQueries(INDIA_PROFILE, p), q);
  // A later page, and a portal that can't page.
  assert.equal(searchUrl(p, q[0], 1), 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7&page=2');
  assert.equal(searchUrl({ ...p, search: { ...p.search, page: undefined } }, q[0], 1), null);
});

test('queries: a portal covering none of the person\'s places gets no searches; recency picks the smallest ≥ 7 days', () => {
  const p = fixturePortal();
  assert.deepEqual(portalQueries({ ...INDIA_PROFILE, countries: ['de'], places: ['Berlin'] }, p), []);
  assert.deepEqual(portalWheres({ countries: [], workModes: ['onsite'], places: [] }, p), [{ workplace: 'any' }]);
  assert.deepEqual(portalWheres({ countries: [], workModes: ['remote'], places: [] }, p), [{ workplace: 'remote' }]);
  assert.equal(recencyValue(p), '7');
  assert.equal(recencyValue({ ...p, search: { ...p.search, recency: { 1: 'a', 3: 'b' } } }), 'b');
  assert.equal(recencyValue({ ...p, search: { ...p.search, recency: undefined } }), '');
});

test('queries on the shipped catalog: LinkedIn names the country for remote; Indeed picks its country host; Hirist has no place filter', () => {
  const cat = loadPortals();
  const li = portalQueries(INDIA_PROFILE, cat.byId.get('linkedin')!);
  assert.ok(li.some((q) => q.url === 'https://www.linkedin.com/jobs/search/?keywords=%22Data%20Analyst%22%20OR%20%22BI%20Analyst%22%20OR%20%22Analytics%20Engineer%22&location=India&f_TPR=r604800&f_WT=2'), li.map((q) => q.url).join('\n'));
  const indeed = portalQueries({ ...INDIA_PROFILE, countries: ['gb'], places: ['London'] }, cat.byId.get('indeed')!);
  assert.ok(indeed.length && indeed.every((q) => q.url.startsWith('https://uk.indeed.com/jobs?q=')), indeed.map((q) => q.url).join('\n'));
  assert.ok(portalQueries(INDIA_PROFILE, cat.byId.get('hirist')!).every((q) => /^https:\/\/www\.hirist\.tech\/k\/[a-z-]+-jobs$/.test(q.url)));
  // Indian-only portals stay out of a Berlin search.
  assert.deepEqual(portalQueries({ ...INDIA_PROFILE, countries: ['de'], places: ['Berlin'] }, cat.byId.get('naukri')!), []);
});
