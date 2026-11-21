// Jobs v2 P5, the ranking part of the learning loop: the person's own actions (applied, not interested, a pick set aside
// by hand, a pick left for a week) nudge the candidates' order by company, title words and source, within caps; Claude's
// verdicts never count; rules and eligibility never change. Fictional people and companies only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobs, role, world } from './helpers.ts';
import { LEARN_CAPS, computeLearned, learnedDelta, learnedLine, personActions, refreshLearned, storedLearned, titleWords } from '../../src/jobs/pipeline/learn.ts';
import { rankRoles } from '../../src/jobs/pipeline/rank.ts';
import { judge } from '../../src/jobs/pipeline/pick.ts';
import { markApplied, notInterested } from '../../src/jobs/pipeline/apply.ts';
import { setRoleStatus } from '../../src/jobs/pipeline/roles.ts';
import { knowledgeView } from '../../src/jobs/views.ts';

const pickedOn = (w: ReturnType<typeof world>, id: string, day: string) => w.ctx.db.prepare(`update roles set status='picked', picked_on=? where id=?`).run(day, id);

function seeded() {
  const w = world('example');
  // Applied twice at Acme Analytics (one from the portal), once at Birch Data.
  for (const [company, title, key] of [['Acme Analytics', 'Data Analyst', 'portal:naukri'], ['Acme Analytics', 'Senior Data Analyst', 'portal:naukri'], ['Birch Data', 'Product Analyst', 'remotive']]) {
    const id = role(w.ctx, { company, title, source_key: key });
    pickedOn(w, id, '2026-11-15');
    markApplied(w.ctx, id);
  }
  // Not interested at Cobalt Sales: sales titles.
  for (const t of ['Sales Analyst', 'Sales Operations Analyst']) notInterested(w.ctx, { role: role(w.ctx, { company: 'Cobalt Sales', title: t }), reason: 'I don\'t want sales roles' });
  // Set aside by the person after being picked.
  const aside = role(w.ctx, { company: 'Dune Reports', title: 'Reporting Specialist' });
  pickedOn(w, aside, '2026-11-18');
  setRoleStatus(w.ctx, aside, 'judged_out', 'not for me after all');
  // Claude's own "no" at Prepare: never learned from.
  const claude = role(w.ctx, { company: 'Ember Judged', title: 'Data Analyst' });
  pickedOn(w, claude, '2026-11-18');
  judge(w.ctx, [{ role: claude, eligible: 'no', score: 10, evidence: 'needs German C1', reason: 'language' }]);
  // A pick left for more than a week, and one picked yesterday.
  pickedOn(w, role(w.ctx, { company: 'Fjord Quiet', title: 'Insights Lead' }), '2026-11-08');
  pickedOn(w, role(w.ctx, { company: 'Grove Fresh', title: 'Insights Lead' }), '2026-11-18');
  return w;
}

test('the signals are the person\'s actions only: applied, not interested, set aside by hand, picks left a week', () => {
  const w = seeded();
  const acts = personActions(w.ctx);
  const by = (s: string) => acts.filter((a) => a.signal === s).map((a) => a.company).sort();
  assert.deepEqual(by('applied'), ['Acme Analytics', 'Acme Analytics', 'Birch Data']);
  assert.deepEqual(by('not_interested'), ['Cobalt Sales', 'Cobalt Sales']);
  assert.deepEqual(by('set_aside'), ['Dune Reports']);
  assert.deepEqual(by('ignored'), ['Fjord Quiet'], 'only the pick older than 7 days');
  assert.ok(!acts.some((a) => a.company === 'Ember Judged'), 'Claude\'s verdict at Prepare is not the person\'s action');
});

