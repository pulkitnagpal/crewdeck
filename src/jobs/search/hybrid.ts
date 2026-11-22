// Hybrid ranking: which of the rule-passing roles Claude should read first. Plain code, no Claude, no tokens.
// Signals (each a ranking of the same roles; one that is missing is skipped, never guessed):
//   title     the existing cheap score (rank.ts rankScore: title fit, seniority, skills in the text, freshness, source, pay)
//   bm25      FTS5/BM25 of the profile's terms (target titles, their synonyms, skills), or of the typed query `q`
//   embed     cosine of the stored role vector and the profile's (or the query's) vector, when the model is installed and
//             at least EMBED_COVERAGE of these roles have a vector (a half-embedded pool would favour the embedded half)
// Reciprocal Rank Fusion (k = 60, equal weights, ties share their average rank): fused = Σ 1/(60 + rank) over the
// signals a role has, scaled to 0..100 by the best possible sum. The learned adjustment (learn.ts, capped ±15) is added
// on top. Rules and eligibility never change here; roles of another occupation stay last. Synchronous on purpose: it
// reads only what is already stored (vectors, FTS), so the model is never loaded to rank.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, notesOf } from '../ctx.ts';
import { type Learned, computeLearned, learnedDelta, personActions } from '../pipeline/learn.ts';
import { compileRules, titleFitOf } from '../rules.ts';
import { OTHER_OCCUPATION_FIT } from '../titles.ts';
import { priorityBonus, rankScore } from '../pipeline/rank.ts';
import { type JobNotes } from '../notes.ts';
import { bm25Scores, ftsQuery, ftsReady, profileTerms, textQuery } from './fts.ts';
import { cosine, getVector, loadVectors, profileKey, profileText, queryKey, vectorCounts } from './embed.ts';

export const RRF_K = 60;
/** The title signal (title fit, seniority, skills, freshness, source, pay: the person's own words) counts double: equal
 * weights let a keyword-rich "Senior Backend Developer" push the exact "Senior Backend Engineer" from 1st to ~25th. */
export const WEIGHTS: Record<string, number> = { title: 2, bm25: 1, embed: 1 };
/** An exact title match (fit 1: one of the person's own titles) stays near the top whatever the other signals say. */
export const EXACT_TITLE_BONUS = 12;
/** Embeddings count only when at least this share of the roles being ranked has a vector. */
export const EMBED_COVERAGE = 0.8;
/** What puts another occupation below every role of the person's own (the same order rank.ts keeps with its `other` sort). */
const OTHER_PENALTY = 1000;

export type SignalName = 'title' | 'bm25' | 'embed';
export type Fused = {
  /** 0..100 relevance plus the learned adjustment (less OTHER_PENALTY for another occupation, in scoreRoles only) */ score: number;
  fused: number; learned: number; fit: number;
  /** each signal's 1-based rank for this role (absent = the signal skipped it or the role has no hit) */ ranks: Partial<Record<SignalName, number>>;
  /** each signal's raw value */ raw: Partial<Record<SignalName, number>>;
};
export type FuseInfo = { signals: SignalName[]; bm25_terms: number; embed_model: string | null; embed_coverage: number; skipped: Partial<Record<SignalName, string>> };

/** Hybrid ranking is on unless CREWDECK_HYBRID_RANK=off, `crewdeck jobs search hybrid off`, or there is no FTS index. */
export function hybridEnabled(ctx: Pick<Ctx, 'db' | 'home'>): boolean {
  if (process.env.CREWDECK_HYBRID_RANK === 'off') return false;
  try { if (JSON.parse(readFileSync(join(ctx.home, 'state', 'search.json'), 'utf8')).hybrid === false) return false; } catch { /* default on */ }
  return ftsReady(ctx.db);
}

/** 1-based ranks, best first; roles with equal values share the average of the places they cover. */
export function ranksOf(values: Map<string, number>): Map<string, number> {
  const rows = [...values].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = new Map<string, number>();
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1][1] === rows[i][1]) j++;
    for (let k = i; k <= j; k++) out.set(rows[k][0], (i + j) / 2 + 1);
    i = j + 1;
  }
  return out;
}

export type RoleRow = { id: string; company_id: number | string; company: string; title: string; description?: string; language?: string | null; source?: string; source_key?: string | null; posted_at?: string | null; first_seen?: string; pay_status?: string | null; location?: string };

/** The profile's BM25 query, or the typed one. */
export const queryFor = (notes: Pick<JobNotes, 'search' | 'career'>, q?: string) => (q && q.trim() ? textQuery(q.trim()) : ftsQuery(profileTerms(notes)));

/** The model whose vectors can serve this ranking: its role vectors, and the profile's (or the typed query's) own vector. */
function embedding(ctx: Pick<Ctx, 'db'>, ids: string[], notes: Pick<JobNotes, 'search' | 'career'>, q: string | undefined, qvec?: { model: string; vec: Float32Array }) {
  const text = profileText(notes);
  const models = vectorCounts(ctx.db).sort((a, b) => b.roles - a.roles);
  for (const m of models) {
    const vec = qvec && qvec.model === m.model ? qvec.vec : (q && q.trim() && getVector(ctx.db, queryKey(q, m.model), m.model)) || (text ? getVector(ctx.db, profileKey(text, m.model), m.model) : null);
    if (!vec) continue;
    const vecs = loadVectors(ctx.db, m.model, ids);
    return { model: m.model, vec, vecs, coverage: ids.length ? vecs.size / ids.length : 0 };
  }
  return null;
}

