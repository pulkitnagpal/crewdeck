import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { type Posting, compileRules, describeRules, isOtherOccupation, judgeBrief, prefilter, titleFitOf, travelLevel } from '../../src/jobs/rules.ts';
import { normalise } from '../../src/jobs/schema.ts';
import { PEOPLE } from './helpers.ts';

const notesOf = (who: string) => loadJobNotes(PEOPLE[who], null);
const rulesOf = (who: string) => compileRules(notesOf(who));
type Case = [string, Partial<Posting>, string?];

function check(who: string, base: Posting, keeps: Case[], drops: Case[]) {
  const c = rulesOf(who);
  for (const [name, over] of keeps) test(`${who} keeps: ${name}`, () => {
    const v = prefilter({ ...base, ...over }, c);
    assert.equal(v.keep, true, v.keep ? '' : `${v.rule}: ${v.reason}`);
  });
  for (const [name, over, rule] of drops) test(`${who} drops: ${name}`, () => {
    const v = prefilter({ ...base, ...over }, c);
    assert.equal(v.keep, false, name);
    if (!v.keep && rule) assert.equal(v.rule, rule, v.reason);
  });
}

// Berlin: on-site/hybrid data analyst, EUR, German titles.
check('berlin-analyst', { title: 'Data Analyst', company: 'Acme', location: 'Berlin', description: '' }, [
  ['German title with (m/w/d)', { title: 'Senior Data Analyst (m/w/d)', location: 'Berlin, Germany' }],
  ['German job title', { title: 'Datenanalyst (m/w/d)' }],
  ['feminine form of a target title', { title: 'Datenanalystin', location: 'Potsdam' }],
  ['hybrid in Berlin', { location: 'Hybrid - Berlin' }],
  ['"EU residents only" passes for Berlin (containment)', { description: 'This role is open to EU residents only.' }],
  ['"must reside in Germany" passes for Berlin', { location: 'Hybrid', description: 'Candidates must reside in Germany.' }],
  ['another country excluded is not about Berlin', { description: 'Applicants from the US are not eligible.' }],
  ['pay whose top reaches the floor', { title: 'BI Analyst', pay_text: '€50.000 – €60.000 brutto pro Jahr' }],
  ['USD pay converted with fx', { pay_text: '$70,000 - $80,000 per year' }],
  ['occasional travel (threshold is frequent)', { description: 'Occasional travel to our Hamburg office.' }],
  ['no pay listed (unlisted: keep)', { description: 'Great team.' }],
  ['a Berlin office of a company that is also in Munich', { location: 'Berlin or Munich' }],
  // ADR-0003: a title outside the targets is never a drop (another occupation: ranked last, not judged).
  ['title outside the targets', { title: 'Marketing Manager' }],
], [
  ['intern', { title: 'Data Analyst Intern' }, 'title_exclude'],
  ['Werkstudent', { title: 'Werkstudent Data Analyst (m/w/d)' }, 'title_exclude'],
  ['sales', { title: 'Sales Data Analyst' }, 'title_exclude'],
  ['excluded company (legal suffix ignored)', { company: 'Example Agency' }, 'company_excluded'],
  ['remote-only posting', { location: 'Remote - Germany' }, 'workplace_excluded'],
  ['another German city', { location: 'Munich, Germany' }, 'location_elsewhere'],
  ['another country', { location: 'London, UK' }, 'location_elsewhere'],
  ['"must reside in the United States"', { location: 'Hybrid', description: 'Candidates must reside in the United States.' }, 'other_only'],
  ['"US only"', { location: 'Hybrid', description: 'This position is US only.' }, 'other_only'],
  ['"excluding Germany"', { location: 'Hybrid', description: 'We hire across Europe, excluding Germany.' }, 'place_excluded'],
  ['gambling industry (company name)', { company: 'Example Betting GmbH', description: 'A leading platform.' }, 'industry'],
  ['gambling industry (title)', { title: 'Data Analyst - Sports Betting' }, 'industry'],
  ['frequent travel', { description: 'Frequent travel to client sites (50%).' }, 'travel'],
  ['pay below the floor', { pay_text: '€40.000 – €48.000 pro Jahr' }, 'pay'],
  ['CHF pay below the floor', { pay_text: 'CHF 50,000 per year' }, 'pay'],
]);

