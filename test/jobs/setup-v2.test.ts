// Setup v2 (design §24.4, §24.10, P9f) scripted through the CLI commands the jobs-setup skill runs, for three fictional
// people starting from the empty templates: E (backend engineer in India, remote, with a resume), N (registered nurse
// in Columbus, Ohio, nights, hourly) and W (warehouse and delivery work in Texas, no resume, a career break). Each ends
// with `crewdeck jobs check` clean and a preview in which every kind of job they want passes at least one posting.
// Postings come in as pasted roles (`add-role`), the path that works everywhere; fetching is tried as setup does and its
// "can't run here" answer is checked. Every person, company and address here is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { jobs } from './helpers.ts';
import { splitNote } from '../../src/jobs/notes.ts';
import { fetchOnce, file, finish, me, ok, posting, pref, preview, search, sources, start } from './setup-helpers.ts';

test('E: backend engineer in India, remote, from a resume: targets checked on postings, variants from the preview loop, boards from the catalog, LinkedIn placed first', () => {
  const p = start();
  // 1–3: the resume path (facts word for word).
  me(p, 'identity.first_name', 'Asha'); me(p, 'identity.last_name', 'Example'); me(p, 'identity.email', 'asha@example.com');
  me(p, 'identity.city', 'Pune'); me(p, 'identity.country', 'India');
  me(p, 'standard_answers.work_authorization', 'I can work in India without sponsorship');
  me(p, 'sections', '[{ id: summary, kind: summary }, { id: example-tech, kind: experience, title: Backend Engineer, org: Example Tech, where: Pune, dates: "2021 – now" }, { id: skills, kind: skills }]');
  me(p, 'facts', '[{ id: example-tech.apis, text: "Built **12** internal APIs in Go serving 3 product teams" }, { id: example-tech.oncall, text: "Cut on-call pages by **40%** with better alerts" }]');
  me(p, 'skills', '[Go, Python, PostgreSQL, Kubernetes]');
  // 4: one kind of job, deliberately narrow at first; level, where, workplace, how.
  pref(p, 'roles.targets', '[{ name: Backend developer, titles: [backend engineer, backend developer], families: [engineering-it] }]', 'backend work, Go or Python');
  pref(p, 'roles.level', 'experienced', 'I have five years');
  pref(p, 'workplace', '[remote]', 'remote only');
  pref(p, 'places.remote_from', '[India]', 'I live in India');
  pref(p, 'employment_types', '[full-time]', 'full-time');
  pref(p, 'needs_sponsorship', 'false', 'I work from India');
  // 5: where to look, from the catalog; LinkedIn placed first (switching it on stays the user's).
  const sg = JSON.parse(ok(p, ['sources', 'suggest', '--json']));
  assert.ok(sg.sources.some((s: any) => s.id === 'remotive'));
  assert.match(sg.coverage.line, /remote work from India for engineering-it/);
  ok(p, ['sources', 'add', '--provider', 'remotive']);
  ok(p, ['sources', 'add', '--provider', 'weworkremotely']);
  ok(p, ['sources', 'add', '--linkedin', '--at', '1']);
  assert.match(sources(p), /sources:\n {2}- \{ key: linkedin, name: LinkedIn, linkedin: search, added: [\d-]+ \}\n {2}- \{ key: remotive/);
  assert.doesNotMatch(readFileSync(join(p.home, 'config.yaml'), 'utf8'), /linkedin_search: true/, 'setup never switches LinkedIn on');
  // 6: fetch once (nothing can run on a fresh home: said plainly), then postings the user pasted.
  fetchOnce(p);
  for (const r of [
    { title: 'Senior Software Engineer, Backend', company: 'Example Payments', location: 'Remote (India)' },
    { title: 'Backend Developer (Go)', company: 'Sample Labs', location: 'Remote, India' },
    { title: 'Platform Engineer', company: 'Example Cloud', location: 'Remote - India' },
    { title: 'Platform Engineer II', company: 'Sample Systems', location: 'Remote (India)' },
    { title: 'Backend Engineer', company: 'Placeholder Inc', location: 'Remote - US only' },
    { title: 'Product Designer', company: 'Example Studio', location: 'Remote, India' },
  ]) posting(p, r);
  const first = preview(p);
  assert.equal(first.pool, 6);
  assert.equal(first.pass, 2);
  assert.ok(first.near.some((g: any) => g.items.some((x: any) => /Platform Engineer/.test(x.label))), 'a near miss the user can add');
  const fix = first.suggestions.find((x: any) => x.kind === 'variants');
  assert.ok(fix, 'a variant fix with its own count');
  // Checked before it is written: the change as a partial search.md, previewed, then saved with the user's yes.
  const tried = preview(p, `roles: { targets: ${JSON.stringify(fix.change['roles.targets'])} }`);
  assert.deepEqual([tried.pass, tried.was], [4, 2]);
  assert.deepEqual(fix.pref.map((x: any) => x.path), ['roles.targets[0].titles'], 'one target\'s titles, the rest of it untouched');
  for (const x of fix.pref) pref(p, x.path, JSON.stringify(x.value), 'yes, platform engineer roles too');
  assert.ok(search(p).roles.targets[0].titles.some((t: string) => /platform engineer/i.test(t)));
  assert.equal(search(p).roles.targets[0].name, 'Backend developer');
  // 7: pay and the rest; cooldown 60 days for engineering.
  pref(p, 'pay.currency', 'INR', 'rupees'); pref(p, 'pay.floor', '0', 'no floor yet'); pref(p, 'pay.locale', 'en-IN', 'Indian format');
  pref(p, 'languages', '[{ name: English, level: fluent }, { name: Hindi, level: native }]', 'English and Hindi');
  pref(p, 'schedule.cooldown_days', '60', 'sixty days is fine');
  pref(p, 'schedule.timezone', 'Asia/Kolkata', 'India time');
  const pv = finish(p, ['Backend developer']);
  assert.equal(pv.pass, 4);
  assert.ok(pv.dropped.some((d: any) => d.company === 'Placeholder Inc') || pv.drops.some((d: any) => /place|remote/.test(d.label)), 'the US-only posting still drops');
});

test('N: registered nurse in Columbus, Ohio, nights, hourly: no nursing board (said plainly), hospitals as employers, nights as her work pattern, 14-day role-scoped cooldown', () => {
  const p = start();
  me(p, 'identity.first_name', 'Nora'); me(p, 'identity.last_name', 'Example'); me(p, 'identity.email', 'nora@example.com');
  me(p, 'identity.city', 'Columbus'); me(p, 'identity.region', 'Ohio'); me(p, 'identity.country', 'United States');
  me(p, 'standard_answers.work_authorization', 'US citizen');
  me(p, 'sections', '[{ id: example-health, kind: experience, title: Registered Nurse, org: Example Health, where: "Columbus, OH", dates: "2019 – now" }, { id: licences, kind: list, title: Licences }]');
  me(p, 'facts', '[{ id: example-health.nights, text: "Charge nurse on a 32-bed medical-surgical unit, night shift" }, { id: licences.rn, text: "RN, Ohio Board of Nursing" }]');
  pref(p, 'roles.targets', '[{ name: Nurse, titles: [registered nurse, RN, staff nurse, charge nurse], families: [healthcare] }]', 'RN jobs, nights');
  pref(p, 'workplace', '[onsite]', 'on the ward');
  pref(p, 'places.onsite', '[Columbus, OH]', 'Columbus');
  pref(p, 'places.commute_km', '40', 'about 25 miles');
  pref(p, 'employment_types', '[full-time, part-time, per-diem]', 'any of those');
  pref(p, 'licenses', '[{ name: RN, where: Ohio }]', 'Ohio RN');
  // P9g: moving, right to work and the work pattern in their own fields; the rest stays in her words.
  pref(p, 'places.relocate_to', '[Cincinnati, Cleveland]', 'I would move to Cincinnati or Cleveland');
  pref(p, 'places.authorized_in', '[United States]', 'allowed to work in the US');
  pref(p, 'work_pattern.shifts', '[night]', 'nights only');
  pref(p, 'work_pattern.hours_per_week', '{ max: 36 }', 'three twelves');
  pref(p, 'judge_notes', 'Three 12-hour shifts a week.', 'nights only, three twelves');
  // Where to look: the catalog has no nursing board in the US, and says so with what still works.
  const sg = JSON.parse(ok(p, ['sources', 'suggest', '--json']));
  assert.deepEqual(sg.sources, []);
  assert.match(sg.coverage.line, /^Crewdeck has no job board that fits .*for healthcare\. Employers' careers pages work when they use /);
  assert.match(sg.coverage.line, /paste any posting you find\.$/);
  // Employers: the hospital's careers page added; resolve can't run on a fresh home and leaves the note as it was.
  ok(p, ['sources', 'add', '--careers-url-file', file(p, 'https://example-health.wd1.myworkdayjobs.example.test/External'), '--name-file', file(p, 'Example Health'), '--employer']);
  const before = sources(p);
  const r = jobs(p.home, ['sources', 'resolve', 'example-health']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /providers are not installed|Node 25/);
  assert.equal(sources(p), before);
  ok(p, ['sources', 'add', '--linkedin']);
  fetchOnce(p);
  for (const x of [
    { title: 'RN - Night Shift', company: 'Example Health', location: 'Columbus, OH', pay_text: '$40 - $48 per hour' },
    { title: 'Registered Nurse, ICU (Nights)', company: 'Sample Medical Center', location: 'Columbus, OH', pay_text: '$42/hr' },
    { title: 'Nursery Assistant', company: 'Example Kids', location: 'Columbus, OH' },
    { title: 'Registered Nurse', company: 'Placeholder Hospital', location: 'Toronto, ON, Canada' },
  ]) posting(p, x);
  pref(p, 'pay.currency', 'USD', 'dollars'); pref(p, 'pay.floor', '38', 'at least 38 an hour'); pref(p, 'pay.period', 'hour', 'hourly');
  pref(p, 'pay.rule', 'bottom_of_range', 'the bottom must reach it');
  pref(p, 'pay.hours_per_week', '36', 'three twelves'); pref(p, 'pay.days_per_week', '3', 'three shifts');
  pref(p, 'schedule.cooldown_days', '14', 'two weeks: hospitals post many units');
  pref(p, 'schedule.cooldown_scope', 'role', 'other units at the same hospital are fine');
  pref(p, 'schedule.timezone', 'America/New_York', 'Ohio time');
  const pv = finish(p, ['Nurse']);
  assert.equal(pv.pass, 2, 'the night RN roles pass; "Nursery Assistant" and Toronto drop');
  assert.deepEqual(search(p).schedule, { daily_picks: 5, cooldown_days: 14, cooldown_scope: 'role', per_company: 1, timezone: 'America/New_York' });
  assert.deepEqual(search(p).work_pattern.shifts, ['night']);
  const brief = ok(p, ['judge-brief']);
  assert.match(brief, /Shifts the user can work: night/);
  assert.match(brief, /may work without sponsorship in: United States/);
  assert.match(brief, /would move to Cincinnati, Cleveland/);
  assert.match(sources(p), /key: example-health, name: Example Health, careers_url: "?https:\/\/example-health\.wd1\.myworkdayjobs\.example\.test\/External"?, employer: true/);
});

test('W: warehouse and delivery work in Texas without a resume: facts from his answers, a career break, two kinds of job, licences with where', () => {
  const p = start();
  me(p, 'identity.first_name', 'Wes'); me(p, 'identity.last_name', 'Example'); me(p, 'identity.email', 'wes@example.com');
  me(p, 'identity.phone', '+1 555 123 4567'); me(p, 'identity.city', 'Houston'); me(p, 'identity.region', 'Texas'); me(p, 'identity.country', 'United States');
  // An experience entry needs an organisation unless it is a break.
  const bad = jobs(p.home, ['me', 'set', 'sections', '--value-file', file(p, '[{ id: odd-jobs, kind: experience, title: Odd jobs }]')]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /sections\[0\]\.org: is missing .*a career break is break: true without one/);
  // The no-resume path: roles he held, in his words, and the break, with no organisation.
  me(p, 'sections', '[{ id: example-logistics, kind: experience, title: Warehouse associate, org: Example Logistics, where: "Houston, TX", dates: "2020 – 2023" }, { id: gig-delivery, kind: experience, title: Delivery driver, org: Self-employed (gig work), dates: "2023 – 2024" }, { id: career-break, kind: experience, title: Career break, break: true, dates: "2024 – 2025" }, { id: licences, kind: list, title: Licences }]');
  me(p, 'facts', '[{ id: example-logistics.picking, text: "Picked and packed about 150 orders a shift" }, { id: example-logistics.forklift, text: "Drove a forklift and a pallet jack every day" }, { id: gig-delivery.routes, text: "Delivered groceries across Houston, 30 to 40 stops a day" }, { id: licences.cdl, text: "CDL Class B (Texas)" }]');
  me(p, 'skills', '[forklift, pallet jack, inventory scanning]');
  me(p, 'standard_answers.employment_gap', 'I took a year off to care for a family member');
  pref(p, 'roles.targets', '[{ name: Warehouse, titles: [warehouse associate, picker packer, material handler, forklift operator], families: [logistics-transport] }, { name: Driving, titles: [delivery driver, CDL driver, box truck driver], families: [logistics-transport] }]', 'warehouse or driving, either is fine');
  pref(p, 'roles.level', 'any', 'any level');
  pref(p, 'workplace', '[onsite]', 'on site');
  pref(p, 'places.onsite', '[Houston, TX]', 'Houston');
  pref(p, 'employment_types', '[part-time, full-time, temporary]', 'part-time preferred');
  pref(p, 'licenses', '["CDL Class B (Texas)", "Forklift certification"]', 'my CDL B and forklift card');
  pref(p, 'work_pattern.hours_per_week', '{ min: 20, max: 24 }', 'about 24 hours');
  pref(p, 'work_pattern.shifts', '[day, evening, weekend]', 'weekends ok');
  const sg = JSON.parse(ok(p, ['sources', 'suggest', '--json']));
  assert.match(sg.coverage.line, /^Crewdeck has no job board that fits .*for logistics-transport\./);
  fetchOnce(p);
  for (const x of [
    { title: 'Warehouse Associate - Weekend Shift', company: 'Example Distribution', location: 'Houston, TX', pay_text: '$18/hour' },
    { title: 'Delivery Driver (Class B CDL)', company: 'Sample Freight', location: 'Houston, TX', pay_text: '$21 an hour' },
    { title: 'Forklift Operator', company: 'Placeholder Supply', location: 'Houston, TX' },
    { title: 'Software Engineer', company: 'Example Apps', location: 'Houston, TX' },
  ]) posting(p, x);
  pref(p, 'pay.currency', 'USD', 'dollars'); pref(p, 'pay.floor', '17', 'seventeen an hour at least'); pref(p, 'pay.period', 'hour', 'hourly');
  pref(p, 'schedule.cooldown_days', '14', 'two weeks');
  pref(p, 'schedule.cooldown_scope', 'role', 'other stores are fine');
  pref(p, 'schedule.timezone', 'America/Chicago', 'Texas time');
  const pv = finish(p, ['Warehouse', 'Driving']);
  assert.equal(pv.pass, 3);
  const career = parse(splitNote(readFileSync(join(p.vault, 'me', 'career.md'), 'utf8')).front!);
  assert.equal(career.sections.find((s: any) => s.id === 'career-break').org, undefined, 'a break has no organisation');
});
