// The source catalog (design D18, §24.2): in step with the pinned manifest, one taxonomy, gazetteer regions, and every
// fill rule turning the user's notes into a provider's keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, catalogEntry, catalogIssues, fillEntry, loadCatalog, userCountries, userTitles } from '../../src/jobs/catalog.ts';
import { loadManifest } from '../../src/jobs/providers.ts';
import { normalise } from '../../src/jobs/schema.ts';

const search = (s: Record<string, unknown>) => normalise.search(s);

test('catalog ids are exactly the manifest\'s providers plus its excluded providers, and the shape is valid', () => {
  const m = loadManifest(), cat = loadCatalog();
  const excluded = Object.keys(m.excluded).filter((p) => /^providers\/[^_/][^/]*\.mjs$/.test(p)).map((p) => p.slice(10, -4));
  assert.deepEqual(cat.sources.map((s) => s.id).sort(), [...m.providers, ...excluded].sort());
  assert.deepEqual(cat.sources.map((s) => s.id), [...cat.sources.map((s) => s.id)].sort(), 'sorted by id');
  for (const id of excluded) assert.equal(catalogEntry(id)!.runnable, false, `${id} can't run`);
  for (const id of m.providers) assert.equal(catalogEntry(id)!.runnable, true, `${id} runs`);
  assert.deepEqual(catalogIssues(), []);
  assert.equal(catalogEntry('linkedin')!.kind, 'board');
  assert.deepEqual(catalogEntry('linkedin')!.switch, ['linkedin_search', 'linkedin_links', 'easy_apply']);
});

test('detect means "a bare careers_url routes here": every such entry is a manifest detector, and the ones that only match provider: are not', () => {
  const m = loadManifest();
  for (const s of loadCatalog().sources) if (s.detect) assert.ok(m.detectors.includes(s.id), `${s.id} detects but the runner wouldn't load it`);
  // Settled from the code (P9a): detect() that returns null, matches only `provider: <id>`, or isn't there.
  for (const id of ['glints', 'builtin', 'sitemap', 'jobstreet', 'kalibrr', 'wttj', 'tes', 'himalayas', 'weworkremotely', 'radancy', 'rexx']) assert.equal(catalogEntry(id)!.detect, false, id);
  for (const id of ['workday', 'greenhouse', 'neogov', 'lever', 'icims', 'darwinbox']) assert.equal(catalogEntry(id)!.detect, true, id);
});

test('confidence is graded and explained: anything below high says what the code could not confirm', () => {
  const cat = loadCatalog();
  const by = (c: string) => cat.sources.filter((s) => s.confidence === c);
  assert.ok(by('high').length >= 60);
  assert.ok(by('low').length <= 3, 'low only where kind or regions is a guess');
  for (const s of [...by('medium'), ...by('low')]) assert.ok(s.unsure && s.unsure.length > 20, `${s.id} explains itself`);
  assert.equal(catalogEntry('themuse')!.blocked, true, 'Cloudflare blocks it: never suggested');
  assert.equal(catalogEntry('remote-com')!.kind, 'employer', 'one company\'s openings, not a remote board');
  assert.equal(catalogEntry('neogov')!.needs, 'careers_url', 'one agency per entry');
  assert.ok(FAMILIES().includes('healthcare') && FAMILIES().includes('any'));
});

test('every needs: config entry that can run has fill rules', () => {
  for (const s of loadCatalog().sources) if (s.needs === 'config' && s.runnable && s.kind !== 'feed') assert.ok(s.fill, `${s.id} has fill rules`);
});

test('userTitles and userCountries: targets first, then roles.titles; on-site, remote-from, then home country', () => {
  const s = search({ roles: { titles: ['analyst'], targets: [{ titles: ['Buchhalter', 'accountant'], families: ['finance-accounting'] }] }, places: { onsite: ['Berlin'], remote_from: ['Austria', 'European Union'] } });
  assert.deepEqual(userTitles(s), ['Buchhalter', 'accountant', 'analyst']);
  assert.deepEqual(userCountries(s, 'Switzerland'), ['de', 'at', 'ch']);
});

// One test per fill rule in the catalog (design §22 P9a exit check).
const A = search({ roles: { targets: [{ titles: ['Buchhalter', 'Finanzbuchhalter', 'accountant', 'controller', 'Bilanzbuchhalter', 'tax clerk'] }] }, places: { onsite: ['Berlin'] } });
const fill = (id: string, s = A, country = '') => fillEntry({ provider: id }, catalogEntry(id), { search: s, country });