// US nurse: remote within licensed states, hourly USD, per-diem.
check('us-nurse', { title: 'Telehealth Registered Nurse', company: 'Example Health', location: 'Remote', description: '' }, [
  ['remote in a licensed state with pay', { title: 'Telehealth Registered Nurse (RN) - Per Diem', location: 'Remote - Texas', pay_text: '$45 - $55 per hour' }],
  ['"must reside in" a list including a licensed state', { title: 'Triage Nurse', location: 'Remote, US', description: 'Must reside in Texas, Arizona or Oklahoma.' }],
  ['a city in a licensed state', { title: 'RN Case Manager', location: 'Phoenix, AZ (Remote)' }],
  ['"US only" passes for Texas', { description: 'US only.' }],
  ['one licensed state excluded, the other still open', { description: 'Not available to residents of Texas.' }],
  ['pay at the floor (bottom of range)', { pay_text: '$42/hr' }],
  ['"no travel required"', { description: 'No travel required.' }],
], [
  ['travel nurse title', { title: 'Travel Registered Nurse - ICU' }, 'title_exclude'],
  ['avoid word from memory', { title: 'Bedside RN' }, 'title_exclude'],
  ['on-site', { title: 'Registered Nurse', location: 'Onsite - Austin, TX' }, 'workplace_excluded'],
  ['remote in another state', { location: 'Remote - California' }, 'location_elsewhere'],
  ['both licensed states excluded', { description: 'This remote role is not open to candidates in Texas or Arizona.' }, 'place_excluded'],
  ['must be located elsewhere', { description: 'Candidates must be located in California.' }, 'other_only'],
  ['bottom of range below the floor', { pay_text: '$35 - $50 per hour' }, 'pay'],
  ['occasional travel (threshold is occasional)', { description: 'Travel up to 25% to clinics.' }, 'travel'],
]);

test('titles are a score, never a drop (ADR-0003): another occupation is set apart, synonyms and families fit', () => {
  const nurse = rulesOf('us-nurse'), analyst = rulesOf('berlin-analyst');
  for (const [c, title, location] of [[nurse, 'Data Analyst', 'Remote - Texas'], [analyst, 'Marketing Manager', 'Berlin'], [nurse, 'Software Engineer', 'Remote - Texas']] as const) {
    assert.equal(prefilter({ company: 'Example Co', location, description: '', title }, c).keep, true, title);
    assert.equal(isOtherOccupation(c, { title }), true, `${title} is another occupation`);
  }
  assert.equal(titleFitOf(nurse, { title: 'Staff Nurse' }).how, 'synonym');
  assert.equal(titleFitOf(nurse, { title: 'Licensed Practical Nurse' }).how, 'family');
  assert.equal(isOtherOccupation(nurse, { title: 'Licensed Practical Nurse' }), false);
  assert.match(describeRules(nurse), /title_gate\s+off: titles are a score, not a drop/);
  assert.match(describeRules(nurse), /Title fit \(a score, never a drop\): .*below 0\.25: other occupations/s);
});

// Example: remote from the EU/UK or hybrid in Lisbon, EUR per month.
check('example', { title: 'Senior Product Designer', company: 'Acme', location: 'Remote', description: '' }, [
  ['remote EMEA', { location: 'Remote - EMEA' }],
  ['remote Europe', { location: 'Remote (Europe)' }],
  ['hybrid Lisbon', { title: 'UX Designer', location: 'Hybrid - Lisbon, Portugal' }],
  ['"EU only"', { title: 'Design Lead', description: 'EU only.' }],
  ['GBP yearly pay converted to EUR a month', { location: 'Remote, UK', pay_text: '£60,000 - £70,000 per year' }],
  ['worldwide', { location: 'Remote - Worldwide' }],
  ['excluding one country is left to the judge', { location: 'Remote - Europe', description: 'Remote across Europe, excluding Portugal and the UK.' }],
  ['"from" pay has no top: kept', { pay_text: 'from €4,000 per month' }],
], [
  ['junior', { title: 'Junior Product Designer' }, 'title_exclude'],
  ['avoid title word', { title: 'Marketing Product Designer' }, 'title_exclude'],
  ['on-site', { location: 'Onsite - Lisbon' }, 'workplace_excluded'],
  ['hybrid outside commuting distance', { location: 'Hybrid - Porto' }, 'location_elsewhere'],
  ['remote US', { location: 'Remote - US' }, 'location_elsewhere'],
  ['LATAM only', { description: 'Open to candidates in LATAM only.' }, 'other_only'],
  ['all acceptable places excluded', { description: 'Not open to candidates in the EU or UK.' }, 'place_excluded'],
  ['company rule from memory', { company: 'Example Travel Co' }, 'company_rule'],
  ['crypto words in the title', { title: 'Senior Product Designer (Web3)' }, 'industry'],
  ['occasional travel', { description: 'Some travel to client offices each quarter.' }, 'travel'],
  ['USD monthly pay below', { pay_text: '$3,000 - $4,000 per month' }, 'pay'],
  ['up to, below the floor', { pay_text: 'up to €4,000 per month' }, 'pay'],
]);

test('avoid reasons show in the drop reason with the memory id', () => {
  const v = prefilter({ title: 'Bedside RN', location: 'Remote' }, rulesOf('us-nurse'));
  assert.ok(!v.keep && /not interested \("bedside" in title\): No bedside or floor roles.*\(m-2\)/.test(v.reason), JSON.stringify(v));
});