test('adjustments by company, title words and source, each capped; one role\'s total capped too', () => {
  const w = seeded();
  const l = refreshLearned(w.ctx);
  const row = (kind: string, label: string) => l.rows.find((r) => r.kind === kind && r.label === label);
  assert.equal(row('company', 'Acme Analytics')!.delta, LEARN_CAPS.company, 'two applications: +4 each, capped at +8');
  assert.equal(row('company', 'Cobalt Sales')!.delta, -6);
  assert.equal(row('company', 'Dune Reports')!.delta, -2);
  assert.equal(row('company', 'Fjord Quiet')!.delta, -1);
  assert.equal(row('company', 'Ember Judged'), undefined);
  assert.equal(row('word', 'sales')!.delta, -LEARN_CAPS.word);
  assert.equal(row('word', 'analyst')!.delta, 2, 'applied 3 times (+6), not interested twice (-4)');
  assert.equal(row('word', 'data')!.delta, LEARN_CAPS.word, 'applied in 2 titles, +2 each: at the cap');
  assert.equal(row('word', 'reporting'), undefined, 'one action says little about a word');
  assert.equal(row('source', 'portal:naukri')!.delta, 4);
  assert.equal(row('source', 'remotive')!.delta, 2);
  assert.ok(!l.rows.some((r) => r.kind === 'source' && r.delta < 0), 'sources learn only from applications');
  // A new role at Acme from Naukri with every positive word still moves at most LEARN_CAPS.total.
  const many = computeLearned(Array.from({ length: 10 }, () => ({ signal: 'applied' as const, company_id: 1, company: 'X', title: 'Data Analyst Engineer Scientist', source_key: 's' })));
  assert.equal(learnedDelta({ company_id: 1, title: 'Data Analyst Engineer Scientist', source_key: 's' }, many), LEARN_CAPS.total);
  assert.deepEqual(titleWords('Senior Data Analyst (Remote) - 2026'), ['senior', 'data', 'analyst']);
  assert.match(learnedLine(row('company', 'Acme Analytics')!), /^Ranks Acme Analytics higher \(\+8\): applied 2$/);
});

test('ranking: learned points reorder candidates, stored in the tracker; eligibility and rules never change', () => {
  const w = seeded();
  const acme = role(w.ctx, { company: 'Acme Analytics', title: 'BI Developer' });
  const plain = role(w.ctx, { company: 'Harbor Neutral', title: 'BI Developer' });
  const cobalt = role(w.ctx, { company: 'Cobalt Sales', title: 'BI Developer' });
  const ranked = rankRoles(w.ctx);
  const get = (id: string) => ranked.find((r) => r.id === id)!;
  assert.equal(get(acme).learned, 8);
  assert.equal(get(plain).learned, 0);
  assert.equal(get(cobalt).learned, -6);
  assert.ok(get(acme).rank > get(plain).rank && get(plain).rank > get(cobalt).rank);
  // Nothing was judged, skipped or filtered by it.
  for (const id of [acme, plain, cobalt]) assert.deepEqual({ ...(w.ctx.db.prepare('select status, eligibility from roles where id=?').get(id) as object) }, { status: 'new', eligibility: null });
  assert.ok(storedLearned(w.ctx).some((r) => r.kind === 'company' && r.label === 'Acme Analytics' && r.counts.applied === 2));
  // What Claude knows → Learned lists it briefly, from the stored rows.
  const k = knowledgeView(w.ctx, 'learned');
  assert.ok(k.items.some((i) => i.title === 'Ranks Acme Analytics higher (+8)' && i.text === 'applied 2' && i.source === 'From what you did'));
  assert.ok(k.items.length <= 12);
});

test('crewdeck jobs learn [--json]: what was learned, with counts and the caps', () => {
  const w = seeded();
  w.ctx.db.close();
  const r = jobs(w.home, ['learn', '--json']);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.caps.total, 15);
  assert.ok(j.rows.some((x: any) => x.kind === 'company' && x.label === 'Cobalt Sales' && x.counts.not_interested === 2 && x.delta === -6));
  const t = jobs(w.home, ['learn']);
  assert.match(t.out, /company Ranks Acme Analytics higher \(\+8\): applied 2/);
  assert.match(t.out, /at most 15 rank points; rules and eligibility never change/);
  // The form-learning use of `jobs learn <role>` is untouched: a role id still needs its label.
  assert.match(jobs(w.home, ['learn', 'abcdefabcdef']).err, /no role abcdefabcdef|--label-file/);
});

test('nothing learned yet: an empty list and a plain line', () => {
  const w = world('example');
  assert.deepEqual(refreshLearned(w.ctx).rows, []);
  w.ctx.db.close();
  assert.match(jobs(w.home, ['learn']).out, /Nothing learned yet/);
});
