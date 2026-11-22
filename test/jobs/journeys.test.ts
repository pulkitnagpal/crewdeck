// The seven persona journeys of design §24.12 (P9i), each from an empty vault to the apply panel through the commands
// Claude runs (spawned CLI, never a TTY) on its own temp home: the setup interview's notes, where to look (suggest and
// its coverage line), postings (pasted, or "fetched": rows the sandboxed runner would store, with their source key and
// structured fields), the preview, a Find within a budget (its funnel, judge-ready candidates, a scripted judge, the
// picks), Prepare (the form's questions in its own language, the draft brief, the fill plan) and the apply panel's state.
// Each journey's outputs are captured in <root>/journey.txt (and in $CREWDECK_JOURNEYS/<key>.txt when set).
// Every person, company, address and number here is fictional; ID numbers are zeros.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Persona, fetchOnce, file, finish, me, ok, posting, pref, preview, sources, start } from './setup-helpers.ts';
import { openJobsDb, upsertRole } from '../../src/jobs/db.ts';
import { applyPanel } from '../../src/jobs/panel.ts';

type Post = { title: string; company: string; location: string; pay_text?: string; description?: string; source_key?: string; employment_type?: string };
/** What the rules must do with a posting ('pass' or the rule that drops it) and the scripted judge's verdict. */
type Expect = { expect: string; judge?: 'yes' | 'no' | 'unclear' };
type Field = { label: string; type: string; options?: string[]; required?: boolean; group?: string; index?: number };
type Spec = {
  key: string;
  setup: (p: Persona) => void;
  coverage: RegExp;
  where: (p: Persona, sg: any) => void;
  postings: (Post & Expect)[];
  targets: string[];
  brief: RegExp[];
  /** The role to prepare (its title), the form's language, how the employer takes applications. */
  prepare: { title: string; lang: string; method?: [string, string]; questions: { label: string; kind: string; required?: boolean; options?: string[] }[]; draft?: RegExp; fields: Field[]; plan: (by: Record<string, any>) => void; panel: string };
  after?: (p: Persona, ids: Map<string, string>, log: (s: string) => void) => void;
};

/** Rows as the sandboxed runner stores them after a fetch (source key, the provider's structured fields). */
function fetched(p: Persona, rows: Post[]): string[] {
  const db = openJobsDb(p.jobsHome);
  try {
    return rows.map((r, i) => upsertRole(db, { url: `https://jobs.example.com/fetched/${encodeURIComponent(r.company)}/${p.n++}-${i}`, source: 'board', description: '', ...r }).id);
  } finally { db.close(); }
}

const json = (p: Persona, args: string[]) => JSON.parse(ok(p, args));
const by = (items: any[]) => Object.fromEntries(items.map((x) => [x.label, x]));
const NEVER = /you type this yourself/;
const SENS = /sensitive/;