test('rules overrides replace a compiled regex by name', () => {
  const n = notesOf('example');
  n.search.data = normalise.search({ ...(n.search.raw as object), rules: { title_gate: '\\bdesigner\\b' } });
  const c = compileRules(n);
  assert.equal(c.source.title_gate, 'rules (your override)');
  assert.equal(prefilter({ title: 'Graphic Designer', location: 'Remote' }, c).keep, true);
  assert.equal(prefilter({ title: 'Graphic Designer', location: 'Remote' }, rulesOf('example')).keep, true, 'without the override the title is a score');
  assert.equal(prefilter({ title: 'Product Manager', location: 'Remote' }, c).keep, false, 'the override is an explicit rule: it drops');
});

test('no places or unknown places: location drops are off, not guessed', () => {
  const n = notesOf('berlin-analyst');
  n.search.data = normalise.search({ ...(n.search.raw as object), places: { onsite: ['Springfield'] } });
  const c = compileRules(n);
  assert.equal(prefilter({ title: 'Data Analyst', location: 'Tokyo, Japan' }, c).keep, true);
  assert.match(describeRules(c), /Springfield not in the gazetteer/);
});

test('travel level reads percentages and skips "no travel" sentences', () => {
  const c = rulesOf('example');
  assert.equal(travelLevel('Travel: up to 75%.', c), 'frequent');
  assert.equal(travelLevel('Travel 10%.', c), 'occasional');
  assert.equal(travelLevel('No travel required. Great benefits.', c), 'none');
  assert.equal(travelLevel('Regular travel to Berlin is required.', c), 'frequent');
});

test('describeRules prints every hard drop and its source', () => {
  const out = describeRules(rulesOf('berlin-analyst'));
  for (const s of ['title_gate', 'title_exclude', 'workplace_excluded', 'location_elsewhere', 'place_excluded', 'other_only', 'industry', 'travel', 'pay', 'below 55000 EUR/year']) assert.ok(out.includes(s), s);
});

test('judge brief: the person\'s settings, and nothing from anyone else', () => {
  const nurse = judgeBrief(notesOf('us-nurse'));
  for (const s of ['Riley', 'Texas, Arizona', 'RN (Texas)', 'per-diem', 'English (native)', 'Spanish (conversational)', '42 USD per hour', 'No bedside or floor roles', 'Night and weekend shifts', 'does not need visa sponsorship', 'Epic']) assert.ok(nurse.includes(s), s);
  const berlin = judgeBrief(notesOf('berlin-analyst'));
  for (const s of ['Ada', 'Berlin', 'German (conversational)', 'full-time', '55000 EUR per year', 'No agency roles', 'Prefer product companies over agencies', 'Not remote']) assert.ok(berlin.includes(s), s);
  const designer = judgeBrief(notesOf('example'));
  for (const s of ['European Union, United Kingdom', 'Lisbon', 'Example Travel Co', 'public design system']) assert.ok(designer.includes(s), s);
  const others: [string, string[]][] = [[nurse, ['Berlin', 'Germany', 'EUR', 'Lisbon', 'Ada']], [berlin, ['Texas', 'USD', 'Lisbon', 'Riley']], [designer, ['Texas', 'Berlin', 'USD']]];
  for (const [text, banned] of others) for (const b of banned) assert.ok(!text.includes(b), `brief mentions ${b}`);
  // No country is hard-coded: a brief built from empty notes names no place at all.
  const empty = judgeBrief(loadJobNotes(PEOPLE.template, null));
  for (const b of ['India', 'Germany', 'United States', 'US', 'EU', 'INR', 'EUR', 'USD']) assert.ok(!new RegExp(`\\b${b}\\b`).test(empty), `template brief mentions ${b}`);
});

test('C7: industry words in the description go to the judge, never a hard drop (boilerplate, negations, client lists)', () => {
  const c = rulesOf('berlin-analyst');
  for (const description of ['We do not work with gambling or betting companies.', 'Our clients range from banks to casinos and airlines.', 'No crypto experience needed.']) {
    const v = prefilter({ title: 'Data Analyst', company: 'Acme', location: 'Berlin', description }, c);
    assert.equal(v.keep, true, description);
  }
  assert.match(judgeBrief(notesOf('berlin-analyst')), /industries .*gambling/, 'the judge still knows');
});

test('C6: only a percentage next to "travel" (about 25 characters) counts as the travel share', () => {
  const c = rulesOf('example');
  assert.equal(travelLevel('Travel to the Lisbon office is reimbursed, and we pay 100% of your health insurance.', c), 'none');
  assert.equal(travelLevel('We cover 100% of your premiums, and the whole team travels to one offsite a year', c), 'none');
  assert.equal(travelLevel('Up to 60% travel to client sites.', c), 'frequent');
  assert.equal(travelLevel('Travel: up to 30% of the time, mostly within Portugal.', c), 'occasional');
});
