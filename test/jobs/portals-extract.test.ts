// ADR-0008: postings from saved portal pages and responses, by layer (json, jsonld, links). Fictional companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPortals } from '../../src/jobs/portals/catalog.ts';
import { canonicalJobUrl, extractPostings, fromJson, fromJsonLd, fromLinks, pathValue, postedAt } from '../../src/jobs/portals/extract.ts';
import { classifyPage } from '../../src/jobs/portals/scan.ts';
import { fixture, fixturePortal } from './portal-helpers.ts';

const NOW = new Date('2026-11-22T12:00:00Z');
const BASE = 'https://www.portal.test/jobs/data-analyst-jobs';

test('canonical job URLs: the portal\'s hosts and pattern only, identifying parameters kept, the rest dropped', () => {
  const p = fixturePortal();
  assert.equal(canonicalJobUrl('/job/Data-Analyst-Ab123456?ref=x#top', BASE, p), 'https://www.portal.test/job/Data-Analyst-Ab123456');
  assert.equal(canonicalJobUrl('https://evil.example.com/job/Data-Analyst-Ab123456', BASE, p), null);
  assert.equal(canonicalJobUrl('/jobs/data-analyst-jobs', BASE, p), null);
  assert.equal(canonicalJobUrl('javascript:alert(1)', BASE, p), null);
  assert.equal(canonicalJobUrl(`https://user:pw${'@'}www.portal.test/job/Data-Analyst-Ab123456`, BASE, p), null, 'no credentials in a job URL');
  const cat = loadPortals();
  const indeed = cat.byId.get('indeed')!;
  assert.equal(canonicalJobUrl('/rc/clk?jk=a1b2c3d4e5f60718&from=serp&vjs=3', 'https://in.indeed.com/jobs?q=x', indeed), 'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f60718');
  assert.equal(canonicalJobUrl('/viewjob?from=serp', 'https://in.indeed.com/jobs?q=x', indeed), null, 'no jk: not a posting');
  const li = cat.byId.get('linkedin')!;
  assert.equal(canonicalJobUrl('/jobs/view/product-analyst-at-marigold-4100000001/?refId=abc&trackingId=x', 'https://www.linkedin.com/jobs/search/', li), 'https://www.linkedin.com/jobs/view/4100000001');
  const gd = cat.byId.get('glassdoor')!;
  assert.equal(canonicalJobUrl('/job-listing/data-analyst-ember-logistics-JV_IC1.htm?jl=1009876543210&pos=101', 'https://www.glassdoor.co.in/Job/jobs.htm', gd), 'https://www.glassdoor.co.in/job-listing/data-analyst-ember-logistics-JV_IC1.htm?jl=1009876543210');
});

test('paths and dates: filters, regex groups, epochs and "3 days ago"', () => {
  const o = { list: [{ type: 'a', label: 'x' }, { type: 'location', label: 'Pune' }], urn: 'urn:li:fsd_jobPostingCard:(4100000001,JOBS_SEARCH)' };
  assert.equal(pathValue(o, 'list[type=location].label'), 'Pune');
  assert.equal(pathValue(o, 'urn ~ \\((\\d{6,}),'), '4100000001');
  assert.equal(pathValue(o, 'nope.deeper'), undefined);
  assert.equal(postedAt('3 days ago', NOW), '2026-11-19T12:00:00.000Z');
  assert.equal(postedAt('today', NOW), NOW.toISOString());
  assert.equal(postedAt(1795200000000, NOW), new Date(1795200000000).toISOString());
  assert.equal(postedAt('2030-01-01', NOW), undefined, 'not in the future');
  assert.equal(postedAt('whenever', NOW), undefined);
});

test('layer json: a search response in Naukri\'s shape (fixture), off-site items dropped', () => {
  // The shipped Naukri entry reads cards (its API wants a reCAPTCHA token); the JSON layer is tested with its old adapter.
  const naukri = { ...loadPortals().byId.get('naukri')!, json: [{ url: '/jobapi/v3/search', list: 'jobDetails', fields: { url: 'jdURL', title: 'title', company: 'companyName', location: 'placeholders[type=location].label', description: 'jobDescription', posted_at: 'createdDate' } }] };
  const got = fromJson([{ url: 'https://www.naukri.com/jobapi/v3/search?noOfResults=20&keyword=data', body: fixture('naukri-jobapi.json') }, { url: 'https://www.naukri.com/other', body: '{}' }], naukri, 'https://www.naukri.com/data-analyst-jobs', NOW);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], {
    url: 'https://www.naukri.com/job-listings-senior-data-analyst-larkspur-analytics-bengaluru-4-to-8-years-201126500123', title: 'Senior Data Analyst', company: 'Larkspur Analytics',
    location: 'Bengaluru', description: 'Own the weekly metrics review for our supply team. SQL and dashboards', posted_at: new Date(1795300000000).toISOString(),
  });
  assert.equal(got[1].url, 'https://www.naukri.com/job-listings-analytics-engineer-quillfeather-labs-remote-3-to-6-years-201126500456');
  assert.equal(got[1].workplace, 'remote');
  // A broken body is skipped, not thrown.
  assert.deepEqual(fromJson([{ url: 'https://www.naukri.com/jobapi/v3/search', body: '{oops' }], naukri, 'https://www.naukri.com/', NOW), []);
});

