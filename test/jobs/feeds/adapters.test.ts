// Each company-board adapter on a response recorded from a real public board (2026-11-20, trimmed to a few jobs,
// contact details scrubbed). Breezy and Zoho were not probed: their tests use hand-made bodies in the documented shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../../../src/jobs/feeds/adapters/index.ts';
import type { Board, Posting } from '../../../src/jobs/feeds/types.ts';
import { fakeFetch, fixture } from './helpers.ts';

async function run(b: Board, url: string, body: string, headers: Record<string, string> = {}) {
  const { fetch, calls } = fakeFetch({ [url]: { body, headers } });
  const r = await ADAPTERS[b.ats].fetchBoard(b, { fetch });
  return { ...r, calls };
}
const byId = (ps: Posting[], id: string) => { const p = ps.find((x) => x.atsJobId === id); assert.ok(p, `posting ${id}`); return p!; };
function common(p: Posting) {
  assert.equal(p.source, 'ats');
  assert.match(p.url, /^https:\/\//);
  assert.match(p.applyUrl, /^https:\/\//);
  assert.ok(p.title && p.company);
  assert.ok(!/<[a-z][^>]*>/i.test(p.descriptionText), 'description text has no tags');
  assert.ok(!/&lt;|&amp;|&nbsp;/.test(p.descriptionText), 'entities decoded');
  assert.ok(Number.isFinite(Date.parse(p.postedAt)));
}

test('Greenhouse: escaped HTML content, workplace from metadata, remote scope from "Remote - USA", ETag kept', async () => {
  const r = await run({ ats: 'greenhouse', slug: 'airbnb' }, 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true', fixture('greenhouse-airbnb.json'), { etag: 'W/"gh1"' });
  assert.equal(r.calls[0].url, 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true');
  assert.deepEqual(r.errors, []);
  assert.equal(r.etag, 'W/"gh1"');
  assert.equal(r.postings.length, 3);
  r.postings.forEach(common);
  const remote = byId(r.postings, '8394382');
  assert.equal(remote.company, 'Airbnb');
  assert.equal(remote.workplace, 'remote');
  assert.deepEqual(remote.remoteCountries, ['US']);
  assert.equal(remote.department, 'Software Engineering');
  assert.ok(remote.descriptionText.length > 3000, 'full description, not clipped');
  assert.match(remote.descriptionHtml!, /^<div/);
  const blr = byId(r.postings, '8023118');
  assert.equal(blr.workplace, 'hybrid');
  assert.deepEqual(blr.countries, ['IN']);
  assert.deepEqual(blr.remoteCountries, []);
  assert.equal(blr.postedAt, '2026-06-23T09:55:55.000Z');
  assert.equal(blr.updatedAt, '2026-11-10T22:52:22.000Z');
});

test('Lever: workplaceType and country, lists and additional text in the description, EU host', async () => {
  const r = await run({ ats: 'lever', slug: 'palantir', company: 'Palantir' }, 'https://api.lever.co/v0/postings/palantir?mode=json', fixture('lever-palantir.json'));
  assert.equal(r.postings.length, 3);
  r.postings.forEach(common);
  const remote = byId(r.postings, '0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0');
  assert.equal(remote.workplace, 'remote');
  assert.deepEqual(remote.remoteCountries, ['CA', 'MX', 'US'], '"North America" expands to its countries');
  assert.deepEqual(remote.countries, ['US']);
  const sg = byId(r.postings, '6ed76ce8-4156-4b60-b120-403538bd66cd');
  assert.equal(sg.workplace, 'hybrid');
  assert.deepEqual(sg.countries, ['SG']);
  assert.equal(sg.employmentType, 'full_time');
  assert.match(sg.descriptionText, /What We Require/, 'the lists are part of the text');
  assert.match(sg.applyUrl, /\/apply$/);
  assert.equal(sg.postedAt, new Date(1786469891368).toISOString());
  assert.equal(byId(r.postings, 'ac978161-6f46-4f6b-ad9e-a258e642751c').workplace, 'onsite');
  assert.equal(ADAPTERS.lever.feedUrl({ ats: 'lever', slug: 'acme', host: 'eu' }), 'https://api.eu.lever.co/v0/postings/acme?mode=json');
});

test('Ashby: Remote with secondary locations, Hybrid despite isRemote, salary from compensation tiers', async () => {
  const r = await run({ ats: 'ashby', slug: 'openai', company: 'OpenAI' }, 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true', fixture('ashby-openai.json'));
  assert.equal(r.postings.length, 3);
  r.postings.forEach(common);
  const remote = byId(r.postings, 'c414f15f-60c4-40b5-a896-d2ad6c7f4415');
  assert.equal(remote.workplace, 'remote');
  assert.deepEqual(remote.remoteCountries, ['US']);
  assert.deepEqual(remote.locations.slice(0, 2), ['US - Remote', 'New York City']);
  assert.deepEqual(remote.pay, { min: 207000, max: 285000, currency: 'USD', period: 'year' });
  const hybrid = byId(r.postings, '8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3');
  assert.equal(hybrid.workplace, 'hybrid');
  assert.deepEqual(hybrid.remoteCountries, []);
  assert.deepEqual(hybrid.countries, ['US']);
  assert.equal(byId(r.postings, '240d459b-696d-43eb-8497-fab3e56ecd9b').workplace, 'unknown');
});

test('Workable: account name, telecommuting, ISO codes, region in the title scopes remoteness', async () => {
  const r = await run({ ats: 'workable', slug: 'huggingface' }, 'https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true', fixture('workable-huggingface.json'));
  assert.equal(r.postings.length, 3);
  r.postings.forEach(common);
  const emea = byId(r.postings, '81B46579FE');
  assert.equal(emea.company, 'Hugging Face');
  assert.equal(emea.workplace, 'remote');
  for (const c of ['FR', 'DE', 'GB', 'NG', 'AE']) assert.ok(emea.remoteCountries.includes(c), c);
  assert.ok(!emea.remoteCountries.includes('US'));
  assert.deepEqual(byId(r.postings, '19A136F8E2').remoteCountries, ['US']);
});

test('Recruitee: hybrid and remote flags, several locations, careers URLs', async () => {
  const r = await run({ ats: 'recruitee', slug: 'bunq' }, 'https://bunq.recruitee.com/api/offers/', fixture('recruitee-bunq.json'));
  assert.equal(r.postings.length, 2);
  r.postings.forEach(common);
  const hy = byId(r.postings, '2832667');
  assert.equal(hy.workplace, 'hybrid');
  assert.deepEqual(hy.countries, ['BG', 'NL', 'TR']);
  assert.equal(hy.applyUrl, 'https://careers.bunq.com/o/copywriter-3/c/new');
  assert.equal(hy.postedAt, '2026-11-18T16:23:32.000Z');
  const rem = byId(r.postings, '2821648');
  assert.equal(rem.workplace, 'remote');
  assert.deepEqual(rem.remoteCountries, ['FR']);
  assert.ok(!JSON.stringify(r.postings).includes('mailbox'), 'raw stays minimal');
});

test('Personio: XML positions; descriptions from jobDescription CDATA when present', async () => {
  const r = await run({ ats: 'personio', slug: 'personio', company: 'Personio' }, 'https://personio.jobs.personio.de/xml', fixture('personio-personio.xml'));
  assert.equal(r.postings.length, 2);
  const p = byId(r.postings, '2885178');
  assert.equal(p.title, 'Business Development Representative (d/f/m)');
  assert.deepEqual(p.countries, ['DE']);
  assert.equal(p.department, 'Go to Market');
  assert.equal(p.employmentType, 'full_time');
  assert.equal(p.url, 'https://personio.jobs.personio.de/job/2885178');
  // The recorded board left descriptions empty; the documented form:
  const xml = `<?xml version="1.0"?><workzag-jobs><position><id>7</id><subcompany>Acme GmbH</subcompany><office>Hamburg</office>
    <additionalOffices><office>Remote</office></additionalOffices><name>Buchhalter &amp; Controller (m/w/d)</name>
    <jobDescriptions><jobDescription><name>Deine Aufgaben</name><value><![CDATA[<ul><li>Monatsabschluss</li></ul>]]></value></jobDescription></jobDescriptions>
    <employmentType>permanent</employmentType><schedule>part-time</schedule><createdAt>2026-11-01T09:00:00+00:00</createdAt></position></workzag-jobs>`;
  const d = await run({ ats: 'personio', slug: 'acme' }, 'https://acme.jobs.personio.de/xml', xml);
  const q = d.postings[0];
  assert.equal(q.title, 'Buchhalter & Controller (m/w/d)');
  assert.equal(q.company, 'Acme GmbH');
  assert.match(q.descriptionText, /^Deine Aufgaben\n+- Monatsabschluss$/);
  assert.equal(q.employmentType, 'part_time');
  assert.deepEqual(q.locations, ['Hamburg', 'Remote']);
  assert.equal(q.workplace, 'remote');
  assert.deepEqual(q.remoteCountries, ['DE']);
});

test('Teamtailor: RSS items, remoteStatus, tt:locations, escaped HTML description', async () => {
  const r = await run({ ats: 'teamtailor', slug: 'career' }, 'https://career.teamtailor.com/jobs.rss', fixture('teamtailor-career.rss'), { etag: 'W/"tt"' });
  assert.equal(r.postings.length, 2);
  r.postings.forEach(common);
  const h = byId(r.postings, 'fb8cc63f-b262-44e6-94c2-ae6d551d3cce');
  assert.equal(h.company, 'Teamtailor');
  assert.equal(h.workplace, 'hybrid');
  assert.deepEqual(h.countries, ['SE']);
  assert.match(h.descriptionText, /^Let's build the future together!/);
  assert.equal(h.department, 'Customer Success');
  assert.equal(r.postings[1].workplace, 'onsite', 'remoteStatus none = on-site');
  assert.equal(ADAPTERS.teamtailor.feedUrl({ ats: 'teamtailor', slug: 'x', host: 'jobs.acme.com' }), 'https://jobs.acme.com/jobs.rss');
});

test('Keka: the careers embed JSON; job pages on the company subdomain; needs the portal id', async () => {
  const site = '24040a7e-a7c5-47a5-9cd5-019962c66385';
  const r = await run({ ats: 'keka', slug: 'hr', site, company: 'Keka' }, `https://hr.keka.com/careers/api/embedjobs/default/active/${site}`, fixture('keka-hr.json'));
  assert.equal(r.postings.length, 2);
  r.postings.forEach(common);
  const p = byId(r.postings, '146621');
  assert.equal(p.url, 'https://hr.keka.com/careers/jobdetails/146621');
  assert.deepEqual(p.countries, ['IN']);
  assert.equal(p.locations.length, 2);
  assert.equal(p.department, 'Visual Design');
  const bad = await ADAPTERS.keka.fetchBoard({ ats: 'keka', slug: 'hr' }, { fetch: fakeFetch({}).fetch });
  assert.match(bad.errors[0], /portal id/);
});

test('Breezy (unverified shape): positions with location.is_remote, no descriptions in the list', async () => {
  const body = JSON.stringify([{ id: 'p1', friendly_id: 'senior-nurse', name: 'Senior Nurse', url: 'https://acme.breezy.hr/p/p1-senior-nurse', published_date: '2026-11-02T10:00:00.000Z',
    type: { id: 'fullTime', name: 'Full-Time' }, location: { country: { name: 'United States', id: 'US' }, state: { id: 'TX', name: 'Texas' }, city: 'Austin', name: 'Austin, TX', is_remote: false },
    department: 'Clinical', company: { name: 'Acme Health' } }, { id: 'p2', name: 'Support Agent', url: 'https://acme.breezy.hr/p/p2', published_date: '2026-11-03', type: { name: 'Part-Time' },
    location: { country: { name: 'Canada', id: 'CA' }, name: 'Remote', is_remote: true }, company: { name: 'Acme Health' } }]);
  const r = await run({ ats: 'breezy', slug: 'acme' }, 'https://acme.breezy.hr/json', body);
  assert.equal(ADAPTERS.breezy.status, 'unverified');
  const [a, b] = r.postings;
  assert.equal(a.company, 'Acme Health');
  assert.deepEqual(a.countries, ['US']);
  assert.equal(a.employmentType, 'full_time');
  assert.equal(a.descriptionText, '');
  assert.equal(b.workplace, 'remote');
  assert.deepEqual(b.remoteCountries, ['CA']);
  assert.equal(b.employmentType, 'part_time');
});

test('Zoho Recruit (unverified): hidden jobs input, else JSON-LD JobPosting', async () => {
  const jobs = [{ id: '42', Posting_Title: 'Accountant', City: 'Chennai', State: 'Tamil Nadu', Country: 'India', Remote_Job: false, Job_Type: 'Full time', Date_Opened: '2026-11-01', Job_Description: '<p>Books &amp; GST</p>' }];
  const page = `<html><body><input type="hidden" id="jobs" value="${JSON.stringify(jobs).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></body></html>`;
  const r = await run({ ats: 'zoho', slug: 'acme', host: 'in', company: 'Acme' }, 'https://acme.zohorecruit.in/jobs/Careers', page);
  assert.equal(r.postings.length, 1);
  assert.equal(r.postings[0].title, 'Accountant');
  assert.deepEqual(r.postings[0].countries, ['IN']);
  assert.equal(r.postings[0].descriptionText, 'Books & GST');
  const ld = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Driver","url":"https://acme.zohorecruit.com/jobs/Careers/9","identifier":{"value":"9"},
    "datePosted":"2026-11-02","employmentType":"PART_TIME","description":"<p>Deliveries</p>","hiringOrganization":{"name":"Acme"},"jobLocationType":"TELECOMMUTE",
    "jobLocation":{"address":{"addressLocality":"Pune","addressCountry":"IN"}}}</script>`;
  const l = await run({ ats: 'zoho', slug: 'acme' }, 'https://acme.zohorecruit.com/jobs/Careers', ld);
  assert.equal(l.postings[0].workplace, 'remote');
  assert.deepEqual(l.postings[0].remoteCountries, ['IN']);
  assert.equal(l.postings[0].employmentType, 'part_time');
});

test('Workday (undocumented): pages of 20 until empty, a detail GET only for new jobs, known jobs stay partial', async () => {
  const base = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite';
  const page1 = JSON.parse(fixture('workday-nvidia-list.json'));
  // A second page made from the first (new ids), then an empty page.
  const page2 = { total: 0, jobPostings: page1.jobPostings.slice(0, 20).map((j: any, i: number) => ({ ...j, externalPath: `${j.externalPath}-p2`, bulletFields: [`JRP2${i}`] })) };
  const detail = JSON.parse(fixture('workday-nvidia-detail.json'));
  const offsets: number[] = [];
  const routes: Record<string, any> = {
    [`${base}/jobs`]: (req: any) => {
      assert.equal(req.method, 'POST');
      const o = JSON.parse(req.body).offset;
      offsets.push(o);
      return { body: JSON.stringify(o === 0 ? page1 : o === 20 ? page2 : { total: 0, jobPostings: [] }) };
    },
  };
  for (const j of [...page1.jobPostings, ...page2.jobPostings]) {
    routes[`${base}${j.externalPath}`] = { body: JSON.stringify({ ...detail, jobPostingInfo: { ...detail.jobPostingInfo, title: j.title, externalUrl: undefined } }) };
  }
  const { fetch, calls } = fakeFetch(routes);
  const b: Board = { ats: 'workday', slug: 'nvidia', host: 'wd5', site: 'NVIDIAExternalCareerSite', company: 'NVIDIA' };
  const known = new Set(page1.jobPostings.slice(0, 15).map((j: any) => j.bulletFields[0]));
  const r = await ADAPTERS.workday.fetchBoard(b, { fetch, known, now: Date.parse('2026-11-20T12:00:00Z') });
  assert.deepEqual(offsets, [0, 20, 40], 'paged by 20 until an empty page');
  assert.deepEqual(r.errors, []);
  assert.equal(r.complete, true);
  const details = calls.filter((c) => c.method !== 'POST');
  assert.equal(details.length, 25, 'details only for the 25 jobs not known');
  assert.equal(r.postings.filter((p) => p.partial).length, 15);
  const full = r.postings.find((p) => p.atsJobId === 'JRP21')!;
  assert.equal(full.employmentType, 'full_time');
  assert.deepEqual(full.countries, ['US']);
  assert.deepEqual(full.locations, ['US, CA, Santa Clara', 'US, NY, New York', 'US, WA, Seattle']);
  assert.match(full.descriptionText, /^GPU clusters fail\./);
  assert.equal(full.postedAt, '2026-11-20T00:00:00.000Z');
  // The real list says "Posted Yesterday" for some: approximate dates from the run's clock.
  const partial = r.postings.find((p) => p.partial && p.atsJobId === 'JR2028934')!;
  assert.equal(partial.postedAt, '2026-11-19T12:00:00.000Z');
  // detail limit: the rest are left for the next run, and the list is marked incomplete
  const capped = await ADAPTERS.workday.fetchBoard(b, { fetch, maxDetails: 3 });
  assert.equal(capped.complete, false);
  assert.match(capped.errors[0], /37 new jobs left/);
  assert.equal(ADAPTERS.workday.status, 'undocumented');
  assert.match((await ADAPTERS.workday.fetchBoard({ ats: 'workday', slug: 'x', site: 'S' }, { fetch })).errors[0], /host/);
});

test('a board that is gone or answers garbage is an error, not an exception', async () => {
  const { fetch } = fakeFetch({ 'https://api.lever.co/v0/postings/nope': { status: 404, body: '{"ok":false}' }, 'https://boards-api.greenhouse.io/v1/boards/x/jobs': { body: '<html>' } });
  const a = await ADAPTERS.lever.fetchBoard({ ats: 'lever', slug: 'nope' }, { fetch });
  assert.match(a.errors[0], /404/);
  assert.equal(a.complete, false);
  const b = await ADAPTERS.greenhouse.fetchBoard({ ats: 'greenhouse', slug: 'x' }, { fetch });
  assert.match(b.errors[0], /not JSON/);
  assert.throws(() => ADAPTERS.recruitee.feedUrl({ ats: 'recruitee', slug: 'evil.com/x' }), /not a valid board/);
});

test('ETag: If-None-Match is sent and 304 means not modified', async () => {
  for (const [b, url] of [
    [{ ats: 'greenhouse', slug: 'airbnb' }, 'https://boards-api.greenhouse.io/v1/boards/airbnb/jobs?content=true'],
    [{ ats: 'lever', slug: 'palantir' }, 'https://api.lever.co/v0/postings/palantir?mode=json'],
    [{ ats: 'ashby', slug: 'openai' }, 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true'],
  ] as [Board, string][]) {
    const { fetch, calls } = fakeFetch({ [url]: (req) => (req.headers?.['if-none-match'] === 'W/"v1"' ? { status: 304, headers: { etag: 'W/"v1"' } } : { body: '[]' }) });
    const r = await ADAPTERS[b.ats].fetchBoard(b, { fetch, etag: 'W/"v1"' });
    assert.equal(r.notModified, true, b.ats);
    assert.equal(r.etag, 'W/"v1"');
    assert.deepEqual(r.postings, []);
    assert.equal(calls[0].headers?.['if-none-match'], 'W/"v1"');
  }
});

test('since drops postings older than the given time', async () => {
  const { fetch } = fakeFetch({ 'https://api.lever.co/v0/postings/palantir': { body: fixture('lever-palantir.json') } });
  const r = await ADAPTERS.lever.fetchBoard({ ats: 'lever', slug: 'palantir' }, { fetch, since: '2026-01-01T00:00:00Z' });
  assert.deepEqual(r.postings.map((p) => p.atsJobId), ['6ed76ce8-4156-4b60-b120-403538bd66cd']);
});