function journey(s: Spec) {
  test(`${s.key}: setup, where to look, postings, preview, Find, Prepare in the form's language, the apply panel`, () => {
    const p = start();
    const out: string[] = [];
    const log = (line: string) => out.push(line);
    // 1. The interview: the notes as the jobs-setup skill writes them, one confirmed value at a time.
    s.setup(p);
    // 2. Where to look: the catalog's proposal and its coverage line, said plainly.
    const sg = json(p, ['sources', 'suggest', '--json']);
    log(`suggest: ${sg.sources.map((x: any) => x.id).join(', ') || '(none)'}\ncoverage: ${sg.coverage.line}`);
    assert.match(sg.coverage.line, s.coverage);
    s.where(p, sg);
    log(`sources.md:\n${sources(p).split('---')[1].trim()}`);
    // 3. Fetch once (on a fresh home it says why it can't run), then postings: fetched rows and pasted links.
    fetchOnce(p);
    const ids = new Map<string, string>();
    const toFetch = s.postings.filter((x) => x.source_key || x.employment_type);
    fetched(p, toFetch.map(({ expect: _, judge: __, ...r }) => r)).forEach((id, i) => ids.set(`${toFetch[i].title} — ${toFetch[i].company}`, id));
    for (const x of s.postings.filter((y) => !toFetch.includes(y))) {
      const { expect: _, judge: __, ...r } = x;
      ids.set(`${x.title} — ${x.company}`, posting(p, r));
    }
    // 4. The preview: every kind of job catches something; the notes check clean.
    const pv = finish(p, s.targets);
    log(`preview: ${pv.pass} of ${pv.pool} pass; by kind of job: ${pv.by_target.map((t: any) => `${t.name} ${t.pass}`).join(', ')}; dropped by first reason: ${pv.drops.map((d: any) => `${d.label} ${d.n}`).join(', ')}`);
    const passes = s.postings.filter((x) => x.expect === 'pass');
    assert.equal(pv.pass, passes.length, JSON.stringify(pv.dropped));
    // 5. The rules, posting by posting: what passes, and the rule that drops each of the rest.
    const pf = json(p, ['prefilter']);
    const dropOf = new Map(pf.drops.map((d: any) => [d.id, d]));
    for (const x of s.postings) {
      const d = dropOf.get(ids.get(`${x.title} — ${x.company}`)) as any;
      log(`  ${x.title} — ${x.company}: ${d ? `dropped (${d.rule}: ${d.reason})` : x.expect === 'other' ? 'passes, another occupation (not judged)' : 'passes'}`);
      // 'other': another occupation passes the rules (titles are never a drop, ADR-0003) but is never a candidate.
      assert.equal(d?.rule ?? 'pass', x.expect === 'other' ? 'pass' : x.expect, `${x.title} — ${x.company}: ${d?.reason ?? 'kept'}`);
    }
    const others = s.postings.filter((x) => x.expect === 'other').length;
    // 6. Find within a budget: judge-ready candidates in rank order with the funnel, a scripted judge, the picks.
    const brief = ok(p, ['judge-brief']);
    for (const re of s.brief) assert.match(brief, re);
    log(`judge brief: ${s.brief.length} lines checked`);
    const need = 5;
    const run = json(p, ['candidates', '--budget', '20', '--need', String(need), '--start']);
    assert.deepEqual(run.batch.map((c: any) => c.id).sort(), passes.map((x) => ids.get(`${x.title} — ${x.company}`)).sort(), 'every posting that passed the rules is a candidate');
    assert.equal(run.run.funnel.passed_rules, passes.length + others);
    assert.equal(run.run.funnel.other_occupations, others);
    const verdicts = run.batch.map((c: any) => {
      const x = s.postings.find((y) => ids.get(`${y.title} — ${y.company}`) === c.id)!;
      return { role: c.id, eligible: x.judge ?? 'yes', score: x.judge === 'no' ? 20 : 80, evidence: `scripted judge: ${x.title}` };
    });
    ok(p, ['judge', '--results-file', file(p, JSON.stringify(verdicts))]);
    const after = json(p, ['candidates', '--budget', '20', '--need', String(need)]);
    const fits = verdicts.filter((v: any) => v.eligible === 'yes').length;
    assert.equal(after.run.funnel.fits, fits);
    const companies = new Set(verdicts.filter((v: any) => v.eligible === 'yes').map((v: any) => s.postings.find((y) => ids.get(`${y.title} — ${y.company}`) === v.role)!.company)).size;
    assert.equal(after.run.funnel.fit_companies, companies);
    assert.match(after.run.funnel.line, new RegExp(`^${s.postings.length} fetched → ${passes.length + others} passed your rules${others ? ` \\(${others} other occupations? set aside\\)` : ''} → ${verdicts.length} judged → ${fits} fits?${fits ? ` from ${companies} compan(y|ies)` : ''}$`));
    log(`find: ${after.run.funnel.line}${after.run.funnel.rules_line ? ` · ${after.run.funnel.rules_line}` : ''}`);
    const picked = ok(p, ['pick', '--n', String(need)]);
    log(`picked:\n${picked.trim()}`);
    // 7. Prepare one pick: the form's language, its questions (ID numbers never stored), the draft brief, the plan.
    const id = ids.get(s.prepare.title)!;
    assert.ok(id && picked.includes(id), `${s.prepare.title} is picked`);
    ok(p, ['role', id, '--lang', s.prepare.lang, ...(s.prepare.method ? ['--apply-method', s.prepare.method[0], '--apply-note-file', file(p, s.prepare.method[1])] : [])]);
    log(`form: ${ok(p, ['form', id, '--fields-file', file(p, JSON.stringify(s.prepare.questions))]).trim()}`);
    if (s.prepare.draft) {
      const out_ = join(p.jobsHome, 'out', 'tmp', `brief-${s.key}.json`);
      log(`draft: ${ok(p, ['draft', id, '--brief', out_]).trim()}`);
      assert.match(JSON.parse(readFileSync(out_, 'utf8')).prompt, s.prepare.draft);
    }
    const plan = json(p, ['fill-plan', id, '--fields-file', file(p, JSON.stringify(s.prepare.fields))]);
    assert.equal(plan.mode, 'fill');
    for (const it of plan.items) log(`  plan: ${it.label} → ${it.action}${it.value !== undefined ? ` "${it.value}"` : ''}${it.reason ? ` (${it.reason})` : ''}`);
    s.prepare.plan(by(plan.items));
    // 8. The apply panel as the page shows it for this role.
    const today = json(p, ['view', 'today', '--role', id]);
    const panel = applyPanel({ status: today.detail.status, apply: today.detail.apply, connected: false });
    log(`apply panel: ${panel.state}${today.detail.apply.note ? ` (${today.detail.apply.note})` : ''}`);
    assert.equal(panel.state, s.prepare.panel);
    s.after?.(p, ids, log);
    const text = `${s.key}\n${out.join('\n')}\n`;
    writeFileSync(join(p.root, 'journey.txt'), text);
    if (process.env.CREWDECK_JOURNEYS) { mkdirSync(process.env.CREWDECK_JOURNEYS, { recursive: true }); writeFileSync(join(process.env.CREWDECK_JOURNEYS, `${s.key}.txt`), text); }
  });
}

