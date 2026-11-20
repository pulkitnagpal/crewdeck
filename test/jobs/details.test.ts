// Full descriptions (jobs v2 P1b): which roles need one, Himalayas' posting API instead of its 403 page, schema.org
// JobPosting with its structured fields, the 4,000-character cut re-read, retries, host backoff and once a day. Against
// recorded fixtures (test/fixtures/jobs/details: the shapes seen on 2026-11-20, fictional content) on a local server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESC_CAP, FULL_MIN, OLD_CAP, fetchDetails, himalayasPath, needsDescription, readHimalayasJob } from '../../src/jobs/pipeline/details.ts';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate } from '../../src/jobs/migrations.ts';
import { role, world } from './helpers.ts';
import { pages, serve, testHosts } from './net-helpers.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'jobs', 'details');
const fixture = (f: string) => readFileSync(join(FIX, f), 'utf8');
const HM_URL = 'https://himalayas.app/companies/example-labs/jobs/data-analyst-4000000001?utm_source=api';
const quick = { sleep: async () => {}, paceMs: 0, backoffMs: 1 };
const row = (w: ReturnType<typeof world>, id: string) => ({ ...(w.ctx.db.prepare('select * from roles where id=?').get(id) as any) });

test('which descriptions need reading: missing, under 200 characters, or cut at exactly 4,000', () => {
  assert.equal(needsDescription(''), true);
  assert.equal(needsDescription(null), true);
  assert.equal(needsDescription('<p>Short.</p>'), true);
  assert.equal(needsDescription('x'.repeat(FULL_MIN)), false);
  assert.equal(needsDescription('x'.repeat(OLD_CAP)), true, 'the providers\' cut');
  assert.equal(needsDescription('x'.repeat(OLD_CAP + 1)), false);
  assert.equal(DESC_CAP, 60_000);
});

test('Himalayas: posting links map to its public posting API; anything else is refused', () => {
  assert.equal(himalayasPath(HM_URL), 'companies/example-labs/jobs/data-analyst-4000000001');
  assert.equal(himalayasPath('https://himalayas.app/companies/example-labs/jobs/data-analyst-4000000001/'), 'companies/example-labs/jobs/data-analyst-4000000001');
  for (const bad of ['http://himalayas.app/companies/a/jobs/b', 'https://evil.example/companies/a/jobs/b', 'https://himalayas.app/companies/a/jobs/b?next=x',
    'https://himalayas.app/companies/../jobs/b', 'https://himalayas.app:8443/companies/a/jobs/b', 'https://himalayas.app/jobs/b']) assert.equal(himalayasPath(bad), null, bad);
  const p = readHimalayasJob(JSON.parse(fixture('himalayas-posting.json')))!;
  assert.equal(p.workplace, 'remote');
  assert.deepEqual(p.remote_countries, ['Germany', 'Austria']);
  assert.equal(p.location, 'Remote (Germany, Austria)');
  assert.equal(p.employment_type, 'Full Time');
  assert.equal(p.pay_text, 'EUR 55000–70000 per year');
  assert.equal(p.valid_through, new Date(1800352381 * 1000).toISOString());
  assert.ok(!/<[a-z]/i.test(p.description!) && p.description!.length > 4000, 'plain text, full length');
  assert.deepEqual(readHimalayasJob({ job: { title: 'x', locationRestrictions: [] , description: '<p>x</p>' } })?.remote_countries, ['Worldwide']);
  assert.equal(readHimalayasJob({ jobs: [] }), null);
});

test('details: Himalayas through its API (never the 403 page), a 4,000-character cut re-read from JSON-LD with its structured fields, a 410 closed', async () => {
  let hm = 0;
  const srv = await serve((req, res) => {
    const u = req.url ?? '';
    if (u.startsWith('/jobs/api/companies/example-labs/jobs/data-analyst-4000000001')) { hm++; res.writeHead(200, { 'content-type': 'application/json' }).end(fixture('himalayas-posting.json')); return; }
    if (u.startsWith('/jobs/api/companies/example-labs/jobs/gone-4000000002')) { res.writeHead(410, { 'content-type': 'application/json' }).end(fixture('himalayas-expired.json')); return; }
    if (u === '/posting/analytics-engineer') { res.writeHead(200, { 'content-type': 'text/html' }).end(fixture('jsonld-posting.html')); return; }
    res.writeHead(404).end();
  });
  try {
    const w = world('berlin-analyst');
    const net = { testHosts: testHosts('hm.example.test', 'jobs.example.test') };
    const himalayasApi = `${srv.base('hm.example.test')}/jobs/api`;
    const a = role(w.ctx, { company: 'Example Labs', title: 'Senior Data Analyst', url: HM_URL, location: 'Germany, Austria' });
    const gone = role(w.ctx, { company: 'Example Gone', title: 'Senior Data Analyst', url: 'https://himalayas.app/companies/example-labs/jobs/gone-4000000002' });
    const cut = role(w.ctx, { company: 'Sample Freight GmbH', title: 'Senior Data Analyst', url: `${srv.base('jobs.example.test')}/posting/analytics-engineer`, description: 'y'.repeat(OLD_CAP), location: '' });
    const r = await fetchDetails(w.ctx, { net, himalayasApi, ...quick });
    assert.deepEqual(r, { tried: 3, found: 2, closed: 1, errors: 0, retried: 0, deferred: 0, backed_off: [] });
    assert.equal(hm, 1);
    const ra = row(w, a);
    assert.ok(ra.description.length > OLD_CAP && /dbt and Looker/.test(ra.description));
    assert.deepEqual([ra.workplace, JSON.parse(ra.remote_countries), ra.employment_type, ra.pay_text, ra.detail_status, ra.location],
      ['remote', ['Germany', 'Austria'], 'Full Time', 'EUR 55000–70000 per year', 'ok', 'Germany, Austria']);
    assert.equal(row(w, gone).status, 'expired');
    const rc = row(w, cut);
    assert.ok(rc.description.length > OLD_CAP && rc.description.length <= DESC_CAP && /routing team/.test(rc.description), 'the full text replaces the cut one');
    assert.deepEqual([rc.workplace, JSON.parse(rc.remote_countries), rc.employment_type, rc.valid_through, rc.pay_text, rc.location],
      ['remote', ['Germany', 'Netherlands'], 'FULL_TIME', '2026-12-31T23:59:59.000Z', 'EUR 65000–80000 per year', 'Remote (Germany, Netherlands)']);
    // Read once: a full description is never fetched again.
    assert.equal((await fetchDetails(w.ctx, { net, himalayasApi, ...quick })).tried, 0);
  } finally { await srv.close(); }
});

