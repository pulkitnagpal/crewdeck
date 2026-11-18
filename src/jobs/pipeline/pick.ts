// From prefiltered roles to today's picks (design §2.4): a cheap rank from the notes decides what Claude judges first;
// Claude's verdicts are stored; `pick` takes the best eligible roles, one per company, respecting cooldowns and the
// daily count, idempotent per day in the user's time zone. A role the user chose (pasted) skips judging but not the
// safety gates: those come back as warnings unless the user overrides them.
import { type Ctx, notesOf, nowIso, todayOf } from '../ctx.ts';
import { addEvent, getRole, setStatus, tx } from '../db.ts';
import type { JobNotes } from '../notes.ts';
import { compileRules, prefilter } from '../rules.ts';
import { fold } from '../places.ts';
import { clip, plainText } from '../text.ts';

export type Candidate = { id: string; company: string; title: string; url: string; location: string; pay: string; source: string; rank: number; description: string };
export type Verdict = { role: string; eligible: 'yes' | 'no' | 'unclear'; score: number; evidence: string; reason?: string };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (text: string, word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(fold(word))}`, 'u').test(text);
const SOURCE_RANK: Record<string, number> = { pasted: 15, manual: 12, alert: 12, linkedin: 10, board: 6 };

/** A cheap score from the notes (no Claude): title, seniority, skills overlap, freshness and source quality. */
export function rankScore(row: { title: string; description?: string; source?: string; posted_at?: string | null; first_seen?: string }, notes: Pick<JobNotes, 'search' | 'career'>, at: Date): number {
  const s = notes.search.data, title = fold(row.title ?? ''), body = `${title}\n${fold(plainText(row.description ?? ''))}`;
  let score = 0;
  const ti = s.roles.titles.findIndex((t) => has(title, t));
  if (ti >= 0) score += Math.max(10, 30 - ti * 3);
  const si = s.roles.seniority_prefer.findIndex((t) => has(title, t));
  if (si >= 0) score += Math.max(5, 15 - si * 3);
  score += Math.min(25, 5 * notes.career.data.skills.filter((k) => has(body, k)).length);
  const seen = Date.parse(row.posted_at ?? row.first_seen ?? '') || at.getTime();
  const days = (at.getTime() - seen) / 86_400_000;
  score += days <= 3 ? 15 : days <= 7 ? 10 : days <= 14 ? 6 : days <= 30 ? 3 : 0;
  score += SOURCE_RANK[row.source ?? ''] ?? 3;
  return score;
}

/** Unjudged roles that passed the prefilter, best first, with plain clipped descriptions. */
export function candidates(ctx: Ctx, limit = 40): Candidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('--limit must be from 1 to 40 (at most 40 postings are judged per run)');
  const notes = notesOf(ctx);
  const at = ctx.clock();
  const rows = ctx.db.prepare(`select r.id, c.name company, r.title, r.url, r.location, coalesce(r.pay_text, r.pay_status, '') pay, r.source,
      r.description, r.posted_at, r.first_seen from roles r join companies c on c.id=r.company_id
      where r.status='new' and r.eligibility is null`).all() as any[];
  return rows.map((r) => ({ ...r, rank: rankScore(r, notes, at) }))
    .sort((a, b) => b.rank - a.rank || String(b.posted_at ?? b.first_seen).localeCompare(String(a.posted_at ?? a.first_seen)) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((r) => ({ id: r.id, company: r.company, title: r.title, url: r.url, location: r.location, pay: r.pay, source: r.source, rank: r.rank, description: clip(plainText(r.description ?? '')) }));
}

/** Validate one verdict from Claude's results file. */
export function cleanVerdict(v: any): Verdict {
  if (!v || typeof v !== 'object') throw new Error('each result is { role, eligible, score, evidence, reason? }');
  if (typeof v.role !== 'string' || !/^[a-f0-9]{12}$/.test(v.role)) throw new Error(`"${String(v.role)}" is not a role id`);
  if (!['yes', 'no', 'unclear'].includes(v.eligible)) throw new Error(`${v.role}: eligible must be yes, no or unclear`);
  const score = Number(v.score ?? 0);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`${v.role}: score must be 0-100`);
  return { role: v.role, eligible: v.eligible, score: Math.round(score), evidence: String(v.evidence ?? '').slice(0, 1000), reason: v.reason ? String(v.reason).slice(0, 1000) : undefined };
}

/** Store Claude's verdicts: no → judged_out, unclear → bench, yes → eligible for picking. */
export function judge(ctx: Ctx, verdicts: Verdict[]) {
  const at = nowIso(ctx);
  return tx(ctx.db, () => verdicts.map((v) => {
    const r = getRole(ctx.db, v.role);
    if (!['new', 'bench'].includes(r.status)) return { role: v.role, stored: false, why: `status is ${r.status}` };
    ctx.db.prepare('update roles set eligibility=?, evidence=?, score=?, updated_at=? where id=?').run(v.eligible, v.evidence, v.score, at, v.role);
    if (v.reason) addEvent(ctx.db, v.role, 'judge', v.reason, at);
    if (v.eligible === 'no') setStatus(ctx.db, v.role, 'judged_out', v.reason ?? v.evidence, at);
    if (v.eligible === 'unclear') setStatus(ctx.db, v.role, 'bench', `unclear: ${v.evidence}`, at);
    return { role: v.role, stored: true };
  }));
}

/** Roles whose title or company the current notes now exclude (judged before the user said so). */
function nowExcluded(ctx: Ctx) {
  const compiled = compileRules(notesOf(ctx));
  return (r: { title: string; company: string }) => {
    const v = prefilter({ title: r.title, company: r.company }, compiled);
    return !v.keep && ['title_exclude', 'company_excluded', 'company_rule'].includes(v.rule) ? v.reason : null;
  };
}

/** Pick up to n roles for `day` (YYYY-MM-DD, the user's day): best score first, one per company. Idempotent per day. */
export function pick(ctx: Ctx, n: number, day = todayOf(ctx)): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error('--n must be from 0 to 50');
  const at = nowIso(ctx);
  return tx(ctx.db, () => {
    const already = (ctx.db.prepare(`select id from roles where picked_on=? and source<>'pasted' and status in ('picked','prepared','applied') order by score desc, id`).all(day) as any[]).map((r) => r.id as string);
    if (already.length >= n) return already.slice(0, n);
    const excluded = nowExcluded(ctx);
    const pool = (ctx.db.prepare(`select r.id, r.company_id, r.title, c.name company from roles r join companies c on c.id=r.company_id
        where r.eligibility='yes' and r.status in ('new','bench')
          and (c.cooldown_until is null or c.cooldown_until <= ?)
          and not exists (select 1 from roles o where o.company_id=r.company_id and o.status in ('picked','prepared'))
        order by r.score desc, r.first_seen, r.id`).all(at) as any[])
      .filter((r) => { const why = excluded(r); if (why) setStatus(ctx.db, r.id, 'skipped', why, at); return !why; });
    const chosen = [...already];
    const used = new Set<number>();
    for (const r of pool) {
      if (chosen.length >= n) break;
      if (used.has(r.company_id)) continue;
      used.add(r.company_id);
      chosen.push(r.id);
      ctx.db.prepare('update roles set picked_on=? where id=?').run(day, r.id);
      setStatus(ctx.db, r.id, 'picked', '', at);
    }
    for (const r of pool) if (!chosen.includes(r.id)) {
      const st = (ctx.db.prepare('select status from roles where id=?').get(r.id) as any).status;
      if (st === 'new') setStatus(ctx.db, r.id, 'bench', 'eligible, not in today\'s picks', at);
    }
    return chosen;
  });
}

/** A role the user chose: picked today unless a safety gate says otherwise (returned as warnings; force overrides). */
export function pickPasted(ctx: Ctx, id: string, day = todayOf(ctx), force = false): string[] {
  const at = nowIso(ctx);
  return tx(ctx.db, () => {
    const r = getRole(ctx.db, id);
    const warnings: string[] = [];
    if (r.status === 'applied') warnings.push('you already applied to this role');
    if (r.cooldown_until && r.cooldown_until > at) warnings.push(`${r.company} is in its cooldown until ${String(r.cooldown_until).slice(0, 10)} (applied recently)`);
    const busy = ctx.db.prepare(`select title from roles where company_id=? and id<>? and status in ('picked','prepared')`).get(r.company_id, id) as any;
    if (busy) warnings.push(`${r.company} already has "${busy.title}" in progress`);
    if (warnings.length && !force) return warnings;
    if (r.status === 'picked' || r.status === 'prepared') return [];
    ctx.db.prepare(`update roles set eligibility='yes', evidence='chosen by the user', score=100, picked_on=? where id=?`).run(day, id);
    setStatus(ctx.db, id, 'picked', force && warnings.length ? `chosen by the user despite: ${warnings.join('; ')}` : 'chosen by the user', at);
    return [];
  });
}

/** How many roles to pick per day: schedule.daily_picks in jobs/search.md. */
export const dailyPicks = (ctx: Ctx) => notesOf(ctx).search.data.schedule.daily_picks;
