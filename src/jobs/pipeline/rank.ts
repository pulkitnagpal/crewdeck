// Rank (design §2.4 step 2): a cheap score from the notes decides what Claude reads first, so Find spends tokens only on
// what can still pass. No Claude here: title match, seniority, skills overlap with career.md, freshness, source quality
// (pasted links first, then the user's sources by their position in jobs/sources.md), pay. Companies with a remembered company-wide rule are dropped
// before ranking. Every rule-passing role that arrived without a full description gets its posting read (netguard,
// details.ts) by the scheduled run, and a Find works the ranked pool in batches within a budget, stopping once the day's picks are covered.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome } from '../../config.ts';
import { type Ctx, notesOf, nowIso, todayOf } from '../ctx.ts';
import { setStatus, tx } from '../db.ts';
import type { JobNotes } from '../notes.ts';
import { type Compiled, compileRules, prefilter, titleFitOf } from '../rules.ts';
import { type FitHow, OTHER_OCCUPATION_FIT } from '../titles.ts';
import { fold } from '../places.ts';
import { clip, plainText } from '../text.ts';
import type { NetOptions } from '../net/netguard.ts';
import { type Funnel, findFunnel } from '../funnel.ts';
import { todayPickIds, trackerCheck, trackerRules } from './tracker.ts';
import { learnedDelta, refreshLearned } from './learn.ts';
import { fuse, hybridEnabled } from '../search/hybrid.ts';

export type Ranked = { id: string; company: string; company_id: number; title: string; url: string; location: string; pay: string; source: string; rank: number; description: string; posted_at: string | null; first_seen: string;
  /** Title/occupation fit 0..1; below OTHER_OCCUPATION_FIT another occupation (ranked last, never judged). */ fit: number;
  /** P5: the part of `rank` learned from the person's own actions (learn.ts; capped, never a rule). */ learned: number };
