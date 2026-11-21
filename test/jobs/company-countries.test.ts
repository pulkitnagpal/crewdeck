// ADR-0008 §8–9: the company-country preference (schema, lookup, rules, judge brief, planner, portal filter), the two
// intake kinds (company_countries, portal_toggle) and items that start later (effective_from → scheduled → applyDue).
// Fictional people only; temp homes and vaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validate, normalise, sourceItems } from '../../src/jobs/schema.ts';
import { compileRules, prefilter, allDrops, describeRules, judgeBrief } from '../../src/jobs/rules.ts';
import { REASON_LABEL } from '../../src/jobs/preview.ts';
import { companyCountry, directoryCountry, isoCountry } from '../../src/jobs/company-country.ts';
import { countryAllowed, countryPrefText } from '../../src/jobs/country-pref.ts';
import { portalAllowed, portalVerdict } from '../../src/jobs/portals/allow.ts';
import { planSources } from '../../src/jobs/directory/plan.ts';
import { loadDirectory, sha256 } from '../../src/jobs/directory/seed.ts';
import { migrate, ADDITIVE_COLUMNS } from '../../src/jobs/migrations.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { type ApplyEnv, addProposal, applyDue, approve, checkProposal, getProposal, proposalView, undo, ProposalError } from '../../src/jobs/proposals.ts';
import { sourcePlan, runSources } from '../../src/jobs/sources.ts';
import { notesOf, todayOf } from '../../src/jobs/ctx.ts';
import { NOTES } from '../../src/jobs/notes.ts';
import { setField } from '../../src/jobs/edit.ts';
import { changeSources } from '../../src/jobs/sources-note.ts';
import { role, world } from './helpers.ts';

const searchOf = (data: Record<string, unknown>) => ({ search: { data: normalise.search(data) }, memory: { data: { items: [] } } }) as any;
const cc = (only: string[] = [], exclude: string[] = []) => ({ only, exclude });

// ---- schema ----

test('companies.countries: defaults empty, codes lowercased, clear errors for a wrong form, an unknown code, both lists', () => {
  assert.deepEqual(normalise.search({}).companies, { countries: { only: [], exclude: [] } });
  assert.deepEqual(normalise.search({ companies: { countries: { exclude: ['IN', 'in', 'x'] } } }).companies.countries, { only: [], exclude: ['in'] });
  assert.deepEqual(validate('search', { companies: { countries: { only: ['de'], exclude: ['in'] } } }).filter((i) => i.path.startsWith('companies')), []);
  const bad = validate('search', { companies: { countries: { only: ['IND', 'zz'], exclude: ['de', 'in'] } } }).filter((i) => i.level === 'error');
  assert.ok(bad.some((i) => i.path === 'companies.countries.only[0]' && /wrong form/.test(i.message) && /two-letter country code/.test(i.fix!)), JSON.stringify(bad));
  assert.ok(bad.some((i) => i.path === 'companies.countries.only[1]' && /not a country code Crewdeck knows/.test(i.message)));
  const both = validate('search', { companies: { countries: { only: ['de'], exclude: ['de'] } } }).filter((i) => i.level === 'error');
  assert.deepEqual(both.map((i) => [i.path, i.message]), [['companies.countries.exclude', 'de is both in only and in exclude']]);
  const typo = validate('search', { companies: { country: { only: ['de'] } } });
  assert.ok(typo.some((i) => i.level === 'warning' && /did you mean "countries"/.test(i.fix!)));
  // The template carries the section, empty.
  const tpl = readFileSync(join(import.meta.dirname, '..', '..', 'vault-template', 'jobs', 'search.md'), 'utf8');
  assert.match(tpl, /companies:[^\n]*\n\s+countries: \{ only: \[\], exclude: \[\] \}/);
});

