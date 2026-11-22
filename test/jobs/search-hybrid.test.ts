import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notesOf } from '../../src/jobs/ctx.ts';
import { rankRoles } from '../../src/jobs/pipeline/rank.ts';
import { candidates } from '../../src/jobs/pipeline/pick.ts';
import { embedMissing, ensureProfileVector } from '../../src/jobs/search/embed.ts';
import { EMBED_COVERAGE, EXACT_TITLE_BONUS, RRF_K, WEIGHTS, explainRoles, fuse, hybridEnabled, ranksOf, scoreRoles } from '../../src/jobs/search/hybrid.ts';
import { jobs } from './helpers.ts';
import { engineerWorld, fakeEmbedder, role } from './search-helpers.ts';

const KUBE = 'We run Kubernetes clusters and distributed systems in Go; GPU inference serving for LLM models.';
const MOBILE = 'You will build our Android app in Kotlin with Jetpack Compose.';

test('ranksOf: best first, equal values share the average of the places they cover', () => {
  const r = ranksOf(new Map([['a', 5], ['b', 9], ['c', 5], ['d', 5], ['e', 1]]));
  assert.deepEqual([...r].sort(), [['a', 3], ['b', 1], ['c', 3], ['d', 3], ['e', 5]]);
});

test('scoreRoles(ctx, ids, { q? }) returns a Map of id → number for exactly the ids asked, synchronously', () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: KUBE });
  const b = role(w.ctx, { company: 'B Co', title: 'Android Engineer', description: MOBILE });
  role(w.ctx, { company: 'C Co', title: 'Platform Engineer', description: KUBE });
  const s = scoreRoles(w.ctx, [a, b]);
  assert.ok(s instanceof Map);
  assert.deepEqual([...s.keys()].sort(), [a, b].sort());
  assert.ok([...s.values()].every((x) => typeof x === 'number' && Number.isFinite(x)));
  assert.ok(s.get(a)! > s.get(b)!);
  assert.equal(scoreRoles(w.ctx, []).size, 0);
  assert.equal(scoreRoles(w.ctx, ['000000000000']).size, 0, 'an unknown id is not scored');
  // a typed query steers the keyword signal
  const mobile = scoreRoles(w.ctx, [a, b], { q: 'android kotlin' });
  assert.ok(mobile.get(b)! > mobile.get(a)!, 'the query matches the Android role');
  assert.equal(explainRoles(w.ctx, [a, b], { q: 'android kotlin' }).info.bm25_terms, 2);
});

test('rules and eligibility never change: scoring and ranking write no status, and another occupation stays last', () => {
  const w = engineerWorld();
  const good = role(w.ctx, { company: 'A Co', title: 'Senior Backend Engineer', description: 'Go' });
  const sales = role(w.ctx, { company: 'S Co', title: 'Account Executive', description: KUBE + ' Kubernetes Go Python distributed systems inference backend engineer platform engineer' });
  const before = w.ctx.db.prepare('select id, status, eligibility, evidence, score from roles order by id').all();
  const s = scoreRoles(w.ctx, [good, sales]);
  assert.ok(s.get(good)! > 0 && s.get(sales)! < 0, 'another occupation is below every role of the person\'s own');
  const ranked = rankRoles(w.ctx);
  assert.deepEqual(ranked.map((r) => r.id), [good, sales], 'rankRoles keeps its other-occupation sort');
  assert.ok(ranked[1].fit < 0.25);
  assert.deepEqual(w.ctx.db.prepare('select id, status, eligibility, evidence, score from roles order by id').all(), before);
});

