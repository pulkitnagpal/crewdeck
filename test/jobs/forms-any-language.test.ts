// Forms and answers in any language (design §24.9, §24.10, D32–D35, P9h): form terms per language (sensitive and
// never_fill), the four form fixtures' fill plans, ID numbers never stored even when a note holds one, answers in the
// form's language citing facts through approved translations, the resume in German, a cited cover letter, apply
// methods, "Add another" blocks, referees and availability grids. Every person, company and number here is fictional;
// ID numbers are zeros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { classOf, labelKey, profileRows } from '../../src/jobs/form-terms.ts';
import { type PageField, type PlanItem, fillPlan, planForRole } from '../../src/jobs/plan.ts';
import { normalise, validate } from '../../src/jobs/schema.ts';
import { profileValues } from '../../src/jobs/fields.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { storeFormFields } from '../../src/jobs/kb/questions.ts';
import { answerFirstTime, currentAnswers, remember } from '../../src/jobs/kb/ops.ts';
import { learnField } from '../../src/jobs/kb/learn.ts';
import { checkAnswer } from '../../src/jobs/kb/cite.ts';
import { applyDraft, prepareDraft } from '../../src/jobs/draft/draft.ts';
import { resumeHtml, resumeModel } from '../../src/jobs/resume.ts';
import { checkLetter, renderLetter } from '../../src/jobs/letter.ts';
import { letterPath } from '../../src/jobs/letter-path.ts';
import { setApplyMethod, setFormLang } from '../../src/jobs/pipeline/roles.ts';
import { todayView } from '../../src/jobs/views.ts';
import { applyPanel } from '../../src/jobs/panel.ts';
import { readForm } from '../../src/jobs/read-form.ts';
import { jobs, REPO, role, textFile, world } from './helpers.ts';
import { noBrowser, serve, testHosts } from './net-helpers.ts';

type W = ReturnType<typeof world>;
function notes(w: W, n: { profile?: object; career?: object; search?: object }) {
  for (const [name, file, tag] of [['profile', 'me/profile.md', 'me'], ['career', 'me/career.md', 'me'], ['search', 'jobs/search.md', 'jobs']] as const) {
    const data = (n as any)[name];
    if (data) writeFileSync(join(w.vault, file), `---\n${stringify({ tags: tag, ...data })}---\n# ${name}\n`);
  }
}
const by = (plan: PlanItem[]) => Object.fromEntries(plan.map((p) => [p.label, p]));
const NEVER = /you type this yourself/;
const SENS = /sensitive/;

// ---- people (fictional) ----
const LENA = {
  profile: {
    identity: { first_name: 'Lena', last_name: 'Example', email: 'lena@example.com', phone: '+49 30 1234567', city: 'Berlin', country: 'Germany' },
    standard_answers: { notice_period: '3 Monate', date_of_birth: '1990-01-01', nationality: 'deutsch' },
    education: [{ school: 'Example Hochschule', degree: 'B.A.', discipline: 'Betriebswirtschaft', end_year: 2014 }],
  },
  career: {
    language: 'en',
    resume: { language: 'de', personal: ['date_of_birth', 'nationality', 'languages'], word: 'CV', max_pages: 2 },
    sections: [
      { id: 'summary', kind: 'summary' },
      { id: 'example-steuer', kind: 'experience', title: 'Accountant', org: 'Example Steuer GmbH', where: 'Berlin', start: '2019-04', dates: '2019 – heute' },
      { id: 'skills', kind: 'skills' }, { id: 'education', kind: 'education' },
    ],
    facts: [
      { id: 'summary.accounting', text: 'Accountant with eight years of month-end closing for small firms', tr: { de: 'Buchhalterin mit acht Jahren Monatsabschlüssen für kleine Unternehmen' } },
      { id: 'example-steuer.closing', text: 'Closed the books for **40** clients each month in DATEV', tr: { de: 'Monatlicher Abschluss für **40** Mandanten in DATEV' } },
      { id: 'example-steuer.audit', text: 'Prepared year-end files for 12 audits' },
    ],
    skills: ['DATEV', 'Excel'],
    terms: { extra: ['DATEV'] },
  },
  search: { roles: { targets: [{ name: 'Accountant', titles: ['Buchhalter', 'accountant'] }] }, workplace: ['hybrid'], places: { onsite: ['Berlin'] }, languages: [{ name: 'German', level: 'C1' }, { name: 'English', level: 'C2' }] },
};
const RAVI = {
  profile: {
    identity: { first_name: 'Ravi', last_name: 'Example', email: 'ravi@example.com', phone: '+91 20 1234567', city: 'Pune', country: 'India' },
    // Even when a note holds an ID number, it is never used (and `jobs check` refuses it).
    standard_answers: { notice_period: '30 days', years_experience: '8', aadhaar_number: '0000 0000 0000', pan: 'XXXXX0000X' },
  },
};
const WES = {
  profile: {
    identity: { first_name: 'Wes', last_name: 'Example', email: 'wes@example.com', phone: '+1 555 123 4567', city: 'Houston', region: 'Texas', country: 'United States' },
    standard_answers: { ssn: '000-00-0000' },
  },
  search: { roles: { targets: [{ name: 'Warehouse', titles: ['warehouse associate'] }] }, workplace: ['onsite'], places: { onsite: ['Houston, TX'] }, work_pattern: { shifts: ['evening', 'weekend'], shifts_avoid: ['night'], hours_per_week: { min: 20, max: 24 } } },
};
const TARA = {
  profile: {
    identity: { first_name: 'Tara', last_name: 'Example', email: 'tara@example.com', phone: '+44 113 1234567', city: 'Leeds', country: 'United Kingdom' },
    references: [
      { name: 'Sam Sample', role: 'Head Teacher', org: 'Example Primary School', email: 'sam.sample@example.com', phone: '+44 7000 1234567', relationship: 'Current line manager' },
      { name: 'Jo Placeholder', role: 'Nursery Manager', org: 'Sample Nursery', email: 'jo@example.com', phone: '+44 7001 1234567', relationship: 'Previous manager' },
    ],
  },
  career: {
    sections: [
      { id: 'example-primary', kind: 'experience', title: 'Teaching Assistant', org: 'Example Primary School', where: 'Leeds', start: '2021-09' },
      { id: 'sample-nursery', kind: 'experience', title: 'Nursery Assistant', org: 'Sample Nursery', where: 'Leeds', start: '2018-01', end: '2021-07' },
      { id: 'example-club', kind: 'experience', title: 'Playworker', org: 'Example Holiday Club', start: '2016-06', end: '2017-12' },
      { id: 'career-break', kind: 'experience', title: 'Career break', break: true, dates: '2017 – 2018' },
    ],
    facts: [{ id: 'example-primary.phonics', text: 'Ran phonics groups for 6 pupils in Year 1' }],
  },
};