// ---- E: backend engineer in India, remote, INR a year (the owner's case in miniature) ----
journey({
  key: 'in-backend-remote',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Asha, last_name: Example, email: asha@example.com, phone: "+91 20 1234567", city: Pune, country: India }');
    me(p, 'standard_answers.notice_period', '30 days');
    me(p, 'language', 'en');
    me(p, 'sections', '[{ id: summary, kind: summary }, { id: example-tech, kind: experience, title: Backend Engineer, org: Example Tech, where: Pune, start: "2021-01" }, { id: skills, kind: skills }]');
    me(p, 'facts', '[{ id: example-tech.apis, text: "Built **12** internal APIs in Go serving 3 product teams" }, { id: example-tech.oncall, text: "Cut on-call pages by **40%** with better alerts" }]');
    me(p, 'skills', '[Go, Python, PostgreSQL, Kubernetes]');
    pref(p, 'roles.targets', '[{ name: Backend developer, titles: [backend engineer, backend developer], families: [engineering-it] }]', 'backend work in Go or Python');
    pref(p, 'roles.level', 'experienced', 'five years');
    pref(p, 'workplace', '[remote]', 'remote only');
    pref(p, 'places.remote_from', '[India]', 'I live in India');
    pref(p, 'employment_types', '[full-time]', 'full-time');
    pref(p, 'pay', '{ currency: INR, floor: 3000000, period: year, rule: top_of_range, unlisted: keep, locale: en-IN, fx: { USD: 85 } }', '30 lakh a year at least; a dollar is about 85 rupees');
    pref(p, 'languages', '[{ name: English, level: fluent }, { name: Hindi, level: native }]', 'English and Hindi');
    pref(p, 'schedule.timezone', 'Asia/Kolkata', 'India time');
  },
  coverage: /job boards fit remote work from India for software and IT \(most of their remote jobs are limited to the US or Europe\)/,
  where: (p, sg) => {
    for (const id of ['remotive', 'weworkremotely']) { assert.ok(sg.sources.some((x: any) => x.id === id), id); ok(p, ['sources', 'add', '--provider', id]); }
    ok(p, ['sources', 'add', '--linkedin', '--at', '1']);
    assert.match(sources(p), /sources:\n {2}- \{ key: linkedin, name: LinkedIn, linkedin: search, added: [\d-]+ \}\n {2}- \{ key: remotive/);
  },
  postings: [
    { title: 'Senior Software Engineer, Backend', company: 'Example Payments', location: 'Remote (India)', pay_text: '$40,000 – $60,000 a year', source_key: 'remotive', expect: 'pass' },
    { title: 'Backend Developer (Go)', company: 'Sample Labs', location: 'Remote, India', source_key: 'weworkremotely', expect: 'pass' },
    { title: 'Backend Engineer', company: 'Placeholder Inc', location: 'Remote', description: 'This role is US only.', source_key: 'remotive', expect: 'other_only' },
    { title: 'Backend Engineer', company: 'Example Budget', location: 'Remote - India', pay_text: '$10,000 – $20,000 a year', source_key: 'weworkremotely', expect: 'pay' },
    { title: 'Product Designer', company: 'Example Studio', location: 'Remote, India', source_key: 'remotive', expect: 'other' },
    { title: 'Backend Engineer, Payments', company: 'Demo Fintech', location: 'Remote - India', expect: 'pass', judge: 'no' },
  ],
  targets: ['Backend developer'],
  brief: [/Backend developer/, /INR/],
  prepare: {
    title: 'Senior Software Engineer, Backend — Example Payments', lang: 'en',
    questions: [{ label: 'First name', kind: 'text', required: true }, { label: 'Expected CTC (in LPA)', kind: 'text', required: true }, { label: 'Why do you want to join Example Payments?', kind: 'textarea', required: true }],
    draft: /- The form is in English \(en\): answer in English\./,
    fields: [{ label: 'First name *', type: 'text', required: true }, { label: 'Last name *', type: 'text', required: true }, { label: 'Email *', type: 'email', required: true },
      { label: 'Notice period', type: 'text' }, { label: 'Expected CTC (in LPA) *', type: 'text', required: true }, { label: 'PAN Number', type: 'text' }, { label: 'Resume *', type: 'file', required: true }, { label: 'Submit application', type: 'submit' }],
    plan: (b) => {
      assert.deepEqual(['First name *', 'Last name *', 'Email *', 'Notice period'].map((l) => b[l].value), ['Asha', 'Example', 'asha@example.com', '30 days']);
      assert.match(b['Expected CTC (in LPA) *'].reason, SENS);
      assert.match(b['PAN Number'].reason, NEVER);
      assert.equal(b['Resume *'].action, 'upload');
      assert.equal(b['Submit application'].action, 'skip');
    },
    panel: 'ready',
  },
  after: (p, ids, log) => {
    // The US-only posting stays dropped for its place; the judge's "no" is never picked.
    const t = json(p, ['view', 'today']);
    assert.ok(!t.queue.some((q: any) => q.company === 'Demo Fintech'));
    log(`today: ${t.queue.map((q: any) => `${q.company} — ${q.title}`).join(' · ')}`);
    assert.ok(ids.size === 6);
  },
});