test('sources: a portal row is an id with no provider or page, listed once; it gets a key from the id', () => {
  const ok = { sources: [{ key: 'portal-example-jobs', name: 'Example Jobs', portal: 'example-jobs', enabled: false }] };
  assert.deepEqual(validate('sources', ok).filter((i) => i.level === 'error'), []);
  const items = sourceItems({ sources: [{ name: 'Example Jobs', portal: 'example-jobs' }] }).items;
  assert.equal(items[0].portal, 'example-jobs');
  assert.equal(items[0].key, 'portal-example-jobs');
  const errs = (d: unknown) => validate('sources', d).filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`);
  assert.deepEqual(errs({ sources: [{ key: 'p', name: 'P', portal: 'Example Jobs' }] }), ['sources[0].portal: "Example Jobs" has the wrong form']);
  assert.deepEqual(errs({ sources: [{ key: 'p', name: 'P', portal: 'ex', provider: 'remotive' }] }), ['sources[0]: a portal row takes no provider, careers_url or url']);
  assert.deepEqual(errs({ sources: [{ key: 'a', name: 'A', portal: 'ex' }, { key: 'b', name: 'B', portal: 'ex' }] }), ['sources[1].portal: the portal ex is listed twice']);
  // The providers never fetch a portal row.
  assert.deepEqual(sourcePlan({ sources: { data: sourceItems({ sources: [{ key: 'p', name: 'P', portal: 'ex' }] }) } } as any).entries, []);
});

// ---- the lookup ----

/** A tiny directory of fictional employers (its own seed, hash-pinned like the real one). */
function fakeDirectory(root: string) {
  mkdirSync(root, { recursive: true });
  const seed = join(root, 'seed.csv'), curated = join(root, 'curated.yaml');
  writeFileSync(seed, 'ats_vendor,company_name,board_slug,last_crawled\ngreenhouse,"Northwind Labs UK",northwind,2026-07-01\nlever,"Quillon Systems",quillon,2026-07-01\n');
  writeFileSync(curated, [
    'companies:',
    '  - { ats: lever, board: quillon, name: Quillon Systems, regions: [in], families: [engineering-it], remote: true, status: verified, evidence: "https://jobs.lever.co/quillon", checked: 2026-11-01 }',
    '  - { ats: ashby, board: tamarind, name: Tamarind Pay, regions: [in, us], hq: us, families: [engineering-it], remote: true, status: verified, evidence: "https://jobs.ashbyhq.com/tamarind", checked: 2026-11-01 }',
    '  - { ats: ashby, board: vellum, name: Vellum Works, regions: [in, us], families: [engineering-it], status: verified, evidence: "https://jobs.ashbyhq.com/vellum", checked: 2026-11-01 }',
  ].join('\n'));
  return loadDirectory({ seedFile: seed, pin: sha256(readFileSync(seed)), curatedFile: curated });
}

test('companyCountry: curated hq, then a curated single home country; names guessed from seed rows never count; then the role', () => {
  const w = world('berlin-analyst');
  const dir = fakeDirectory(join(w.root, 'dir'));
  assert.equal(companyCountry(null, 'Tamarind Pay', { directory: dir }), 'us', 'hq wins over regions');
  assert.equal(companyCountry(null, 'Quillon Systems Pvt. Ltd.', { directory: dir }), 'in', 'one curated region, legal suffix ignored');
  assert.equal(companyCountry(null, 'Vellum Works', { directory: dir }), null, 'two regions, no hq: unknown');
  assert.equal(directoryCountry(dir.byId.get('greenhouse:northwind')!), null, '"UK" in a seed name is not where it is from');
  assert.equal(companyCountry(null, 'Northwind Labs UK', { directory: dir }), null);
  // Feed or portal metadata on the role: the hint, the role's stored column, another role at that company.
  assert.equal(companyCountry(null, 'Unlisted Co', { directory: dir, company_country: 'DE' }), 'de');
  assert.equal(companyCountry(null, 'Unlisted Co', { directory: dir, company_country: 'zz' }), null);
  const id = role(w.ctx, { company: 'Brightfield Analytics', company_country: 'NL' });
  assert.equal(w.ctx.db.prepare('select company_country c from roles where id = ?').get(id)!.c, 'nl', 'stored lowercased');
  assert.equal(companyCountry(w.ctx, 'Brightfield Analytics', { directory: dir, role: id }), 'nl');
  assert.equal(companyCountry(w.ctx, 'Brightfield Analytics GmbH', { directory: dir }), 'nl', 'another role at the company');
  assert.equal(companyCountry(w.ctx, 'Nobody Knows Ltd', { directory: dir }), null);
  // An upsert without the field keeps what an earlier source said.
  role(w.ctx, { company: 'Brightfield Analytics', url: w.ctx.db.prepare('select url from roles where id = ?').get(id)!.url as string });
  assert.equal(w.ctx.db.prepare('select company_country c from roles where id = ?').get(id)!.c, 'nl');
  assert.equal(isoCountry('IN'), 'in');
  assert.equal(isoCountry('eu'), null);
  // The shipped directory: curated hq entries resolve.
  assert.ok(loadDirectory().companies.some((c) => c.hq === 'in'));
});

test('the migration adds roles.company_country to an older database, once (no version step)', () => {
  const w = world('berlin-analyst');
  const db = new DatabaseSync(join(w.root, 'old.db'));
  migrate(db);
  db.exec('alter table roles drop column company_country');
  const v = Number((db.prepare('PRAGMA user_version').get() as any).user_version);
  assert.equal(migrate(db), v, 'the version is untouched');
  assert.ok((db.prepare('PRAGMA table_info(roles)').all() as any[]).some((c) => c.name === 'company_country'));
  assert.equal(migrate(db), v, 'safe to run again');
  assert.deepEqual(ADDITIVE_COLUMNS.map((c) => `${c.table}.${c.column}`), ['roles.company_country']);
  db.close();
});

// ---- rules and the judge ----

test('rules: a company whose country is known and not wanted drops ("company country"); unknown passes', () => {
  const c = compileRules(searchOf({ companies: { countries: { exclude: ['in'] } } }));
  const post = { title: 'Data Analyst', company: 'Quillon Systems', location: '' };
  assert.deepEqual(prefilter({ ...post, company_country: 'in' }, c), { keep: false, rule: 'company_country', reason: 'company from India (you want only companies headquartered outside India)' });
  assert.deepEqual(prefilter({ ...post, company_country: null }, c), { keep: true });
  assert.deepEqual(prefilter({ ...post, company_country: 'us' }, c), { keep: true });
  assert.equal(allDrops({ ...post, company_country: 'in' }, c)[0].group, 'company');
  assert.equal(REASON_LABEL.company_country, 'company country');
  const only = compileRules(searchOf({ companies: { countries: { only: ['de', 'at'] } } }));
  assert.equal(prefilter({ ...post, company_country: 'fr' }, only).keep, false);
  assert.equal(prefilter({ ...post, company_country: 'at' }, only).keep, true);
  const none = compileRules(searchOf({}));
  assert.equal(none.companyCountries, null);
  assert.equal(prefilter({ ...post, company_country: 'in' }, none).keep, true);
  assert.match(describeRules(c), /company_country\s+only companies headquartered outside India, when the company's country is known/);
  assert.match(describeRules(none), /company_country\s+off/);
  assert.equal(countryAllowed('IN', cc([], ['in'])), false);
  assert.equal(countryPrefText(cc(['de', 'at'])), 'only companies headquartered in Germany or Austria');
});

test('the judge brief carries the preference as an eligibility line, unclear when the posting does not say', () => {
  const w = world('berlin-analyst');
  setField(join(w.vault, NOTES.search), 'search', ['companies', 'countries', 'exclude'], 'in');
  const brief = judgeBrief(notesOf(w.ctx));
  const elig = brief.split('## Scoring')[0];
  assert.match(elig, /- Company country: only companies headquartered outside India: decide from the posting or the company's own page .*answer "unclear" when it doesn't say\./);
  setField(join(w.vault, NOTES.search), 'search', ['companies', 'countries', 'exclude'], '');
  assert.doesNotMatch(judgeBrief(notesOf(w.ctx)), /Company country/);
});

test('the prefilter drops roles at companies from a country the person excluded; unknown and allowed ones stay', () => {
  const w = world('berlin-analyst');
  setField(join(w.vault, NOTES.search), 'search', ['companies', 'countries', 'exclude'], 'nl');
  const out = role(w.ctx, { company: 'Brightfield Analytics', company_country: 'nl' });
  const unknown = role(w.ctx, { company: 'Larkspur Data' });
  const fine = role(w.ctx, { company: 'Oakmont Insights', company_country: 'de' });
  const r = runPrefilter(w.ctx);
  const st = (id: string) => w.ctx.db.prepare('select status, status_reason from roles where id = ?').get(id) as any;
  assert.equal(st(out).status, 'prefiltered_out');
  assert.match(st(out).status_reason, /^company_country: company from Netherlands/);
  assert.notEqual(st(unknown).status, 'prefiltered_out');
  assert.notEqual(st(fine).status, 'prefiltered_out');
  assert.ok(r.drops.some((d) => d.rule === 'company_country'));
});

// ---- the planner and portals ----

test('the planner: "only non-Indian companies" skips the India company set and companies known to be Indian', () => {
  const base = { families: ['engineering-it'], countries: ['in'], workModes: ['remote' as const], titles: ['Backend Engineer'] };
  const before = planSources(base);
  assert.ok(before.sources.some((s) => s.id === 'company-feeds:india-tech-employers'), 'the India set is planned without the preference');
  const after = planSources({ ...base, companyCountries: cc([], ['in']) });
  assert.ok(!after.sources.some((s) => s.id === 'company-feeds:india-tech-employers'));
  assert.match(after.coverage.note, /skipped the local company set: you want only companies headquartered outside India/);
  const dir = loadDirectory();
  const picks = after.sources.filter((s) => s.kind === 'company-feeds').flatMap((s) => (s.params.companies as any[]));
  assert.ok(picks.length, 'a remote-friendly set is still planned');
  assert.ok(picks.every((p) => directoryCountry(dir.byId.get(p.id)!) !== 'in'), 'no company known to be Indian');
  // Someone abroad who excludes India keeps their local set.
  const de = planSources({ families: ['engineering-it'], countries: ['de'], workModes: ['onsite' as const], companyCountries: cc([], ['in']) });
  assert.doesNotMatch(de.coverage.note, /skipped the local company set/);
});

test('portalAllowed (ADR-0008 §8): an India-only portal is skipped for "only non-Indian companies"; multi-country and worldwide portals stay', () => {
  const noIndia = cc([], ['in']);
  assert.equal(portalAllowed(['in'], noIndia, ['in', 'world']), false);
  assert.match(portalVerdict(['in'], noIndia, ['in']).why, /lists jobs in in only, and you want only companies headquartered outside India/);
  assert.equal(portalAllowed(['in'], null, ['in']), true, 'no preference');
  assert.equal(portalAllowed(['in'], cc([], []), []), true);
  assert.equal(portalAllowed(['in', 'ae'], noIndia, []), true, 'another country is still wanted');
  assert.equal(portalAllowed(['world'], noIndia, ['in']), true, 'a portal for anywhere');
  assert.equal(portalAllowed([], noIndia, ['in']), true);
  assert.equal(portalAllowed(['au'], null, ['in']), false, 'a portal for a country the person does not work in');
  assert.equal(portalAllowed(['in'], null, ['in/bengaluru']), true, 'a city folds to its country');
  assert.equal(portalAllowed(['de'], cc(['us']), ['de']), false, 'only: [us] bars a Germany-only portal');
  assert.equal(portalAllowed(['de'], null, ['european-union']), true, 'a region the person works in contains the country');
});

// ---- the two intake kinds ----

const envOf = (w: ReturnType<typeof world>) => {
  const links: string[] = [];
  const e: ApplyEnv = { ctx: w.ctx, queueLink: (url) => { links.push(url); return links.length; }, cancelLink: () => true };
  return e;
};
const search = (w: ReturnType<typeof world>) => notesOf(w.ctx).search.data;
const portals = (w: ReturnType<typeof world>) => notesOf(w.ctx).sources.data.items.filter((x) => x.portal);

test('company_countries: checked, applied at once from the person\'s words, logged, undone to what it was', () => {
  const w = world('berlin-analyst');
  const e = envOf(w);
  for (const [payload, msg] of [
    [{}, /give only, exclude or both/], [{ exclude: ['india'] }, /"india" is not a two-letter country code/],
    [{ exclude: 'in' }, /must be a list/], [{ only: ['de'], exclude: ['de'] }, /de is in both only and exclude/], [{ exclude: ['in'], also: 1 }, /unknown field "also"/],
  ] as const) assert.throws(() => checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'company_countries', payload, reason: 'r' }] }), (err: any) => err instanceof ProposalError && msg.test(err.message));
  setField(join(w.vault, NOTES.search), 'search', ['companies', 'countries', 'exclude'], 'nl');
  const said = 'only companies from outside India please';
  const p = addProposal(e, checkProposal({ origin: 'person', summary: 'No Indian companies', items: [{ kind: 'company_countries', payload: { exclude: ['IN'] }, reason: 'You want companies from outside India', evidence: 'only companies from outside India' }] }), { told: said });
  assert.equal(p.items[0].status, 'approved');
  assert.equal(p.items[0].auto, true);
  assert.deepEqual(search(w).companies.countries, { only: [], exclude: ['in'] });
  assert.match(readFileSync(join(w.vault, NOTES.search), 'utf8'), /companies\.countries\.exclude: nl → in\. "only companies from outside India"/);
  const v = proposalView(p).items[0];
  assert.equal(v.line, 'Only companies headquartered outside India');
  assert.equal(v.can_undo, true);
  undo(e, p.id, 1);
  assert.deepEqual(search(w).companies.countries.exclude, ['nl'], 'back to what it was');
});

test('portal_toggle: writes a portal row in jobs/sources.md (added switched off, or switched), undoable', () => {
  const w = world('berlin-analyst');
  const e = envOf(w);
  assert.throws(() => checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'portal_toggle', payload: { portal: 'Example', on: false }, reason: 'r' }] }), /portal id/);
  assert.throws(() => checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'portal_toggle', payload: { portal: 'example-jobs', on: 'no' }, reason: 'r' }] }), /on is true/);
  const told = 'stop scanning example jobs';
  const off = addProposal(e, checkProposal({ origin: 'person', summary: 'off', items: [{ kind: 'portal_toggle', payload: { portal: 'example-jobs', on: false }, reason: 'Switch it off', evidence: told }] }), { told });
  assert.equal(off.items[0].status, 'approved');
  assert.deepEqual(portals(w).map((x) => [x.portal, x.enabled, x.key]), [['example-jobs', false, 'portal-example-jobs']]);
  assert.equal(proposalView(off).items[0].line, 'Switch off the portal example-jobs');
  undo(e, off.id, 1);
  assert.deepEqual(portals(w), [], 'the row it added is removed');
  // An existing row is switched, and undo switches it back.
  changeSources(w.ctx, { op: 'add', source: { portal: 'example-jobs', name: 'Example Jobs' } });
  const again = addProposal(e, checkProposal({ origin: 'person', summary: 'off', items: [{ kind: 'portal_toggle', payload: { portal: 'example-jobs', on: false }, reason: 'Switch it off', evidence: told }] }), { told });
  assert.match(again.items[0].done!, /switched off the portal Example Jobs/);
  assert.equal(portals(w)[0].enabled, false);
  undo(e, again.id, 1);
  assert.equal(portals(w)[0].enabled, true);
  // Adding the same portal twice is refused with a plain message.
  assert.throws(() => changeSources(w.ctx, { op: 'add', source: { portal: 'example-jobs' } }), /already in your list as portal-example-jobs/);
});

// ---- effective_from ----

test('effective_from: approved before its day it waits as scheduled ("Starts <date>"), applies on the day, Undo before cancels', () => {
  const w = world('berlin-analyst', { now: '2026-11-21T20:00:00Z' }); // 21:00 in Berlin
  const e = envOf(w);
  const today = todayOf(w.ctx);
  assert.equal(today, '2026-11-21');
  assert.throws(() => checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'company_countries', payload: { exclude: ['in'] }, reason: 'r', effective_from: '2026-11-31' }] }), /effective_from is a date, YYYY-MM-DD/);
  assert.throws(() => checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'company_countries', payload: { exclude: ['in'] }, reason: 'r', effective_from: 'tomorrow' }] }), /effective_from/);
  const said = 'from tomorrow just scan non-Indian companies or portals';
  const p = addProposal(e, checkProposal({
    origin: 'person', summary: 'From tomorrow: no Indian companies or portals',
    items: [
      { kind: 'company_countries', payload: { exclude: ['in'] }, reason: 'Only companies outside India', evidence: 'just scan non-Indian companies', effective_from: '2026-11-22' },
      { kind: 'portal_toggle', payload: { portal: 'example-in', on: false }, reason: 'An India-only portal', evidence: 'non-Indian companies or portals', effective_from: '2026-11-22' },
    ],
  }), { told: said });
  assert.deepEqual(p.items.map((i) => i.status), ['scheduled', 'scheduled']);
  assert.equal(p.status, 'pending', 'kept open while items wait');
  assert.deepEqual(search(w).companies.countries.exclude, [], 'nothing changed yet');
  assert.deepEqual(portals(w), []);
  const v = proposalView(getProposal(w.ctx.db, p.id));
  assert.deepEqual(v.items.map((i) => [i.starts, i.can_undo]), [['2026-11-22', true], ['2026-11-22', true]]);
  // Not yet: today in Berlin is still the 21st.
  assert.deepEqual(applyDue(e), { applied: 0, failed: [] });
  // Undo one before it starts: cancelled.
  undo(e, p.id, 2);
  assert.equal(getProposal(w.ctx.db, p.id).items[1].status, 'rejected');
  assert.equal(getProposal(w.ctx.db, p.id).items[1].undone, true);
  // The next morning in Berlin.
  w.at('2026-11-22T06:00:00Z');
  assert.deepEqual(applyDue(e), { applied: 1, failed: [] });
  const done = getProposal(w.ctx.db, p.id);
  assert.deepEqual(done.items.map((i) => i.status), ['approved', 'rejected']);
  assert.equal(done.status, 'done');
  assert.equal(done.items[0].auto, true, 'still undoable as applied from their words');
  assert.deepEqual(search(w).companies.countries.exclude, ['in']);
  assert.deepEqual(portals(w), [], 'the cancelled toggle never ran');
  assert.match(readFileSync(join(w.vault, NOTES.search), 'utf8'), /2026-11-22: companies\.countries\.exclude: \(none\) → in\. "just scan non-Indian companies"/);
  assert.deepEqual(applyDue(e), { applied: 0, failed: [] }, 'once');
});

test('effective_from: an approved (not auto) item waits too and applies with the person\'s yes; a past date applies at once', () => {
  const w = world('berlin-analyst', { now: '2026-11-21T10:00:00Z' });
  const e = envOf(w);
  const p = addProposal(e, checkProposal({ origin: 'quoted', summary: 'later', items: [
    { kind: 'exclude', payload: { field: 'industries', value: 'tobacco' }, reason: 'No tobacco', effective_from: '2026-12-01' },
    { kind: 'exclude', payload: { field: 'industries', value: 'gambling' }, reason: 'No gambling', effective_from: '2026-11-01' },
  ] }));
  assert.deepEqual(p.items.map((i) => i.status), ['pending', 'pending']);
  assert.equal(proposalView(p).items[0].starts, '2026-12-01', 'shown while it waits for approval too');
  const r = approve(e, p.id, undefined, { quote: 'yes to both' });
  assert.equal(r.applied, 2);
  assert.deepEqual(r.proposal.items.map((i) => i.status), ['scheduled', 'approved']);
  assert.deepEqual(search(w).exclude.industries, ['gambling']);
  w.at('2026-12-01T09:00:00Z');
  assert.equal(applyDue(e).applied, 1);
  assert.deepEqual(search(w).exclude.industries, ['gambling', 'tobacco']);
  assert.match(readFileSync(join(w.vault, NOTES.search), 'utf8'), /2026-12-01: exclude\.industries: gambling → gambling, tobacco\. "yes to both"/);
  // Undo of an applied, non-auto item is still refused (as before).
  assert.throws(() => undo(e, p.id, 1), /not applied by Crewdeck on its own/);
});

test('a sources run applies what is due before it fetches', async () => {
  const w = world('berlin-analyst', { now: '2026-11-21T10:00:00Z' });
  const e = envOf(w);
  const told = 'from tomorrow only companies outside India';
  addProposal(e, checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'company_countries', payload: { exclude: ['in'] }, reason: 'r', evidence: told, effective_from: '2026-11-22' }] }), { told });
  w.at('2026-11-22T10:00:00Z');
  const s = await runSources(w.ctx, { details: 0 });
  assert.deepEqual((s as any).proposals, { applied: 1, failed: [] });
  assert.deepEqual(search(w).companies.countries.exclude, ['in']);
});

test('the server applies what is due when it starts', async () => {
  const { createJobsApi } = await import('../../src/jobs/api.ts');
  const { Requests } = await import('../../src/requests.ts');
  const { FEATURE_DEFAULTS } = await import('../../src/config.ts');
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // Approved three days ago for yesterday (the server reads the real clock).
  const w = world('berlin-analyst', { now: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  const told = 'from then on only companies outside India';
  const p = addProposal(envOf(w), checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'company_countries', payload: { exclude: ['in'] }, reason: 'r', evidence: told, effective_from: day(Date.now() - 86_400_000) }] }), { told });
  assert.equal(p.items[0].status, 'scheduled');
  const c: any = { port: 0, vault: w.vault, silverbullet: { port: 4849, version: 'x' }, projects: [], apps: [], appearance: 'light',
    jobs: { enabled: true, home: w.jobsHome, workspace: w.root, browser: 'auto', fetch_every: '12h', features: { ...FEATURE_DEFAULTS } } };
  const api = createJobsApi(c, new Requests(join(w.home, 'requests.json')), { configPath: join(w.home, 'config.yaml'), browser: () => ({ name: 'Test Browser', path: '/x' }) as any });
  try {
    assert.equal(getProposal(w.ctx.db, p.id).items[0].status, 'approved');
    assert.deepEqual(search(w).companies.countries.exclude, ['in']);
  } finally { api.close(); }
});

test('the Proposals card shows an item that starts later with its date and Undo; a pending one says when it would start', async () => {
  const { render } = await import('preact-render-to-string');
  const { html } = await import('../../web/jobs/lib.js');
  const { Proposals } = await import('../../web/jobs/screens/tell.js');
  const item = (o: Record<string, unknown>) => ({ n: 1, kind: 'company_countries', line: 'Only companies headquartered outside India', reason: 'From tomorrow', evidence: null, auto: true, undone: false, done: null, error: null, ...o });
  const out = render(html`<${Proposals} data=${{ pending: [
    { id: 3, origin: 'person', summary: 's', status: 'pending', items: [item({ status: 'scheduled', starts: '2026-11-22', can_undo: true })] },
    { id: 4, origin: 'quoted', summary: 't', status: 'pending', items: [item({ status: 'pending', starts: '2026-12-01', can_undo: false, auto: false })] },
  ], recent: [] }} />`);
  assert.match(out, /Only companies headquartered outside India<\/span>\s*<button[^>]*aria-label="Undo: Only companies headquartered outside India"[^>]*>Undo<\/button><\/div><span class="hint">Starts 2026-11-22<\/span>/);
  assert.match(out, /Starts 2026-12-01 · From tomorrow/);
  assert.doesNotMatch(out, /Applied from your words/, 'a waiting item is not "applied"');
});