// ---- form terms ----
test('form terms per language: sensitive and never_fill classes in en, de, fr, es, pt, it, nl and Indian and Philippine English', () => {
  const cases: [string, ReturnType<typeof classOf>][] = [
    ['Expected salary', 'sensitive'], ['Date of birth', 'sensitive'], ['Gender', 'sensitive'], ['Social Security Number', 'never_fill'], ['Routing number', 'never_fill'],
    ['Anrede', 'sensitive'], ['Geburtsdatum', 'sensitive'], ['Gehaltsvorstellung (brutto/Jahr)', 'sensitive'], ['Staatsangehörigkeit', 'sensitive'], ['Familienstand', 'sensitive'],
    ['Steuer-ID', 'never_fill'], ['Sozialversicherungsnummer', 'never_fill'], ['IBAN', 'never_fill'],
    ['Prétentions salariales', 'sensitive'], ['Numéro de sécurité sociale', 'never_fill'], ['Civilité', 'sensitive'],
    ['Pretensión salarial', 'sensitive'], ['Fecha de nacimiento', 'sensitive'], ['DNI/NIE', 'never_fill'], ['NIE', 'never_fill'],
    ['Pretensão salarial', 'sensitive'], ['CPF', 'never_fill'], ['Estado civil', 'sensitive'],
    ['RAL desiderata', 'sensitive'], ['Codice fiscale', 'never_fill'], ['Data di nascita', 'sensitive'],
    ['Salarisindicatie', 'sensitive'], ['BSN', 'never_fill'], ['Geboortedatum', 'sensitive'],
    ['Current CTC (in LPA)', 'sensitive'], ['Expected CTC', 'sensitive'], ["Father's Name", 'sensitive'], ['Aadhaar Number', 'never_fill'], ['PAN', 'never_fill'], ['PAN Number', 'never_fill'],
    ['Civil status', 'sensitive'], ['SSS number', 'never_fill'], ['TIN', 'never_fill'], ['PhilHealth number', 'never_fill'],
    // Ordinary questions stay ordinary: words inside others, and short ID words elsewhere.
    ['Job title', null], ['Email', null], ['Language skills', null], ['Are you open to pan-India relocation?', null], ['Haben Sie nie im Ausland gearbeitet?', null], ['Agency name', null],
  ];
  for (const [label, cls] of cases) assert.equal(classOf(label), cls, label);
  // Profile fields in each language never map one label to two keys.
  const seen = new Map<string, string>();
  for (const { key, re } of profileRows()) for (const l of ['vorname', 'nachname', 'prenom', 'nom', 'nombre', 'apellidos', 'nome', 'cognome', 'voornaam', 'achternaam', 'email id', 'kundigungsfrist', 'telefono']) {
    if (!re.test(labelKey(l))) continue;
    assert.ok(!seen.has(l) || seen.get(l) === key, `${l}: ${seen.get(l)} and ${key}`);
    seen.set(l, key);
  }
  assert.equal(seen.get('vorname'), 'first_name');
  assert.equal(seen.get('cognome'), 'last_name');
  assert.equal(seen.get('email id'), 'email');
});

