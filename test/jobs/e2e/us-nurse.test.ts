// Journey test (design §2, §19): Riley Example, a fictional registered nurse who wants remote telehealth work from the
// states she is licensed in (Texas, Arizona), per diem or part time, paid in USD per hour (the bottom of a range must reach
// 42). Everything is local and fictional.
import './env.ts'; // first: a temp CREWDECK_HOME before any Crewdeck module loads
import { type FormQ, runJourney } from './journey.ts';

const TRIAGE = 'Phone and video triage for adult patients, documented in Epic, with nights and weekends available. ';
const yesNo = ['Yes', 'No'];

const pasted: FormQ[] = [
  { id: 'first', label: 'First name', kind: 'text', required: true },
  { id: 'last', label: 'Last name', kind: 'text', required: true },
  { id: 'email', label: 'Email', kind: 'text', required: true },
  { id: 'phone', label: 'Phone', kind: 'text', required: true },
  { id: 'years', label: 'Years of experience', kind: 'text', required: true },
  { id: 'auth', label: 'Work authorization', kind: 'text', required: true },
  { id: 'shift', label: 'Shift availability', kind: 'text', required: true },
  { id: 'cv', label: 'Resume', kind: 'file' },
  { id: 'why', label: 'Why Northstar Virtual Care?', kind: 'textarea', required: true, max: 500 },
  { id: 'epic', label: 'Have you documented patient visits in Epic?', kind: 'radio', options: yesNo, required: true },
  { id: 'pay', label: 'Desired pay (per hour)', kind: 'text' },
  { id: 'gender', label: 'Gender', kind: 'select', options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'] },
  // Only on the live form (Apply): a question Prepare never saw, an account password and a CAPTCHA.
  { id: 'compact', label: 'Do you hold an active multistate (compact) RN license?', kind: 'radio', options: yesNo, required: true, live: true },
  { id: 'password', label: 'Create a password (optional)', kind: 'password', live: true },
  { id: 'robot', label: 'I\'m not a robot', kind: 'captcha', live: true },
];

const second: FormQ[] = [
  { id: 'first', label: 'First name', kind: 'text', required: true },
  { id: 'email', label: 'Email', kind: 'text', required: true },
  { id: 'epic', label: 'Have you documented patient visits in Epic?', kind: 'radio', options: yesNo, required: true },
  { id: 'work', label: 'What would you like to work on in this role?', kind: 'textarea', required: true, max: 500 },
];

runJourney({
  person: 'us-nurse',
  preset: 'healthcare-us',
  search: { schedule: { timezone: 'America/Chicago', daily_picks: 2, cooldown_days: 45 } },
  memory: [
    { kind: 'answer', key: 'shift_availability', text: 'Nights and weekends', quote: 'I can do nights and weekends' },
    { kind: 'avoid', text: 'No bedside or floor roles, telehealth only', quote: 'no more bedside, telehealth only', title_words: ['bedside'] },
  ],
  feeds: [
    { company: 'Example Telehealth', slug: 'example-telehealth', jobs: [
      { slug: 'et-telehealth-nurse', title: 'Telehealth Nurse (RN) - Remote', location: 'Remote (Texas)', description: TRIAGE.repeat(3), salary: { min: 45, max: 52, currency: 'USD', period: 'hour' }, days: 1, expect: 'keep' },
      { slug: 'et-triage-nurse', title: 'Triage Nurse - Remote', location: 'Remote (Texas or Arizona)', description: TRIAGE.repeat(2), days: 2, expect: 'keep' },
      { slug: 'et-rn-california', title: 'Registered Nurse - Remote', location: 'Remote (California only)', description: TRIAGE, days: 1, expect: 'location_elsewhere' },
    ] },
    { company: 'Sample Care Network', slug: 'sample-care', jobs: [
      { slug: 'sc-icu-onsite', title: 'Registered Nurse - ICU', location: 'On-site · Dallas, TX', description: TRIAGE, days: 2, expect: 'workplace_excluded' },
      { slug: 'sc-triage-hybrid', title: 'Triage Nurse', location: 'Hybrid · Austin, TX', description: TRIAGE, days: 3, expect: 'workplace_excluded' },
      // A yearly salary for an hourly floor: 65,000 / 2,080 h = 31.25 an hour at the bottom of the range.
      { slug: 'sc-case-manager-salaried', title: 'Nurse Case Manager - Remote', location: 'Remote (Texas)', description: TRIAGE, salary: { min: 65000, max: 70000, currency: 'USD', period: 'year' }, days: 2, expect: 'pay' },
    ] },
    { company: 'Demo Health Partners', slug: 'demo-health', jobs: [
      { slug: 'dh-telehealth-low', title: 'Telehealth Nurse - Remote', location: 'Remote (Arizona)', description: TRIAGE, salary: { min: 38, max: 40, currency: 'USD', period: 'hour' }, days: 1, expect: 'pay' },
      { slug: 'dh-travel-nurse', title: 'Travel Nurse RN', location: 'Remote (Texas)', description: TRIAGE, days: 1, expect: 'title_exclude' },
      { slug: 'dh-bedside', title: 'Bedside RN - Remote Monitoring', location: 'Remote (Texas)', description: TRIAGE, days: 2, expect: 'title_exclude' },
    ] },
    { company: 'Placeholder Clinics', slug: 'placeholder-clinics', jobs: [
      { slug: 'pc-rn-triage', title: 'Registered Nurse - Remote Triage', location: 'Remote (Texas)', description: `${TRIAGE}Requires an active California RN license.`, days: 3, expect: 'keep' },
      { slug: 'pc-utilization', title: 'Nurse Case Manager - Utilization Review', location: 'Remote (Arizona)', description: TRIAGE.repeat(2), days: 4, expect: 'keep' },
    ] },
    { company: 'Sample Home Health', slug: 'sample-home-health', jobs: [
      { slug: 'shh-rn-coordinator', title: 'RN Care Coordinator - Remote', location: 'Remote (Texas)', description: TRIAGE.repeat(2), days: 2, expect: 'keep' },
    ] },
  ],
  judge: (c) => /California RN license/i.test(c.description)
    ? { eligible: 'no', score: 0, evidence: 'requires a California licence; the user holds Texas and Arizona (compact)' }
    : { eligible: 'yes', score: /telehealth/i.test(c.title) ? 90 : /triage/i.test(c.title) ? 80 : /coordinator/i.test(c.title) ? 75 : 70, evidence: 'remote from Texas or Arizona; triage' },
  posting: {
    slug: 'northstar-telehealth-triage-nurse', company: 'Northstar Virtual Care', title: 'Telehealth Triage Nurse', location: 'Remote (Texas)',
    description: 'Northstar Virtual Care runs a nurse line for patients across Texas. Per diem, nights and weekends, remote from Texas.',
    salary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 48, maxValue: 55, unitText: 'HOUR' } },
  },
  forms: { pasted, second },
  draft: (label, mem) => {
    if (/^Why Northstar/.test(label)) return {
      answer: 'I handled 60+ telehealth triage calls per shift. Northstar Virtual Care runs a nurse line for patients across Texas.',
      claims: [
        { text: 'I handled 60+ telehealth triage calls per shift', about: 'me', fact_ids: ['example-health.triage'] },
        { text: 'Northstar Virtual Care runs a nurse line for patients across Texas', about: 'company', fact_ids: ['posting'] },
      ],
    };
    if (/^Shift availability/.test(label)) return { answer: 'Nights and weekends.', claims: [{ text: 'I can work nights and weekends', about: 'me', fact_ids: [mem('shift_availability')] }] };
    // The model reaches beyond the fact it cites: the citation check catches "Epic".
    if (/Epic/.test(label)) return { answer: 'Yes', claims: [{ text: 'I documented triage calls in Epic', about: 'me', fact_ids: ['example-health.triage'] }] };
    if (/work on in this role/.test(label)) return {
      answer: 'Telehealth triage: I handled 60+ telehealth triage calls per shift.',
      claims: [{ text: 'I handled 60+ telehealth triage calls per shift', about: 'me', fact_ids: ['example-health.triage'] }],
    };
    return undefined;
  },
  citation: { label: 'Have you documented patient visits in Epic?', term: 'Epic', option: 'Yes' },
  needsYou: { label: 'Do you hold an active multistate (compact) RN license?', answer: 'Yes', path: 'request' },
  variant: { sections: { summary: ['summary.rn'], 'example-health': ['example-health.triage'], licences: ['licences.rn', 'licences.bls'] } },
  pref: { sets: [['workplace', 'remote,hybrid']], because: 'I\'m OK with hybrid now.', restores: ['Triage Nurse'] },
  notInterested: {
    title: 'Nurse Case Manager - Utilization Review', reason: 'No utilization review roles, I want patient contact.', words: ['Utilization Review'],
    later: { feed: 'placeholder-clinics', job: { slug: 'pc-ur-specialist', title: 'RN Utilization Review Specialist - Remote', location: 'Remote (Texas)', description: TRIAGE, days: 1, expect: 'title_exclude' } },
  },
  broken: { from: 'currency: USD', to: 'currency: Dollars', path: 'pay.currency', still: /USD/ },
});