test('details: a host answering 403 or 429 is left alone for the rest of the run; a 503 that recovers is retried; the rest wait for the next run', async () => {
  let flaky = 0;
  const srv = await serve((req, res) => {
    const u = req.url ?? '';
    if (u === '/x') { res.writeHead(403).end('no'); return; }
    if (u === '/flaky') { flaky++; if (flaky < 2) { res.writeHead(503).end('busy'); return; } res.writeHead(200, { 'content-type': 'text/html' }).end(fixture('jsonld-posting.html')); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end(fixture('jsonld-posting.html'));
  });
  try {
    const w = world('berlin-analyst');
    const net = { testHosts: testHosts('blocked.example.test', 'ok.example.test') };
    const x = role(w.ctx, { company: 'X Example', title: 'Senior Data Analyst', url: `${srv.base('blocked.example.test')}/x` });
    const y = role(w.ctx, { company: 'Y Example', title: 'Data Analyst', url: `${srv.base('blocked.example.test')}/y` });
    const f = role(w.ctx, { company: 'F Example', title: 'Senior Data Analyst', url: `${srv.base('ok.example.test')}/flaky` });
    const r = await fetchDetails(w.ctx, { net, ...quick, concurrency: 1 });
    assert.deepEqual(r, { tried: 2, found: 1, closed: 0, errors: 1, retried: 1, deferred: 1, backed_off: ['blocked.example.test'] });
    assert.ok(!srv.hits.includes('/y'), 'nothing more is asked of a host that said no');
    assert.deepEqual([row(w, x).detail_status, row(w, y).detail_status, row(w, f).detail_status], ['http_403', null, 'ok']);
    // The next run (same day): the 403 role waits a day; the deferred one is read.
    const again = await fetchDetails(w.ctx, { net, ...quick });
    assert.deepEqual([again.tried, again.found], [1, 1]);
    assert.ok(srv.hits.includes('/y'));
  } finally { await srv.close(); }
});

test('details: LinkedIn roles are never read here (its own paced client reads them); a page without a fuller text keeps what was there', async () => {
  const srv = await serve(pages({ '/short': '<html><head><meta name="description" content="Short."></head></html>' }));
  try {
    const w = world('berlin-analyst');
    role(w.ctx, { company: 'L Example', title: 'Senior Data Analyst', url: 'https://www.linkedin.com/jobs/view/4000000099' });
    const s = role(w.ctx, { company: 'S Example', title: 'Senior Data Analyst', url: `${srv.base('jobs.example.test')}/short`, description: 'Analyst role in Berlin, SQL.' });
    const r = await fetchDetails(w.ctx, { net: { testHosts: testHosts('jobs.example.test') }, ...quick });
    assert.deepEqual([r.tried, r.found], [1, 0]);
    assert.deepEqual([row(w, s).description, row(w, s).detail_status], ['Analyst role in Berlin, SQL.', 'none']);
  } finally { await srv.close(); }
});

test('DB migration v5: a v4 tracker gains workplace, remote_countries, valid_through and the detail status, keeping its rows', () => {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS.filter((x) => x.version <= 4)) db.exec(m.sql);
  db.exec("insert into companies(name, key) values ('Example Co', 'example co')");
  db.exec("insert into roles(id, company_id, title, url, source, first_seen, updated_at) values ('aaaaaaaaaaaa', 1, 'Data Analyst', 'https://jobs.example.com/1', 'board', 't', 't')");
  assert.equal(migrate(db), 5);
  const cols = (db.prepare('PRAGMA table_info(roles)').all() as any[]).map((c) => c.name);
  for (const c of ['workplace', 'remote_countries', 'valid_through', 'detail_status', 'detail_at']) assert.ok(cols.includes(c), c);
  assert.equal((db.prepare('select title from roles').get() as any).title, 'Data Analyst');
  db.close();
});
