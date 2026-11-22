// runFeeds end to end on fixtures: new → 304 → changed → closed, roles written for the pipeline, robots skip,
// Workday details only for new jobs on the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../../src/jobs/db.ts';
import { runFeeds } from '../../../src/jobs/feeds/run.ts';
import { postingId, postingToRole, readPosting } from '../../../src/jobs/feeds/store.ts';
import type { Board } from '../../../src/jobs/feeds/types.ts';
import { fakeClock, fakeFetch, fixture } from './helpers.ts';

const GH = 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true';
const ROBOTS_OK = { body: 'User-agent: *\nDisallow: /embed/\n' };

test('greenhouse board: new, then 304, then changed and closed; roles carry remote scope', async () => {
  const db = openDb(':memory:');
  const c = fakeClock();
  let body = fixture('greenhouse-airbnb.json');
  let etag = 'W/"v1"';
  const { fetch, calls } = fakeFetch({
    'https://boards-api.greenhouse.io/robots.txt': ROBOTS_OK,
    [GH]: (req) => (req.headers?.['if-none-match'] === etag ? { status: 304, headers: { etag } } : { body, headers: { etag } }),
  });
  const boards: Board[] = [{ ats: 'greenhouse', slug: 'airbnb' }];

  const [s1] = await runFeeds(boards, { db, fetch, clock: c.clock });
  assert.deepEqual({ ...s1, errors: s1.errors.length }, { board: 'greenhouse:airbnb', ats: 'greenhouse', status: 'ok', fetched: 3, new: 3, changed: 0, notModified: false, closed: 0, errors: 0 });
  const roles = db.prepare('select r.*, c.name company from roles r join companies c on c.id = r.company_id order by r.url').all() as any[];
  assert.equal(roles.length, 3);
  const remote = roles.find((r) => r.url.includes('8394382'));
  assert.equal(remote.location, 'Remote (United States) · Remote - USA; United States');
  assert.equal(remote.source, 'board');
  assert.equal(remote.source_key, 'ats:greenhouse:airbnb');
  assert.equal(remote.company, 'Airbnb');
  assert.ok(remote.description.length > 3000);
  assert.equal((db.prepare(`select count(*) n from events where kind = 'added'`).get() as any).n, 3);
  const stored = readPosting(db, postingId({ ats: 'greenhouse', board: 'greenhouse:airbnb', atsJobId: '8394382' }))!;
  assert.deepEqual(stored.remoteCountries, ['US']);
  assert.equal(stored.workplace, 'remote');

  // second run: the ETag goes out, the board answers 304
  c.advance(86_400_000);
  const [s2] = await runFeeds(boards, { db, fetch, clock: c.clock });
  assert.equal(s2.status, "not_modified", s2.errors.join(";"));
  assert.equal(s2.notModified, true);
  assert.equal(s2.new + s2.changed, 0);
  assert.equal(calls.filter((x) => x.url === GH).at(-1)!.headers!['if-none-match'], 'W/"v1"');
  assert.equal(calls.filter((x) => x.url.endsWith('/robots.txt')).length, 1, 'robots.txt once a week');

  // third run: one job changed, one gone
  const data = JSON.parse(body);
  data.jobs[0].title = 'Senior Engineering Manager, External Search';
  data.jobs.pop();
  body = JSON.stringify(data);
  etag = 'W/"v2"';
  c.advance(86_400_000);
  const [s3] = await runFeeds(boards, { db, fetch, clock: c.clock });
  assert.deepEqual([s3.fetched, s3.new, s3.changed, s3.closed], [2, 0, 1, 1]);
  assert.equal((db.prepare('select count(*) n from postings_ats where closed_at is not null').get() as any).n, 1);
  assert.ok((db.prepare('select 1 from roles where title = ?').get('Senior Engineering Manager, External Search')));
  assert.equal((db.prepare('select count(*) n from roles').get() as any).n, 3, 'the role is updated, not duplicated');
  assert.equal((db.prepare(`select etag from feed_boards where key = 'greenhouse:airbnb'`).get() as any).etag, 'W/"v2"');
});

test('roles: false keeps the pipeline untouched; a board robots.txt disallows is skipped', async () => {
  const db = openDb(':memory:');
  const { fetch, calls } = fakeFetch({
    'https://boards-api.greenhouse.io/robots.txt': ROBOTS_OK,
    [GH]: { body: fixture('greenhouse-airbnb.json') },
    'https://career.teamtailor.com/robots.txt': { body: 'User-agent: *\nDisallow: /jobs.rss\n' },
    'https://bunq.recruitee.com/robots.txt': { body: 'User-agent: crewdeck\nDisallow: /api/\n' },
  });
  const stats = await runFeeds([{ ats: 'greenhouse', slug: 'airbnb' }, { ats: 'teamtailor', slug: 'career' }, { ats: 'recruitee', slug: 'bunq' }], { db, fetch, clock: fakeClock().clock, roles: false });
  const by = Object.fromEntries(stats.map((s) => [s.ats, s]));
  assert.equal(by.greenhouse.new, 3);
  assert.equal((db.prepare('select count(*) n from roles').get() as any).n, 0);
  for (const a of ['teamtailor', 'recruitee']) {
    assert.equal(by[a].status, "skipped", by[a].errors.join(";"));
    assert.match(by[a].errors[0], /disallows/);
  }
  assert.ok(!calls.some((x) => x.url.includes('jobs.rss') || x.url.includes('/api/offers')), 'nothing fetched past robots');
});

