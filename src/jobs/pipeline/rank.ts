// Rank (design §2.4 step 2): a cheap score from the notes decides what Claude reads first, so Find spends tokens only on
// what can still pass. No Claude here: title match, seniority, skills overlap with career.md, freshness, source quality
// (pasted links first, then the user's sources by their position in jobs/sources.md), pay. Companies with a remembered company-wide rule are dropped
// before ranking. The best roles that arrived without a description get their posting page read (netguard) by the
// scheduled run, and a Find works the ranked pool in batches within a budget, stopping once the day's picks are covered.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome } from '../../config.ts';
import { type Ctx, notesOf, nowIso } from '../ctx.ts';
import { addEvent, setStatus, tx } from '../db.ts';
import type { JobNotes } from '../notes.ts';
import { type Compiled, compileRules, prefilter, titleMatchOf } from '../rules.ts';
import { fold } from '../places.ts';
import { clip, plainText } from '../text.ts';
import { hostOf, isLinkedinHost, isXHost } from '../fields.ts';
import type { NetOptions } from '../net/netguard.ts';
import { type Funnel, findFunnel } from '../funnel.ts';
import { trackerCheck, trackerRules } from './tracker.ts';

export type Ranked = { id: string; company: string; company_id: number; title: string; url: string; location: string; pay: string; source: string; rank: number; description: string; posted_at: string | null; first_seen: string };
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

/** A cheap score from the notes (no Claude). */
export function rankScore(row: { title: string; description?: string; source?: string; source_key?: string | null; posted_at?: string | null; first_seen?: string; pay_status?: string | null; language?: string | null }, notes: Pick<JobNotes, 'search' | 'career'> & Partial<Pick<JobNotes, 'sources'>>, at: Date, priority: Map<string, number> = notes.sources ? priorityBonus(notes as Pick<JobNotes, 'sources'>) : new Map(), compiled: Pick<Compiled, 'titles'> = compileRules({ search: notes.search, memory: { data: { items: [] } } as any })): number {
  const s = notes.search.data, title = fold(row.title ?? ''), desc = plainText(row.description ?? ''), body = `${title}\n${fold(desc)}`;
  let score = 0;
  // Which target title matched and how (D26): the old phrase in order first, any order a little less, broad least.
  const m = titleMatchOf(compiled as Compiled, row);
  if (m) score += m.how === 'broad' ? 8 : Math.max(10, 30 - m.variant * 3) - (m.how === 'words' ? 4 : 0);
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

/** Unjudged roles that passed the prefilter, best first. Roles of a company with a company rule are dropped here. */
export function rankRoles(ctx: Ctx): Ranked[] {
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
  return keep.map((r) => ({ ...r, rank: rankScore(r, notes, at, priority, compiled) }))
    .sort((a, b) => b.rank - a.rank || String(b.posted_at ?? b.first_seen).localeCompare(String(a.posted_at ?? a.first_seen)) || a.id.localeCompare(b.id));
}

export const toCandidate = (r: Ranked): Candidate => ({ id: r.id, company: r.company, title: r.title, url: r.url, location: r.location, pay: r.pay, source: r.source, rank: r.rank, description: clip(plainText(r.description ?? '')) });

// ---- descriptions for the best roles (the scheduled run; netguard, no Claude) ----

/** Read the posting page of the top-ranked roles that came without a description (each role is tried once). */
export async function fetchDescriptions(ctx: Ctx, o: { top?: number; net?: NetOptions; concurrency?: number } = {}): Promise<{ tried: number; found: number; closed: number; errors: number }> {
  const top = o.top ?? 50;
  const out = { tried: 0, found: 0, closed: 0, errors: 0 };
  if (top <= 0) return out;
  const tried = ctx.db.prepare(`select 1 from events where role_id=? and kind='details'`);
  const todo = rankRoles(ctx).slice(0, top).filter((r) => {
    if (plainText(r.description ?? '').length >= 40) return false;
    const h = hostOf(r.url);
    return h && !isLinkedinHost(h) && !isXHost(h) && !tried.get(r.id);
  });
  if (!todo.length) return out;
  const { guardedFetch } = await import('../net/netguard.ts');
  const { readPostingPage } = await import('../link.ts');
  let next = 0;
  const one = async () => {
    while (next < todo.length) {
      const r = todo[next++];
      out.tried++;
      const at = nowIso(ctx);
      try {
        const page = await guardedFetch(r.url, { ...o.net, timeoutMs: 15_000 });
        if (page.status === 404 || page.status === 410) {
          setStatus(ctx.db, r.id, 'expired', `the posting page answered HTTP ${page.status}`, at); out.closed++; continue;
        }
        if (page.status < 200 || page.status > 299) { addEvent(ctx.db, r.id, 'details', `HTTP ${page.status}`, at); out.errors++; continue; }
        const p = readPostingPage(page.body, ctx.clock());
        if (p.closed) { setStatus(ctx.db, r.id, 'expired', `the posting is closed: ${p.closed_reason}`, at); out.closed++; continue; }
        const d = (p.description ?? '').slice(0, 200_000);
        if (plainText(d).length >= 40) {
          ctx.db.prepare(`update roles set description=?, pay_text=coalesce(pay_text, ?), posted_at=coalesce(posted_at, ?), updated_at=? where id=?`).run(d, p.pay_text ?? null, p.posted_at ?? null, at, r.id);
          addEvent(ctx.db, r.id, 'details', 'description read from the posting page', at);
          out.found++;
        } else addEvent(ctx.db, r.id, 'details', 'no description on the posting page', at);
      } catch (e: any) {
        addEvent(ctx.db, r.id, 'details', `not read: ${String(e.message).slice(0, 200)}`, at);
        out.errors++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, 8)) }, one));
  return out;
}