// ---- the four fixtures ----
test('German form: Anrede, Geburtsdatum, Staatsangehörigkeit and Gehaltsvorstellung are sensitive; Steuer-ID is never filled', () => {
  const p = normalise.profile(LENA.profile), c = normalise.career(LENA.career);
  const fields: PageField[] = [
    { label: 'Anrede *', type: 'select', options: ['Herr', 'Frau', 'Divers'], required: true },
    { label: 'Vorname *', type: 'text', required: true }, { label: 'Nachname *', type: 'text', required: true },
    { label: 'E-Mail-Adresse *', type: 'email', required: true }, { label: 'Telefonnummer', type: 'tel' },
    { label: 'Geburtsdatum', type: 'date' }, { label: 'Staatsangehörigkeit', type: 'text' },
    { label: 'Gehaltsvorstellung (brutto/Jahr) *', type: 'text', required: true }, { label: 'Kündigungsfrist', type: 'text' },
    { label: 'Steuer-ID', type: 'text' }, { label: 'Lebenslauf *', type: 'file', required: true }, { label: 'Anschreiben', type: 'file' },
    { label: 'Bewerbung absenden', type: 'submit' },
  ];
  const plan = by(fillPlan(fields, {}, p, { career: c }));
  assert.deepEqual(['Vorname *', 'Nachname *', 'E-Mail-Adresse *', 'Telefonnummer', 'Kündigungsfrist'].map((l) => plan[l].value), ['Lena', 'Example', 'lena@example.com', '+49 30 1234567', '3 Monate']);
  for (const l of ['Anrede *', 'Geburtsdatum', 'Staatsangehörigkeit', 'Gehaltsvorstellung (brutto/Jahr) *']) assert.match(`${plan[l].action} ${plan[l].reason}`, /^skip .*sensitive/, l);
  assert.equal(plan['Steuer-ID'].action, 'skip');
  assert.match(plan['Steuer-ID'].reason!, NEVER);
  assert.equal(plan['Lebenslauf *'].action, 'upload');
  assert.match(plan['Anschreiben'].reason!, /crewdeck jobs letter/);
  assert.equal(plan['Bewerbung absenden'].action, 'skip');
  // With a letter rendered, the Anschreiben upload is offered.
  assert.equal(by(fillPlan(fields, {}, p, { career: c, letter: true }))['Anschreiben'].action, 'upload');
});

test('Indian form: Aadhaar and PAN never filled (even with numbers in the profile); Father\'s name, CTC, date of birth and marital status sensitive', () => {
  const p = normalise.profile(RAVI.profile);
  assert.deepEqual(validate('profile', RAVI.profile).filter((i) => i.level === 'error').map((i) => i.path).sort(), ['standard_answers.aadhaar_number', 'standard_answers.pan']);
  assert.ok(!('aadhaar_number' in profileValues(p)) && !('pan' in profileValues(p)), 'ID numbers are never profile values');
  const plan = by(fillPlan([
    { label: 'Full Name *', type: 'text', required: true }, { label: "Father's Name *", type: 'text', required: true }, { label: 'Date of Birth *', type: 'date', required: true },
    { label: 'Mobile Number *', type: 'text', required: true }, { label: 'Email ID *', type: 'text', required: true }, { label: 'Current Location *', type: 'text', required: true },
    { label: 'Total Experience (in years) *', type: 'text', required: true }, { label: 'Current CTC (in LPA) *', type: 'text', required: true }, { label: 'Expected CTC (in LPA) *', type: 'text', required: true },
    { label: 'Notice Period (in days) *', type: 'text', required: true }, { label: 'Aadhaar Number *', type: 'text', required: true }, { label: 'PAN Number *', type: 'text', required: true },
    { label: 'Marital Status', type: 'select', options: ['Single', 'Married'] }, { label: 'Upload Resume *', type: 'file', required: true },
  ], { 'Aadhaar Number': '0000 0000 0000' }, p));
  assert.deepEqual(['Full Name *', 'Mobile Number *', 'Email ID *', 'Current Location *', 'Total Experience (in years) *', 'Notice Period (in days) *'].map((l) => plan[l].value), ['Ravi Example', '+91 20 1234567', 'ravi@example.com', 'Pune, India', '8', '30 days']);
  for (const l of ["Father's Name *", 'Date of Birth *', 'Current CTC (in LPA) *', 'Expected CTC (in LPA) *', 'Marital Status']) assert.match(plan[l].reason ?? '', SENS, l);
  for (const l of ['Aadhaar Number *', 'PAN Number *']) { assert.equal(plan[l].action, 'skip'); assert.match(plan[l].reason!, NEVER, l); }
  assert.equal(plan['Upload Resume *'].action, 'upload');
});

