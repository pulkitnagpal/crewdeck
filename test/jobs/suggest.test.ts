// "Where to look" (design D25, D42): the catalog scored from the notes of the seven fictional personas of §24.12, with
// the coverage line each one hears. Every person here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../../src/jobs/schema.ts';
import { PRESET_QUERIES, langCode, proposable, suggestSources } from '../../src/jobs/suggest.ts';
import { catalogEntry } from '../../src/jobs/catalog.ts';

const notes = (search: Record<string, unknown>, country: string) => ({ search: { data: normalise.search(search), raw: search } as any, profile: { data: normalise.profile({ identity: { country } }) } as any });
const target = (titles: string[], families: string[]) => ({ targets: [{ titles, families }] });

const PERSONAS = {
  E: notes({ roles: target(['backend engineer', 'software engineer'], ['engineering-it', 'data']), workplace: ['remote'], places: { remote_from: ['India', 'Worldwide'] }, languages: [{ name: 'English', level: 'fluent' }] }, 'India'),
  N: notes({ roles: target(['registered nurse', 'RN'], ['healthcare']), workplace: ['onsite'], places: { onsite: ['Columbus, OH'] }, languages: [{ name: 'English', level: 'native' }] }, 'United States'),
  A: notes({ roles: target(['Buchhalter', 'accountant'], ['finance-accounting']), workplace: ['hybrid', 'onsite'], places: { onsite: ['Berlin'] }, languages: [{ name: 'German', level: 'fluent' }, { name: 'English', level: 'fluent' }] }, 'Germany'),
  R: notes({ roles: target(['store manager'], ['retail']), workplace: ['onsite'], places: { onsite: ['Pune'] }, languages: [{ name: 'English' }, { name: 'Hindi' }, { name: 'Marathi' }] }, 'India'),
  G: notes({ roles: { level: 'entry', ...target(['marketing associate'], ['marketing']) }, workplace: ['onsite', 'hybrid'], places: { onsite: ['Manila'] }, languages: [{ name: 'English' }, { name: 'Filipino' }] }, 'Philippines'),
  W: notes({ roles: target(['warehouse associate', 'picker packer'], ['logistics-transport']), workplace: ['onsite'], places: { onsite: ['Houston, TX'] }, languages: [{ name: 'English' }] }, 'United States'),
  F: notes({ roles: target(['translator', 'traductor'], ['creative-media']), workplace: ['remote'], places: { remote_from: ['Spain', 'European Union'] }, languages: [{ name: 'Spanish' }, { name: 'English' }] }, 'Spain'),
};
const ids = (k: keyof typeof PERSONAS) => suggestSources(PERSONAS[k]).sources.map((s) => s.id);
const line = (k: keyof typeof PERSONAS) => suggestSources(PERSONAS[k]).coverage.line;

test('E, engineer in India, remote: remote tech boards; a warning that most remote jobs are limited to the US or Europe', () => {
  const got = ids('E');
  for (const id of ['remotive', 'weworkremotely', 'himalayas', 'remoteok', 'hackernews']) assert.ok(got.includes(id), id);
  for (const id of ['builtin', 'germantechjobs', 'itviec', 'arbeitsagentur', 'themuse', 'remote-com', 'workday']) assert.ok(!got.includes(id), `${id}: another country's board, blocked, one company, or an ATS`);
  assert.match(line('E'), /^\d+ job boards fit remote work from India for engineering-it, data \(most of their remote jobs are limited to the US or Europe\)\. Employers' careers pages work when they use .*Darwinbox/);
  assert.match(line('E'), /LinkedIn search is available if you switch it on in Jobs → Settings/);
});

test('N, nurse in Columbus: no nursing board in the US runs in Crewdeck; hospital and public-sector systems named', () => {
  assert.deepEqual(ids('N'), []);
  assert.match(line('N'), /^Crewdeck has no job board that fits United States for healthcare\. Employers' careers pages work when they use GovernmentJobs/);
  assert.match(line('N'), /tell me the employers and I'll check each; LinkedIn search is available .*; paste any posting you find\.$/);
  assert.deepEqual(suggestSources(PERSONAS.N).coverage.missing, ['no job board for healthcare in United States']);
});

test('A, accountant in Berlin: Arbeitsagentur (keywords from the titles), WTTJ and German boards; German ATSes named', () => {
  const got = ids('A');
  for (const id of ['arbeitsagentur', 'arbeitnow', 'wttj']) assert.ok(got.includes(id), id);
  const a = suggestSources(PERSONAS.A).sources.find((s) => s.id === 'arbeitsagentur')!;
  assert.deepEqual(a.fill, ['arbeitsagentur.keywords']);
  assert.match(a.reasons.join(' '), /covers Germany/);
  assert.match(line('A'), /^\d job boards fit Germany for finance-accounting/);
  assert.match(line('A'), /Personio/);
});

test('R, store manager in Pune: no Indian job board; Indian HR systems named', () => {
  assert.deepEqual(ids('R'), []);
  assert.match(line('R'), /^Crewdeck has no job board that fits India for retail\. Employers' careers pages work when they use .*Darwinbox.*Keka|Keka.*Darwinbox/);
});

test('G, graduate in Manila: only boards that read the Philippines (never JobStreet, which has no Philippines host)', () => {
  const got = ids('G');
  assert.ok(got.includes('kalibrr'));
  assert.ok(!got.includes('jobstreet') && !got.includes('glints'));
  assert.match(line('G'), /fit Philippines for marketing/);
});

test('W, warehouse in Texas: no logistics board; employers\' systems and LinkedIn named honestly', () => {
  assert.deepEqual(ids('W'), []);
  assert.match(line('W'), /^Crewdeck has no job board that fits United States for logistics-transport\./);
  assert.doesNotMatch(line('W'), /AppliTrack|Red Rover|SchoolSpring/, 'school systems aren\'t proposed for warehouse work');
});

test('F, translator in Spain, remote: European boards; never a US-only one', () => {
  const got = ids('F');
  assert.ok(got.includes('wttj'));
  for (const id of got) assert.ok(!catalogEntry(id)!.regions.every((r) => r === 'us'), id);
  assert.match(line('F'), /fit remote work from Spain for creative-media/);
});

test('nothing proposable is an ATS, an employer, retired, blocked or unrunnable; the line never names a missing source', () => {
  for (const k of Object.keys(PERSONAS) as (keyof typeof PERSONAS)[]) for (const s of suggestSources(PERSONAS[k]).sources) {
    const c = catalogEntry(s.id)!;
    assert.ok(proposable(c), `${k}: ${s.id}`);
    assert.ok(s.reasons.length > 0);
  }
  assert.equal(langCode('Deutsch'), 'de');
  assert.equal(langCode('Filipino'), 'tl');
});

test('the LinkedIn sentence follows the switch; no places: the line asks where', () => {
  assert.match(suggestSources(PERSONAS.N, {}, { linkedinOn: true }).coverage.line, /LinkedIn search is on/);
  assert.match(suggestSources(notes({}, ''), PRESET_QUERIES['onsite-city']).coverage.line, /^Tell me where you can work/);
});
