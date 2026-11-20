import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitNote } from '../../src/jobs/notes.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { storeFormFields, slugKey } from '../../src/jobs/kb/questions.ts';
import { answerFirstTime, changeAnswer, currentAnswers, editAnswer, insertAnswer, knowledge, remember, undoLast } from '../../src/jobs/kb/ops.ts';
import { learnField } from '../../src/jobs/kb/learn.ts';
import { role, world } from './helpers.ts';

const memItems = (w: { vault: string }) => parse(splitNote(readFileSync(join(w.vault, 'jobs', 'memory.md'), 'utf8')).front!).items as any[];

/** Two open roles at two companies, each with a choice question and a written one (a draft on the second). */
function seed() {
  const w = world('berlin-analyst');
  const { ctx } = w;
  const ids: Record<string, string> = {};
  for (const co of ['Example Labs', 'Sample Retail']) {
    ids[co] = role(ctx, { company: co }, 'picked');
    storeFormFields(ctx.db, ids[co], notesOf(ctx).profile.data, [
      { label: 'Experience with SQL', kind: 'radio', required: true, options: ['Beginner', 'Daily use in production'] },
      { label: 'Describe a dashboard you are proud of', kind: 'textarea', required: true },
    ]);
    const f = currentAnswers(ctx.db, ids[co]);
    insertAnswer(ctx, f[0], ids[co], co, null, [], 'first_time');
    insertAnswer(ctx, f[1], ids[co], co, 'I built 40 dashboards used by 300 colleagues.', ['example-gmbh.dashboards'], 'drafted');
  }
  return { ...w, ids };
}
const field = (w: any, id: string, re: RegExp) => currentAnswers(w.ctx.db, id).find((a) => re.test(a.label))!;