test('fill arbeitsagentur: keywords are the first five titles; required', () => {
  assert.deepEqual(fill('arbeitsagentur').entry.arbeitsagentur, { keywords: ['Buchhalter', 'Finanzbuchhalter', 'accountant', 'controller', 'Bilanzbuchhalter'] });
  assert.match(fill('arbeitsagentur', search({})).missing!, /needs keywords .*they come from your job titles; add a title/);
  // A key the user set keeps their value.
  assert.deepEqual(fillEntry({ provider: 'arbeitsagentur', arbeitsagentur: { keywords: ['Steuerfachangestellte'], wo: 'Berlin' } }, catalogEntry('arbeitsagentur'), { search: A }).entry.arbeitsagentur, { keywords: ['Steuerfachangestellte'], wo: 'Berlin' });
  assert.deepEqual(fillEntry({ provider: 'arbeitsagentur', arbeitsagentur: { wo: 'Berlin' } }, catalogEntry('arbeitsagentur'), { search: A }).entry.arbeitsagentur, { wo: 'Berlin', keywords: ['Buchhalter', 'Finanzbuchhalter', 'accountant', 'controller', 'Bilanzbuchhalter'] });
});

test('fill builtin, occ, apple: queries from titles; required', () => {
  assert.deepEqual((fill('builtin').entry.builtin as any).queries.length, 5);
  assert.deepEqual(fill('occ').entry.queries, ['Buchhalter', 'Finanzbuchhalter', 'accountant', 'controller', 'Bilanzbuchhalter']);
  assert.deepEqual((fill('apple').entry.apple as any).queries[0], 'Buchhalter');
  for (const id of ['builtin', 'occ', 'apple']) assert.ok(fill(id, search({})).missing, id);
});

test('fill wttj: up to three title queries and an office-country filter from the user\'s places', () => {
  const fr = search({ roles: { titles: ['comptable', 'accountant', 'controller', 'auditor'] }, places: { onsite: ['Paris'] } });
  assert.deepEqual(fill('wttj', fr).entry.wttj, { queries: ['comptable', 'accountant', 'controller'], filters: 'offices.country_code:FR' });
  assert.deepEqual(fill('wttj', search({ roles: { titles: ['designer'] } })).entry.wttj, { queries: ['designer'] }, 'no country: no filter');
});

test('fill amazon and google: first title, the on-site place, the country name', () => {
  assert.deepEqual(fill('amazon').entry.amazon, { base_query: 'Buchhalter', loc_query: 'Berlin' });
  assert.deepEqual(fill('google').entry.google, { queries: ['Buchhalter', 'Finanzbuchhalter', 'accountant', 'controller', 'Bilanzbuchhalter'], location: 'Germany' });
  assert.equal(fill('amazon', search({})).missing, undefined, 'optional');
});

test('fill jobstreet: the market host and site key from the user\'s country; none for the Philippines (no host)', () => {
  const sg = search({ roles: { titles: ['nurse'] }, places: { onsite: ['Singapore'] } });
  assert.deepEqual(fill('jobstreet', sg).entry, { provider: 'jobstreet', api: 'https://sg.jobstreet.com/api/jobsearch/v5/search', siteKey: 'SG-Main', searchKeywords: 'nurse' });
  const ph = search({ roles: { titles: ['nurse'] }, places: { onsite: ['Manila'] } });
  assert.match(fill('jobstreet', ph).missing!, /covers Indonesia, Singapore, Malaysia, Australia, New Zealand, Hong Kong: none of your places is there/);
});

test('fill glints and kalibrr: country code and keywords', () => {
  const vn = search({ roles: { titles: ['kế toán'] }, places: { onsite: ['Vietnam'] } });
  assert.deepEqual(fill('glints', vn).entry, { provider: 'glints', countryCode: 'VN', searchKeywords: 'kế toán' });
  assert.ok(fill('glints', search({ roles: { titles: ['x'] }, places: { onsite: ['Manila'] } })).missing);
  assert.deepEqual(fill('kalibrr', vn).entry, { provider: 'kalibrr', searchKeywords: 'kế toán' });
  assert.equal(fill('kalibrr', search({})).missing, undefined);
});

test('the home country counts when places are empty', () => {
  assert.equal(fill('glints', search({ roles: { titles: ['x'] } }), 'Malaysia').entry.countryCode, 'MY');
});