test('layer json: LinkedIn\'s voyager cards (fixture) through where + url_template', () => {
  const li = loadPortals().byId.get('linkedin')!;
  const got = fromJson([{ url: 'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?decorationId=x&q=jobSearch', body: fixture('linkedin-voyager.json') }], li, 'https://www.linkedin.com/jobs/search/', NOW);
  assert.deepEqual(got.map((x) => [x.url, x.title, x.company, x.workplace]), [
    ['https://www.linkedin.com/jobs/view/4100000001', 'Product Analyst', 'Marigold Fintech', 'hybrid'],
    ['https://www.linkedin.com/jobs/view/4100000002', 'Data Analyst', 'Tamarind Health', 'remote'],
  ]);
});

test('layer jsonld: ItemList of JobPostings (fixture); broken scripts and off-site items skipped', () => {
  const got = fromJsonLd(fixture('jsonld-search.html'), fixturePortal(), BASE, NOW);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { url: 'https://www.portal.test/job/data-analyst-ember-logistics-a1b2c3d4', title: 'Data Analyst', company: 'Ember Logistics', company_country: 'in', location: 'Bengaluru, IN', description: 'Build the fleet dashboards.', posted_at: '2026-11-17T00:00:00.000Z' });
  assert.deepEqual(got[1], { url: 'https://www.portal.test/job/bi-analyst-saffron-retail-e5f6g7h8', title: 'BI Analyst', company: 'Saffron Retail', location: 'Remote', posted_at: '2026-11-18T00:00:00.000Z', workplace: 'remote' });
});

test('layer links: job links and their card text (fixture): company, place, posted time; buttons and other sites ignored', () => {
  const got = fromLinks(fixture('cards-search.html'), fixturePortal(), BASE, NOW);
  assert.deepEqual(got, [
    { url: 'https://www.portal.test/job/Analytics-Engineer-Remote-Juniper-Data-Q7rT9xYz', title: 'Analytics Engineer', company: 'Juniper Data', location: 'Remote', posted_at: '2026-11-20T12:00:00.000Z', workplace: 'remote' },
    { url: 'https://www.portal.test/job/Senior-Data-Analyst-Pune-Cobalt-Freight-M3nB8vCx', title: 'Senior & Lead Data Analyst', company: 'Cobalt Freight', location: 'Pune, India', posted_at: NOW.toISOString() },
  ]);
});

test('all three layers: each posting once, the first layer named, later layers filling empty fields', () => {
  const p = fixturePortal();
  const captured = [{ url: 'https://www.portal.test/api/search?q=data', body: JSON.stringify({ results: [{ link: '/job/data-analyst-ember-logistics-a1b2c3d4', name: 'Data Analyst', org: { name: 'Ember Logistics' }, where: '' }] }) }];
  const x = extractPostings({ html: fixture('jsonld-search.html'), url: BASE, captured }, p, NOW);
  assert.deepEqual(x.by, { json: 1, jsonld: 1, links: 0 });
  const ember = x.postings.find((f) => f.title === 'Data Analyst')!;
  assert.equal(ember.by, 'json');
  assert.equal(ember.location, 'Bengaluru, IN', 'filled from JSON-LD');
  assert.equal(ember.description, 'Build the fleet dashboards.');
  const cards = extractPostings({ html: fixture('cards-search.html'), url: BASE }, p, NOW);
  assert.deepEqual(cards.by, { json: 0, jsonld: 0, links: 2 });
});

test('hostile pages stay bounded: a huge page and thousands of links finish quickly with at most 500 postings', () => {
  const p = fixturePortal();
  const many = Array.from({ length: 3000 }, (_, i) => `<a href="/job/X-${String(i).padStart(8, '0')}">Role ${i}</a>`).join('');
  const t = Date.now();
  const x = extractPostings({ html: `${'<div>'.repeat(50_000)}${many}<a href="/job/`.repeat(1), url: BASE }, p, NOW);
  assert.ok(x.postings.length <= 500);
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});

test('stops: a challenge page, a sign-in wall, 429/999, a 403 and a redirect off the portal', () => {
  const p = fixturePortal();
  const at = (o: Partial<{ status: number; url: string; html: string }>) => classifyPage({ status: 200, url: BASE, html: '<html></html>', ...o }, p);
  assert.equal(at({ html: fixture('challenge.html') })?.kind, 'challenge');
  assert.equal(at({ url: 'https://www.portal.test/login?next=/jobs' })?.kind, 'sign_in');
  assert.equal(at({ status: 429 })?.kind, 'rate');
  assert.equal(at({ status: 999 })?.kind, 'rate');
  assert.equal(at({ status: 403 })?.kind, 'challenge');
  assert.equal(at({ url: 'https://auth.elsewhere.example/sso' })?.kind, 'challenge');
  assert.equal(at({ status: 503 })?.kind, 'error');
  assert.equal(at({ html: fixture('cards-search.html') }), null);
  assert.equal(at({ html: fixture('jsonld-search.html') }), null);
});