test('fusion is weighted RRF (k=60; the title signal counts double) over the signals a role has, scaled to 0..100, an exact own title kept near the top, plus the learned nudge', () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: KUBE });
  const b = role(w.ctx, { company: 'B Co', title: 'Backend Engineer', description: 'Nothing relevant here at all.' });
  const { by, info } = explainRoles(w.ctx, [a, b]);
  assert.deepEqual(info.signals, ['title', 'bm25']);
  const fa = by.get(a)!, fb = by.get(b)!;
  const best = (WEIGHTS.title + WEIGHTS.bm25) / (RRF_K + 1);
  const bonus = fa.fit >= 1 ? EXACT_TITLE_BONUS : 0;
  assert.ok(Math.abs(fa.fused - ((100 * (WEIGHTS.title / (RRF_K + fa.ranks.title!) + WEIGHTS.bm25 / (RRF_K + fa.ranks.bm25!))) / best + bonus)) < 1e-9);
  assert.equal(WEIGHTS.title, 2);
  assert.equal(RRF_K, 60);
  assert.ok(fa.fused <= 100 + EXACT_TITLE_BONUS && fb.fused > 0 && fa.fused > fb.fused);
  assert.equal(fb.ranks.bm25 !== undefined, true, 'its title matches the profile terms');
  // the learned adjustment is added on top (capped by learn.ts: ±15 in all), not fused
  const rows = [{ id: a, company_id: 1, company: 'A Co', title: 'x' }, { id: b, company_id: 2, company: 'B Co', title: 'x' }] as any;
  const title = new Map([[a, 10], [b, 10]]), fit = new Map([[a, 1], [b, 1]]);
  const out = fuse(w.ctx, rows, { notes: notesOf(w.ctx), title, fit, learned: { companies: new Map([['2', 4]]), words: new Map(), sources: new Map(), rows: [] } }).by;
  assert.equal(out.get(b)!.learned, 4);
  assert.ok(Math.abs(out.get(b)!.score - out.get(b)!.fused - 4) < 1e-9);
});

test('embeddings join only when the model made vectors: missing vectors, a half-embedded pool, or no profile vector skip the signal', async () => {
  const w = engineerWorld();
  const ids = [
    role(w.ctx, { company: 'A Co', title: 'Member of Technical Staff, Infra', description: KUBE }),
    role(w.ctx, { company: 'B Co', title: 'Senior Software Engineer (Android)', description: MOBILE }),
    role(w.ctx, { company: 'C Co', title: 'Platform Engineer', description: KUBE }),
    role(w.ctx, { company: 'D Co', title: 'Backend Engineer', description: 'Go services and APIs' }),
    role(w.ctx, { company: 'E Co', title: 'Frontend Engineer', description: 'React and CSS' }),
  ];
  const e = fakeEmbedder();
  assert.match(explainRoles(w.ctx, ids).info.skipped.embed!, /no embeddings/);
  await embedMissing(w.ctx, e, { ids: ids.slice(0, 3) }); // 3 of 5 = 60% < 80%
  await ensureProfileVector(w.ctx, e, notesOf(w.ctx));
  const half = explainRoles(w.ctx, ids).info;
  assert.ok(!half.signals.includes('embed'));
  assert.match(half.skipped.embed!, /only 60% of these roles have a vector/);
  assert.equal(EMBED_COVERAGE, 0.8);
  await embedMissing(w.ctx, e, { ids });
  const full = explainRoles(w.ctx, ids);
  assert.deepEqual(full.info.signals, ['title', 'bm25', 'embed']);
  assert.equal(full.info.embed_model, e.id);
  assert.ok(Object.values(full.by.get(ids[0])!.ranks).length === 3);
  // a different profile text means a different (missing) profile vector: skipped, never a stale one
  writeFileSync(join(w.vault, 'me', 'career.md'), readFileSync(join(w.vault, 'me', 'career.md'), 'utf8').replace('skills: [Go,', 'skills: [Rust, Go,'));
  assert.match(explainRoles(w.ctx, ids).info.skipped.embed!, /profile vector is not made yet/);
});

