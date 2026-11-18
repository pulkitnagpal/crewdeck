import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { checkAnswer, numbersIn, termsFor, type CiteContext } from '../../src/jobs/kb/cite.ts';
import type { MemoryItem } from '../../src/jobs/schema.ts';
import { PEOPLE } from './helpers.ts';

const analyst = loadJobNotes(PEOPLE['berlin-analyst'], null);
const nurse = loadJobNotes(PEOPLE['us-nurse'], null);
const memory: MemoryItem[] = [
  { id: 'm-7', kind: 'fact', text: 'Built a churn model in Python for the sales team', quote: 'I built a churn model in Python', scope: 'all', created: '2026-11-17' },
  { id: 'm-8', kind: 'fact', text: 'Old claim', quote: 'q', scope: 'all', created: '2026-11-17', superseded_by: 'm-9' },
  { id: 'm-9', kind: 'style', text: 'Keep it short', quote: 'short', scope: 'all', created: '2026-11-17' },
];
const ctx: CiteContext = {
  facts: analyst.career.data.facts, memory, postingText: 'Example Labs builds forecasting tools on Snowflake and Looker.',
  profile: { notice_period: '1 month', email: 'ada@example.com' },
};
const me = (text: string, fact_ids: string[]) => ({ text, about: 'me' as const, fact_ids });

test('passes a claim whose numbers appear in the cited fact (bold markers ignored)', () => {
  const text = 'I built 40 dashboards used by 300 colleagues.';
  assert.deepEqual(checkAnswer({ text, claims: [me(text, ['example-gmbh.dashboards'])] }, ctx), { ok: true });
});

test('rejects a number or a named term no cited source mentions, naming it', () => {
  const n = 'I built 45 dashboards.';
  const r1 = checkAnswer({ text: n, claims: [me(n, ['example-gmbh.dashboards'])] }, ctx);
  assert.equal(r1.ok, false);
  assert.match((r1 as any).reason, /45/);
  const t = 'I moved reporting to dbt and Tableau.';
  const r2 = checkAnswer({ text: t, claims: [me(t, ['sample-ag.etl'])] }, ctx);
  assert.equal(r2.ok, false);
  assert.match((r2 as any).reason, /Tableau/);
});

test('rejects unknown, superseded and non-fact memory ids; accepts memory and profile sources', () => {
  assert.equal(checkAnswer({ text: 'x', claims: [me('x', ['example-gmbh.invented'])] }, ctx).ok, false);
  assert.equal(checkAnswer({ text: 'Old claim', claims: [me('Old claim', ['m-8'])] }, ctx).ok, false);
  assert.match((checkAnswer({ text: 'Keep it short', claims: [me('Keep it short', ['m-9'])] }, ctx) as any).reason, /style item/);
  const t = 'I built a churn model in Python.';
  assert.equal(checkAnswer({ text: t, claims: [me(t, ['m-7'])] }, ctx).ok, true);
  assert.equal(checkAnswer({ text: '1 month', claims: [me('1 month', ['profile:notice_period'])] }, ctx).ok, true);
  assert.equal(checkAnswer({ text: '2 weeks', claims: [me('2 weeks', ['profile:notice_period'])] }, ctx).ok, false);
  assert.match((checkAnswer({ text: 'x', claims: [me('x', ['profile:salary'])] }, ctx) as any).reason, /unknown profile field/);
});

test('company claims may name what the posting names, and only that; claims about the user never cite the posting', () => {
  const ok = 'Example Labs forecasts on Snowflake.';
  assert.equal(checkAnswer({ text: ok, claims: [{ text: ok, about: 'company', fact_ids: ['posting'] }] }, ctx).ok, true);
  const bad = 'Example Labs runs on Databricks.';
  assert.equal(checkAnswer({ text: bad, claims: [{ text: bad, about: 'company', fact_ids: ['posting'] }] }, ctx).ok, false);
  const mine = 'I know Snowflake.';
  assert.equal(checkAnswer({ text: mine, claims: [me(mine, ['posting'])] }, ctx).ok, false);
});

test('the whole answer is checked, not just the listed claims; text without claims is refused', () => {
  const r = checkAnswer({ text: 'I built 40 dashboards. I also have 9 years of Python.', claims: [me('I built 40 dashboards', ['example-gmbh.dashboards'])] }, ctx);
  assert.equal(r.ok, false);
  assert.equal(checkAnswer({ text: 'Something', claims: [] }, ctx).ok, false);
});

test('terms span fields: healthcare and analytics names, aliases, short names only as written, the user\'s extra terms', () => {
  const nctx: CiteContext = { facts: nurse.career.data.facts, memory: [], postingText: '', profile: {} };
  const ok = 'I am an RN with a compact licence.';
  assert.equal(checkAnswer({ text: ok, claims: [me(ok, ['licences.rn'])] }, nctx).ok, true);
  const alias = 'Registered nurse, BLS and ACLS certified.';
  assert.equal(checkAnswer({ text: alias, claims: [me(alias, ['licences.rn', 'licences.bls'])] }, nctx).ok, true);
  const icu = 'I worked in the ICU and with Epic.';
  assert.match((checkAnswer({ text: icu, claims: [me(icu, ['summary.rn'])] }, nctx) as any).reason, /ICU|Epic/);
  const prose = 'I go to great lengths for patients and excel at teamwork.';
  assert.equal(checkAnswer({ text: prose, claims: [me(prose, ['summary.rn'])] }, nctx).ok, true, 'go / excel in prose are not Go / Excel');
  const extra = 'I use Kestrel daily.';
  const withExtra = { ...ctx, terms: termsFor(['Kestrel']) };
  assert.match((checkAnswer({ text: extra, claims: [me(extra, ['summary.analytics'])] }, withExtra) as any).reason, /Kestrel/);
  assert.deepEqual(numbersIn('5,000+ users, 50K rows, p99'), ['5000', '50k', '99']);
});