test('US hourly form: the availability grid from work_pattern, EEO questions sensitive, SSN never filled though the profile holds one', () => {
  const p = normalise.profile(WES.profile), wp = normalise.search(WES.search).work_pattern;
  const grid = ['Morning', 'Evening', 'Overnight', 'Not available'];
  const plan = by(fillPlan([
    { label: 'First name *', type: 'text', required: true }, { label: 'Phone number *', type: 'tel', required: true },
    { label: 'Social Security Number *', type: 'text', required: true }, { label: 'Desired pay rate', type: 'text' },
    { label: 'Monday availability', type: 'select', options: grid }, { label: 'Wednesday availability', type: 'select', options: grid }, { label: 'Saturday availability', type: 'select', options: grid },
    { label: 'Gender', type: 'select', options: ['Female', 'Male', 'Decline to self-identify'] }, { label: 'Race/Ethnicity', type: 'select', options: ['Decline to self-identify'] },
    { label: 'Veteran status', type: 'select', options: ['I am not a protected veteran'] }, { label: 'Resume (optional)', type: 'file' },
  ], {}, p, { workPattern: wp }));
  assert.deepEqual([plan['First name *'].value, plan['Phone number *'].value], ['Wes', '+1 555 123 4567']);
  assert.match(plan['Social Security Number *'].reason!, NEVER);
  assert.ok(!Object.values(plan).some((x) => x.value === '000-00-0000'), 'the number is nowhere in the plan');
  for (const d of ['Monday', 'Wednesday', 'Saturday']) assert.deepEqual([plan[`${d} availability`].action, plan[`${d} availability`].value], ['select', 'Evening'], d);
  for (const l of ['Desired pay rate', 'Gender', 'Race/Ethnicity', 'Veteran status']) assert.match(plan[l].reason ?? '', SENS, l);
  // Without a work pattern the grid is the user's to answer.
  assert.match(by(fillPlan([{ label: 'Monday availability', type: 'select', options: grid }], {}, p))['Monday availability'].reason!, /work_pattern\.shifts/);
});

