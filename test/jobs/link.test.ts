// Paste a link (design §2.3 step 3): JobPosting JSON-LD and meta parsing, closed postings, the role added and picked
// for today with pickPasted's warnings, X refused, LinkedIn only when switched on (a local guest-API fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { link, readPostingPage } from '../../src/jobs/link.ts';
import { parsePay } from '../../src/jobs/pay.ts';
import { jobs, textFile, world } from './helpers.ts';
import { pages, serve, testHosts } from './net-helpers.ts';
import { DETAIL } from './linkedin-fixtures.ts';

const ld = (v: unknown) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;
const POSTING = {
  '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior Data Analyst', datePosted: '2026-11-15',
  hiringOrganization: { '@type': 'Organization', name: 'Example Mobility GmbH' },
  jobLocation: [{ '@type': 'Place', address: { addressLocality: 'Berlin', addressRegion: 'Berlin', addressCountry: { name: 'DE' } } }],
  description: '<p>Own our <b>Looker</b> dashboards &amp; models.</p><ul><li>SQL</li></ul>',
  baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', minValue: 60000, maxValue: 75000, unitText: 'YEAR' } },
  validThrough: '2026-12-31',
};
const AT = new Date('2026-11-19T10:00:00Z');

test('JSON-LD JobPosting is read in every common shape; meta tags are the fallback', () => {
  const p = readPostingPage(`<html><head>${ld(POSTING)}</head></html>`, AT);
  assert.deepEqual(p, { title: 'Senior Data Analyst', company: 'Example Mobility GmbH', location: 'Berlin, DE', description: 'Own our Looker dashboards & models. SQL',
    pay_text: 'EUR 60000–75000 per year', posted_at: '2026-11-15T00:00:00.000Z', closed: false, closed_reason: undefined,
    workplace: 'onsite', remote_countries: undefined, employment_type: undefined, valid_through: '2026-12-31T00:00:00.000Z' });
  assert.deepEqual(parsePay(p.pay_text, 'EUR')?.min, 60000);
  // @graph, an array, @type as a list, a hiringOrganization string, remote with applicant locations, a single amount.
  const graph = readPostingPage(ld({ '@graph': [{ '@type': 'WebPage' }, { ...POSTING, '@type': ['JobPosting'], jobLocation: undefined, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ '@type': 'Country', name: 'Germany' }, { '@type': 'Country', name: 'Austria' }] }] }), AT);
  assert.equal(graph.location, 'Remote (Germany, Austria)');
  // The structured fields are kept too (P1b): workplace, the countries a remote role hires from, employment type.
  assert.deepEqual([graph.workplace, graph.remote_countries, graph.employment_type], ['remote', ['Germany', 'Austria'], undefined]);
  assert.equal(readPostingPage(ld({ ...POSTING, employmentType: ['FULL_TIME', 'CONTRACTOR'] }), AT).employment_type, 'FULL_TIME, CONTRACTOR');
  const arr = readPostingPage(ld([{ '@type': 'Organization' }, { ...POSTING, hiringOrganization: 'Example Co', baseSalary: { currency: 'USD', value: { value: 45, unitText: 'HOUR' } } }]), AT);
  assert.equal(arr.company, 'Example Co');
  assert.equal(arr.pay_text, 'USD 45 per hour');
  // Broken JSON-LD is skipped; the next block counts.
  assert.equal(readPostingPage(`<script type="application/ld+json">{oops</script>${ld(POSTING)}`, AT).title, 'Senior Data Analyst');
  // Meta: either attribute order, entities decoded; no company (Claude reads the page).
  const meta = readPostingPage('<title>ignored</title><meta content="Analyst &amp; Engineer" property="og:title"><meta name="description" content="Hello">', AT);
  assert.deepEqual([meta.title, meta.company, meta.description], ['Analyst & Engineer', undefined, 'Hello']);
  assert.equal(readPostingPage('<title> Data Analyst – Example </title>', AT).title, 'Data Analyst – Example');
});

test('closed postings: validThrough in the past, or the page says so', () => {
  const expired = readPostingPage(ld({ ...POSTING, validThrough: '2026-10-01' }), AT);
  assert.equal(expired.closed, true);
  assert.match(expired.closed_reason!, /expired on 2026-10-01/);
  assert.equal(readPostingPage(`${ld(POSTING)}<p>This job is no longer available.</p>`, AT).closed, true);
  assert.equal(readPostingPage('<h1>Analyst</h1><div>No longer accepting applications</div>', AT).closed, true);
  assert.equal(readPostingPage('<p>We are accepting applications until December.</p>', AT).closed, false);
});

