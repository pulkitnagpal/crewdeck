import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notesOf } from '../../src/jobs/ctx.ts';
import { addEvent } from '../../src/jobs/db.ts';
import { storeFormFields } from '../../src/jobs/kb/questions.ts';
import { answerFirstTime, currentAnswers } from '../../src/jobs/kb/ops.ts';
import { prepareDraft } from '../../src/jobs/draft/draft.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { markApplied } from '../../src/jobs/pipeline/apply.ts';
import { applicationsView, knowledgeView, money, payLine, resumeFileName, sourceLine, todayView } from '../../src/jobs/views.ts';
import { role, world } from './helpers.ts';

/** Intl puts no-break spaces between amount and symbol; compare as plain spaces. */
const sp = (s: string) => s.replace(/\u00a0|\u202f/g, ' ');

function seeded(person: 'berlin-analyst' | 'us-nurse' = 'berlin-analyst') {
  const w = world(person);
  const id = role(w.ctx, { company: 'Example Labs', pay_text: person === 'us-nurse' ? '$45 - $52 per hour' : '€60,000 – €70,000 per year', location: person === 'us-nurse' ? 'Remote - Texas' : 'Berlin' });
  runPrefilter(w.ctx);
  w.ctx.db.prepare(`update roles set status='picked', picked_on='2026-11-19' where id=?`).run(id);
  storeFormFields(w.ctx.db, id, notesOf(w.ctx).profile.data, [
    { label: 'Email', kind: 'text', required: true },
    { label: 'Optional video link', kind: 'text' },
  ]);
  prepareDraft(w.ctx, id);
  return { ...w, id };
}

test('today: queue chips, required first-time questions first and blocking Apply, sources in plain words', () => {
  const w = seeded();
  let v = todayView(w.ctx).detail!;
  assert.equal(v.approvable, true, 'an optional first-time question doesn\'t block Apply');
  assert.equal(sp(v.meta), 'Berlin · 60.000 €–70.000 € a year');
  assert.equal(v.rows.find((r) => r.label === 'Email')!.source, 'Sources: your profile');
  assert.deepEqual(v.apply, { mode: 'fill' });
  storeFormFields(w.ctx.db, w.id, notesOf(w.ctx).profile.data, [
    { label: 'Email', kind: 'text', required: true }, { label: 'Optional video link', kind: 'text' },
    { label: 'Experience with Looker', kind: 'radio', required: true, options: ['Some', 'A lot'] },
  ]);
  prepareDraft(w.ctx, w.id);
  w.ctx.db.prepare(`insert into answers(role_id, form_field_id, question_id, company, text, status, created_at) select role_id, id, question_id, 'Example Labs', null, 'first_time', '2026-11-19' from form_fields where label like 'Experience%'`).run();
  const t = todayView(w.ctx);
  v = t.detail!;
  assert.equal(v.approvable, false);
  assert.equal(v.rows[0].label, 'Experience with Looker');
  assert.deepEqual(t.queue[0].chip, { kind: 'first', text: '1 first-time question' });
  answerFirstTime(w.ctx, { role: w.id, question: 'Looker', value: 'A lot', quote: 'a lot of Looker' });
  const after = todayView(w.ctx).detail!;
  assert.match(after.rows.find((r) => r.label.startsWith('Experience'))!.source, /^Sources: your words, 19\. Nov\.$/);
  assert.equal(after.approvable, true);
});