// ---- N: registered nurse in Columbus, nights, hourly ----
journey({
  key: 'us-nurse-nights',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Nora, last_name: Example, email: nora@example.com, phone: "+1 614 123 4567", city: Columbus, region: Ohio, country: United States }');
    me(p, 'standard_answers.work_authorization', 'US citizen');
    me(p, 'sections', '[{ id: example-health, kind: experience, title: Registered Nurse, org: Example Health, where: "Columbus, OH", start: "2019-05" }, { id: licences, kind: list, title: Licences }]');
    me(p, 'facts', '[{ id: example-health.nights, text: "Charge nurse on a 32-bed medical-surgical unit, night shift" }, { id: licences.rn, text: "RN, Ohio Board of Nursing" }]');
    pref(p, 'roles.targets', '[{ name: Nurse, titles: [registered nurse, RN, staff nurse, charge nurse], families: [healthcare] }]', 'RN jobs, nights');
    pref(p, 'workplace', '[onsite]', 'on the ward');
    pref(p, 'places.onsite', '[Columbus, OH]', 'Columbus');
    pref(p, 'places.authorized_in', '[United States]', 'allowed to work in the US');
    pref(p, 'employment_types', '[full-time, part-time, per-diem]', 'any of those');
    pref(p, 'licenses', '[{ name: RN, where: Ohio }]', 'Ohio RN');
    pref(p, 'work_pattern', '{ shifts: [night], shifts_avoid: [day], hours_per_week: { max: 36 } }', 'nights only, three twelves');
    pref(p, 'pay', '{ currency: USD, floor: 38, period: hour, hours_per_week: 36, days_per_week: 3, rule: bottom_of_range, unlisted: keep }', 'at least 38 an hour');
    pref(p, 'schedule', '{ daily_picks: 5, cooldown_days: 14, cooldown_scope: role, per_company: 1, timezone: America/New_York }', 'two weeks, other units are fine');
  },
  coverage: /^Crewdeck has no job board that fits United States for healthcare\. Employers' careers pages work when they use /,
  where: (p, sg) => {
    assert.deepEqual(sg.sources, []);
    ok(p, ['sources', 'add', '--careers-url-file', file(p, 'https://example-health.wd1.myworkdayjobs.example.test/External'), '--name-file', file(p, 'Example Health'), '--employer']);
  },
  postings: [
    { title: 'RN - Night Shift', company: 'Example Health', location: 'Columbus, OH', pay_text: '$40 - $48 per hour', expect: 'pass' },
    { title: 'Registered Nurse, ICU (Nights)', company: 'Sample Medical Center', location: 'Columbus, OH', pay_text: '$42/hr', expect: 'pass' },
    { title: 'Registered Nurse - Day Shift', company: 'Demo Hospital', location: 'Columbus, OH', pay_text: '$44/hr', description: 'Days only, 7a-7p.', expect: 'pass', judge: 'no' },
    { title: 'RN, Med/Surg', company: 'Placeholder Clinic', location: 'Columbus, OH', pay_text: '$30 - $34 an hour', expect: 'pay' },
    { title: 'Nursery Assistant', company: 'Example Kids', location: 'Columbus, OH', expect: 'other' },
    { title: 'Registered Nurse', company: 'Placeholder Hospital', location: 'Toronto, ON, Canada', expect: 'location_elsewhere' },
  ],
  targets: ['Nurse'],
  brief: [/Shifts the user can work: night/, /may work without sponsorship in: United States/],
  prepare: {
    title: 'RN - Night Shift — Example Health', lang: 'en',
    questions: [{ label: 'First name', kind: 'text', required: true }, { label: 'Desired pay rate', kind: 'text' }],
    fields: [{ label: 'First name *', type: 'text', required: true }, { label: 'Phone number *', type: 'tel', required: true }, { label: 'Social Security Number *', type: 'text', required: true },
      { label: 'Desired pay rate', type: 'text' }, { label: 'Monday availability', type: 'select', options: ['Morning', 'Evening', 'Overnight', 'Not available'] },
      { label: 'Gender', type: 'select', options: ['Female', 'Male', 'Decline to self-identify'] }, { label: 'Resume', type: 'file' }],
    plan: (b) => {
      assert.deepEqual([b['First name *'].value, b['Phone number *'].value], ['Nora', '+1 614 123 4567']);
      assert.match(b['Social Security Number *'].reason, NEVER);
      for (const l of ['Desired pay rate', 'Gender']) assert.match(b[l].reason, SENS, l);
      assert.deepEqual([b['Monday availability'].action, b['Monday availability'].value], ['select', 'Overnight']);
    },
    panel: 'ready',
  },
  after: (p, ids, log) => {
    // cooldown_scope: role. Applied to one unit, another unit at the same hospital still comes through.
    ok(p, ['applied', ids.get('RN - Night Shift — Example Health')!]);
    const other = posting(p, { title: 'Registered Nurse - Nights, Cardiac', company: 'Example Health', location: 'Columbus, OH', pay_text: '$41/hr' });
    const pf = json(p, ['prefilter']);
    assert.ok(!pf.drops.some((d: any) => d.id === other), 'another unit at the same hospital is not in cooldown');
    log('cooldown (role scope): another unit at Example Health passes after applying to one');
  },
});