async function site() {
  const s = await serve(pages({
    '/jobs/analyst': `<html><head>${ld(POSTING)}</head><body>Apply below</body></html>`,
    '/jobs/second': ld({ ...POSTING, title: 'Lead Data Analyst' }),
    '/jobs/closed': ld({ ...POSTING, validThrough: '2026-01-01' }),
    '/jobs/meta-only': '<meta property="og:title" content="Data Analyst">',
    '/jobs/moved': { status: 301, headers: { location: '/jobs/analyst' } },
    '/jobs/error': { status: 500, body: 'oops' },
    '/example/abc-123': ld({ ...POSTING, hiringOrganization: { name: 'Example Lever Co' } }),
  }));
  return { ...s, at: (p: string, host = 'jobs.example.test') => `${s.base(host)}${p}` };
}
const net = { testHosts: testHosts('jobs.example.test', 'jobs.lever.co') };

test('a pasted posting becomes a role picked for today; a second one at the same company comes back with a warning', async (t) => {
  const s = await site();
  t.after(() => s.close());
  const w = world('berlin-analyst', { now: '2026-11-19T10:00:00Z' });
  const r = await link(w.ctx, { url: s.at('/jobs/analyst#apply') }, { net });
  assert.equal(r.picked, true);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual([r.company, r.title, r.apply_kind], ['Example Mobility GmbH', 'Senior Data Analyst', 'external']);
  const row = w.ctx.db.prepare('select url, source, status, picked_on, location, pay_text, posted_at, apply_kind from roles where id=?').get(r.id) as any;
  assert.deepEqual({ ...row }, { url: s.at('/jobs/analyst'), source: 'pasted', status: 'picked', picked_on: '2026-11-19', location: 'Berlin, DE', pay_text: 'EUR 60000–75000 per year', posted_at: '2026-11-15T00:00:00.000Z', apply_kind: 'external' });
  // Pasting it again finds the same role.
  assert.equal((await link(w.ctx, { url: s.at('/jobs/analyst') }, { net })).id, r.id);
  const second = await link(w.ctx, { url: s.at('/jobs/second') }, { net });
  assert.equal(second.picked, false);
  assert.match(second.warnings[0], /already has "Senior Data Analyst" in progress/);
  const forced = await link(w.ctx, { url: s.at('/jobs/second'), force: true }, { net });
  assert.equal(forced.picked, true);
  // A redirect is followed; the role keeps the address the user pasted.
  const moved = await link(world('berlin-analyst').ctx, { url: s.at('/jobs/moved') }, { net });
  assert.equal(moved.title, 'Senior Data Analyst');
});

test('known ATS postings get the form address as apply URL', async (t) => {
  const s = await site();
  t.after(() => s.close());
  const w = world('berlin-analyst');
  const r = await link(w.ctx, { url: s.at('/example/abc-123', 'jobs.lever.co') }, { net });
  assert.equal((w.ctx.db.prepare('select apply_url from roles where id=?').get(r.id) as any).apply_url, s.at('/example/abc-123/apply', 'jobs.lever.co'));
});

test('closed, missing, unreadable and failing pages', async (t) => {
  const s = await site();
  t.after(() => s.close());
  const w = world('berlin-analyst');
  const closed = await link(w.ctx, { url: s.at('/jobs/closed') }, { net });
  assert.deepEqual([closed.closed, closed.id, closed.picked], [true, '', false]);
  assert.match(closed.warnings[0], /closed: the posting expired/);
  const gone = await link(w.ctx, { url: s.at('/jobs/nope') }, { net });
  assert.match(gone.warnings[0], /HTTP 404/);
  const meta = await link(w.ctx, { url: s.at('/jobs/meta-only') }, { net });
  assert.equal(meta.id, '');
  assert.match(meta.needs!, /add-role --role-file.*pick --role/);
  await assert.rejects(link(w.ctx, { url: s.at('/jobs/error') }, { net }), /HTTP 500/);
  assert.equal((w.ctx.db.prepare('select count(*) n from roles').get() as any).n, 0);
});

test('local, X and non-web addresses are refused; nothing reaches the local server', async (t) => {
  const s = await site();
  t.after(() => s.close());
  const w = world('berlin-analyst');
  await assert.rejects(link(w.ctx, { url: s.at('/jobs/analyst', '127.0.0.1') }), /private or local address/);
  await assert.rejects(link(w.ctx, { url: s.at('/jobs/analyst', 'localhost') }), /this machine/);
  await assert.rejects(link(w.ctx, { url: 'https://x.com/someone/status/1' }), /X links are never used/);
  await assert.rejects(link(w.ctx, { url: 'https://twitter.com/i/jobs/1' }), /X links are never used/);
  await assert.rejects(link(w.ctx, { url: 'file:///etc/passwd' }), /http/);
  await assert.rejects(link(w.ctx, { url: 'not a link' }), /not a web address/);
  await assert.rejects(link(w.ctx, { nope: 1 } as any), /\{ url, force\? \}/);
  assert.deepEqual(s.hits, []);
});