test('UK school form: employment history with a capped "Add another", referees from the profile (ask them first), National Insurance never filled', () => {
  const p = normalise.profile(TARA.profile), c = normalise.career(TARA.career);
  const fields: PageField[] = [
    { label: 'Title', type: 'select', options: ['Mr', 'Mrs', 'Ms', 'Miss', 'Dr'] }, { label: 'First name *', type: 'text', required: true }, { label: 'Surname *', type: 'text', required: true },
    { label: 'Telephone', type: 'tel' }, { label: 'National Insurance number *', type: 'text', required: true },
    { label: 'Employer', type: 'text', group: 'employment', index: 0 }, { label: 'Job title', type: 'text', group: 'employment', index: 0 },
    { label: 'Start date', type: 'month', group: 'employment', index: 0 }, { label: 'End date', type: 'month', group: 'employment', index: 0 },
    { label: 'Add another employer', type: 'button', group: 'employment' },
    { label: 'Reference 1 name', type: 'text' }, { label: 'Reference 1 position', type: 'text' }, { label: 'Reference 1 organisation', type: 'text' },
    { label: 'Reference 1 email', type: 'email' }, { label: 'Reference 1 telephone', type: 'tel' }, { label: 'Reference 1 relationship to you', type: 'text' },
    { label: 'Reference 2 name', type: 'text' }, { label: 'Reference 2 email', type: 'email' }, { label: 'Add another reference', type: 'button' },
    { label: 'Supporting statement', type: 'file' }, { label: 'Submit application', type: 'submit' },
  ];
  const plan = by(fillPlan(fields, {}, p, { career: c }));
  assert.match(plan['Title'].reason!, SENS, 'a salutation is sensitive');
  assert.deepEqual([plan['First name *'].value, plan['Surname *'].value, plan['Telephone'].value], ['Tara', 'Example', '+44 113 1234567']);
  assert.match(plan['National Insurance number *'].reason!, NEVER);
  assert.deepEqual(['Employer', 'Job title', 'Start date'].map((l) => plan[l].value), ['Example Primary School', 'Teaching Assistant', '2021-09']);
  assert.match(plan['End date'].reason!, /goes on/);
  // Three jobs (the break is no employer), one block on the page: two more, and never past the cap.
  assert.deepEqual([plan['Add another employer'].action, plan['Add another employer'].times], ['add', 2]);
  assert.deepEqual(['Reference 1 name', 'Reference 1 position', 'Reference 1 organisation', 'Reference 1 email', 'Reference 1 telephone', 'Reference 1 relationship to you', 'Reference 2 name', 'Reference 2 email'].map((l) => plan[l].value),
    ['Sam Sample', 'Head Teacher', 'Example Primary School', 'sam.sample@example.com', '+44 7000 1234567', 'Current line manager', 'Jo Placeholder', 'jo@example.com']);
  assert.match(plan['Reference 1 name'].reason!, /another person's details \(ask them first\)/);
  assert.equal(plan['Add another reference'].action, 'skip', 'both referees already have a block');
  assert.match(plan['Supporting statement'].reason!, /crewdeck jobs letter/);
  // The next page: the two new blocks get jobs 2 and 3; the user's own name never fills a referee's.
  const next = fillPlan([
    { label: 'Employer', type: 'text', group: 'employment', index: 1 }, { label: 'End date', type: 'month', group: 'employment', index: 1 },
    { label: 'Employer', type: 'text', group: 'employment', index: 2 }, { label: 'Name', type: 'text', group: 'reference', index: 0 },
  ], { Name: 'Tara Example' }, p, { career: c });
  assert.deepEqual(next.map((x) => x.value), ['Sample Nursery', '2021-07', 'Example Holiday Club', 'Sam Sample']);
  // The cap: twelve jobs, one block, at most ten presses.
  const many = normalise.career({ sections: Array.from({ length: 12 }, (_, i) => ({ id: `job-${i}`, kind: 'experience', title: 'Assistant', org: `Example ${i}` })) });
  assert.equal(by(fillPlan([{ label: 'Add another employer', type: 'button', group: 'employment' }], {}, p, { career: many }))['Add another employer'].times, 10);
});

// ---- never stored ----
test('never_fill is never stored: not as a form question, a remembered answer, a learned question, or through me set; check refuses it in a note', () => {
  const w = world('template');
  notes(w, { profile: WES.profile });
  const id = role(w.ctx, { company: 'Example Distribution', title: 'Warehouse Associate' });
  const n = storeFormFields(w.ctx.db, id, notesOf(w.ctx).profile.data, [{ label: 'First name', kind: 'text' }, { label: 'Social Security Number', kind: 'text', required: true }, { label: 'Bank account number', kind: 'text' }]);
  assert.equal(n, 1);
  assert.deepEqual(currentAnswers(w.ctx.db, id).map((a) => a.label), ['First name']);
  assert.throws(() => remember(w.ctx, { kind: 'answer', key: 'social_security_number', text: '000-00-0000', quote: 'it is 000-00-0000', scope: 'all' }), /never stores/);
  const l = learnField(w.ctx, id, { label: 'SSN', answer: '000-00-0000', quote: '000-00-0000' });
  assert.equal(l.ok, false);
  assert.match((l as any).reason, /never stores/);
  assert.equal((w.ctx.db.prepare(`select count(*) n from form_fields where label like '%SSN%' or label like '%Security%'`).get() as any).n, 0);
  assert.doesNotMatch(readFileSync(join(w.vault, 'jobs', 'memory.md'), 'utf8'), /000-00-0000/);
  // The CLI: check names the field and the fix; me set refuses a new one.
  const check = jobs(w.home, ['check']);
  assert.match(check.out + check.err, /standard_answers\.ssn.*ID, bank or tax number/);
  const set = jobs(w.home, ['me', 'set', 'standard_answers.iban', '--value-file', textFile(w.root, 'iban.txt', 'DE00 0000 0000 0000 0000 00')]);
  assert.notEqual(set.code, 0);
  assert.doesNotMatch(readFileSync(join(w.vault, 'me', 'profile.md'), 'utf8'), /iban/i);
  // The fill plan for this role skips it whatever the role's answers hold.
  const plan = planForRole(w.ctx, id, [{ label: 'Social Security Number', type: 'text', required: true }]);
  assert.ok(plan.mode === 'fill' && plan.items[0].action === 'skip' && NEVER.test(plan.items[0].reason!));
});

test('sensitive answers are kept for the same company unless the user says "use this everywhere"; Claude may raise a field, never lower one', () => {
  const w = world('template');
  notes(w, { profile: LENA.profile, career: LENA.career });
  const a = role(w.ctx, { company: 'Example Steuer GmbH', title: 'Buchhalter (m/w/d)' });
  const b = role(w.ctx, { company: 'Sample Kanzlei', title: 'Buchhalterin' });
  const c = role(w.ctx, { company: 'Placeholder AG', title: 'Accountant' });
  const p = notesOf(w.ctx).profile.data;
  for (const r of [a, b, c]) storeFormFields(w.ctx.db, r, p, [{ label: 'Gehaltsvorstellung', kind: 'text', required: true }]);
  const r1 = answerFirstTime(w.ctx, { role: a, question: 'Q1', value: '58.000 €', quote: '58.000 bei Example' });
  assert.equal(r1.remembered.scope, 'company');
  prepareDraft(w.ctx, b);
  assert.equal(currentAnswers(w.ctx.db, b)[0].status, 'first_time', 'another company asks again');
  const r2 = answerFirstTime(w.ctx, { role: b, question: 'Q1', value: '60.000 €', quote: 'überall 60.000', everywhere: true });
  assert.equal(r2.remembered.scope, 'all');
  prepareDraft(w.ctx, c);
  assert.equal(currentAnswers(w.ctx.db, c)[0].text, '60.000 €');
  // Raised by Claude: a question the words don't flag.
  const d = role(w.ctx, { company: 'Example Partner', title: 'Accountant' });
  storeFormFields(w.ctx.db, d, p, [{ label: 'Tell us about your family situation', kind: 'textarea' }, { label: 'Geburtsdatum', kind: 'text', sensitive: false } as any]);
  const brief = prepareDraft(w.ctx, d);
  assert.deepEqual(brief.refs, ['Q1'], 'Geburtsdatum stays sensitive though the reader said false');
  applyDraft(w.ctx, d, { answers: [{ field_ref: 'Q1', label: 'Tell us about your family situation', answer: null, claims: [], sensitive: true }] });
  const f = currentAnswers(w.ctx.db, d)[0];
  assert.deepEqual([f.kind, f.status, f.reason], ['sensitive', 'first_time', 'sensitive: tell Claude once']);
  const plan = by(fillPlan([{ label: 'Tell us about your family situation', type: 'textarea', sensitive: true }, { label: 'Geburtsdatum', type: 'text', sensitive: false }], {}, p));
  assert.match(plan['Tell us about your family situation'].reason!, SENS);
  assert.match(plan['Geburtsdatum'].reason!, SENS);
});

// ---- answers in the form's language ----
test('citation check: a German answer cites an English fact through its approved translation; a fact without one is refused', () => {
  const career = normalise.career(LENA.career);
  const ctx = { facts: career.facts, memory: [], postingText: '', profile: {}, lang: 'de', factsLang: 'en' };
  const ok = checkAnswer({ text: 'Ich habe jeden Monat für 40 Mandanten in DATEV abgeschlossen.', claims: [{ text: 'Monatlicher Abschluss für 40 Mandanten in DATEV', about: 'me', fact_ids: ['example-steuer.closing'] }] }, ctx);
  assert.deepEqual(ok, { ok: true });
  const no = checkAnswer({ text: 'Ich habe Jahresabschlüsse für 12 Prüfungen vorbereitet.', claims: [{ text: 'Jahresabschlüsse für 12 Prüfungen', about: 'me', fact_ids: ['example-steuer.audit'] }] }, ctx);
  assert.equal(no.ok, false);
  assert.match((no as any).reason, /example-steuer\.audit has no approved German translation \(facts\[\]\.tr\.de\)/);
  // A number the translation doesn't hold is still refused.
  const bad = checkAnswer({ text: 'Abschluss für 50 Mandanten.', claims: [{ text: 'Abschluss für 50 Mandanten', about: 'me', fact_ids: ['example-steuer.closing'] }] }, ctx);
  assert.match((bad as any).reason, /"50"/);
  // In the facts' own language no translation is needed.
  assert.deepEqual(checkAnswer({ text: 'I prepared year-end files for 12 audits.', claims: [{ text: 'Prepared year-end files for 12 audits', about: 'me', fact_ids: ['example-steuer.audit'] }] }, { ...ctx, lang: 'en' }), { ok: true });
});

test('drafting in the form\'s language: the brief says German and shows approved translations; the draft is checked in German', () => {
  const w = world('template');
  notes(w, { profile: LENA.profile, career: LENA.career });
  const id = role(w.ctx, { company: 'Example Steuer GmbH', title: 'Buchhalter (m/w/d)' });
  setFormLang(w.ctx, id, 'de');
  storeFormFields(w.ctx.db, id, notesOf(w.ctx).profile.data, [{ label: 'Was haben Sie zuletzt gemacht?', kind: 'textarea' }, { label: 'Erfahrung mit Prüfungen?', kind: 'textarea' }]);
  const brief = prepareDraft(w.ctx, id);
  assert.match(brief.prompt, /The form is in German \(de\): answer in German\. The facts are in English: cite a fact only through its approved German translation/);
  assert.match(brief.prompt, /tr\.de \(approved by the user\): Monatlicher Abschluss für 40 Mandanten in DATEV/);
  const r = applyDraft(w.ctx, id, { answers: [
    { field_ref: 'Q1', label: 'Was haben Sie zuletzt gemacht?', answer: 'Monatlicher Abschluss für 40 Mandanten in DATEV.', claims: [{ text: 'Monatlicher Abschluss für 40 Mandanten in DATEV', about: 'me', fact_ids: ['example-steuer.closing'] }] },
    { field_ref: 'Q2', label: 'Erfahrung mit Prüfungen?', answer: 'Jahresabschlüsse für 12 Prüfungen.', claims: [{ text: 'Jahresabschlüsse für 12 Prüfungen', about: 'me', fact_ids: ['example-steuer.audit'] }] },
  ] });
  assert.deepEqual([r.drafted, r.first_time], [1, 1]);
  assert.match(currentAnswers(w.ctx.db, id)[1].reason!, /no approved German translation/);
});

// ---- the resume and the letter ----
test('resume in German: localised headings, approved translations, the personal block from standard answers, a warning for an untranslated fact', () => {
  const career = normalise.career(LENA.career), profile = normalise.profile(LENA.profile), search = normalise.search(LENA.search);
  const m = resumeModel(career, profile, { sections: { summary: ['summary.accounting'], 'example-steuer': ['example-steuer.closing', 'example-steuer.audit'] } }, { search });
  assert.equal(m.lang, 'de');
  assert.equal(m.word, 'Lebenslauf');
  assert.deepEqual(m.blocks.map((b) => b.title), ['Persönliche Daten', '', 'Berufserfahrung', 'Kenntnisse', 'Ausbildung']);
  const personal = m.blocks[0] as any;
  assert.deepEqual(personal.items, [{ label: 'Geburtsdatum', value: '1990-01-01' }, { label: 'Staatsangehörigkeit', value: 'deutsch' }, { label: 'Sprachen', value: 'German (C1), English (C2)' }]);
  const html = resumeHtml(m);
  assert.match(html, /<html lang="de">/);
  assert.match(html, /Buchhalterin mit acht Jahren Monatsabschlüssen/);
  assert.match(html, /Monatlicher Abschluss für <strong>40<\/strong> Mandanten in DATEV/);
  assert.match(html, /Prepared year-end files for 12 audits/, 'no translation: the original');
  assert.deepEqual(m.warnings, ['example-steuer.audit has no approved German translation: shown in English']);
  // resume.headings overrides a default; resume.word names the file.
  const own = resumeModel(normalise.career({ ...LENA.career, resume: { ...LENA.career.resume, headings: { experience: 'Beruflicher Werdegang' } } }), profile, { sections: { 'example-steuer': ['example-steuer.closing'] } });
  assert.ok(own.blocks.some((b) => b.title === 'Beruflicher Werdegang'));
  assert.equal(career.resume.file_name, '{first_name} {last_name} CV.pdf');
  assert.deepEqual(validate('career', LENA.career).filter((i) => i.level === 'error'), []);
  assert.match(validate('career', LENA.career).map((i) => i.message).join('\n'), /1 fact has no approved de translation: they render in en/);
});

test('crewdeck jobs letter: refused when a claim isn\'t supported (nothing printed); the fill plan offers it once it exists', async () => {
  const w = world('template');
  notes(w, { profile: LENA.profile, career: LENA.career });
  const id = role(w.ctx, { company: 'Example Steuer GmbH', title: 'Buchhalter (m/w/d)', description: 'Example Steuer GmbH betreut Handwerksbetriebe in Berlin.' });
  setFormLang(w.ctx, id, 'de');
  assert.throws(() => checkLetter(w.ctx, id, 'Ich habe 60 Mandanten betreut.', [{ text: 'Ich habe 60 Mandanten betreut', about: 'me', fact_ids: ['example-steuer.closing'] }]), /the letter was not rendered: "60"/);
  assert.throws(() => checkLetter(w.ctx, id, 'Ich habe 12 Prüfungen vorbereitet.', [{ text: 'Ich habe 12 Prüfungen vorbereitet', about: 'me', fact_ids: ['example-steuer.audit'] }]), /no approved German translation/);
  const good = checkLetter(w.ctx, id, 'Monatlicher Abschluss für 40 Mandanten in DATEV.\n\nExample Steuer GmbH betreut Handwerksbetriebe in Berlin.', [
    { text: 'Monatlicher Abschluss für 40 Mandanten in DATEV', about: 'me', fact_ids: ['example-steuer.closing'] },
    { text: 'Example Steuer GmbH betreut Handwerksbetriebe in Berlin', about: 'company', fact_ids: ['posting'] },
  ]);
  assert.equal(good.lang, 'de');
  assert.ok(letterPath(w.ctx, id, notesOf(w.ctx)).endsWith('/Lena Example Anschreiben.pdf'));
  assert.ok(!existsSync(letterPath(w.ctx, id, notesOf(w.ctx))));
});

test('crewdeck jobs letter renders a cited PDF in the form\'s language (headless Chromium, JS and network off)', { skip: noBrowser, timeout: 90_000 }, async () => {
  const w = world('template');
  notes(w, { profile: LENA.profile, career: LENA.career });
  const id = role(w.ctx, { company: 'Example Steuer GmbH', title: 'Buchhalter (m/w/d)', description: 'Example Steuer GmbH betreut Handwerksbetriebe in Berlin.' }, 'picked');
  setFormLang(w.ctx, id, 'de');
  const r = await renderLetter(w.ctx, id, 'Sehr geehrte Damen und Herren,\n\nMonatlicher Abschluss für 40 Mandanten in DATEV.\n\nMit freundlichen Grüßen\nLena Example', [
    { text: 'Monatlicher Abschluss für 40 Mandanten in DATEV', about: 'me', fact_ids: ['example-steuer.closing'] },
  ]);
  assert.equal(readFileSync(r.pdf).subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.pages, 1);
  assert.match(readFileSync(r.html, 'utf8'), /<html lang="de">[\s\S]*Lena Example Anschreiben[\s\S]*20\. November 2026|<html lang="de">[\s\S]*19\. November 2026/);
  const plan = planForRole(w.ctx, id, [{ label: 'Anschreiben', type: 'file' }]);
  assert.ok(plan.mode === 'fill' && plan.items[0].action === 'upload' && plan.items[0].value === 'cover letter PDF');
  assert.equal(todayView(w.ctx, id).detail?.letter, 'Lena Example Anschreiben.pdf');
});

// ---- apply methods ----
test('apply methods recorded at Prepare: walk-in shows where and when, email/document/chatbot show answers to copy, account_needed asks the user to sign up', () => {
  const w = world('template');
  notes(w, { profile: RAVI.profile });
  const id = role(w.ctx, { company: 'Example Retail Pvt Ltd', title: 'Store Manager' }, 'picked');
  const r = jobs(w.home, ['role', id, '--apply-method', 'walk_in', '--apply-note-file', textFile(w.root, 'note.txt', 'Walk-in interviews, Monday to Saturday 10 am – 1 pm, Example Mall, Pune')]);
  assert.equal(r.code, 0, r.err);
  let d = todayView(w.ctx, id).detail!;
  assert.deepEqual([d.apply.mode, d.apply.note], ['walk_in', 'Walk-in interviews, Monday to Saturday 10 am – 1 pm, Example Mall, Pune']);
  assert.deepEqual([applyPanel({ status: 'picked', apply: d.apply, connected: true }).state, applyPanel({ status: 'picked', apply: d.apply, connected: true }).note], ['walk_in', d.apply.note]);
  for (const m of ['email', 'document', 'chatbot']) {
    setApplyMethod(w.ctx, id, m);
    d = todayView(w.ctx, id).detail!;
    assert.equal(d.apply.mode, 'copy', m);
    assert.equal(applyPanel({ status: 'picked', apply: d.apply, connected: true }).state, 'copy');
  }
  setApplyMethod(w.ctx, id, 'account_needed');
  const p = applyPanel({ status: 'picked', apply: todayView(w.ctx, id).detail!.apply, connected: true });
  assert.deepEqual([p.state, p.method], ['ready', 'account_needed']);
  assert.throws(() => setApplyMethod(w.ctx, id, 'fax'), /form, email, document, walk_in, chatbot, account_needed/);
  assert.notEqual(jobs(w.home, ['role', id, '--lang', 'deutsch']).code, 0);
});

// ---- reading the fixtures headlessly ----
const FORMS = join(REPO, 'test', 'fixtures', 'jobs', 'forms');
test('the four fixture forms read headlessly: the page language recorded, ID numbers never stored', { skip: noBrowser, timeout: 120_000 }, async (t) => {
  const s = await serve((req, res) => {
    const name = (req.url ?? '').replace(/^\/forms\//, '');
    if (!/^[a-z-]+\.html$/.test(name)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(FORMS, name)));
  });
  t.after(() => s.close());
  const net = { testHosts: testHosts('apply.example.test') };
  const w = world('template');
  notes(w, { profile: RAVI.profile });
  const expect: Record<string, { lang: string; never: string[]; has: string[] }> = {
    'de-steuerberatung.html': { lang: 'de', never: ['Steuer-ID'], has: ['Anrede', 'Gehaltsvorstellung (brutto/Jahr)', 'Kündigungsfrist'] },
    'in-retail-pune.html': { lang: 'en', never: ['Aadhaar Number', 'PAN Number'], has: ["Father's Name", 'Current CTC (in LPA)'] },
    'us-hourly.html': { lang: 'en', never: ['Social Security Number'], has: ['Monday availability', 'Gender'] },
    'uk-school.html': { lang: 'en', never: ['National Insurance number'], has: ['Reference 1 name', 'Employer', 'Start date'] },
  };
  for (const [file, e] of Object.entries(expect)) {
    const id = role(w.ctx, { company: `Example ${file}`, title: 'Role' });
    const r = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/${file}`, net });
    assert.equal(r.needs, undefined, `${file}: ${r.needs}`);
    assert.equal(r.lang, e.lang, file);
    const stored = currentAnswers(w.ctx.db, id).map((a) => a.label);
    for (const l of e.has) assert.ok(stored.includes(l), `${file}: ${l} in ${stored.join(' | ')}`);
    for (const l of e.never) assert.ok(!stored.includes(l), `${file}: ${l} must not be stored`);
    assert.match(r.notes.join(' '), /not stored: the user types/);
    assert.equal((w.ctx.db.prepare('select form_lang from roles where id=?').get(id) as any).form_lang, e.lang);
  }
});