// ---- A: accountant in Berlin, hybrid, German C1, German forms ----
journey({
  key: 'de-accountant',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Lena, last_name: Example, email: lena@example.com, phone: "+49 30 1234567", city: Berlin, country: Germany }');
    me(p, 'standard_answers', '{ notice_period: 3 Monate, date_of_birth: "1990-01-01", nationality: deutsch }');
    me(p, 'language', 'en');
    me(p, 'resume', '{ language: de, word: CV, max_pages: 2 }');
    me(p, 'sections', '[{ id: summary, kind: summary }, { id: example-steuer, kind: experience, title: Accountant, org: Example Steuer GmbH, where: Berlin, start: "2019-04" }]');
    me(p, 'facts', '[{ id: example-steuer.closing, text: "Closed the books for **40** clients each month in DATEV", tr: { de: "Monatlicher Abschluss für **40** Mandanten in DATEV" } }]');
    pref(p, 'roles.targets', '[{ name: Buchhaltung, titles: [Buchhalter, accountant], families: [finance-accounting] }]', 'Buchhaltung, gern auch Finanzbuchhaltung');
    pref(p, 'workplace', '[hybrid, onsite]', 'hybrid or in the office');
    pref(p, 'places.onsite', '[Berlin]', 'Berlin');
    pref(p, 'languages', '[{ name: German, level: C1 }, { name: English, level: C2 }]', 'Deutsch C1, English C2');
    pref(p, 'pay', '{ currency: EUR, floor: 50000, period: year, rule: top_of_range, unlisted: keep, locale: de-DE }', '50.000 im Jahr');
    pref(p, 'schedule.timezone', 'Europe/Berlin', 'Berlin');
  },
  coverage: /^\d job boards fit Germany for finance and accounting/,
  where: (p, sg) => {
    const a = sg.sources.find((x: any) => x.id === 'arbeitsagentur');
    assert.deepEqual(a.fill, ['arbeitsagentur.keywords']);
    ok(p, ['sources', 'add', '--provider', 'arbeitsagentur']);
    assert.match(sources(p), /arbeitsagentur/);
  },
  postings: [
    { title: 'Finanzbuchhalter (m/w/d)', company: 'Example Logistik GmbH', location: 'Berlin', description: 'Hybrid: zwei Tage Homeoffice. Deutsch C1.', pay_text: '52.000 – 58.000 € brutto/Jahr', source_key: 'arbeitsagentur', language: 'de', expect: 'pass' } as any,
    { title: 'Bilanzbuchhalter*in', company: 'Sample Treuhand', location: 'Berlin', source_key: 'arbeitsagentur', expect: 'pass' },
    { title: 'Buchhalterin (m/w/d) Teilzeit', company: 'Demo Praxis', location: 'Berlin', expect: 'pass', judge: 'unclear' },
    { title: 'Steuerfachangestellte (m/w/d)', company: 'Example Kanzlei', location: 'Berlin', source_key: 'arbeitsagentur', expect: 'other' },
    { title: 'Senior Accountant', company: 'Placeholder AG', location: 'München', source_key: 'arbeitsagentur', expect: 'location_elsewhere' },
  ],
  targets: ['Buchhaltung'],
  brief: [/German.*C1/],
  prepare: {
    title: 'Finanzbuchhalter (m/w/d) — Example Logistik GmbH', lang: 'de',
    questions: [{ label: 'Vorname', kind: 'text', required: true }, { label: 'Steuer-ID', kind: 'text' }, { label: 'Warum möchten Sie bei uns arbeiten?', kind: 'textarea', required: true }],
    draft: /The form is in German \(de\): answer in German\. The facts are in English: cite a fact only through its approved German translation/,
    fields: [{ label: 'Anrede *', type: 'select', options: ['Herr', 'Frau', 'Divers'], required: true }, { label: 'Vorname *', type: 'text', required: true }, { label: 'Nachname *', type: 'text', required: true },
      { label: 'E-Mail-Adresse *', type: 'email', required: true }, { label: 'Geburtsdatum', type: 'date' }, { label: 'Gehaltsvorstellung (brutto/Jahr) *', type: 'text', required: true },
      { label: 'Kündigungsfrist', type: 'text' }, { label: 'Steuer-ID', type: 'text' }, { label: 'Lebenslauf *', type: 'file', required: true }, { label: 'Bewerbung absenden', type: 'submit' }],
    plan: (b) => {
      assert.deepEqual(['Vorname *', 'Nachname *', 'E-Mail-Adresse *', 'Kündigungsfrist'].map((l) => b[l].value), ['Lena', 'Example', 'lena@example.com', '3 Monate']);
      for (const l of ['Anrede *', 'Geburtsdatum', 'Gehaltsvorstellung (brutto/Jahr) *']) assert.match(b[l].reason, SENS, l);
      assert.match(b['Steuer-ID'].reason, NEVER);
      assert.equal(b['Lebenslauf *'].action, 'upload');
    },
    panel: 'ready',
  },
});