test('today: preparing roles can\'t be applied; applied today stays listed; the resume shows once rendered', () => {
  const w = seeded();
  const fresh = role(w.ctx, { company: 'Sample Retail' }, 'picked');
  const t = todayView(w.ctx, fresh);
  assert.equal(t.queue.find((q) => q.id === fresh)!.chip.text, 'Preparing');
  assert.equal(t.detail!.approvable, false);
  assert.equal(t.detail!.resume, null);
  const dir = join(w.jobsHome, 'out', w.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Ada Example Lebenslauf.pdf'), '%PDF-1.4\n');
  assert.equal(todayView(w.ctx, w.id).detail!.resume!.pdf, join(dir, 'Ada Example Lebenslauf.pdf'));
  markApplied(w.ctx, w.id);
  const v = todayView(w.ctx, w.id);
  assert.equal(v.queue.at(-1)!.chip.text, 'Applied');
  assert.equal(v.detail!.applied, '19. Nov.', 'dates in the user\'s locale (de-DE)');
  w.at('2026-11-21T10:00:00Z');
  assert.ok(!todayView(w.ctx).queue.some((q) => q.id === w.id), 'earlier days live in Applications');
  const apps = applicationsView(w.ctx).rows;
  assert.deepEqual(apps.find((a) => a.id === w.id), { id: w.id, company: 'Example Labs', title: 'Senior Data Analyst', status: 'Applied', applied: '19. Nov.', outreach: '—', next: 'Wait for a reply' });
});

test('money and dates follow the user\'s pay.locale, pay.currency and time zone', () => {
  const n = seeded('us-nurse');
  assert.equal(todayView(n.ctx).detail!.meta, 'Remote - Texas · $45–$52 an hour');
  assert.equal(sp(money(55000, 'EUR', 'de-DE')), '55.000 €');
  assert.equal(money(42.5, 'USD', 'en-US'), '$42.50');
  assert.equal(money(4500000, 'INR', 'en-IN'), '₹45,00,000');
  assert.equal(payLine({ pay_text: 'competitive' }), 'competitive');
  assert.equal(payLine({ pay_min: null, pay_max: 80000, pay_currency: 'GBP', pay_period: 'year' }, 'en-GB'), 'up to £80,000 a year');
  addEvent(n.ctx.db, n.id, 'deadline', '2026-11-30T05:00:00Z'); // still the 29th in Chicago
  const fresh = role(n.ctx, { company: 'Sample Health' }, 'picked');
  n.ctx.db.prepare(`insert into events(role_id, kind, detail, at) values (?, 'deadline', '2026-11-30T05:00:00Z', '2026-11-19')`).run(fresh);
  storeFormFields(n.ctx.db, fresh, notesOf(n.ctx).profile.data, [{ label: 'Email', kind: 'text' }]);
  prepareDraft(n.ctx, fresh);
  assert.equal(todayView(n.ctx).queue.find((q) => q.id === fresh)!.chip.text, 'Closes Nov 29');
});

test('what Claude knows: six tabs (learned has no note), each naming its note for "Open in Notes"', () => {
  const w = seeded();
  answerFirstTime(w.ctx, { role: w.id, question: 'video', value: 'https://video.example.com/ada', quote: 'here is my video' });
  const profile = knowledgeView(w.ctx, 'profile');
  assert.equal(profile.note, 'me/profile.md');
  assert.ok(profile.items.some((i) => i.id === 'profile:email' && i.text === 'ada@example.com' && i.used === 'used 1 time'));
  const career = knowledgeView(w.ctx, 'career');
  assert.equal(career.note, 'me/career.md');
  assert.ok(career.items.some((i) => i.id === 'example-gmbh.dashboards' && i.title === 'Senior Data Analyst, Example GmbH' && i.text === 'Built 40 dashboards used by 300 colleagues.'));
  const search = knowledgeView(w.ctx, 'search');
  assert.equal(search.note, 'jobs/search.md');
  assert.ok(search.items.some((i) => i.title === 'pay' && sp(i.text) === 'floor 55.000 € a year'));
  const memory = knowledgeView(w.ctx, 'memory');
  assert.equal(memory.note, 'jobs/memory.md');
  assert.ok(memory.items.some((i) => i.quote === 'here is my video' && /your words, 19\. Nov\. · Example Labs only/.test(i.source)));
  const answers = knowledgeView(w.ctx, 'answers');
  assert.equal(answers.note, null);
  assert.ok(answers.items.some((i) => i.title === 'Optional video link'));
  assert.deepEqual(Object.keys(answers.counts), ['profile', 'career', 'search', 'memory', 'answers', 'learned']);
  assert.equal(knowledgeView(w.ctx, 'learned').note, null);
  assert.ok(answers.counts.career >= 6);
  assert.throws(() => knowledgeView(w.ctx, 'secrets' as any), /tab must be/);
});

test('sources and resume file names in plain words, from the notes', () => {
  assert.equal(sourceLine(['example-gmbh.dashboards', 'profile:email']), 'Sources: your resume (example-gmbh.dashboards), your profile');
  assert.match(sourceLine(['m-3'], [{ id: 'm-3', created: '2026-11-17' } as any]), /your words, 17 Nov/);
  assert.equal(sourceLine(['posting']), 'Sources: the posting');
  const w = seeded();
  const n = notesOf(w.ctx);
  assert.equal(resumeFileName(n.career.data, n.profile.data), 'Ada Example Lebenslauf.pdf');
  assert.equal(currentAnswers(w.ctx.db, w.id).length, 2);
});