test('changeAnswer refuses a claim the user never made and stores nothing; a supported one becomes the current version', () => {
  const w = seed();
  const id = w.ids['Example Labs'];
  const bad = changeAnswer(w.ctx, { role: id, question: 'Q2', new_text: 'I built 90 dashboards in Tableau.', claims: [{ text: 'I built 90 dashboards in Tableau.', about: 'me', fact_ids: ['example-gmbh.dashboards'] }], instruction: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(field(w, id, /dashboard/).text, 'I built 40 dashboards used by 300 colleagues.');
  const text = 'Built 40 dashboards for 300 colleagues at Example GmbH.';
  const ok = changeAnswer(w.ctx, { role: id, question: 'dashboard', new_text: text, claims: [{ text, about: 'me', fact_ids: ['example-gmbh.dashboards'] }], instruction: 'shorter' });
  assert.equal(ok.ok, true);
  const f = field(w, id, /dashboard/);
  assert.deepEqual([f.text, f.status, f.version], [text, 'approved', 2]);
});

test('a first-time choice answer is remembered in the user\'s words and fills the same question on every open role', () => {
  const w = seed();
  const r = answerFirstTime(w.ctx, { role: w.ids['Example Labs'], question: 'SQL', value: 'daily use', quote: 'I use SQL daily in production' });
  assert.equal(r.answer.text, 'Daily use in production', 'matched to the option');
  const other = field(w, w.ids['Sample Retail'], /SQL/);
  assert.deepEqual([other.text, other.status, other.sources], ['Daily use in production', 'approved', [r.remembered.id]]);
  const item = memItems(w).find((m) => m.id === r.remembered.id);
  assert.deepEqual([item.kind, item.key, item.quote, item.scope], ['answer', 'experience_with_sql', 'I use SQL daily in production', 'all']);
  assert.ok(knowledge(w.ctx, 'SQL').memory.some((m) => m.text === 'Daily use in production'));
  assert.ok(knowledge(w.ctx, 'sql').answers.some((a) => a.answer === 'Daily use in production'));
});

test('a written first-time answer stays with that company; a company-scoped memory never changes another company', () => {
  const w = seed();
  const a = w.ids['Example Labs'], b = w.ids['Sample Retail'];
  w.ctx.db.prepare(`update answers set status='first_time', text=null where form_field_id=?`).run(field(w, b, /dashboard/).field_id);
  answerFirstTime(w.ctx, { role: a, question: 'dashboard', value: 'The Example Labs pricing dashboard', quote: 'the pricing one' });
  assert.equal(field(w, b, /dashboard/).text, null);
  const item = memItems(w).at(-1);
  assert.deepEqual([item.scope, item.company], ['company', 'Example Labs']);
});

test('a style rule queues written drafts for a redraft, never the user\'s own corrections', () => {
  const w = seed();
  const a = w.ids['Example Labs'], b = w.ids['Sample Retail'];
  editAnswer(w.ctx, { role: a, field_id: field(w, a, /dashboard/).field_id, text: 'My own words about dashboards.' });
  const r = remember(w.ctx, { kind: 'style', text: 'Two sentences, numbers first', quote: 'numbers first, two sentences' });
  assert.ok(r.applied >= 1);
  assert.match(field(w, b, /dashboard/).reason ?? '', /^redraft:m-\d+$/);
  assert.equal(field(w, a, /dashboard/).text, 'My own words about dashboards.');
  assert.equal(field(w, a, /dashboard/).status, 'approved');
});

test('undo reverts the latest change; undoing a new answer restores the one it replaced', () => {
  const w = seed();
  const id = w.ids['Example Labs'];
  const text = 'Built 40 dashboards for 300 colleagues.';
  changeAnswer(w.ctx, { role: id, question: 'Q2', new_text: text, claims: [{ text, about: 'me', fact_ids: ['example-gmbh.dashboards'] }], instruction: 'x' });
  undoLast(w.ctx);
  assert.equal(field(w, id, /dashboard/).text, 'I built 40 dashboards used by 300 colleagues.');
  // m-1 (notice_period "1 month") is replaced by a new answer, then the undo brings it back.
  const r = remember(w.ctx, { kind: 'answer', key: 'notice_period', text: '2 weeks', quote: 'two weeks now' });
  assert.deepEqual(r.superseded, ['m-1']);
  const u = undoLast(w.ctx);
  assert.equal(u.undone, `memory ${r.item.id}`);
  const items = memItems(w);
  assert.equal(items.find((m) => m.id === 'm-1').superseded_by, undefined);
  assert.equal(items.find((m) => m.id === r.item.id).superseded_by, 'retired');
  assert.equal(undoLast(w.ctx).undone, 'nothing to undo');
});

test('learn: a profile question met on a live form is answered from the profile at once, never first-time', () => {
  const w = seed();
  const id = w.ids['Example Labs'];
  const email = learnField(w.ctx, id, { label: 'Email address', required: true });
  assert.equal(email.ok && email.saved, 'Answered from what you already told Claude.');
  const f = field(w, id, /Email/);
  assert.deepEqual([f.text, f.status, f.sources, f.kind], ['ada@example.com', 'approved', ['profile:email'], 'contact']);
  const notice = learnField(w.ctx, id, { label: 'Notice period' });
  assert.ok(notice.ok);
  assert.deepEqual(field(w, id, /Notice/).sources, ['m-1'], 'a remembered answer wins over the profile');
  const visa = learnField(w.ctx, id, { label: 'Will you require visa sponsorship?', options: ['Yes', 'No'], answer: 'No' });
  assert.equal(visa.ok, false, 'sensitive questions need the user\'s own words');
  const asked = learnField(w.ctx, id, { label: 'Will you require visa sponsorship?', options: ['Yes', 'No'] });
  assert.equal(asked.ok && asked.saved, 'Recorded as a first-time question.');
  const told = learnField(w.ctx, id, { label: 'Will you require visa sponsorship?', options: ['Yes', 'No'], answer: 'No', quote: 'No, I am an EU citizen' });
  assert.equal(told.ok && told.saved, 'Remembered.');
  assert.equal(field(w, id, /visa/).text, 'No');
});

test('learn: a Yes/No answer to a question met without its options is a choice about the user, reused for every company', () => {
  // Found by the P6 journey: a "needs you" question answered on the page was kept for one company only.
  const w = seed();
  const [a, b] = [w.ids['Example Labs'], w.ids['Sample Retail']];
  const r = learnField(w.ctx, a, { label: 'Do you hold a valid driving licence?', answer: 'yes', quote: 'yes', required: true });
  assert.equal(r.ok && r.saved, 'Remembered.');
  const f = field(w, a, /driving/);
  assert.deepEqual([f.kind, f.options, f.text, f.status], ['choice', ['Yes', 'No'], 'Yes', 'approved']);
  assert.equal(memItems(w).find((x) => x.key === f.canonical_key).scope, 'all');
  const again = learnField(w.ctx, b, { label: 'Do you hold a valid driving licence?', options: ['Yes', 'No'], required: true });
  assert.equal(again.ok && again.saved, 'Answered from what you already told Claude.');
  assert.equal(field(w, b, /driving/).text, 'Yes');
  // A written answer still stays with its company.
  learnField(w.ctx, a, { label: 'What drew you to us?', answer: 'Your route planning product', quote: 'Your route planning product' });
  assert.equal(memItems(w).find((x) => x.text === 'Your route planning product').scope, 'company');
});

test('canonical keys are snake_case and start with a letter', () => {
  assert.equal(slugKey('Years of experience with SQL?'), 'years_of_experience_with_sql');
  assert.equal(slugKey('2nd language'), 'q_2nd_language');
  assert.equal(slugKey('Über uns: Warum?'), 'uber_uns_warum');
  assert.equal(slugKey('???'), 'question');
});

test('the user\'s own terms (career.md terms.extra) join the citation check; invalid copy-only hosts are refused', async () => {
  const { setField } = await import('../../src/jobs/edit.ts');
  const w = seed();
  const id = w.ids['Example Labs'];
  const text = 'I built 40 dashboards in Kestrel.';
  const claims = [{ text, about: 'me' as const, fact_ids: ['example-gmbh.dashboards'] }];
  assert.equal(changeAnswer(w.ctx, { role: id, question: 'Q2', new_text: text, claims, instruction: 'x' }).ok, true, 'unknown to the built-in list');
  setField(join(w.vault, 'me', 'career.md'), 'career', ['terms', 'extra'], 'Kestrel');
  const r = changeAnswer(w.ctx, { role: id, question: 'Q2', new_text: text, claims, instruction: 'x' });
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /Kestrel/);
  assert.throws(() => setField(join(w.vault, 'me', 'profile.md'), 'profile', ['copy_only_hosts'], 'not a host'), /not a host name/);
});