test('a failing board is reported, the others still run', async () => {
  const db = openDb(':memory:');
  const { fetch } = fakeFetch({ [GH]: { body: fixture('greenhouse-airbnb.json') }, 'https://api.lever.co/v0/postings/gone': { status: 404 } });
  const stats = await runFeeds([{ ats: 'lever', slug: 'gone' }, { ats: 'greenhouse', slug: 'airbnb' }, { ats: 'nope' as any, slug: 'x' }], { db, fetch, robots: false, clock: fakeClock().clock });
  const by = Object.fromEntries(stats.map((s) => [s.ats, s]));
  assert.equal(by.lever.status, 'failed');
  assert.match(by.lever.errors[0], /404/);
  assert.equal(by.greenhouse.new, 3);
  assert.equal(by.nope.status, 'failed');
});

test('Workday through the runner: the second run fetches details only for new jobs', async () => {
  const db = openDb(':memory:');
  const base = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite';
  const page1 = JSON.parse(fixture('workday-nvidia-list.json'));
  const detail = JSON.parse(fixture('workday-nvidia-detail.json'));
  let list = page1.jobPostings.slice(0, 5);
  const routes: Record<string, any> = {
    [`${base}/jobs`]: (req: any) => ({ body: JSON.stringify({ total: list.length, jobPostings: JSON.parse(req.body).offset === 0 ? list : [] }) }),
  };
  for (const j of page1.jobPostings) routes[`${base}${j.externalPath}`] = { body: JSON.stringify({ ...detail, jobPostingInfo: { ...detail.jobPostingInfo, title: j.title } }) };
  const { fetch, calls } = fakeFetch(routes);
  const b: Board = { ats: 'workday', slug: 'nvidia', host: 'wd5', site: 'NVIDIAExternalCareerSite', company: 'NVIDIA' };
  const c = fakeClock();
  const [s1] = await runFeeds([b], { db, fetch, robots: false, clock: c.clock });
  assert.deepEqual([s1.fetched, s1.new], [5, 5]);
  const details1 = calls.filter((x) => x.method !== 'POST').length;
  assert.equal(details1, 5);
  list = page1.jobPostings.slice(0, 7);
  c.advance(7 * 86_400_000);
  const [s2] = await runFeeds([b], { db, fetch, robots: false, clock: c.clock });
  assert.equal(calls.filter((x) => x.method !== 'POST').length - details1, 2, 'two details for two new jobs');
  assert.deepEqual([s2.new, s2.changed, s2.closed], [2, 0, 0]);
  list = page1.jobPostings.slice(1, 7);
  c.advance(7 * 86_400_000);
  const [s3] = await runFeeds([b], { db, fetch, robots: false, clock: c.clock });
  assert.equal(s3.closed, 1, 'a job no longer listed is closed');
});

test('postingToRole: pay text, remote scope names, apply link', () => {
  const r = postingToRole({ source: 'ats', ats: 'ashby', board: 'ashby:openai', atsJobId: '1', company: 'OpenAI', title: 'TPM', url: 'https://jobs.ashbyhq.com/openai/1',
    applyUrl: 'https://jobs.ashbyhq.com/openai/1/application', descriptionText: 'x', locations: ['US - Remote'], workplace: 'remote', remoteCountries: ['US', 'CA'], countries: ['US'],
    employmentType: 'full_time', pay: { min: 207000, max: 285000, currency: 'USD', period: 'year' }, postedAt: '2026-11-05T02:20:02.702Z', updatedAt: '', raw: {} });
  assert.equal(r.location, 'Remote (United States, Canada) · US - Remote');
  assert.equal(r.pay_text, 'USD 207,000–285,000 a year');
  assert.equal(r.apply_url, 'https://jobs.ashbyhq.com/openai/1/application');
  assert.equal(r.employment_type, 'full_time');
  assert.equal(postingToRole({ ...({} as any), workplace: 'remote', remoteCountries: ['*'], locations: ['Anywhere'], title: 't', company: 'c', url: 'u', descriptionText: '', board: 'x:y', employmentType: '' }).location, 'Remote (anywhere) · Anywhere');
});
