// Work pattern, pay and rule words (design §24.8, D29–D31, D36–D38, P9g): the rules and pay checks for six fictional
// people of §24.12, each from their own search notes. N: a nurse in Columbus, nights, hourly; W: warehouse work in
// Houston, 24 hours a week; F: a freelance translator in Spain with a day rate; A: an accountant in Berlin with German
// C1; T: a teaching assistant in Leeds, term-time only; R: a store manager in Pune paid monthly in INR. Every person and
// company here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { type Posting, compileRules, describeRules, judgeBrief, prefilter } from '../../src/jobs/rules.ts';
import { normalise, validate } from '../../src/jobs/schema.ts';
import { payCheck, paySettingsOf } from '../../src/jobs/pay.ts';
import { employmentKinds } from '../../src/jobs/rule-words.ts';
import { refilter, runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { markApplied } from '../../src/jobs/pipeline/apply.ts';
import { judge, pick } from '../../src/jobs/pipeline/pick.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { role, world } from './helpers.ts';

const target = (name: string, titles: string[], families: string[]) => ({ targets: [{ name, titles, families }] });
const PEOPLE: Record<string, Record<string, unknown>> = {
  N: {
    roles: target('Nurse', ['registered nurse', 'RN'], ['healthcare']), workplace: ['onsite'],
    places: { onsite: ['Columbus, OH'], relocate_to: ['Cincinnati', 'Cleveland'], authorized_in: ['United States'] },
    employment_types: ['full-time', 'part-time', 'per-diem'], licenses: [{ name: 'RN', where: 'Ohio' }, { name: 'Nurse Licensure Compact' }],
    work_pattern: { shifts: ['night', 'weekend'], shifts_avoid: ['day'], hours_per_week: { min: 24, max: 36 } },
    needs_sponsorship: false,
    pay: { currency: 'USD', floor: 38, period: 'hour', hours_per_week: 36, days_per_week: 3, rule: 'bottom_of_range', unlisted: 'keep' },
    schedule: { daily_picks: 5, cooldown_days: 14, cooldown_scope: 'role', per_company: 2 },
  },
  W: {
    roles: target('Warehouse', ['warehouse associate', 'picker packer'], ['logistics-transport']), workplace: ['onsite'],
    places: { onsite: ['Houston, TX'] }, employment_types: ['part-time', 'temporary', 'seasonal'],
    work_pattern: { hours_per_week: { min: 20, max: 24 }, shifts: ['evening', 'weekend'] },
    pay: { currency: 'USD', floor: 15, period: 'hour', rule: 'bottom_of_range', unlisted: 'keep' },
  },
  F: {
    roles: target('Translator', ['translator', 'traductor', 'traductora'], ['creative-media']), workplace: ['remote'],
    places: { remote_from: ['Spain', 'European Union'] }, employment_types: ['freelance', 'contract'],
    languages: [{ name: 'Spanish', level: 'C2' }, { name: 'English', level: 'C1' }],
    pay: { currency: 'EUR', floor: 200, period: 'day', hours_per_week: 40, days_per_week: 5, per_unit: '€0.08 a word at least', rule: 'top_of_range', unlisted: 'keep', fx: { USD: 0.92 } },
  },
  A: {
    roles: target('Accountant', ['Buchhalter', 'accountant', 'Finanzbuchhalter'], ['finance-accounting']), workplace: ['hybrid', 'onsite'],
    places: { onsite: ['Berlin'] }, languages: [{ name: 'German', level: 'C1' }, { name: 'English', level: 'C2' }],
    exclude: { industries: ['gambling'], travel: 'occasional' },
    pay: { currency: 'EUR', floor: 50000, period: 'year', rule: 'top_of_range', unlisted: 'keep' },
  },
  T: {
    roles: target('Teaching assistant', ['teaching assistant', 'learning support assistant'], ['education']), workplace: ['onsite'],
    places: { onsite: ['Leeds'] }, licenses: [{ name: 'QTS', where: 'England' }],
    work_pattern: { term_time_only: true, hours_per_week: { max: 32 } },
    pay: { currency: 'GBP', floor: 20000, period: 'year', rule: 'top_of_range', unlisted: 'keep' },
    schedule: { cooldown_days: 14, cooldown_scope: 'role' },
  },
  R: {
    roles: target('Store manager', ['store manager', 'retail store manager'], ['retail']), workplace: ['onsite'],
    places: { onsite: ['Pune'] }, languages: [{ name: 'English' }, { name: 'Hindi' }, { name: 'Marathi' }],
    pay: { currency: 'INR', floor: 30000, period: 'month', rule: 'bottom_of_range', unlisted: 'keep' },
  },
};
const notes = (who: string, over: Record<string, unknown> = {}) => {
  const raw = { ...PEOPLE[who], ...over };
  return { search: { data: normalise.search(raw), raw } as any, memory: { data: { items: [] } } as any, career: { data: normalise.career({ skills: [] }) } as any, profile: { data: normalise.profile({ identity: { first_name: who }, standard_answers: { years_experience: '6' } }) } as any };
};
const rules = (who: string, over?: Record<string, unknown>) => compileRules(notes(who, over));
const settings = (who: string, over?: Record<string, unknown>) => paySettingsOf(notes(who, over).search.data)!;

function check(who: string, base: Posting, keeps: [string, Partial<Posting>][], drops: [string, Partial<Posting>, string][], over?: Record<string, unknown>) {
  const c = rules(who, over);
  for (const [name, p] of keeps) test(`${who} keeps: ${name}`, () => {
    const v = prefilter({ ...base, ...p }, c);
    assert.equal(v.keep, true, v.keep ? '' : `${v.rule}: ${v.reason}`);
  });
  for (const [name, p, rule] of drops) test(`${who} drops: ${name}`, () => {
    const v = prefilter({ ...base, ...p }, c);
    assert.equal(v.keep, false, name);
    if (!v.keep) assert.equal(v.rule, rule, v.reason);
  });
}

test('every persona\'s search notes validate with no errors', () => {
  for (const [who, raw] of Object.entries(PEOPLE)) assert.deepEqual(validate('search', raw).filter((i) => i.level === 'error'), [], who);
});

// ---- N: nights, hourly, 36 hours over three 12-hour shifts; would move to Cincinnati or Cleveland ----
check('N', { title: 'Registered Nurse - Night Shift', company: 'Example Health', location: 'Columbus, OH', description: '' }, [
  ['"RN - Night Shift" with hourly pay over the floor', { title: 'RN - Night Shift (ICU)', pay_text: '$40 - $48 per hour' }],
  ['a weekly rate over the floor at 36 hours ($1,500 / 36 = $41.67)', { pay_text: '$1,500 per week' }],
  ['a day rate over the floor at 12-hour days ($480 / 12 = $40)', { pay_text: '$480 per day' }],
  ['a yearly salary over the floor at 36 hours a week', { pay_text: '$85,000 per year' }],
  ['on-site in Cincinnati, where she would move', { location: 'Cincinnati, OH' }],
  ['a structured PART_TIME', { employment_type: 'PART_TIME' }],
  ['a structured PER_DIEM', { employment_type: 'PER_DIEM' }],
  ['a structured type Crewdeck doesn\'t know goes to the judge', { employment_type: 'VOLUNTEER' }],
  ['a day-only posting is the judge\'s, never a rule', { title: 'Registered Nurse - Days', description: 'Day shift only, 7a-7p.' }],
], [
  ['bottom of the hourly range below $38', { pay_text: '$34 - $40/hr' }, 'pay'],
  ['a weekly rate below the floor at 36 hours ($1,200 / 36 = $33.33)', { pay_text: '$1,200 per week' }, 'pay'],
  ['a day rate below the floor at 12-hour days ($400 / 12 = $33.33)', { pay_text: '$400 per day' }, 'pay'],
  ['on-site in Toronto', { location: 'Toronto, ON' }, 'location_elsewhere'],
  ['a structured CONTRACTOR (contract is not one of her types)', { employment_type: 'CONTRACTOR' }, 'employment_type'],
]);

test('N: the brief lists her shifts and hours (never inferred), licences with where, right to work and moving', () => {
  const b = judgeBrief(notes('N'));
  assert.match(b, /Shifts the user can work: night, weekend\. Fail postings whose hours are only shifts outside these\./);
  assert.match(b, /Shifts the user can't work: day\. Fail postings that require them\./);
  assert.match(b, /Hours a week the user wants: 24–36/);
  assert.match(b, /never infer a shift or hours limit they didn't give/);
  assert.match(b, /Licences the user holds: RN \(Ohio\), Nurse Licensure Compact\. A licence valid only in a named state/);
  assert.match(b, /may work without sponsorship in: United States\. Fail postings that require the right to work in a country outside these and say they can't sponsor/);
  assert.match(b, /would move to Cincinnati, Cleveland for a job/);
  assert.match(b, /The user has 6 years of experience: fail postings that require clearly more/);
  assert.match(b, /about 36 hours a week over 3 days/);
  assert.match(b, /quote the evidence in the posting's own words/);
  const r = describeRules(rules('N'));
  assert.match(r, /employment_type +a structured employment type .* none of: full-time, part-time, per-diem/);
  assert.match(r, /would move to Cincinnati, Cleveland/);
  assert.match(r, /36 h a week over 3 days/);
  assert.match(r, /the same title at a company in its 14-day cooldown after applying, or a company with 2 roles already picked/);
});

// ---- W: part-time, 20–24 hours; a monthly wage converts at his 24 hours, not 40 ----
check('W', { title: 'Warehouse Associate', company: 'Example Logistics', location: 'Houston, TX', description: '' }, [
  ['a monthly wage at 24 hours a week ($2,000 × 12 / 52 / 24 = $19.23)', { pay_text: '$2,000 per month' }],
  ['a structured PART_TIME', { employment_type: 'PART_TIME' }],
  ['a structured TEMPORARY (temporary and seasonal wanted)', { employment_type: 'TEMPORARY' }],
  ['"Part-time, Full-time": one of them is wanted', { employment_type: 'Part-time, Full-time' }],
  ['"Full-time" in the description is the judge\'s, never a rule', { description: 'This is a full-time role.' }],
], [
  ['a monthly wage below at 24 hours ($1,400 → $13.46)', { pay_text: '$1,400 a month' }, 'pay'],
  ['a structured FULL_TIME', { employment_type: 'FULL_TIME' }, 'employment_type'],
  ['a provider\'s "Full time"', { employment_type: 'Full time' }, 'employment_type'],
]);

test('W: hours drive the conversion (the same $2,000 a month is below $15 at 40 hours) and the brief says 20–24', () => {
  const s = settings('W');
  assert.equal(s.hoursPerWeek, 24, 'pay conversion uses the most of work_pattern.hours_per_week');
  const at24 = payCheck('$2,000 per month', '', s), at40 = payCheck('$2,000 per month', '', { ...s, hoursPerWeek: 40 });
  assert.equal(at24.status, 'ok');
  assert.equal(Math.round(at24.min! * 100) / 100, 19.23);
  assert.equal(at40.status, 'below_floor');
  assert.match(judgeBrief(notes('W')), /Hours a week the user wants: 20–24\. Fail postings whose fixed hours are clearly outside this\./);
});

// ---- F: freelance translator, a day rate, per-word work kept for the judge ----
check('F', { title: 'Traductor/a inglés-español', company: 'Example Lingua', location: 'Remoto - España', description: '' }, [
  ['"Traductor/a" with a monthly rate over the day rate (€4,500 → €207.69 a day)', { pay_text: '€4.500 al mes' }],
  ['an hourly rate at the day rate (€25 × 8 = €200)', { pay_text: '€25 per hour' }],
  ['a per-word rate is kept for the judge', { pay_text: '0,06 € por palabra' }],
  ['"EU only" passes for Spain', { description: 'EU only.' }],
  ['"solo residentes en España" passes for Spain', { description: 'Puesto solo para residentes en España.' }],
  ['a structured CONTRACTOR is freelance', { employment_type: 'CONTRACTOR' }],
  ['"100% remoto" in the location', { location: '100% remoto' }],
], [
  ['a monthly wage below the day rate (€2,400 → €110.77 a day)', { pay_text: '2.400 € al mes' }, 'pay'],
  ['"US only"', { description: 'This role is US only.' }, 'other_only'],
  ['"solo candidatos residentes en México"', { description: 'Solo candidatos residentes en México.' }, 'other_only'],
  ['a structured FULL_TIME', { employment_type: 'FULL_TIME' }, 'employment_type'],
  ['on-site in Madrid (presencial)', { location: 'Presencial - Madrid' }, 'workplace_excluded'],
]);

test('F: a per-word posting is unclear with the reason and her own rate; the brief carries per_unit as text, never a floor', () => {
  const p = payCheck('0,06 € por palabra', '', settings('F'));
  assert.equal(p.status, 'unclear');
  assert.match(p.reason, /per palabra: for the judge \(your rate: €0\.08 a word at least\)/);
  assert.equal(payCheck('$0.10 per word', '', settings('F')).status, 'unclear');
  const b = judgeBrief(notes('F'));
  assert.match(b, /Pay per unit, in the user's words: "€0\.08 a word at least"\. .* never a floor for time/);
  assert.match(b, /Spanish \(C2, native\), English \(C1, fluent\)/);
});

// ---- A: German C1, "Homeoffice", German rule words ----
check('A', { title: 'Buchhalter (m/w/d)', company: 'Example Steuer GmbH', location: 'Berlin', description: '' }, [
  ['"Homeoffice möglich" is hybrid', { location: 'Berlin (Homeoffice möglich)' }],
  ['"Hybrides Arbeiten" in the title', { title: 'Finanzbuchhalterin – Hybrides Arbeiten' }],
  ['"keine Reisetätigkeit"', { description: 'Keine Reisetätigkeit.' }],
  ['"nicht nur in Berlin" is no restriction', { description: 'Sie arbeiten nicht nur in Berlin, sondern auch in München.' }],
  ['"Wohnsitz in Deutschland" passes for Berlin', { description: 'Wohnsitz in Deutschland erforderlich.' }],
  ['a monthly German salary read as a year (4.500 € → 54,000 €)', { pay_text: '4.500 € brutto monatlich' }],
], [
  ['"100% Homeoffice" is remote only', { location: '100% Homeoffice' }, 'workplace_excluded'],
  ['"Wohnsitz in Österreich"', { description: 'Wohnsitz in Österreich erforderlich.' }, 'other_only'],
  ['"nur Bewerber aus der Schweiz"', { description: 'Wir berücksichtigen nur Bewerber aus der Schweiz.' }, 'other_only'],
  ['"Reisebereitschaft" is occasional travel', { description: 'Reisebereitschaft wird vorausgesetzt.' }, 'travel'],
  ['"regelmäßige Reisetätigkeit"', { description: 'Regelmäßige Reisetätigkeit zu Mandanten.' }, 'travel'],
  ['gambling in German (Sportwetten)', { company: 'Example Sportwetten GmbH' }, 'industry'],
]);

test('A: "Deutsch C1": CEFR levels are accepted and printed with the words they compare as', () => {
  assert.match(judgeBrief(notes('A')), /German \(C1, fluent\), English \(C2, native\)\. Fail postings that require another language, or a higher level than listed \(CEFR: A1–A2 basic, B1 conversational, B2 professional, C1 fluent, C2 native-like\)/);
  assert.deepEqual(validate('search', { languages: [{ name: 'German', level: 'C3' }] }).map((i) => i.path), ['languages[0].level', 'roles.titles', 'workplace']);
});

// ---- T: term-time only, QTS in England ----
check('T', { title: 'Teaching Assistant - Term Time Only', company: 'Example Primary School', location: 'Leeds', description: '' }, [
  ['a term-time posting with pay over the floor', { pay_text: '£21,000 per year' }],
  ['an all-year posting is the judge\'s (term-time is in the brief, not a rule)', { title: 'Teaching Assistant', description: 'All year round, 52 weeks.' }],
  ['"must be based in England" passes for Leeds', { description: 'Candidates must be based in England.' }],
], [
  ['"Scotland only"', { description: 'Scotland only.' }, 'other_only'],
]);

test('T: the brief asks for term-time contracts and QTS (England); setup\'s role-scoped cooldown is valid', () => {
  const b = judgeBrief(notes('T'));
  assert.match(b, /Term-time only: .* Fail postings that are clearly all year round \(52 weeks\)\./);
  assert.match(b, /Licences the user holds: QTS \(England\)/);
  assert.match(b, /Hours a week the user wants: up to 32/);
});

// ---- R: monthly INR, LPA postings ----
check('R', { title: 'Store Manager', company: 'Example Retail Pvt Ltd', location: 'Pune, Maharashtra', description: '' }, [
  ['a monthly wage over the floor', { pay_text: '₹35,000 per month' }],
  ['"4.2 LPA" is ₹35,000 a month', { pay_text: '4.2 LPA' }],
  ['"Maharashtra only" passes for Pune', { description: 'Maharashtra candidates only.' }],
], [
  ['"3-4 LPA": the bottom is ₹25,000 a month', { pay_text: '3-4 LPA' }, 'pay'],
  ['a monthly range below ("Rs." is the user\'s rupee)', { pay_text: 'Rs. 25,000 - 28,000 per month' }, 'pay'],
  ['"Karnataka candidates only"', { description: 'Karnataka candidates only.' }, 'other_only'],
]);
check('R', { title: 'Store Manager', company: 'Example Retail Pvt Ltd', location: 'Pune', description: '' }, [
  ['"3-4 LPA" with the top of the range: ₹33,333 a month', { pay_text: '3-4 LPA' }],
], [], { pay: { currency: 'INR', floor: 30000, period: 'month', rule: 'top_of_range' } });

// ---- data ----
test('structured employment types: JSON-LD values and providers\' words, unknown ones left to the judge', () => {
  assert.deepEqual(employmentKinds('FULL_TIME'), ['full-time']);
  assert.deepEqual(employmentKinds('CONTRACTOR')?.sort(), ['contract', 'freelance']);
  assert.deepEqual(employmentKinds('Teilzeit'), ['part-time']);
  assert.deepEqual(employmentKinds('INTERN')?.sort(), ['apprenticeship', 'internship']);
  assert.deepEqual(employmentKinds('FULL_TIME, PART_TIME')?.sort(), ['full-time', 'part-time']);
  assert.equal(employmentKinds('OTHER'), null);
  assert.equal(employmentKinds('FULL_TIME, VOLUNTEER'), null);
  assert.equal(employmentKinds(''), null);
});

test('exclude.travel: off (none still reads as off); licences as text or { name, where }; new fields typed', () => {
  assert.equal(normalise.search({ exclude: { travel: 'none' } }).exclude.travel, 'off');
  assert.equal(compileRules(notes('W', { exclude: { travel: 'off' } })).travelDrop, null);
  assert.deepEqual(validate('search', { exclude: { travel: 'none' } }).filter((i) => i.path.startsWith('exclude')), []);
  const s = normalise.search({ licenses: ['CDL Class B (Texas)', { name: 'Forklift' }, { name: 'QTS', where: 'England' }] });
  assert.deepEqual(s.licenses, ['CDL Class B (Texas)', 'Forklift', 'QTS (England)']);
  const bad = validate('search', { work_pattern: { hours_per_week: { min: 30, max: 20 }, shifts: ['nights'] }, schedule: { cooldown_scope: 'team', per_company: 0 }, pay: { period: 'fortnight' } });
  assert.deepEqual(bad.filter((i) => i.level === 'error').map((i) => i.path).sort(), ['pay.period', 'schedule.cooldown_scope', 'schedule.per_company', 'work_pattern.hours_per_week', 'work_pattern.shifts[0]']);
});

// ---- the tracker: cooldown scope and per_company; refilter round trips ----
function setSearch(w: ReturnType<typeof world>, data: Record<string, unknown>) {
  writeFileSync(join(w.vault, 'jobs', 'search.md'), `---\n${stringify({ tags: 'jobs', ...data })}---\n# Job search\n\n## Changes\n`);
}

test('N: cooldown_scope role lets another unit at the same hospital through, not the same title; company scope blocks both', () => {
  const w = world('template');
  setSearch(w, PEOPLE.N);
  const first = role(w.ctx, { company: 'Example Health', title: 'Registered Nurse - ICU Nights', location: 'Columbus, OH' });
  markApplied(w.ctx, first);
  const other = role(w.ctx, { company: 'Example Health', title: 'Registered Nurse - Med/Surg Nights', location: 'Columbus, OH' });
  const again = role(w.ctx, { company: 'Example Health', title: 'Registered Nurse - ICU Nights', location: 'Columbus, OH' });
  const r = runPrefilter(w.ctx);
  assert.deepEqual(r.drops.map((d) => [d.id, d.rule]), [[again, "cooldown"]]);
  assert.match(r.drops[0].reason, /you applied to this title at this company on 2026-11-19: cooldown until 2026-12-03 \(scope: role\)/);
  assert.equal((w.ctx.db.prepare('select status from roles where id=?').get(other) as any).status, 'new');
  // Company scope (the default): the whole company waits, the other unit too.
  setSearch(w, { ...PEOPLE.N, schedule: { cooldown_days: 14 } });
  const third = role(w.ctx, { company: 'Example Health', title: 'Registered Nurse - Cardiac Nights', location: 'Columbus, OH' });
  assert.deepEqual(runPrefilter(w.ctx).drops.map((d) => [d.id, d.rule]).sort(), [[other, 'cooldown'], [third, 'cooldown']].sort());
});

test('N: per_company 2 picks two roles at one hospital, never a third', () => {
  const w = world('template');
  setSearch(w, PEOPLE.N);
  const ids = ['ICU', 'Med/Surg', 'Cardiac'].map((u) => role(w.ctx, { company: 'Example Health', title: `Registered Nurse - ${u} Nights`, location: 'Columbus, OH' }));
  const elsewhere = role(w.ctx, { company: 'Example Clinic', title: 'Registered Nurse - Nights', location: 'Columbus, OH' });
  runPrefilter(w.ctx);
  judge(w.ctx, [...ids, elsewhere].map((id, i) => ({ role: id, eligible: 'yes', score: 90 - i, evidence: 'nights' })));
  const got = pick(w.ctx, 5);
  assert.deepEqual(got.sort(), [ids[0], ids[1], elsewhere].sort());
  // A new posting there is now an active_pick drop (two in progress).
  const fourth = role(w.ctx, { company: 'Example Health', title: 'Registered Nurse - Oncology Nights', location: 'Columbus, OH' });
  const r = runPrefilter(w.ctx);
  assert.deepEqual(r.drops.map((d) => [d.id, d.rule]), [[fourth, 'active_pick']]);
  assert.match(r.drops[0].reason, /2 roles picked or in progress \(per_company: 2\)/);
});

test('refilter round trips: a structured type and a pay rule come back when the notes allow them, and go again', () => {
  const w = world('template');
  setSearch(w, PEOPLE.W);
  const ft = role(w.ctx, { company: 'Example Logistics', title: 'Warehouse Associate', location: 'Houston, TX', employment_type: 'FULL_TIME' });
  const pt = role(w.ctx, { company: 'Example Depot', title: 'Picker Packer', location: 'Houston, TX', employment_type: 'PART_TIME', pay_text: '$1,400 a month' });
  const status = (id: string) => (w.ctx.db.prepare('select status from roles where id=?').get(id) as any).status;
  let r = runPrefilter(w.ctx);
  assert.deepEqual(r.drops.map((d) => [d.id, d.rule]).sort(), [[ft, 'employment_type'], [pt, 'pay']].sort());
  // He'd take full-time too, and works 40 hours on it: both come back ($1,400 a month at 40 h is below; at the floor of 8 it passes).
  setSearch(w, { ...PEOPLE.W, employment_types: ['part-time', 'full-time'], pay: { currency: 'USD', floor: 8, period: 'hour', rule: 'bottom_of_range' } });
  const back = refilter(w.ctx, 7);
  assert.equal(back.restored, 2);
  assert.deepEqual([status(ft), status(pt)], ['new', 'new']);
  // And back: the original notes drop them again.
  setSearch(w, PEOPLE.W);
  r = runPrefilter(w.ctx);
  assert.deepEqual(r.drops.map((d) => d.id).sort(), [ft, pt].sort());
  assert.match(notesOf(w.ctx).search.raw ? 'ok' : '', /ok/);
});

test('R: refilter after switching the pay rule brings "3-4 LPA" back', () => {
  const w = world('template');
  setSearch(w, PEOPLE.R);
  const lpa = role(w.ctx, { company: 'Example Retail', title: 'Store Manager', location: 'Pune', pay_text: '3-4 LPA' });
  assert.deepEqual(runPrefilter(w.ctx).drops.map((d) => [d.id, d.rule]), [[lpa, 'pay']]);
  setSearch(w, { ...PEOPLE.R, pay: { currency: 'INR', floor: 30000, period: 'month', rule: 'top_of_range' } });
  assert.equal(refilter(w.ctx, 7).restored, 1);
  const row = w.ctx.db.prepare('select pay_min, pay_max, pay_period from roles where id=?').get(lpa) as any;
  assert.deepEqual([Math.round(row.pay_min), Math.round(row.pay_max), row.pay_period], [25000, 33333, 'month']);
});