test('LinkedIn links: off unless switched on; then read through the guest page (Easy Apply kind, closed, stop at 429)', async (t) => {
  let refuse = false;
  const li = await serve((req, res) => {
    if (refuse) { res.writeHead(429).end(); return; }
    const id = /\/jobPosting\/(\d+)$/.exec(req.url ?? '')?.[1];
    if (id === '4000000061') { res.writeHead(200).end(DETAIL({ company: 'Example Li Co' })); return; }
    if (id === '4000000062') { res.writeHead(200).end(DETAIL({ closed: true })); return; }
    res.writeHead(404).end();
  });
  t.after(() => li.close());
  const opts = { linkedin: { base: `${li.base('li.example.test')}/jobs-guest/jobs/api`, net: { testHosts: testHosts('li.example.test') }, sleep: async () => {} } };
  const off = world('berlin-analyst');
  await assert.rejects(link(off.ctx, { url: 'https://www.linkedin.com/jobs/view/4000000061' }, opts), /Pasted LinkedIn links are off/);
  assert.deepEqual(li.hits, []);
  const w = world('berlin-analyst', { features: { linkedin_links: true } });
  await assert.rejects(link(w.ctx, { url: 'https://www.linkedin.com/in/someone' }, opts), /not a job posting/);
  const r = await link(w.ctx, { url: 'https://de.linkedin.com/jobs/view/senior-data-analyst-at-example-4000000061?trk=x' }, opts);
  assert.deepEqual([r.picked, r.company, r.apply_kind], [true, 'Example Li Co', 'easy']);
  assert.equal((w.ctx.db.prepare('select url, source from roles where id=?').get(r.id) as any).url, 'https://www.linkedin.com/jobs/view/4000000061');
  const closed = await link(w.ctx, { url: 'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4000000062' }, opts);
  assert.equal(closed.closed, true);
  await assert.rejects(link(w.ctx, { url: 'https://www.linkedin.com/jobs/view/4000000063' }, opts), /does not show that posting/);
  refuse = true;
  await assert.rejects(link(w.ctx, { url: 'https://www.linkedin.com/jobs/view/4000000064' }, opts), /HTTP 429.*stopped/);
});

test('CLI: link reads the URL from a file and refuses a local address and X', () => {
  const w = world('berlin-analyst');
  const local = jobs(w.home, ['link', '--url-file', textFile(w.root, 'u1.txt', 'http://127.0.0.1:9/jobs/1\n')]);
  assert.equal(local.code, 1);
  assert.match(local.err, /private or local address/);
  const x = jobs(w.home, ['link', '--url-file', textFile(w.root, 'u2.txt', 'https://x.com/a/status/1')]);
  assert.match(x.err, /X links are never used/);
  const usage = jobs(w.home, ['link', 'https://jobs.example.com/1']);
  assert.match(usage.err, /--url-file/);
});

test('E6: 2 MB adversarial pages (unclosed scripts, styles, meta and title tags, bare <, LinkedIn markers) parse in under a second each', async () => {
  const { plainText } = await import('../../src/jobs/text.ts');
  const { parseDetail, parseSearch } = await import('../../src/jobs/linkedin.ts');
  const N = 2_000_000;
  const fill = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const evil = {
    script: fill('<script type="application/ld+json">'), scripts: fill('<script '), style: fill('<style>'), meta: fill('<meta a=b '),
    metaAttrs: `<meta ${fill('a="b ')}`, title: fill('<title>'), lt: fill('<'), amp: fill('&a'), tags: fill('<p x'),
    topcard: fill('topcard__title>'), markup: fill('show-more-less-html__markup><'), cards: fill('<li>urn:li:jobPosting:1 base-search-card__title>'),
  };
  for (const [name, page] of Object.entries(evil)) {
    for (const [fn, f] of [['readPostingPage', (h: string) => readPostingPage(h)], ['plainText', plainText], ['parseDetail', (h: string) => parseDetail('1', h)], ['parseSearch', parseSearch]] as const) {
      const t = performance.now();
      (f as (h: string) => unknown)(page);
      const ms = performance.now() - t;
      assert.ok(ms < 1000, `${fn} on ${name}: ${Math.round(ms)} ms`);
    }
  }
  // Still the same answers on ordinary pages.
  assert.equal(plainText('<p>a<script>x<y</script>b</p><style>s</style>c &amp; d<>e'), 'a b c & d<>e');
  assert.equal(plainText('<b>never closed <script>gone'), 'never closed');
  assert.equal(readPostingPage('<html><head><title>Data Analyst at Example</title><meta property="og:title" content="Analyst &amp; Lead"></head></html>').title, 'Analyst & Lead');
  assert.equal(readPostingPage('<title>Plain title</title>').title, 'Plain title');
});