// ---- R: store manager in Pune, no LinkedIn, INR a month, walk-in interviews ----
journey({
  key: 'in-retail-pune',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Ravi, last_name: Example, email: ravi@example.com, phone: "+91 20 1234567", city: Pune, country: India }');
    me(p, 'standard_answers', '{ notice_period: 30 days, years_experience: "8" }');
    me(p, 'sections', '[{ id: example-retail, kind: experience, title: Store Manager, org: Example Retail Pvt Ltd, where: Pune, start: "2018-06" }]');
    me(p, 'facts', '[{ id: example-retail.team, text: "Led a team of 14 across two shifts" }]');
    pref(p, 'roles.targets', '[{ name: Store manager, titles: [store manager, retail store manager], families: [retail] }]', 'store manager');
    pref(p, 'workplace', '[onsite]', 'in the store');
    pref(p, 'places.onsite', '[Pune]', 'Pune');
    pref(p, 'languages', '[{ name: English }, { name: Hindi }, { name: Marathi }]', 'English, Hindi, Marathi');
    pref(p, 'pay', '{ currency: INR, floor: 30000, period: month, rule: top_of_range, unlisted: keep, locale: en-IN }', '30,000 a month at least');
    pref(p, 'schedule', '{ daily_picks: 5, cooldown_days: 14, cooldown_scope: role, timezone: Asia/Kolkata }', 'two weeks; other stores are fine');
  },
  coverage: /^Crewdeck has no job board that fits India for retail\. Employers' careers pages work when they use .*Darwinbox/,
  where: (p, sg) => {
    assert.deepEqual(sg.sources, []);
    ok(p, ['sources', 'add', '--careers-url-file', file(p, 'https://example-retail.darwinbox.example.test/ms/candidate/careers'), '--name-file', file(p, 'Example Retail Pvt Ltd'), '--employer']);
  },
  postings: [
    { title: 'Store Manager', company: 'Example Retail Pvt Ltd', location: 'Pune, Maharashtra', pay_text: '₹3-4 LPA', description: 'Walk-in interviews Monday to Saturday, 10 am to 1 pm, Example Mall, Pune.', expect: 'pass' },
    { title: 'Retail Store Manager', company: 'Sample Fashion', location: 'Pune', pay_text: '₹35,000 per month', expect: 'pass' },
    { title: 'Assistant Store Manager', company: 'Demo Mart', location: 'Pune', pay_text: '₹2.4 LPA', expect: 'pay' },
    { title: 'Store Manager', company: 'Placeholder Stores', location: 'Mumbai', expect: 'location_elsewhere' },
  ],
  targets: ['Store manager'],
  brief: [/Store manager/],
  prepare: {
    title: 'Store Manager — Example Retail Pvt Ltd', lang: 'en', method: ['walk_in', 'Walk-in interviews Monday to Saturday, 10 am to 1 pm, Example Mall, Pune'],
    questions: [{ label: 'Full Name', kind: 'text', required: true }, { label: 'Aadhaar Number', kind: 'text', required: true }, { label: "Father's Name", kind: 'text' }],
    fields: [{ label: 'Full Name *', type: 'text', required: true }, { label: "Father's Name *", type: 'text', required: true }, { label: 'Mobile Number *', type: 'text', required: true },
      { label: 'Current Location *', type: 'text', required: true }, { label: 'Aadhaar Number *', type: 'text', required: true }, { label: 'PAN Number *', type: 'text', required: true },
      { label: 'Marital Status', type: 'select', options: ['Single', 'Married'] }],
    plan: (b) => {
      assert.deepEqual(['Full Name *', 'Mobile Number *', 'Current Location *'].map((l) => b[l].value), ['Ravi Example', '+91 20 1234567', 'Pune, India']);
      for (const l of ["Father's Name *", 'Marital Status']) assert.match(b[l].reason, SENS, l);
      for (const l of ['Aadhaar Number *', 'PAN Number *']) assert.match(b[l].reason, NEVER, l);
    },
    panel: 'walk_in',
  },
});

