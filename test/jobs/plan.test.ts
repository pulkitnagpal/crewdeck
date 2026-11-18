import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notesOf } from '../../src/jobs/ctx.ts';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { PLAN_ACTIONS, answerFor, fillPlan, planForRole } from '../../src/jobs/plan.ts';
import { storeFormFields } from '../../src/jobs/kb/questions.ts';
import { prepareDraft } from '../../src/jobs/draft/draft.ts';
import { join } from 'node:path';
import { setField } from '../../src/jobs/edit.ts';
import { PEOPLE, role, world } from './helpers.ts';

const ada = loadJobNotes(PEOPLE['berlin-analyst'], null).profile.data;
const riley = loadJobNotes(PEOPLE['us-nurse'], null).profile.data;

test('fill plan: per-role answers, then profile; sensitive and unmatched choices are left for the user', () => {
  const plan = fillPlan([
    { label: 'First Name *', type: 'text', required: true },
    { label: 'Why do you want to work here?', type: 'textarea' },
    { label: 'Expected salary', type: 'text' },
    { label: 'Country', type: 'select', options: ['United States', 'Germany'] },
    { label: 'Do you need sponsorship?', type: 'radio', options: ['Yes', 'No'] },
    { label: 'Notice period', type: 'text' },
    { label: 'Work authorization', type: 'text' },
    { label: 'Resume/CV', type: 'file' },
    { label: 'Autofill from resume', type: 'file' },
    { label: 'Pronouns', type: 'select', options: ['she/her', 'he/him'] },
    { label: 'Favourite colour', type: 'text', required: true },
  ], { 'Why do you want to work here?': 'Because of the forecasting work.' }, ada);
  const by = Object.fromEntries(plan.map((p) => [p.label, p]));
  assert.deepEqual([by['First Name *'].action, by['First Name *'].value], ['fill', 'Ada']);
  assert.equal(by['Why do you want to work here?'].value, 'Because of the forecasting work.');
  assert.equal(by['Expected salary'].action, 'skip');
  assert.match(by['Expected salary'].reason!, /sensitive/);
  assert.deepEqual([by['Country'].action, by['Country'].value], ['select', 'Germany']);
  assert.equal(by['Do you need sponsorship?'].action, 'skip');
  assert.equal(by['Notice period'].value, '1 month');
  assert.equal(by['Work authorization'].value, 'EU citizen', 'a sensitive question exactly matching a standard answer');
  assert.equal(by['Resume/CV'].action, 'upload');
  assert.equal(by['Autofill from resume'].action, 'skip');
  assert.equal(by['Pronouns'].action, 'skip');
  assert.match(by['Favourite colour'].reason!, /required, no answer/);
});

test('fill plan: never a submit or review action; passwords, CAPTCHAs and buttons are skipped', () => {
  const plan = fillPlan([
    { label: 'Submit application', type: 'submit' },
    { label: 'Review', type: 'button' },
    { label: 'Next', type: 'button' },
    { label: 'Create a password', type: 'password', required: true },
    { label: 'Verification code', type: 'text' },
    { label: 'I\'m not a robot', type: 'checkbox', options: ['I\'m not a robot'] },
    { label: 'Email', type: 'email' as any },
  ], { 'Create a password': 'hunter2', 'Submit application': 'yes' }, riley);
  for (const p of plan) assert.ok(PLAN_ACTIONS.includes(p.action), p.action);
  assert.deepEqual(plan.slice(0, 6).map((p) => p.action), ['skip', 'skip', 'skip', 'skip', 'skip', 'skip']);
  assert.ok(!plan.some((p) => p.value === 'hunter2'));
  assert.equal(plan[6].value, 'riley@example.com');
});

test('fill plan: an explicit answer whose option is missing is skipped, never guessed; labels match loosely', () => {
  const [p] = fillPlan([{ label: 'Years of experience', type: 'select', options: ['0-2', '3-5'] }], { 'Years of experience': '9' }, riley);
  assert.equal(p.action, 'skip');
  assert.match(p.reason!, /no option matches/);
  assert.equal(answerFor('Describe your triage experience: *', { 'Describe your triage experience': 'x' }), 'x');
  assert.equal(answerFor('Shift availability (nights?)', { 'shift availability': 'Nights' }), 'Nights');
  assert.equal(answerFor('Name', { 'Referrer name': 'x' }), undefined);
});

function seeded(features = {}, url?: string) {
  const w = world('berlin-analyst', { features });
  const id = role(w.ctx, { company: 'Example Labs', ...(url ? { url } : {}) }, 'prepared');
  storeFormFields(w.ctx.db, id, notesOf(w.ctx).profile.data, [{ label: 'Email', kind: 'text' }, { label: 'Notice period', kind: 'text' }]);
  prepareDraft(w.ctx, id);
  return { ...w, id };
}
const FIELDS = [{ label: 'Email', type: 'text' }, { label: 'Notice period', type: 'text' }, { label: 'Submit', type: 'submit' }];

test('copy-only sites (built in, or the user\'s copy_only_hosts) get the answers to copy, not a plan', () => {
  const w = seeded({}, 'https://wellfound.com/jobs/123');
  const p = planForRole(w.ctx, w.id, FIELDS);
  assert.equal(p.mode, 'copy');
  assert.deepEqual(p.mode === 'copy' && p.answers, [{ label: 'Email', text: 'ada@example.com' }, { label: 'Notice period', text: '1 month' }]);
  const v = seeded({}, 'https://careers.example.org/jobs/9');
  assert.equal(planForRole(v.ctx, v.id, FIELDS).mode, 'fill');
  assert.equal(planForRole(v.ctx, v.id, FIELDS, 'https://apply.example.net/form').mode, 'fill');
  setField(join(v.vault, 'me', 'profile.md'), 'profile', ['copy_only_hosts'], 'example.net');
  assert.equal(planForRole(v.ctx, v.id, FIELDS, 'https://apply.example.net/form').mode, 'copy', 'the user\'s own copy-only host, by subdomain');
});

test('Easy Apply: refused while off; with it on, each role counts once per local day up to daily_quick_apply', () => {
  const li = (n: number) => `https://www.linkedin.com/jobs/view/${n}`;
  const off = seeded({ linkedin_links: true }, li(1));
  const p = planForRole(off.ctx, off.id, FIELDS);
  assert.equal(p.mode, 'copy');
  assert.match(p.mode === 'copy' ? p.reason : '', /Easy Apply filling is off/);

  const w = world('berlin-analyst', { features: { easy_apply: true, daily_quick_apply: 2 }, now: '2026-11-19T21:00:00Z' });
  const ids = [1, 2, 3].map((n) => role(w.ctx, { company: `Example ${n}`, url: li(100 + n) }, 'prepared'));
  assert.equal(planForRole(w.ctx, ids[0], FIELDS).mode, 'fill');
  assert.equal(planForRole(w.ctx, ids[0], FIELDS).mode, 'fill', 'the same role again does not count twice');
  const second = planForRole(w.ctx, ids[1], FIELDS);
  assert.deepEqual(second.mode === 'fill' && second.quick_apply, { used: 2, cap: 2 });
  assert.match((planForRole(w.ctx, ids[2], FIELDS) as any).reason, /limit \(2\) is used/);
  w.at('2026-11-19T23:30:00Z'); // 00:30 in Berlin: a new day
  assert.equal(planForRole(w.ctx, ids[2], FIELDS).mode, 'fill');
});