/**
 * Fuse the signals for these roles. `title` (id → the existing cheap score) is passed in by rank.ts, which has computed it
 * already; scoreRoles computes it. `learned` is the person's capped adjustment table.
 */
export function fuse(ctx: Pick<Ctx, 'db'>, rows: RoleRow[], o: { notes: Pick<JobNotes, 'search' | 'career'>; title: Map<string, number>; fit: Map<string, number>; learned?: Learned; q?: string; qvec?: { model: string; vec: Float32Array } }): { by: Map<string, Fused>; info: FuseInfo } {
  const ids = rows.map((r) => r.id);
  const info: FuseInfo = { signals: ['title'], bm25_terms: 0, embed_model: null, embed_coverage: 0, skipped: {} };
  const ranks: Partial<Record<SignalName, Map<string, number>>> = { title: ranksOf(o.title) };
  const raw: Partial<Record<SignalName, Map<string, number>>> = { title: o.title };

  const query = queryFor(o.notes, o.q);
  info.bm25_terms = query ? query.split(' OR ').length : 0;
  if (!ftsReady(ctx.db)) info.skipped.bm25 = 'no full-text index (this SQLite has no FTS5, or run: crewdeck jobs search reindex)';
  else if (!query) info.skipped.bm25 = 'no profile terms (add target titles or skills) and no query';
  else {
    const b = bm25Scores(ctx, query, ids);
    if (b.size) { raw.bm25 = b; ranks.bm25 = ranksOf(b); info.signals.push('bm25'); } else info.skipped.bm25 = 'no role matches the terms';
  }

  const e = ids.length ? embedding(ctx, ids, o.notes, o.q, o.qvec) : null;
  if (!e) info.skipped.embed = 'no embeddings (model not installed, or the profile vector is not made yet: crewdeck jobs search reindex)';
  else if (e.coverage < EMBED_COVERAGE) { info.embed_model = e.model; info.embed_coverage = e.coverage; info.skipped.embed = `only ${Math.round(e.coverage * 100)}% of these roles have a vector (need ${EMBED_COVERAGE * 100}%): crewdeck jobs search reindex`; }
  else {
    const sims = new Map([...e.vecs].map(([id, v]) => [id, cosine(e.vec, v)] as [string, number]));
    raw.embed = sims; ranks.embed = ranksOf(sims); info.signals.push('embed'); info.embed_model = e.model; info.embed_coverage = e.coverage;
  }

  const best = info.signals.reduce((a, sg) => a + (WEIGHTS[sg] ?? 1), 0) / (RRF_K + 1);
  const learned = o.learned ?? { companies: new Map(), words: new Map(), sources: new Map(), rows: [] };
  const by = new Map<string, Fused>();
  for (const r of rows) {
    const rk: Fused['ranks'] = {}, rw: Fused['raw'] = {};
    let sum = 0;
    for (const s of info.signals) {
      const rank = ranks[s]!.get(r.id);
      if (rank === undefined) continue;
      rk[s] = rank; rw[s] = raw[s]!.get(r.id);
      sum += (WEIGHTS[s] ?? 1) / (RRF_K + rank);
    }
    const exact = (o.fit.get(r.id) ?? 0) >= 1 ? EXACT_TITLE_BONUS : 0;
    const fused = (100 * sum) / best + exact, d = learnedDelta(r, learned);
    by.set(r.id, { score: fused + d, fused, learned: d, fit: o.fit.get(r.id) ?? 1, ranks: rk, raw: rw });
  }
  return { by, info };
}

/** Roles by id with the columns the cheap score needs. */
export function loadRows(ctx: Pick<Ctx, 'db'>, ids: string[]): any[] {
  return ctx.db.prepare(`select r.id, r.company_id, c.name company, r.title, r.url, r.location, coalesce(r.pay_text, r.pay_status, '') pay, r.pay_status,
      r.source, r.source_key, r.language, r.description, r.posted_at, r.first_seen from roles r join companies c on c.id=r.company_id
      where r.id in (select value from json_each(?))`).all(JSON.stringify(ids)) as any[];
}

/** The full explanation for these roles (the CLI's `search`), and the same scores scoreRoles returns. */
export function explainRoles(ctx: Ctx, ids: string[], o: { q?: string; qvec?: { model: string; vec: Float32Array } } = {}): { by: Map<string, Fused>; info: FuseInfo; rows: any[] } {
  const notes = notesOf(ctx), compiled = compileRules(notes), at = ctx.clock(), priority = priorityBonus(notes);
  const rows = loadRows(ctx, ids);
  const title = new Map(rows.map((r) => [r.id, rankScore(r, notes, at, priority, compiled)] as [string, number]));
  const fit = new Map(rows.map((r) => [r.id, titleFitOf(compiled, r).fit] as [string, number]));
  const out = fuse(ctx, rows, { notes, title, fit, learned: computeLearned(personActions(ctx)), q: o.q, qvec: o.qvec });
  return { ...out, rows };
}

/**
 * A relevance score per role (higher = better) for these ids: the hybrid ordering. Missing vectors skip that signal;
 * another occupation's role scores below every role of the person's own. Never changes rules or eligibility.
 */
export function scoreRoles(ctx: Ctx, ids: string[], o: { q?: string } = {}): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const { by } = explainRoles(ctx, ids, { q: o.q });
  for (const [id, f] of by) out.set(id, f.score - (f.fit < OTHER_OCCUPATION_FIT ? OTHER_PENALTY : 0));
  return out;
}