// ---- Find within a budget ----

export type FindRun = { started: string; budget: number; judged: string[]; need?: number; funnel?: Funnel };
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
export function pickableCompanies(ctx: Ctx): number {
  const tracker = trackerCheck(ctx.db, trackerRules(notesOf(ctx).search.data), nowIso(ctx));
  const rows = ctx.db.prepare(`select r.id, r.company_id, r.title from roles r where r.eligibility='yes' and r.status in ('new','bench')`).all() as any[];
  return new Set(rows.filter((r) => !tracker.check(r)).map((r) => Number(r.company_id))).size;
}

export type Budgeted = {
  batch: Candidate[];
  run: { started: string; budget: number; judged: number; remaining: number; need: number; passed: number; done: boolean; why: 'enough' | 'budget' | 'pool' | null; funnel: Funnel };
  pool: { unjudged: number };
};

/**
 * The next batch for Claude to judge in this Find: rank order, never a role already judged, never past the budget, and
 * nothing once `need` companies have an eligible role. `start` begins a new Find (else one older than 6 h starts fresh).
 */
export function budgetedCandidates(ctx: Ctx, o: { budget: number; batch: number; need: number; start?: boolean }): Budgeted {
  if (!Number.isInteger(o.budget) || o.budget < 1 || o.budget > 40) throw new Error('--budget must be from 1 to 40 (at most 40 postings are judged per Find)');
  if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 20) throw new Error('--batch must be from 1 to 20');
  if (!Number.isInteger(o.need) || o.need < 1 || o.need > 50) throw new Error('--need must be from 1 to 50');
  const now = ctx.clock();
  let run = readFindRun(ctx.home);
  if (o.start || !run || now.getTime() - Date.parse(run.started) > RUN_TTL_MS || !existsSync(runFile(ctx.home))) run = { started: now.toISOString(), budget: o.budget, judged: [] };
  run.budget = o.budget;
  run.need = o.need;
  const ranked = rankRoles(ctx);
  // The funnel is stored with the run (design §24.7): the page's card and Claude's close line read the same numbers.
  run.funnel = findFunnel(ctx, o.need);
  writeFindRun(ctx.home, run);
  const passed = pickableCompanies(ctx);
  const remaining = Math.max(0, run.budget - run.judged.length);
  const why = passed >= o.need ? 'enough' : remaining === 0 ? 'budget' : ranked.length === 0 ? 'pool' : null;
  const batch = why ? [] : ranked.slice(0, Math.min(o.batch, remaining)).map(toCandidate);
  return {
    batch,
    run: { started: run.started, budget: run.budget, judged: run.judged.length, remaining, need: o.need, passed, done: !!why, why, funnel: run.funnel },
    pool: { unjudged: ranked.length },
  };
}
