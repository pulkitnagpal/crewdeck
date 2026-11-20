// The owner's acceptance re-run (design §24.12, §22 P9i) as the engineer from the audit, from zero: a senior backend/AI
// engineer in India who wants remote work. Setup through the commands the jobs-setup skill runs (v0.4 notes: a kind of
// job with its titles, remote from India), sources from the catalog with LinkedIn placed first (never switched on), his
// first real run's pool as nine sources stored it (1,480 postings, owner-fixture.ts), the preview's variants accepted
// with his yes, and Find within a budget. It must end with ≥ 100 passing, every posting limited to another country still
// dropped for its place, LinkedIn's position changing the order and never the drops, and Find returning its picks with
// the funnel. Every person and company is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openJobsDb } from '../../src/jobs/db.ts';
import { makeCtx } from '../../src/jobs/ctx.ts';
import { SOURCES, seedOwnerPool } from './owner-fixture.ts';
import { file, finish, me, ok, pref, preview, search, sources, start } from './setup-helpers.ts';

const json = (p: ReturnType<typeof start>, args: string[]) => JSON.parse(ok(p, args));

test('owner acceptance: from zero to ≥ 100 passing with the right place drops, LinkedIn first changes order not drops, Find picks 5', () => {
  const p = start();
  const out: string[] = [];
  // Setup: who he is, then the search as v0.4 notes (one kind of job; the matcher reads word order and forms).
  me(p, 'identity', '{ first_name: Arjun, last_name: Example, email: arjun@example.com, city: Bengaluru, country: India }');
  me(p, 'sections', '[{ id: summary, kind: summary }]');
  me(p, 'facts', '[{ id: summary.backend, text: "Backend and AI engineer, eight years, Go and Python" }]');
  pref(p, 'roles.targets', '[{ name: Backend and AI engineering, titles: [backend engineer, ai engineer], families: [engineering-it, data] }]', 'backend or AI engineering');
  pref(p, 'roles.seniority_prefer', '[senior, staff, lead]', 'senior roles first');
  pref(p, 'roles.exclude_title_words', '[intern]', 'no internships');
  pref(p, 'workplace', '[remote]', 'remote only');
  pref(p, 'places.remote_from', '[India]', 'I live in India');
  pref(p, 'employment_types', '[full-time, contract]', 'full-time or contract');
  pref(p, 'languages', '[{ name: English, level: fluent }, { name: Hindi, level: native }]', 'English and Hindi');
  pref(p, 'schedule', '{ timezone: Asia/Kolkata, daily_picks: 5, cooldown_days: 60 }', 'five a day');
  // Where to look: the catalog proposes the remote boards he used; LinkedIn placed first, its switch stays off.
  const sg = json(p, ['sources', 'suggest', '--json']);
  assert.match(sg.coverage.line, /job boards fit remote work from India for software and IT or data and analytics \(most of their remote jobs are limited to the US or Europe\)/);
  for (const [key] of SOURCES.slice(1)) {
    assert.ok(sg.sources.some((s: any) => s.id === key), `${key} is proposed`);
    ok(p, ['sources', 'add', '--provider', key]);
  }
  ok(p, ['sources', 'add', '--linkedin', '--at', '1']);
  assert.match(sources(p), /sources:\n {2}- \{ key: linkedin, name: LinkedIn, linkedin: search/);
  assert.doesNotMatch(ok(p, ['features']), /linkedin_search +on/);
  // His first run's pool, as nine sources stored it.
  const db = openJobsDb(p.jobsHome);
  const { ids, roles } = seedOwnerPool(makeCtx({ db, vault: p.vault, home: p.jobsHome }), new Date());
  db.close();
  const fixture = new Map(ids.map((id, i) => [id, roles[i]]));

  // The preview on the notes as setup wrote them: word matching already passes more than the old phrase gate's 1.
  const saved = preview(p);
  assert.equal(saved.pool, 1480);
  assert.ok(saved.pass > 1, `the saved notes: ${saved.pass}`);
  out.push(`preview, as set up: ${saved.pass} of ${saved.pool} pass; near misses: ${saved.near.map((n: any) => `${n.head} → ${n.items.slice(0, 3).map((x: any) => x.label).join(', ')}`).join('; ')}`);
  const fix = saved.suggestions.find((s: any) => s.kind === 'variants');
  assert.ok(fix, 'a variants fix is offered');
  assert.deepEqual(fix.pref.map((x: any) => x.path), ['roles.targets[0].titles']);
  // Shown before it is saved (--search-file), then written with his yes.
  const tried = preview(p, `roles: { targets: ${JSON.stringify(fix.change['roles.targets'])} }`);
  assert.ok(tried.pass >= 100, `with the variants: ${tried.pass}`);
  assert.equal(tried.was, saved.pass);
  for (const x of fix.pref) pref(p, x.path, JSON.stringify(x.value), 'yes, add those titles');
  assert.equal(search(p).roles.targets[0].name, 'Backend and AI engineering');
  const pv = finish(p, ['Backend and AI engineering']);
  assert.equal(pv.pass, tried.pass, 'the saved change passes what the preview said');
  out.push(`${fix.label}; after his yes: ${pv.pass} of ${pv.pool} pass (was ${saved.pass}); first reasons: ${pv.drops.map((d: any) => `${d.label} ${d.n}`).join(', ')}`);

  // The rules, role by role: ≥ 100 kept; every posting limited to another country dropped, the 92 with his titles on place.
  const pf = json(p, ['prefilter']);
  assert.ok(pf.kept >= 100, `kept ${pf.kept}`);
  const dropped = new Map<string, any>(pf.drops.map((d: any) => [d.id, d]));
  for (const [id, r] of fixture) {
    if (r.limited) assert.ok(dropped.has(id), `${r.title} (${r.description}) is dropped`);
    if (r.kind === 'place') assert.equal(dropped.get(id)?.rule, 'other_only', `${r.title}: ${dropped.get(id)?.reason}`);
    if (r.kind === 'pass') assert.ok(!dropped.has(id));
  }
  out.push(`prefilter: ${pf.kept} kept, ${pf.dropped} dropped; all ${[...fixture.values()].filter((r) => r.limited).length} limited to other countries dropped (the 92 with his titles on place)`);

  // LinkedIn first changes the order, never the drops.
  const linkedinIn = (c: any[]) => c.filter((x) => fixture.get(x.id) && ids.indexOf(x.id) % SOURCES.length === 0).length;
  const first = json(p, ['candidates', '--limit', '40']);
  ok(p, ['sources', 'move', 'linkedin', 'last']);
  const last = json(p, ['candidates', '--limit', '40']);
  assert.ok(linkedinIn(first) > linkedinIn(last), `LinkedIn roles in the top 40: first ${linkedinIn(first)}, last ${linkedinIn(last)}`);
  assert.equal(preview(p).pass, pv.pass, 'the position never changes what passes');
  ok(p, ['sources', 'move', 'linkedin', 'first']);
  out.push(`LinkedIn's roles in the first 40 candidates: ${linkedinIn(first)} placed first, ${linkedinIn(last)} placed last; passes unchanged`);

  // Find 5 within a budget: batches of 10 best first, a scripted judge (engineering roles fit), stop once 5 pass.
  let run = json(p, ['candidates', '--budget', '40', '--need', '5', '--start']);
  assert.equal(run.run.funnel.passed_rules, pf.kept);
  let batches = 0;
  while (run.batch.length) {
    batches++;
    const verdicts = run.batch.map((c: any) => {
      const r = fixture.get(c.id)!;
      const fits = r.kind === 'pass' || r.kind === 'engineering' || /backend|ai engineer/i.test(r.title);
      // His own titles score highest, as a judge reading his notes would.
      return { role: c.id, eligible: fits ? 'yes' : 'no', score: !fits ? 15 : /backend|ai engineer/i.test(r.title) ? 92 : 80, evidence: `scripted: ${r.title}, ${r.location}` };
    });
    ok(p, ['judge', '--results-file', file(p, JSON.stringify(verdicts))]);
    run = json(p, ['candidates', '--budget', '40', '--need', '5']);
  }
  assert.equal(run.run.why, 'enough', JSON.stringify(run.run));
  assert.ok(run.run.judged <= 40);
  const picked = ok(p, ['pick', '--n', '5']).trim().split('\n');
  assert.equal(picked.length, 5, picked.join('\n'));
  assert.equal(new Set(picked.map((l) => l.split('  ')[1].split(' — ')[0])).size, 5, 'one per company');
  assert.match(picked[0], /Senior Backend Engineer/, 'the one role the old gate passed is still the first pick');
  const funnel = json(p, ['candidates', '--budget', '40', '--need', '5']).run.funnel;
  assert.match(funnel.line, /^1,480 fetched → \d+ passed your rules → \d+ judged → \d+ fits?$/);
  out.push(`find: ${batches} batch(es), ${run.run.judged} judged, picked ${picked.length}: ${funnel.line}`, ...picked.map((l) => `  ${l}`));
  writeFileSync(join(p.root, 'acceptance.txt'), `${out.join('\n')}\n`);
  if (process.env.CREWDECK_JOURNEYS) writeFileSync(join(process.env.CREWDECK_JOURNEYS, 'owner-acceptance.txt'), `${out.join('\n')}\n`);
});
