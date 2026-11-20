// Source plan table (ADR-0001): field × place × work mode → ordered sources with reasons and an honest coverage score,
// for the eight acceptance personas of the Jobs v2 design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES } from '../../../src/jobs/catalog.ts';
import { API_IDS, MAX_SOURCES, type Plan, type PlanProfile, planSources, planTableIssues } from '../../../src/jobs/directory/plan.ts';

const ids = (p: Plan) => p.sources.map((s) => s.id);
const kinds = (p: Plan) => p.sources.map((s) => s.kind);
const companiesOf = (p: Plan, i: number) => (p.sources[i].params.companies as { name: string }[]).map((c) => c.name);

function check(p: Plan) {
  assert.ok(p.sources.length >= 5 && p.sources.length <= MAX_SOURCES, `${p.sources.length} sources`);
  assert.equal(new Set(ids(p)).size, p.sources.length, 'no source twice');
  for (const s of p.sources) {
    assert.ok(s.reason, `${s.id} has a reason`);
    if (s.kind === 'api') assert.ok((API_IDS as readonly string[]).includes(s.id), s.id);
  }
  assert.ok(ids(p).includes('watchlist') && ids(p).at(-1) === 'linkedin-import', 'own watchlist and LinkedIn import (manual, last)');
  assert.equal(p.sources.at(-1)!.kind, 'manual');
  assert.ok(p.coverage.score >= 0 && p.coverage.score <= 1 && p.coverage.note);
}

test('the table is well-formed: registry ids, gazetteer places, catalog families, a catch-all row', () => {
  assert.deepEqual(planTableIssues(undefined, FAMILIES()), []);
});

const persona = (p: PlanProfile) => { const r = planSources(p); check(r); return r; };

test('remote backend engineer eligible from India: remote-friendly company feeds, then remote boards, then India', () => {
  const r = persona({ families: ['engineering-it'], countries: ['in'], workModes: ['remote'], titles: ['Backend Engineer'] });
  assert.equal(r.sources[0].kind, 'company-feeds');
  assert.ok(companiesOf(r, 0).includes('GitLab'));
  assert.deepEqual(ids(r).slice(1, 3), ['himalayas', 'remotive']);
  assert.ok(ids(r).includes('adzuna') && ids(r).includes('jooble'));
  assert.deepEqual(r.sources.find((s) => s.id === 'adzuna')!.params.countries, ['in']);
  assert.equal(r.sources[1].params.remote, 'only');
  assert.ok(r.coverage.score >= 0.5);
  assert.match(r.coverage.note, /US\/EU-only/);
});

test('AI engineer on-site in Bengaluru: India company feeds first (incl. Keka), Adzuna India, no remote boards', () => {
  const r = persona({ families: ['data', 'engineering-it'], countries: ['in/bengaluru'], workModes: ['onsite'], titles: ['AI Engineer'] });
  assert.equal(r.sources[0].kind, 'company-feeds');
  assert.ok(companiesOf(r, 0).includes('Groww') && companiesOf(r, 0).includes('Kickdrum'));
  assert.deepEqual(ids(r).slice(1, 3), ['adzuna', 'jooble']);
  assert.ok(!ids(r).includes('himalayas') && !ids(r).includes('remotive'));
  assert.match(r.coverage.note, /Naukri/);
});

test('PM career-changer in India: product companies, aggregators, a lower score that points to LinkedIn and APM titles', () => {
  const r = persona({ families: ['product-project'], countries: ['in'], workModes: ['hybrid', 'onsite'], titles: ['Associate Product Manager'] });
  assert.equal(r.rows[0], 'product-india');
  assert.equal(r.sources[0].kind, 'company-feeds');
  assert.ok(r.coverage.score < 0.6);
  assert.match(r.coverage.note, /LinkedIn/);
  assert.match(r.coverage.note, /APM/);
});

test('RN moving from Australia to the US: hospital feeds, then USAJobs (VA), then aggregators; licence note', () => {
  const r = persona({ families: ['healthcare'], countries: ['us'], workModes: ['onsite'], titles: ['Registered Nurse'] });
  assert.equal(r.sources[0].kind, 'company-feeds');
  assert.ok(companiesOf(r, 0).includes('Mass General Brigham'));
  assert.deepEqual(ids(r).slice(1, 4), ['usajobs', 'adzuna', 'jooble']);
  assert.match(r.coverage.note, /NCLEX/);
  assert.ok(r.coverage.score <= 0.6);
});

test('UK teacher: DfE Teaching Vacancies first, then Reed; England-only caveat', () => {
  const r = persona({ families: ['education'], countries: ['gb'], workModes: ['onsite'], titles: ['Secondary Teacher'] });
  assert.deepEqual(ids(r).slice(0, 2), ['teaching-vacancies', 'reed']);
  assert.ok(!ids(r).includes('nhs-jobs') && !ids(r).includes('usajobs'));
  assert.ok(r.coverage.score >= 0.7);
  assert.match(r.coverage.note, /England/);
});

test('Germany accountant: BA Jobsuche first, German employers and boards next', () => {
  const r = persona({ families: ['finance-accounting'], countries: ['de'], workModes: ['onsite', 'hybrid'], titles: ['Buchhalter'] });
  assert.equal(ids(r)[0], 'ba-jobsuche');
  assert.ok(ids(r).includes('arbeitnow') && ids(r).includes('adzuna'));
  assert.deepEqual(r.sources.find((s) => s.id === 'adzuna')!.params.countries, ['de']);
  assert.ok(r.coverage.score >= 0.6);
});

test('US warehouse worker: aggregators first, USAJobs, low coverage that says to watch the big employers', () => {
  const r = persona({ families: ['logistics-transport'], countries: ['us'], workModes: ['onsite'], titles: ['Warehouse Associate'] });
  assert.deepEqual(ids(r).slice(0, 3), ['adzuna', 'jooble', 'usajobs']);
  assert.ok(r.coverage.score < 0.4);
  assert.match(r.coverage.note, /Amazon/);
  assert.match(r.coverage.note, /watchlist/);
});

test('EU freelance translator: remote boards, very low coverage, says where freelance work actually is', () => {
  const r = persona({ families: ['creative-media'], countries: ['european-union'], workModes: ['remote'], titles: ['Translator'], freelance: true });
  assert.deepEqual(ids(r).slice(0, 3), ['himalayas', 'remotive', 'arbeitnow']);
  assert.ok(!ids(r).includes('usajobs') && !ids(r).includes('reed'));
  assert.ok(r.coverage.score <= 0.3);
  assert.match(r.coverage.note, /agenc/);
});

test('India healthcare is honestly low; the watchlist and careers pages are kept', () => {
  const r = planSources({ families: ['healthcare'], countries: ['in'], workModes: ['onsite'], watchlist: [{ name: 'Apollo Hospitals' }], careersPages: ['https://example.org/careers'] });
  assert.ok(r.coverage.score <= 0.25, String(r.coverage.score));
  assert.deepEqual(r.sources.find((s) => s.id === 'watchlist')!.params.companies, [{ name: 'Apollo Hospitals' }]);
  assert.ok(kinds(r).includes('careers-pages'));
});
