// Each adapter mapped from one recorded response (verified) or one written from the provider's docs (unverified).
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ApiCtx, ApiPosting, ApiQuery, ApiRequest } from '../../../src/jobs/apis/types.ts';
import { PROVIDERS, provider } from '../../../src/jobs/apis/registry.ts';
import { remoteFrom } from '../../../src/jobs/apis/util.ts';

// The fixtures were recorded on 2026-11-20: daysBack is measured from then.
before(() => mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T12:00:00Z') }));
after(() => mock.timers.reset());

const FIX = resolve(import.meta.dirname, '..', '..', 'fixtures', 'jobs', 'apis');
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8');

/** A ctx whose fetch answers every request with one fixture and records what was asked. */
function fake(body: string, keys: Record<string, string> = {}) {
  const reqs: ApiRequest[] = [];
  const ctx: ApiCtx = {
    keys: { get: (k) => keys[k] },
    fetch: async (req) => { reqs.push(req); return { status: 200, url: req.url, headers: {}, body }; },
  };
  return { ctx, reqs };
}

const run = async (id: string, file: string, q: Partial<ApiQuery>, keys?: Record<string, string>) => {
  const { ctx, reqs } = fake(fixture(file), keys);
  const r = await provider(id)!.search({ titles: ['x'], country: 'GB', ...q } as ApiQuery, ctx);
  return { ...r, reqs };
};

function wellFormed(p: ApiPosting) {
  assert.equal(p.source, 'api');
  assert.ok(p.sourceKey && p.sourceJobId, 'identity');
  assert.ok(p.title, 'title');
  assert.match(p.url, /^https:\/\//);
  assert.match(p.applyUrl, /^https:\/\//);
  assert.ok(['remote', 'hybrid', 'onsite', 'unknown'].includes(p.workplace));
  for (const c of [...p.countries, ...p.remoteCountries.filter((c) => c !== '*')]) assert.match(c, /^[A-Z]{2}$/);
  assert.ok(!Number.isNaN(Date.parse(p.postedAt)), `postedAt ${p.postedAt}`);
  assert.doesNotMatch(p.descriptionText, /<\/?(p|div|span|strong|b)\b/);
}

test('registry: every provider has coverage, terms, a rate limit and a fixture status; keyed ones say where to sign up', () => {
  assert.equal(PROVIDERS.length, 10);
  for (const p of PROVIDERS) {
    assert.ok(p.countries.length && p.terms && p.rateLimit.minIntervalMs >= 1000, p.id);
    assert.ok(['verified', 'unverified'].includes(p.fixture));
    if (p.needsKey) assert.match(p.needsKey.signupUrl, /^https:\/\//);
  }
  assert.deepEqual(PROVIDERS.filter((p) => p.needsKey).map((p) => p.id).sort(), ['adzuna', 'jooble', 'reed', 'usajobs']);
  assert.equal(provider('adzuna')!.attribution!.text, 'Jobs by Adzuna');
  assert.equal(provider('ba-jobsuche')!.undocumented, true);
});

test('USAJobs (unverified): PositionTitle per alternate, email as User-Agent, remote from RemoteIndicator', async () => {
  const r = await run('usajobs', 'usajobs-search.json', { titles: ['Nurse', 'Clinical Nurse'], country: 'US', places: ['Phoenix, Arizona'], remote: false, daysBack: 10 }, { usajobs: 'me@example.com:abcdef123456' });
  assert.equal(r.reqs.length, 2);
  const u = new URL(r.reqs[0].url);
  assert.equal(u.host, 'data.usajobs.gov');
  assert.equal(u.searchParams.get('PositionTitle'), 'Nurse');
  assert.equal(u.searchParams.get('DatePosted'), '10');
  assert.equal(r.reqs[0].headers!['user-agent'], 'me@example.com');
  assert.equal(r.reqs[0].headers!['authorization-key'], 'abcdef123456');
  assert.equal(r.postings.length, 2); // deduped across the two titles
  const [a, b] = r.postings;
  for (const p of r.postings) wellFormed(p);
  assert.equal(a.workplace, 'onsite');
  assert.deepEqual(a.countries, ['US']);
  assert.deepEqual(a.pay, { min: 78000, max: 118000, currency: 'USD', period: 'year' });
  assert.match(a.descriptionText, /direct patient care/);
  assert.equal(b.workplace, 'remote');
  assert.deepEqual(b.remoteCountries, ['US']);
  assert.equal(b.pay!.period, 'year');
  assert.equal(r.next, 2);
  const bad = await run('usajobs', 'usajobs-search.json', { country: 'US' }, { usajobs: 'justakey' });
  assert.match(bad.errors[0], /<email>:<key>/);
  assert.equal(bad.reqs.length, 0);
});

test('NHS Jobs (verified): XML search mapped; salary text parsed; GB; teaser descriptions', async () => {
  const r = await run('nhs-jobs', 'nhs-search.xml', { titles: ['Staff Nurse'], places: ['Leeds'] });
  const u = new URL(r.reqs[0].url);
  assert.equal(u.pathname, '/api/v1/search_xml');
  assert.equal(u.searchParams.get('keyword'), 'Staff Nurse');
  assert.equal(u.searchParams.get('location'), 'Leeds');
  assert.equal(r.postings.length, 4);
  for (const p of r.postings) wellFormed(p);
  const first = r.postings[0];
  assert.equal(first.sourceJobId, '5446451');
  assert.equal(first.company, 'Priory Healthcare');
  assert.deepEqual(first.pay, { min: 32593, max: 37211, currency: 'GBP', period: 'year' });
  assert.deepEqual(first.countries, ['GB']);
  assert.equal(first.workplace, 'unknown');
  assert.equal(first.closesAt, '2026-11-30');
  assert.ok(r.postings.some((p) => p.locations.length === 2));
  assert.equal(r.next, 2);
});

test('DfE Teaching Vacancies (verified): whole feed page, titles matched locally, OGL attribution, pay from baseSalary', async () => {
  const all = await run('dfe-teaching-vacancies', 'dfe-teaching-vacancies.json', { titles: ['teaching assistant', 'teacher'] });
  assert.equal(new URL(all.reqs[0].url).searchParams.get('page'), '1');
  assert.ok(all.postings.length >= 1);
  for (const p of all.postings) {
    wellFormed(p);
    assert.match(p.title.toLowerCase(), /teaching assistant|teacher/);
    assert.match(p.attribution!.text, /Open Government Licence/);
    assert.ok(p.url.endsWith(`/jobs/${p.sourceJobId}`));
    assert.deepEqual(p.countries, ['GB']);
    assert.equal(p.workplace, 'onsite');
  }
  const paid = all.postings.find((p) => p.pay);
  if (paid) assert.equal(paid.pay!.currency, 'GBP');
  assert.equal(all.next, 2);
  const none = await run('dfe-teaching-vacancies', 'dfe-teaching-vacancies.json', { titles: ['astronaut'] });
  assert.equal(none.postings.length, 0);
});

test('BA Jobsuche (unverified, undocumented): X-API-Key header, refnr links, home office → hybrid', async () => {
  const r = await run('ba-jobsuche', 'ba-jobsuche.json', { titles: ['Pflegefachkraft'], country: 'DE', places: ['Berlin'], remote: true, daysBack: 14 });
  const u = new URL(r.reqs[0].url);
  assert.equal(r.reqs[0].headers!['x-api-key'], 'jobboerse-jobsuche');
  assert.equal(u.searchParams.get('was'), 'Pflegefachkraft');
  assert.equal(u.searchParams.get('wo'), 'Berlin');
  assert.equal(u.searchParams.get('arbeitszeit'), 'ho');
  assert.equal(u.searchParams.get('veroeffentlichtseit'), '14');
  assert.equal(r.postings.length, 2);
  for (const p of r.postings) wellFormed(p);
  assert.equal(r.postings[0].url, 'https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1198765432-S');
  assert.equal(r.postings[1].applyUrl, 'https://karriere.seniorenhaus.example.org/stellen/42');
  assert.deepEqual(r.postings[0].countries, ['DE']);
  assert.equal(r.postings[0].workplace, 'hybrid');
  assert.equal(r.next, 2);
});

test('Reed (unverified): Basic auth with the key, dd/mm/yyyy dates, hourly rates recognised', async () => {
  const r = await run('reed', 'reed-search.json', { titles: ['Nurse'], places: ['Leeds'], page: 2 }, { reed: 'reed-key-0123456789' });
  const u = new URL(r.reqs[0].url);
  assert.equal(u.searchParams.get('resultsToSkip'), '100');
  assert.equal(r.reqs[0].headers!.authorization, `Basic ${Buffer.from('reed-key-0123456789:').toString('base64')}`);
  assert.ok(!r.reqs[0].url.includes('reed-key'));
  for (const p of r.postings) wellFormed(p);
  assert.equal(r.postings[0].postedAt, '2026-11-18');
  assert.equal(r.postings[0].closesAt, '2026-12-18');
  assert.deepEqual(r.postings[0].pay, { min: 36000, max: 41000, currency: 'GBP', period: 'year' });
  assert.equal(r.postings[1].pay!.period, 'hour');
  assert.equal(r.postings[1].workplace, 'remote');
  assert.equal(r.next, 3);
});

test('Adzuna (unverified): country path, app_id/app_key, title_only, predicted pay dropped, "Jobs by Adzuna"', async () => {
  const r = await run('adzuna', 'adzuna-search.json', { titles: ['Software Engineer'], country: 'IN', places: ['Bengaluru'], daysBack: 7 }, { adzuna: 'myappid:myappkey0123456789' });
  const u = new URL(r.reqs[0].url);
  assert.equal(u.pathname, '/v1/api/jobs/in/search/1');
  assert.equal(u.searchParams.get('app_id'), 'myappid');
  assert.equal(u.searchParams.get('title_only'), 'Software Engineer');
  assert.equal(u.searchParams.get('max_days_old'), '7');
  for (const p of r.postings) wellFormed(p);
  const [a, b] = r.postings;
  assert.equal(a.title, 'Senior Software Engineer');
  assert.deepEqual(a.pay, { min: 2400000, max: 3600000, currency: 'INR', period: 'year' });
  assert.deepEqual(a.countries, ['IN']);
  assert.equal(a.attribution!.text, 'Jobs by Adzuna');
  assert.equal(b.pay, undefined);
  assert.equal(b.workplace, 'remote');
  assert.equal(r.next, 2);
});

test('Jooble (unverified): POST to /api/<key> with a JSON body; snippets cleaned', async () => {
  const r = await run('jooble', 'jooble-search.json', { titles: ['Data Analyst'], country: 'IN', places: ['Pune'] }, { jooble: 'jooble-key-abcdef' });
  assert.equal(r.reqs[0].method, 'POST');
  assert.equal(r.reqs[0].url, 'https://jooble.org/api/jooble-key-abcdef');
  assert.deepEqual(JSON.parse(r.reqs[0].body!), { keywords: 'Data Analyst', location: 'Pune, India', page: '1', ResultOnPage: '50' });
  for (const p of r.postings) wellFormed(p);
  assert.equal(r.postings[0].sourceJobId, '-1234567890123456789');
  assert.deepEqual(r.postings[0].countries, ['IN']);
  assert.equal(r.postings[0].pay!.currency, 'INR');
  assert.equal(r.postings[1].workplace, 'remote');
  assert.equal(r.next, 2);
});

test('Himalayas (verified): country filter sent; locationRestrictions → remoteCountries ([] = anywhere)', async () => {
  const r = await run('himalayas', 'himalayas-search.json', { titles: ['software engineer'], country: 'IN' });
  const u = new URL(r.reqs[0].url);
  assert.equal(u.pathname, '/jobs/api/search');
  assert.equal(u.searchParams.get('country'), 'IN');
  assert.equal(r.postings.length, 5);
  for (const p of r.postings) { wellFormed(p); assert.equal(p.workplace, 'remote'); assert.match(p.applyUrl, /himalayas\.app/); assert.ok(p.attribution); }
  assert.deepEqual(r.postings[0].remoteCountries, ['*']);
  assert.deepEqual(r.postings[1].remoteCountries, ['IN', 'US']);
  assert.deepEqual(r.postings[2].remoteCountries, ['IN']);
  const hourly = r.postings.find((p) => p.pay?.period === 'hour');
  assert.deepEqual(hourly?.pay, { min: 50, max: hourly?.pay?.max ?? null, currency: 'USD', period: 'hour' });
  const many = r.postings.find((p) => p.remoteCountries.length > 20)!;
  assert.ok(many.remoteCountries.includes('BN') && many.remoteCountries.includes('LA'), 'long official names map too');
  assert.equal(r.next, 2);
});

test('Remotive (verified): candidate_required_location → remoteCountries; credit + link back', async () => {
  const r = await run('remotive', 'remotive-search.json', { titles: ['engineer'], country: 'IN' });
  assert.equal(new URL(r.reqs[0].url).searchParams.get('search'), 'engineer');
  assert.equal(r.postings.length, 4);
  for (const p of r.postings) { wellFormed(p); assert.match(p.url, /^https:\/\/remotive\.com\//); assert.equal(p.attribution!.text, 'Job from Remotive'); }
  assert.deepEqual(r.postings[0].remoteCountries, ['CA', 'US']);
  assert.deepEqual(r.postings[1].remoteCountries, ['*']);
  assert.ok(r.postings[2].remoteCountries.includes('DE') && r.postings[2].remoteCountries.includes('BR'), 'regions expand to countries');
  assert.deepEqual(r.postings[3].pay, { min: 14, max: 20, currency: 'USD', period: 'hour' });
  assert.equal(r.next, undefined);
});

test('Arbeitnow (verified): whole page, structured remote flag, hybrid from the location text', async () => {
  const r = await run('arbeitnow', 'arbeitnow-page.json', { titles: ['Entwickler', 'Developer', 'Werkstudent', 'Engineer', 'Manager'], country: 'DE' });
  assert.equal(r.reqs.length, 1);
  for (const p of r.postings) wellFormed(p);
  const remote = r.postings.find((p) => p.title.includes('100% Remote'))!;
  assert.equal(remote.workplace, 'remote');
  assert.deepEqual(remote.remoteCountries, []);
  const hybrid = r.postings.find((p) => /hybrid/i.test(p.locations[0] ?? ''));
  if (hybrid) assert.equal(hybrid.workplace, 'hybrid');
  assert.equal(r.next, 2);
  const onlyRemote = await run('arbeitnow', 'arbeitnow-page.json', { titles: ['Entwickler', 'Developer', 'Werkstudent', 'Engineer', 'Manager'], country: 'DE', remote: true });
  assert.ok(onlyRemote.postings.every((p) => p.workplace === 'remote'));
});

test('remoteFrom: anywhere, countries, regions, time zones only', () => {
  assert.deepEqual(remoteFrom('Worldwide'), ['*']);
  assert.deepEqual(remoteFrom('USA, Canada, USA timezones'), ['CA', 'US']);
  assert.deepEqual(remoteFrom('UK'), ['GB']);
  assert.deepEqual(remoteFrom('Americas timezones'), []);
  assert.ok(remoteFrom('Europe').includes('FR'));
});