export type Candidate = { id: string; company: string; title: string; url: string; location: string; pay: string; source: string; rank: number; description: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(fold(word))}`, 'u').test(text);
/** Roles the user brought themselves keep a fixed bonus; everything fetched gets one by its source's position (D21). */
export const SOURCE_RANK: Record<string, number> = { pasted: 15, manual: 12, alert: 12 };
export const PRIORITY_TOP = 12, UNKNOWN_SOURCE = 3;

/**
 * The bonus each source key earns by its position in jobs/sources.md: the first +12, falling linearly to 0 at the last.
 * LinkedIn's roles carry the key `linkedin`; with no LinkedIn row it counts as last (it runs last then too).
 */
export function priorityBonus(notes: Pick<JobNotes, 'sources'>): Map<string, number> {
  const keys = notes.sources.data.items.map((it) => (it.linkedin ? 'linkedin' : it.key));
  if (!keys.includes('linkedin')) keys.push('linkedin');
  const n = keys.length;
  return new Map(keys.map((k, i) => [k, n <= 1 ? PRIORITY_TOP : Math.round((PRIORITY_TOP * (n - 1 - i)) / (n - 1))]));
}
const PAY_RANK: Record<string, number> = { ok: 8, unclear: 3, no_rate: 3, unlisted: 2, below_floor: 0 };
/** Rank points by how a title fits (the user's own titles: 10-30 by their position, added in rankScore). */
const TITLE_POINTS: Partial<Record<FitHow, number>> = { synonym: 20, family: 14, generic: 12, adjacent: 10, broad: 8, head: 3 };

/** A cheap score from the notes (no Claude). */
export function rankScore(row: { title: string; description?: string; source?: string; source_key?: string | null; posted_at?: string | null; first_seen?: string; pay_status?: string | null; language?: string | null }, notes: Pick<JobNotes, 'search' | 'career'> & Partial<Pick<JobNotes, 'sources'>>, at: Date, priority: Map<string, number> = notes.sources ? priorityBonus(notes as Pick<JobNotes, 'sources'>) : new Map(), compiled: Pick<Compiled, 'titles'> = compileRules({ search: notes.search, memory: { data: { items: [] } } as any })): number {
  const s = notes.search.data, title = fold(row.title ?? ''), desc = plainText(row.description ?? ''), body = `${title}\n${fold(desc)}`;
  let score = 0;
  // Title fit (D26, ADR-0003): the user's own title in order first (earlier titles more), any order a little less, then a
  // synonym, the same occupation family, a bare head word, an adjacent family. Other occupations get nothing.
  const m = titleFitOf(compiled as Compiled, row);
  score += TITLE_POINTS[m.how] ?? 0;
  if (m.how === 'exact' || m.how === 'words') score += Math.max(10, 30 - m.variant * 3) - (m.how === 'words' ? 4 : 0);
  const si = s.roles.seniority_prefer.findIndex((t) => has(title, t));
  if (si >= 0) score += Math.max(5, 15 - si * 3);
  // Skills: career.md's, plus the matched target's own (a switcher's new field ranks by its skills).
  const skills = [...new Set([...notes.career.data.skills, ...(m?.skills ?? [])])];
  score += Math.min(25, 5 * skills.filter((k) => has(body, k)).length);
  const seen = Date.parse(row.posted_at ?? row.first_seen ?? '') || at.getTime();
  const days = (at.getTime() - seen) / 86_400_000;
  score += days <= 3 ? 15 : days <= 7 ? 10 : days <= 14 ? 6 : days <= 30 ? 3 : 0;
  // Never a filter: priority only orders what the rules already let through (D21).
  score += SOURCE_RANK[row.source ?? ''] ?? (row.source_key ? priority.get(row.source_key) : undefined) ?? (row.source === 'linkedin' ? priority.get('linkedin') : undefined) ?? UNKNOWN_SOURCE;
  score += PAY_RANK[row.pay_status ?? ''] ?? 2;
  if (desc.length >= 200) score += 5; // a posting Claude can actually judge
  return score;
}

/**
 * "Pick from" (the Find sheet's `from`): a role's source_key matches a key when it is that key or sits under it
 * (`ats` takes `ats:greenhouse:atlan`; `portal:naukri` only Naukri's roles; `linkedin` LinkedIn's). No keys: every source.
 */
export const FROM_KEY = /^[a-z0-9][a-z0-9:_.-]{0,79}$/;
export const MAX_FROM = 30;
/** A `from` list (a comma-separated flag or the Find payload's array): lowercase keys, no duplicates, at most MAX_FROM. */
export function cleanFrom(v: unknown): string[] {
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!list || list.length > MAX_FROM) throw new Error(`from: give a list of at most ${MAX_FROM} source keys (linkedin, portal:naukri, api:himalayas, ats …)`);
  const keys = list.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  for (const k of keys) if (!FROM_KEY.test(k)) throw new Error(`"${k.slice(0, 40)}" is not a source key (linkedin, portal:naukri, api:himalayas, ats …)`);
  return [...new Set(keys)];
}
export function fromMatches(sourceKey: string | null | undefined, from?: string[] | null): boolean {
  if (!from?.length) return true;
  const k = String(sourceKey ?? '');
  return !!k && from.some((f) => k === f || k.startsWith(`${f}:`));
}

/** Unjudged roles that passed the prefilter, best first. Roles of a company with a company rule are dropped here. */
export function rankRoles(ctx: Ctx, o: { from?: string[] } = {}): Ranked[] {
  const notes = notesOf(ctx);
  const compiled = compileRules(notes);
  const at = ctx.clock(), now = nowIso(ctx);
  const rows = ctx.db.prepare(`select r.id, r.company_id, c.name company, r.title, r.url, r.location, coalesce(r.pay_text, r.pay_status, '') pay, r.pay_status,
      r.source, r.source_key, r.language, r.description, r.posted_at, r.first_seen from roles r join companies c on c.id=r.company_id
      where r.status='new' and r.eligibility is null`).all() as any[];
  const keep: any[] = [];
  const dropped: { id: string; reason: string }[] = [];
  for (const r of rows) {
    const v = compiled.companyRules.length ? prefilter({ title: r.title, company: r.company }, compiled) : { keep: true as const };
    if (!v.keep && v.rule === 'company_rule') dropped.push({ id: r.id, reason: `${v.rule}: ${v.reason}` });
    else keep.push(r);
  }
  if (dropped.length) tx(ctx.db, () => { for (const d of dropped) setStatus(ctx.db, d.id, 'prefiltered_out', d.reason, now); });
  const priority = priorityBonus(notes);
  const other = (r: { fit: number }) => (r.fit < OTHER_OCCUPATION_FIT ? 1 : 0);
  // P5: the person's own actions nudge the order (never the rules): applied, not interested, set aside, ignored picks.
  const learned = refreshLearned(ctx);
  const base = keep.map((r) => ({ r, score: rankScore(r, notes, at, priority, compiled), fit: titleFitOf(compiled, r).fit }));
  // Hybrid (src/jobs/search/hybrid.ts, local, no tokens): the cheap score above, BM25 over the profile's terms and, when the
  // model is installed, embedding similarity, fused by rank (RRF) with the learned nudge added. Off: the cheap score alone.
  const hybrid = base.length && hybridEnabled(ctx)
    ? fuse(ctx, keep, { notes, title: new Map(base.map((b) => [b.r.id, b.score])), fit: new Map(base.map((b) => [b.r.id, b.fit])), learned }).by : null;
  return base.map(({ r, score, fit }) => { const f = hybrid?.get(r.id); const d = f ? f.learned : learnedDelta(r, learned); return { ...r, rank: f ? f.score : score + d, learned: d, fit }; })
    .filter((r) => fromMatches(r.source_key, o.from))
    .sort((a, b) => other(a) - other(b) || b.rank - a.rank || String(b.posted_at ?? b.first_seen).localeCompare(String(a.posted_at ?? a.first_seen)) || a.id.localeCompare(b.id));
}

/**
 * The roles the person chose to judge (Explore's saved ones), as candidates in the order given: only roles Claude can still
 * judge (status new or on the bench), at most 80. The same shape as `candidates`, so the same judging steps apply.
 */
export function candidatesFor(ctx: Ctx, ids: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const id of [...new Set(ids)].slice(0, 80)) {
    const r = ctx.db.prepare(`select r.id, c.name company, r.title, r.url, r.location, coalesce(r.pay_text, r.pay_status, '') pay, r.source, r.description
        from roles r join companies c on c.id=r.company_id where r.id=? and r.status in ('new','bench')`).get(id) as any;
    if (r) out.push({ id: r.id, company: r.company, title: r.title, url: r.url, location: r.location, pay: r.pay, source: r.source, rank: 0, description: clip(plainText(r.description ?? '')) });
  }
  return out;
}

export const toCandidate = (r: Ranked): Candidate => ({ id: r.id, company: r.company, title: r.title, url: r.url, location: r.location, pay: r.pay, source: r.source, rank: r.rank, description: clip(plainText(r.description ?? '')) });

// ---- descriptions (the scheduled run; netguard, no Claude): every rule-passing role, see details.ts ----

/**
 * Read the posting of every rule-passing role whose description is missing or was cut (P1b: not only the top 50, board
 * APIs before pages, retries, once a day per role). `top` is the old name for `limit` (0 = skip).
 */
export async function fetchDescriptions(ctx: Ctx, o: { top?: number; net?: NetOptions; concurrency?: number } & import('./details.ts').DetailOptions = {}) {
  const { fetchDetails } = await import('./details.ts');
  return fetchDetails(ctx, { ...o, limit: o.limit ?? o.top });
}

// ---- Find within a budget ----

export type FindRun = { started: string; budget: number; judged: string[]; need?: number; funnel?: Funnel;
  /** How many picks the day had when this Find began (`pick --add` adds to that, so running it again never adds twice). */ base?: { day: string; picked: number } };
const RUN_TTL_MS = 6 * 3_600_000;
const runFile = (home: string) => join(home, 'state', 'find.json');

export function readFindRun(home: string): FindRun | null {
  try { const r = JSON.parse(readFileSync(runFile(home), 'utf8')); return r && Array.isArray(r.judged) ? r : null; } catch { return null; }
}
function writeFindRun(home: string, r: FindRun) {
  ensureHome(join(home, 'state'));
  const f = runFile(home), tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
  renameSync(tmp, f);
}

/** `judge` adds the roles it stored to the open Find run (so the budget counts what was really read). */
export function recordJudged(ctx: Ctx, ids: string[]) {
  const r = readFindRun(ctx.home);
  if (!r || ctx.clock().getTime() - Date.parse(r.started) > RUN_TTL_MS) return;
  const set = new Set(r.judged);
  for (const id of ids) set.add(id);
  writeFindRun(ctx.home, { ...r, judged: [...set] });
}

/** After `pick`: the open Find run's funnel again (picked changed). */
export function refreshFunnel(ctx: Ctx): Funnel | null {
  const r = readFindRun(ctx.home);
  if (!r || ctx.clock().getTime() - Date.parse(r.started) > RUN_TTL_MS) return null;
  const funnel = findFunnel(ctx, r.need ?? r.funnel?.need ?? 5);
  writeFindRun(ctx.home, { ...r, funnel });
  return funnel;
}

/** Companies with an eligible role `pick` could take now (the same filter as pick's pool). */
export function pickableCompanies(ctx: Ctx, from?: string[]): number {
  const tracker = trackerCheck(ctx.db, trackerRules(notesOf(ctx).search.data), nowIso(ctx));
  const rows = ctx.db.prepare(`select r.id, r.company_id, r.title, r.source_key from roles r where r.eligibility='yes' and r.status in ('new','bench')`).all() as any[];
  return new Set(rows.filter((r) => fromMatches(r.source_key, from) && !tracker.check(r)).map((r) => Number(r.company_id))).size;
}

export type Budgeted = {
  batch: Candidate[];
  run: { started: string; budget: number; judged: number; remaining: number; need: number; passed: number; done: boolean; why: 'enough' | 'budget' | 'pool' | null; funnel: Funnel };
  /** unjudged: roles in the person's occupations still to judge; other_occupations: set aside, never judged. */
  pool: { unjudged: number; other_occupations: number };
};

/**
 * The next batch for Claude to judge in this Find: rank order, never a role already judged, never past the budget, and
 * nothing once `need` companies have an eligible role. `start` begins a new Find (else one older than 6 h starts fresh).
 */
export function budgetedCandidates(ctx: Ctx, o: { budget: number; batch: number; need: number; start?: boolean; from?: string[] }): Budgeted {
  if (!Number.isInteger(o.budget) || o.budget < 1 || o.budget > 80) throw new Error('--budget must be from 1 to 80 (at most 80 postings are judged per Find)');
  if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 20) throw new Error('--batch must be from 1 to 20');
  if (!Number.isInteger(o.need) || o.need < 1 || o.need > 50) throw new Error('--need must be from 1 to 50');
  const now = ctx.clock();
  let run = readFindRun(ctx.home);
  if (o.start || !run || now.getTime() - Date.parse(run.started) > RUN_TTL_MS || !existsSync(runFile(ctx.home))) run = { started: now.toISOString(), budget: o.budget, judged: [], base: { day: todayOf(ctx), picked: todayPickIds(ctx.db, todayOf(ctx)).length } };
  run.budget = o.budget;
  run.need = o.need;
  // Other occupations (title fit below the floor) are ranked last and never spend the judge's budget (ADR-0003).
  const all = rankRoles(ctx, { from: o.from });
  const ranked = all.filter((r) => r.fit >= OTHER_OCCUPATION_FIT);
  // The funnel is stored with the run (design §24.7): the page's card and Claude's close line read the same numbers.
  run.funnel = findFunnel(ctx, o.need);
  writeFindRun(ctx.home, run);
  const passed = pickableCompanies(ctx, o.from);
  const remaining = Math.max(0, run.budget - run.judged.length);
  const why = passed >= o.need ? 'enough' : remaining === 0 ? 'budget' : ranked.length === 0 ? 'pool' : null;
  const batch = why ? [] : ranked.slice(0, Math.min(o.batch, remaining)).map(toCandidate);
  return {
    batch,
    run: { started: run.started, budget: run.budget, judged: run.judged.length, remaining, need: o.need, passed, done: !!why, why, funnel: run.funnel },
    pool: { unjudged: ranked.length, other_occupations: all.length - ranked.length },
  };
}