// ---- G: marketing graduate in Manila, entry level, PHP a month ----
journey({
  key: 'ph-graduate',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Gina, last_name: Example, email: gina@example.com, phone: "+63 2 1234567", city: Manila, country: Philippines }');
    me(p, 'education', '[{ school: Example State University, degree: BS, discipline: Marketing, end_year: 2026 }]');
    me(p, 'sections', '[{ id: summary, kind: summary }, { id: example-agency, kind: experience, title: Marketing Intern, org: Example Agency, start: "2025-06", end: "2025-08" }, { id: projects, kind: list, title: Projects }, { id: education, kind: education }]');
    me(p, 'facts', '[{ id: example-agency.posts, text: "Planned 30 social posts for a local cafe chain" }, { id: projects.thesis, text: "Thesis: a survey of 200 students on how they choose snacks" }]');
    pref(p, 'roles.targets', '[{ name: Marketing, titles: [marketing associate, marketing assistant], families: [marketing] }]', 'marketing, starting out');
    pref(p, 'roles.level', 'entry', 'I just graduated');
    pref(p, 'workplace', '[onsite, hybrid]', 'office or hybrid');
    pref(p, 'places.onsite', '[Manila]', 'Metro Manila');
    pref(p, 'pay', '{ currency: PHP, floor: 20000, period: month, rule: top_of_range, unlisted: keep }', '20,000 a month');
    pref(p, 'languages', '[{ name: English }, { name: Filipino }]', 'English and Filipino');
    pref(p, 'schedule.timezone', 'Asia/Manila', 'Manila');
  },
  coverage: /fit Philippines for marketing/,
  where: (p, sg) => {
    assert.ok(sg.sources.some((x: any) => x.id === 'kalibrr'));
    assert.ok(!sg.sources.some((x: any) => x.id === 'jobstreet'));
    ok(p, ['sources', 'add', '--provider', 'kalibrr']);
  },
  postings: [
    { title: 'Marketing Associate (Fresh Grad)', company: 'Example Foods', location: 'Manila', pay_text: '₱22,000 - ₱25,000 per month', source_key: 'kalibrr', expect: 'pass' },
    { title: 'Marketing Assistant', company: 'Sample Retail', location: 'Makati, Manila', source_key: 'kalibrr', expect: 'pass' },
    { title: 'Senior Marketing Associate', company: 'Demo Corp', location: 'Manila', source_key: 'kalibrr', expect: 'level' },
    { title: 'Senior Marketing Manager', company: 'Example Brands', location: 'Manila', source_key: 'kalibrr', expect: 'level' },
    { title: 'Marketing Associate', company: 'Placeholder Inc', location: 'Cebu City', source_key: 'kalibrr', expect: 'location_elsewhere' },
  ],
  targets: ['Marketing'],
  brief: [/entry/i],
  prepare: {
    title: 'Marketing Associate (Fresh Grad) — Example Foods', lang: 'en',
    questions: [{ label: 'Tell us about a marketing project you worked on', kind: 'textarea', required: true }, { label: 'Expected salary', kind: 'text' }],
    draft: /The form is in English \(en\)/,
    fields: [{ label: 'First name *', type: 'text', required: true }, { label: 'Email *', type: 'email', required: true }, { label: 'Expected salary', type: 'text' }, { label: 'SSS number', type: 'text' }, { label: 'Resume / CV *', type: 'file', required: true }],
    plan: (b) => {
      assert.deepEqual([b['First name *'].value, b['Email *'].value], ['Gina', 'gina@example.com']);
      assert.match(b['Expected salary'].reason, SENS);
      assert.match(b['SSS number'].reason, NEVER);
      assert.equal(b['Resume / CV *'].action, 'upload');
    },
    panel: 'ready',
  },
});

// ---- W: warehouse work in Texas, part-time, no resume ----
journey({
  key: 'us-warehouse-noresume',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Wes, last_name: Example, email: wes@example.com, phone: "+1 555 123 4567", city: Houston, region: Texas, country: United States }');
    me(p, 'sections', '[{ id: example-logistics, kind: experience, title: Warehouse associate, org: Example Logistics, where: "Houston, TX", start: "2020-03", end: "2023-06" }, { id: gig-delivery, kind: experience, title: Delivery driver, org: Self-employed (gig work), start: "2023-07", end: "2024-05" }, { id: career-break, kind: experience, title: Career break, break: true, dates: "2024 – 2025" }]');
    me(p, 'facts', '[{ id: example-logistics.picking, text: "Picked and packed about 150 orders a shift" }, { id: gig-delivery.routes, text: "Delivered groceries across Houston, 30 to 40 stops a day" }]');
    pref(p, 'roles.targets', '[{ name: Warehouse, titles: [warehouse associate, picker packer, material handler], families: [logistics-transport] }]', 'warehouse work');
    pref(p, 'workplace', '[onsite]', 'on site');
    pref(p, 'places.onsite', '[Houston, TX]', 'Houston');
    pref(p, 'employment_types', '[part-time, temporary]', 'part-time');
    pref(p, 'work_pattern', '{ shifts: [evening, weekend], shifts_avoid: [night], hours_per_week: { min: 20, max: 24 } }', 'evenings and weekends, about 24 hours');
    pref(p, 'pay', '{ currency: USD, floor: 15, period: hour, rule: bottom_of_range, unlisted: keep }', 'fifteen an hour');
    pref(p, 'schedule.timezone', 'America/Chicago', 'Texas time');
  },
  coverage: /^Crewdeck has no job board that fits United States for warehouse, driving and transport\./,
  where: (p, sg) => {
    assert.deepEqual(sg.sources, []);
    ok(p, ['sources', 'add', '--careers-url-file', file(p, 'https://example-distribution.wd5.myworkdayjobs.example.test/Careers'), '--name-file', file(p, 'Example Distribution'), '--employer']);
  },
  postings: [
    { title: 'Warehouse Associate - Weekend Shift', company: 'Example Distribution', location: 'Houston, TX', pay_text: '$18/hour', source_key: 'example-distribution', employment_type: 'PART_TIME', expect: 'pass' },
    { title: 'Material Handler', company: 'Sample Freight', location: 'Houston, TX', pay_text: '$17.50 an hour', expect: 'pass' },
    { title: 'Warehouse Associate', company: 'Demo Supply', location: 'Houston, TX', source_key: 'example-distribution', employment_type: 'FULL_TIME', expect: 'employment_type' },
    { title: 'Picker Packer', company: 'Placeholder Goods', location: 'Houston, TX', pay_text: '$12 an hour', expect: 'pay' },
  ],
  targets: ['Warehouse'],
  brief: [/Shifts the user can work: evening, weekend/],
  prepare: {
    title: 'Warehouse Associate - Weekend Shift — Example Distribution', lang: 'en',
    questions: [{ label: 'First name', kind: 'text', required: true }, { label: 'Social Security Number', kind: 'text', required: true }],
    fields: [{ label: 'First name *', type: 'text', required: true }, { label: 'Phone number *', type: 'tel', required: true }, { label: 'Social Security Number *', type: 'text', required: true },
      { label: 'Saturday availability', type: 'select', options: ['Morning', 'Evening', 'Overnight', 'Not available'] },
      { label: 'Employer', type: 'text', group: 'employment', index: 0 }, { label: 'Job title', type: 'text', group: 'employment', index: 0 },
      { label: 'Add another employment', type: 'button', group: 'employment' }],
    plan: (b) => {
      assert.deepEqual([b['First name *'].value, b['Phone number *'].value], ['Wes', '+1 555 123 4567']);
      assert.match(b['Social Security Number *'].reason, NEVER);
      assert.deepEqual([b['Saturday availability'].action, b['Saturday availability'].value], ['select', 'Evening']);
      assert.equal(b.Employer.value, 'Example Logistics');
      assert.equal(b['Add another employment'].action, 'add');
    },
    panel: 'ready',
  },
});

