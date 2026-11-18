// Journey test (design §2, §19): Ada Example, a fictional data analyst who wants on-site or hybrid work in Berlin, paid in
// EUR per year (the top of a range must reach 55,000), with German and English titles. Everything is local and fictional.
import './env.ts'; // first: a temp CREWDECK_HOME before any Crewdeck module loads
import { type FormQ, runJourney } from './journey.ts';

const SQL = 'You will build SQL models in dbt and Looker dashboards with our product and finance teams in Berlin. ';
const yesNo = ['Yes', 'No'];

const pasted: FormQ[] = [
  { id: 'first', label: 'First name', kind: 'text', required: true },
  { id: 'last', label: 'Last name', kind: 'text', required: true },
  { id: 'email', label: 'Email', kind: 'text', required: true },
  { id: 'phone', label: 'Phone', kind: 'text' },
  { id: 'notice', label: 'Notice period', kind: 'text', required: true },
  { id: 'auth', label: 'Work authorization', kind: 'text', required: true },
  { id: 'cv', label: 'Resume/CV', kind: 'file', required: true },
  { id: 'why', label: 'Why do you want to join Nordlicht Data?', kind: 'textarea', required: true, max: 600 },
  { id: 'tableau', label: 'Do you have experience with Tableau?', kind: 'radio', options: yesNo, required: true },
  { id: 'salary', label: 'Expected salary', kind: 'text' },
  { id: 'gender', label: 'Gender', kind: 'select', options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'] },
  // Only on the live form (Apply): a question Prepare never saw, an account password and a CAPTCHA.
  { id: 'onsite', label: 'Can you work on-site in our Berlin office two days a week?', kind: 'radio', options: yesNo, required: true, live: true },
  { id: 'password', label: 'Create a password (optional)', kind: 'password', live: true },
  { id: 'robot', label: 'I\'m not a robot', kind: 'captcha', live: true },
];

const second: FormQ[] = [
  { id: 'first', label: 'First name', kind: 'text', required: true },
  { id: 'email', label: 'Email', kind: 'text', required: true },
  { id: 'notice', label: 'Notice period', kind: 'text', required: true },
  { id: 'tableau', label: 'Do you have experience with Tableau?', kind: 'radio', options: yesNo, required: true },
  { id: 'work', label: 'What would you like to work on in this role?', kind: 'textarea', required: true, max: 600 },
];

runJourney({
  person: 'berlin-analyst',
  preset: 'onsite-city',
  search: { schedule: { timezone: 'Europe/Berlin', daily_picks: 2, cooldown_days: 60 } },
  memory: [
    { kind: 'answer', key: 'notice_period', text: '1 month', quote: 'one month notice' },
    { kind: 'avoid', text: 'No agency roles', quote: 'I don\'t want agency roles' },
    { kind: 'style', text: 'Keep answers under 80 words', quote: 'short answers please' },
  ],
  feeds: [
    { company: 'Example Mobility GmbH', slug: 'example-mobility', jobs: [
      { slug: 'em-senior-data-analyst', title: 'Senior Data Analyst', location: 'Berlin, Germany (hybrid)', description: SQL.repeat(3), salary: { min: 65000, max: 75000, currency: 'EUR', period: 'year' }, days: 1, expect: 'keep' },
      { slug: 'em-bi-analyst', title: 'BI Analyst', location: 'Berlin, Germany', description: SQL.repeat(2), days: 2, expect: 'keep' },
      { slug: 'em-werkstudent', title: 'Werkstudent Data Analyst', location: 'Berlin, Germany', description: SQL, days: 1, expect: 'title_exclude' },
    ] },
    { company: 'Sample AG', slug: 'sample-ag', jobs: [
      { slug: 'sa-data-analyst-munich', title: 'Data Analyst', location: 'On-site · Munich, Germany', description: SQL, days: 2, expect: 'location_elsewhere' },
      // CHF a month: 3,500 × 12 × 1.05 = 44,100 EUR a year, under the floor even at the top of the range.
      { slug: 'sa-analytics-engineer', title: 'Analytics Engineer', location: 'Berlin, Germany', description: SQL, salary: { min: 3000, max: 3500, currency: 'CHF', period: 'month' }, days: 3, expect: 'pay' },
      { slug: 'sa-data-analyst-remote', title: 'Data Analyst (Remote)', location: 'Germany', description: SQL, days: 2, expect: 'workplace_excluded' },
    ] },
    { company: 'Muster Analytics GmbH', slug: 'muster-analytics', jobs: [
      { slug: 'ma-marketing-data-analyst', title: 'Marketing Data Analyst', location: 'Berlin, Germany', description: SQL.repeat(2), days: 3, expect: 'keep' },
      { slug: 'ma-data-analyst-us', title: 'Data Analyst', location: 'New York, NY, United States', description: SQL, days: 1, expect: 'location_elsewhere' },
      { slug: 'ma-senior-data-analyst-us-only', title: 'Senior Data Analyst', location: 'Hybrid', description: `${SQL}This role is open to US-based candidates only.`, days: 1, expect: 'other_only' },
    ] },
    { company: 'Beispiel Bank AG', slug: 'beispiel-bank', jobs: [
      { slug: 'bb-analytics-engineer', title: 'Analytics Engineer', location: 'Berlin, Germany', description: `${SQL}Native German (C2) is required for this role.`, days: 4, expect: 'keep' },
    ] },
    // No description in the feed: the scheduled run reads the posting page, which asks for frequent travel.
    { company: 'Reise Analytics GmbH', slug: 'reise-analytics', jobs: [
      { slug: 'ra-lead-data-analyst', title: 'Lead Data Analyst', location: 'Berlin, Germany', page: 'You will lead our analytics team. The role requires frequent travel to client sites across Europe.', days: 2, expect: 'travel' },
    ] },
    { company: 'Example Agency GmbH', slug: 'example-agency', jobs: [
      { slug: 'ea-data-analyst', title: 'Data Analyst', location: 'Berlin, Germany', description: SQL, days: 1, expect: 'company_excluded' },
    ] },
  ],
  judge: (c) => /native German/i.test(c.description)
    ? { eligible: 'no', score: 0, evidence: 'requires native German; the user speaks conversational German' }
    : { eligible: 'yes', score: /senior/i.test(c.title) ? 90 : /marketing/i.test(c.title) ? 70 : 75, evidence: 'analyst title in Berlin; SQL, dbt and Looker' },
  posting: {
    slug: 'nordlicht-senior-data-analyst', company: 'Nordlicht Data GmbH', title: 'Senior Data Analyst', location: 'Berlin, Germany',
    description: 'Nordlicht Data builds route planning analytics for logistics teams. You will own our SQL and Looker reporting, hybrid in Berlin.',
    salary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', minValue: 62000, maxValue: 72000, unitText: 'YEAR' } },
  },
  forms: { pasted, second },
  draft: (label) => {
    if (/^Why do you want to join Nordlicht Data/.test(label)) return {
      answer: 'I built 40 dashboards used by 300 colleagues. I cut forecast error by 18% with a new demand model. Nordlicht Data builds route planning analytics for logistics teams.',
      claims: [
        { text: 'I built 40 dashboards used by 300 colleagues', about: 'me', fact_ids: ['example-gmbh.dashboards'] },
        { text: 'I cut forecast error by 18% with a new demand model', about: 'me', fact_ids: ['example-gmbh.forecast'] },
        { text: 'Nordlicht Data builds route planning analytics for logistics teams', about: 'company', fact_ids: ['posting'] },
      ],
    };
    // The model reaches beyond the fact it cites: the citation check catches "Tableau".
    if (/Tableau/.test(label)) return { answer: 'Yes', claims: [{ text: 'I built dashboards in Tableau', about: 'me', fact_ids: ['example-gmbh.dashboards'] }] };
    if (/work on in this role/.test(label)) return {
      answer: 'Moving reporting into dbt, as I did when I moved nightly reporting from spreadsheets to dbt.',
      claims: [{ text: 'I moved nightly reporting from spreadsheets to dbt', about: 'me', fact_ids: ['sample-ag.etl'] }],
    };
    return undefined;
  },
  citation: { label: 'Do you have experience with Tableau?', term: 'Tableau', option: 'Yes' },
  needsYou: { label: 'Can you work on-site in our Berlin office two days a week?', answer: 'Yes', path: 'learn' },
  variant: { sections: { summary: ['summary.analytics'], 'example-gmbh': ['example-gmbh.dashboards', 'example-gmbh.forecast'], 'sample-ag': ['sample-ag.etl'], certs: ['certs.gcp'] } },
  pref: { sets: [['workplace', '[onsite, hybrid, remote]'], ['places.remote_from', '[Germany]']], because: 'Remote is fine too, as long as I can work from Germany.', restores: ['Data Analyst (Remote)'] },
  notInterested: {
    title: 'Marketing Data Analyst', reason: 'I don\'t want marketing analytics roles.', words: ['Marketing'],
    later: { feed: 'muster-analytics', job: { slug: 'ma-senior-marketing-data-analyst', title: 'Senior Marketing Data Analyst', location: 'Berlin, Germany', description: SQL, days: 1, expect: 'title_exclude' } },
  },
  broken: { from: 'currency: EUR', to: 'currency: Euro', path: 'pay.currency', still: /EUR/ },
});