test('rankRoles / candidates use the hybrid order by default and fall back to the cheap score without FTS, with the switch off, or with CREWDECK_HYBRID_RANK=off', () => {
  const w = engineerWorld();
  // identical titles: the cheap score ties them, the keywords decide
  const weak = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: 'We make things.' });
  const strong = role(w.ctx, { company: 'B Co', title: 'Backend Engineer', description: KUBE });
  assert.equal(hybridEnabled(w.ctx), true);
  assert.deepEqual(candidates(w.ctx, 40).map((c) => c.id), [strong, weak]);
  assert.ok(candidates(w.ctx, 40)[0].rank > 0 && candidates(w.ctx, 40)[0].rank <= 100 + 15);
  // off, three ways: the cheap score alone (a tie, broken by the existing order: newest, then id)
  const cheap = (x: string[]) => assert.deepEqual(x, rankRoles(w.ctx).map((r) => r.id));
  process.env.CREWDECK_HYBRID_RANK = 'off';
  try { assert.equal(hybridEnabled(w.ctx), false); assert.ok(rankRoles(w.ctx)[0].rank > 20, 'old scale (points), not 0..100 fused'); cheap(rankRoles(w.ctx).map((r) => r.id)); } finally { process.env.CREWDECK_HYBRID_RANK = 'on'; }
  assert.equal(jobs(w.home, ['search', 'hybrid', 'off']).code, 0);
  assert.equal(hybridEnabled(w.ctx), false);
  writeFileSync(join(w.jobsHome, 'state', 'search.json'), '{"hybrid":true}');
  assert.equal(hybridEnabled(w.ctx), true);
  // no FTS5 index (a SQLite without it): no throw, the title signal alone
  for (const t of ['roles_fts_ai', 'roles_fts_ad', 'roles_fts_au', 'roles_fts_cu']) w.ctx.db.exec(`drop trigger ${t}`);
  w.ctx.db.exec('drop table roles_fts');
  assert.equal(hybridEnabled(w.ctx), false);
  assert.equal(rankRoles(w.ctx).length, 2);
  const s = explainRoles(w.ctx, [weak, strong]);
  assert.deepEqual(s.info.signals, ['title']);
  assert.match(s.info.skipped.bm25!, /no full-text index/);
  assert.equal(scoreRoles(w.ctx, [weak, strong]).size, 2, 'scoreRoles still works on the title signal');
});

test('CLI: search "<query>" ranks with each signal\'s rank (text and --json); reindex builds the index; nothing is spent or sent', () => {
  const w = engineerWorld();
  role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: KUBE });
  role(w.ctx, { company: 'B Co', title: 'Android Engineer', description: MOBILE });
  const j = jobs(w.home, ['search', 'android kotlin', '--json', '--limit', '5']);
  assert.equal(j.code, 0, j.err);
  const r = JSON.parse(j.out);
  assert.equal(r.query, 'android kotlin');
  assert.equal(r.pool, 2);
  assert.deepEqual(r.signals, ['title', 'bm25']);
  assert.equal(r.roles[0].title, 'Android Engineer');
  assert.ok(r.roles[0].ranks.title >= 1 && r.roles[0].ranks.bm25 === 1);
  assert.match(r.skipped.embed, /no embeddings/);
  const t = jobs(w.home, ['search', 'kubernetes']);
  assert.match(t.out, /signals: title \+ bm25/);
  assert.match(t.out, /Backend Engineer · A Co\n\s+title #\d+  keywords #\d+/);
  const noq = jobs(w.home, ['search', '--json']);
  assert.equal(JSON.parse(noq.out).query, null, 'no query ranks for the profile');
  const re = jobs(w.home, ['search', 'reindex']);
  assert.match(re.out, /keyword index: 2 roles/);
  assert.match(re.out, /embeddings: not installed/);
  assert.notEqual(jobs(w.home, ['search', '--limit', '0', 'x']).code, 0);
  assert.match(jobs(w.home, ['search', '--help']).out, /usage: crewdeck jobs search/);
});

test('a sources run embeds the roles that passed the rules (plain code after the prefilter), capped; without the model it only says why not', async () => {
  const { runSources } = await import('../../src/jobs/sources.ts');
  const { loadVectors } = await import('../../src/jobs/search/embed.ts');
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: KUBE });
  const b = role(w.ctx, { company: 'B Co', title: 'Platform Engineer', description: KUBE });
  const plan = { entries: [], ids: [], skipped: [] };
  const none = await runSources(w.ctx, { details: 0, plan });
  assert.equal(none.embeddings?.ran, false);
  assert.match(none.embeddings!.why!, /not installed/);
  const e = fakeEmbedder();
  const r = await runSources(w.ctx, { details: 0, plan, embedder: e, embedCap: 1 });
  assert.deepEqual([r.embeddings?.ran, r.embeddings?.embedded, r.embeddings?.remaining], [true, 1, 1]);
  await runSources(w.ctx, { details: 0, plan, embedder: e });
  assert.deepEqual([...loadVectors(w.ctx.db, e.id).keys()].sort(), [a, b].sort());
});
