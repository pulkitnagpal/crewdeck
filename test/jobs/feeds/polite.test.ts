// Politeness (fake clock: no real waiting) and robots.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_USER_AGENT, guardFeedFetch, politeFetch } from '../../../src/jobs/feeds/http.ts';
import { Robots, parseRobots, robotsAllows } from '../../../src/jobs/feeds/robots.ts';
import { NetError } from '../../../src/jobs/net/netguard.ts';
import type { FeedFetch } from '../../../src/jobs/feeds/types.ts';
import { fakeClock, fakeFetch } from './helpers.ts';
import { serve, testHosts } from '../net-helpers.ts';

test('one host: requests are serialised ≥ 1 s apart plus jitter; other hosts are not held up', async () => {
  const c = fakeClock();
  const starts: [string, number][] = [];
  const inner: FeedFetch = async (req) => { starts.push([new URL(req.url).host, c.now]); return { status: 200, url: req.url, headers: {}, body: 'ok' }; };
  const f = politeFetch(inner, { clock: c.clock, random: () => 0.5, jitterMs: 200 });
  await Promise.all([f({ url: 'https://a.example/1' }), f({ url: 'https://a.example/2' }), f({ url: 'https://b.example/1' }), f({ url: 'https://a.example/3' })]);
  const a = starts.filter(([h]) => h === 'a.example').map(([, t]) => t);
  assert.equal(a.length, 3);
  for (let i = 1; i < a.length; i++) assert.equal(a[i] - a[i - 1], 1100, 'gap = 1000 ms + jitter (0.5 × 200)');
  const b = starts.find(([h]) => h === 'b.example')![1];
  assert.equal(b, a[0], 'b.example started at once');
});

test('5xx and timeouts are retried twice with a growing pause; then the last answer is returned', async () => {
  const c = fakeClock();
  let n = 0;
  const f = politeFetch(async (req) => { n++; return { status: 503, url: req.url, headers: {}, body: '' }; }, { clock: c.clock, random: () => 0 });
  const r = await f({ url: 'https://a.example/x' });
  assert.equal(r.status, 503);
  assert.equal(n, 3, '1 try + 2 retries');
  let m = 0;
  const g = politeFetch(async (req) => { m++; if (m < 3) throw new NetError('timeout', 'slow'); return { status: 200, url: req.url, headers: {}, body: 'ok' }; }, { clock: c.clock, random: () => 0 });
  assert.equal((await g({ url: 'https://a.example/y' })).body, 'ok');
  // a refused address is never retried
  let k = 0;
  const h = politeFetch(async () => { k++; throw new NetError('blocked', 'private'); }, { clock: c.clock });
  await assert.rejects(h({ url: 'https://a.example/z' }), /private/);
  assert.equal(k, 1);
});

test('429 backs off the whole host (Retry-After, else 30 s doubling)', async () => {
  const c = fakeClock();
  const starts: number[] = [];
  let n = 0;
  const f = politeFetch(async (req) => {
    starts.push(c.now); n++;
    if (n === 1) return { status: 429, url: req.url, headers: { 'retry-after': '120' }, body: '' };
    if (n === 2) return { status: 429, url: req.url, headers: {}, body: '' };
    return { status: 200, url: req.url, headers: {}, body: 'ok' };
  }, { clock: c.clock, random: () => 0 });
  const r = await f({ url: 'https://a.example/jobs' });
  assert.equal(r.status, 200);
  assert.equal(starts[1] - starts[0], 120_000, 'Retry-After honoured');
  assert.equal(starts[2] - starts[1], 60_000, 'second strike: 30 s × 2');
  const t = c.now;
  await f({ url: 'https://a.example/next' });
  assert.equal(starts[3] - t, 1000, 'after a success the normal pace resumes');
});

test('the real guarded fetch sends the honest User-Agent and stays behind netguard', async () => {
  const s = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/json', etag: '"e1"' }).end(JSON.stringify({ ua: req.headers['user-agent'], inm: req.headers['if-none-match'] ?? null })); });
  try {
    const f = guardFeedFetch({ testHosts: testHosts('boards.example') });
    const r = await f({ url: `${s.base('boards.example')}/feed`, headers: { 'if-none-match': '"e0"' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ua: FEED_USER_AGENT, inm: '"e0"' });
    assert.equal(r.headers.etag, '"e1"');
    await assert.rejects(guardFeedFetch()({ url: `${s.base()}/feed` }), /private or local/);
  } finally { await s.close(); }
});

test('robots.txt: our agent and * are both honoured; longest match wins; empty Disallow allows', () => {
  const r = parseRobots(`# comment
User-agent: *
Disallow: /embed/
Allow: /embed/public$

User-agent: AhrefsBot
Disallow: /

User-agent: Crewdeck
Disallow: /private
`);
  assert.equal(robotsAllows(r, '/v1/boards/x/jobs'), true);
  assert.equal(robotsAllows(r, '/embed/job_board'), false);
  assert.equal(robotsAllows(r, '/embed/public'), true);
  assert.equal(robotsAllows(r, '/private/feed'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\n'), '/jobs.rss'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.rss$\n'), '/jobs.rss'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.rss$\n'), '/jobs.rss?x=1'), true);
  // a group for someone else only
  assert.equal(robotsAllows(parseRobots('User-agent: LinkedInBot\nAllow: /\nUser-agent: *\nDisallow: /\n'), '/api/jobs'), false);
});

test('robots.txt is fetched once per host per week; 4xx = allowed; 5xx = skip for now', async () => {
  let now = Date.parse('2026-11-20T08:00:00Z');
  const { fetch, calls } = fakeFetch({
    'https://a.example/robots.txt': { body: 'User-agent: *\nDisallow: /private\n' },
    'https://b.example/robots.txt': { status: 401, body: 'Unauthorized' },
    'https://c.example/robots.txt': { status: 503 },
  });
  const store = new Map<string, any>();
  const robots = new Robots(fetch, { now: () => now, store: { get: (h) => store.get(h), set: (e) => store.set(e.host, e) } });
  assert.deepEqual(await robots.check('https://a.example/jobs'), { ok: true });
  assert.equal((await robots.check('https://a.example/private/x')).ok, false);
  assert.equal((await robots.check('https://b.example/api')).ok, true);
  assert.match((await robots.check('https://c.example/api')).reason!, /could not be read/);
  assert.equal(calls.length, 3);
  now += 6 * 86_400_000;
  // a new instance (next run) reads the store, not the network
  const again = new Robots(fetch, { now: () => now, store: { get: (h) => store.get(h), set: (e) => store.set(e.host, e) } });
  await again.check('https://a.example/jobs');
  assert.equal(calls.filter((c) => c.url === 'https://a.example/robots.txt').length, 1, 'cached for a week');
  assert.equal(calls.filter((c) => c.url === 'https://c.example/robots.txt').length, 1);
  await again.check('https://c.example/api');
  assert.equal(calls.filter((c) => c.url === 'https://c.example/robots.txt').length, 2, 'a failed robots.txt is retried after an hour');
  now += 2 * 86_400_000;
  await again.check('https://a.example/jobs');
  assert.equal(calls.filter((c) => c.url === 'https://a.example/robots.txt').length, 2, 'refreshed after a week');
});