// ---- F: freelance translator in Spain, remote, a day rate ----
journey({
  key: 'es-translator',
  setup: (p) => {
    me(p, 'identity', '{ first_name: Fernanda, last_name: Example, email: fernanda@example.com, phone: "+34 91 1234567", city: Valencia, country: Spain }');
    me(p, 'language', 'en');
    me(p, 'sections', '[{ id: freelance, kind: experience, title: Freelance translator, org: Self-employed, start: "2017-01" }]');
    me(p, 'facts', '[{ id: freelance.words, text: "Translated about 1.2 million words of software and legal text from English to Spanish", tr: { es: "Traduje cerca de 1,2 millones de palabras de textos de software y jurídicos del inglés al español" } }]');
    pref(p, 'roles.targets', '[{ name: Traducción, titles: [translator, traductor, localization specialist], families: [creative-media] }]', 'traducción y localización');
    pref(p, 'workplace', '[remote]', 'remote');
    pref(p, 'places.remote_from', '[Spain, European Union]', 'from Spain, EU clients');
    pref(p, 'employment_types', '[freelance, contract]', 'freelance');
    pref(p, 'languages', '[{ name: Spanish, level: C2 }, { name: English, level: C1 }]', 'Spanish native, English C1');
    pref(p, 'pay', '{ currency: EUR, floor: 200, period: day, hours_per_week: 40, days_per_week: 5, per_unit: "€0.08 a word at least", rule: top_of_range, unlisted: keep }', '200 a day, or 8 cents a word');
    pref(p, 'schedule.timezone', 'Europe/Madrid', 'Spain');
  },
  coverage: /fit remote work from Spain for writing, content and media/,
  where: (p, sg) => {
    assert.ok(sg.sources.some((x: any) => x.id === 'wttj'));
    ok(p, ['sources', 'add', '--provider', 'wttj']);
  },
  postings: [
    { title: 'Traductor/a inglés-español', company: 'Example Idiomas', location: 'Remoto (España)', pay_text: '5.000 € al mes', expect: 'pass' },
    { title: 'Freelance Translator EN>ES', company: 'Sample Localization', location: 'Remote (EU only)', pay_text: '€0.09/word', expect: 'pass' },
    { title: 'Localization Specialist (Spanish)', company: 'Demo Games', location: 'Remote - Europe', pay_text: '€3,000 per month', expect: 'pay' },
    { title: 'Spanish Translator', company: 'Placeholder Media', location: 'Remote', description: 'Applicants must be located in the United States.', expect: 'other_only' },
  ],
  targets: ['Traducción'],
  brief: [/per word|a word/],
  prepare: {
    title: 'Traductor/a inglés-español — Example Idiomas', lang: 'es',
    questions: [{ label: 'Nombre', kind: 'text', required: true }, { label: 'DNI/NIE', kind: 'text', required: true }, { label: '¿Por qué quieres trabajar con nosotros?', kind: 'textarea', required: true }],
    draft: /The form is in Spanish \(es\): answer in Spanish\./,
    fields: [{ label: 'Nombre *', type: 'text', required: true }, { label: 'Apellidos *', type: 'text', required: true }, { label: 'Correo electrónico *', type: 'email', required: true },
      { label: 'DNI/NIE *', type: 'text', required: true }, { label: 'Pretensión salarial', type: 'text' }, { label: 'Fecha de nacimiento', type: 'date' }, { label: 'Currículum *', type: 'file', required: true }],
    plan: (b) => {
      assert.deepEqual(['Nombre *', 'Apellidos *', 'Correo electrónico *'].map((l) => b[l].value), ['Fernanda', 'Example', 'fernanda@example.com']);
      assert.match(b['DNI/NIE *'].reason, NEVER);
      for (const l of ['Pretensión salarial', 'Fecha de nacimiento']) assert.match(b[l].reason, SENS, l);
      assert.equal(b['Currículum *'].action, 'upload');
    },
    panel: 'ready',
  },
});

