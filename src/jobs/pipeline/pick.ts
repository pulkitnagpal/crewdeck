// From prefiltered roles to today's picks (design §2.4): a cheap rank from the notes decides what Claude judges first;
// Claude's verdicts are stored; `pick` takes the best eligible roles, one per company, respecting cooldowns and the
// daily count, idempotent per day in the user's time zone. A role the user chose (pasted) skips judging but not the
// safety gates: those come back as warnings unless the user overrides them.
import { type Ctx, notesOf, nowIso, todayOf } from '../ctx.ts';
import { addEvent, getRole, setStatus, tx } from '../db.ts';
import { compileRules, prefilter } from '../rules.ts';
import { type Candidate, fromMatches, rankRoles, readFindRun, toCandidate } from './rank.ts';
import { todayPickIds, trackerCheck, trackerRules } from './tracker.ts';

export type { Candidate } from './rank.ts';
export type Verdict = { role: string; eligible: 'yes' | 'no' | 'unclear'; score: number; evidence: string; reason?: string };
export { rankScore } from './rank.ts';

/** Unjudged roles that passed the prefilter, best first, with plain clipped descriptions (rank.ts). */
export function candidates(ctx: Ctx, limit = 40, from?: string[]): Candidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('--limit must be from 1 to 40 (at most 40 postings are judged per run)');
  return rankRoles(ctx, { from }).slice(0, limit).map(toCandidate);
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
    // A pick read in full at Prepare that turns out not to fit: a "no" sets it aside and clears its eligibility.
    if (v.eligible === 'no' && ['picked', 'prepared'].includes(r.status)) {
      ctx.db.prepare('update roles set eligibility=?, evidence=?, score=?, updated_at=? where id=?').run('no', v.evidence, v.score, at, v.role);
      if (v.reason) addEvent(ctx.db, v.role, 'judge', v.reason, at);
      setStatus(ctx.db, v.role, 'judged_out', `at prepare: ${v.reason ?? v.evidence}`, at);
      return { role: v.role, stored: true };
    }
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

/**
 * Pick up to n roles for `day` (YYYY-MM-DD, the user's day): best score first, one per company (or up to
 * schedule.per_company, counting roles already in progress there). Idempotent per day: `n` is the day's total, so asking
 * again returns the same picks. `add` (a second Find, "Find more like these") is "n MORE on top of today's": the target is
 * the day's count when that Find began (kept in its run, so repeating the call adds nothing more) plus n. `from` limits
 * the pool to roles of those sources (see fromMatches); picks already made are kept whatever their source.
 */
export function pick(ctx: Ctx, n: number, day = todayOf(ctx), o: { add?: boolean; from?: string[] } = {}): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error('--n must be from 0 to 50');
  const at = nowIso(ctx);
  return tx(ctx.db, () => {
    const already = todayPickIds(ctx.db, day);
    let total = n;
    if (o.add) {
      const run = readFindRun(ctx.home);
      const fresh = !!run && run.base?.day === day && ctx.clock().getTime() - Date.parse(run.started) <= 6 * 3_600_000;
      total = (fresh ? Math.min(run!.base!.picked, already.length) : already.length) + n;
    }
    if (already.length >= total) return already.slice(0, o.add ? already.length : n);
    const excluded = nowExcluded(ctx);
    const rules = trackerRules(notesOf(ctx).search.data);
    const tracker = trackerCheck(ctx.db, rules, at);
    const pool = (ctx.db.prepare(`select r.id, r.company_id, r.title, r.source_key, c.name company from roles r join companies c on c.id=r.company_id
        where r.eligibility='yes' and r.status in ('new','bench')
        order by r.score desc, r.first_seen, r.id`).all() as any[])
      .filter((r) => fromMatches(r.source_key, o.from))
      .filter((r) => !tracker.check(r))
      .filter((r) => { const why = excluded(r); if (why) setStatus(ctx.db, r.id, 'skipped', why, at); return !why; });
    const chosen = [...already];
    const used = new Map<number, number>();
    for (const r of pool) {
      if (chosen.length >= total) break;
      const k = Number(r.company_id), have = used.get(k) ?? tracker.active(k).length;
      if (have >= rules.perCompany) continue;
      used.set(k, have + 1);
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
    const rules = trackerRules(notesOf(ctx).search.data);
    const t = trackerCheck(ctx.db, rules, at).check(r);
    if (t?.rule === 'cooldown') warnings.push(rules.scope === 'role' ? `${r.company}: ${t.reason}` : `${r.company} is in its cooldown until ${String(r.cooldown_until).slice(0, 10)} (applied recently)`);
    if (t?.rule === 'active_pick') {
      const busy = trackerCheck(ctx.db, rules, at).active(Number(r.company_id), id);
      warnings.push(busy.length === 1 ? `${r.company} already has "${busy[0].title}" in progress` : `${r.company} already has ${busy.length} roles in progress`);
    }
    if (warnings.length && !force) return warnings;
    if (r.status === 'picked' || r.status === 'prepared') return [];
    ctx.db.prepare(`update roles set eligibility='yes', evidence='chosen by the user', score=100, picked_on=? where id=?`).run(day, id);
    setStatus(ctx.db, id, 'picked', force && warnings.length ? `chosen by the user despite: ${warnings.join('; ')}` : 'chosen by the user', at);
    return [];
  });
}

/** How many roles to pick per day: schedule.daily_picks in jobs/search.md. */
export const dailyPicks = (ctx: Ctx) => notesOf(ctx).search.data.schedule.daily_picks;
