// The drops only the tracker knows (design §2.4, D36): a cooldown after applying, and roles already picked or in
// progress at a company. The cooldown's scope is the user's: `company` (no role at that company until it ends, the
// default) or `role` (only the same title at that company: hospitals, schools and chains post many units). `per_company`
// is how many roles of one company may be picked or in progress at once (1 by default).
import { fold } from '../places.ts';
import type { Db } from '../db.ts';
import type { Search } from '../schema.ts';

export type TrackerDrop = { rule: 'cooldown' | 'active_pick'; reason: string };
export type TrackerRules = { scope: 'company' | 'role'; days: number; perCompany: number };
export const trackerRules = (s: Pick<Search, 'schedule'>): TrackerRules => ({ scope: s.schedule.cooldown_scope, days: s.schedule.cooldown_days, perCompany: s.schedule.per_company });

/** One title, compared for a role-scoped cooldown: folded words ("RN – Nights (ICU)" = "rn nights icu"). */
export const titleKey = (t: string) => fold(t).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A checker for many roles at once (prefilter, preview, pick): what the tracker says about each, read once. `at` is
 * now (ISO). Roles are { id, company_id, title }.
 */
export function trackerCheck(db: Db, rules: TrackerRules, at: string) {
  const cool = new Map<number, string>();
  const applied = new Map<number, Map<string, string>>();
  if (rules.scope === 'company') {
    for (const r of db.prepare('select id, cooldown_until from companies where cooldown_until > ?').all(at) as any[]) cool.set(Number(r.id), String(r.cooldown_until));
  } else if (rules.days > 0) {
    const since = new Date(Date.parse(at) - rules.days * 86_400_000).toISOString();
    // A tracker opened read-only before its v3 migration (the preview) has no applied_at: updated_at stands in.
    let rows: any[];
    try { rows = db.prepare(`select company_id, title, applied_at from roles where status = 'applied' and applied_at > ?`).all(since) as any[]; }
    catch { rows = db.prepare(`select company_id, title, updated_at applied_at from roles where status = 'applied' and updated_at > ?`).all(since) as any[]; }
    for (const r of rows) {
      const m = applied.get(Number(r.company_id)) ?? new Map<string, string>();
      const k = titleKey(String(r.title)), was = m.get(k);
      if (!was || String(r.applied_at) > was) m.set(k, String(r.applied_at));
      applied.set(Number(r.company_id), m);
    }
  }
  const busy = new Map<number, { id: string; title: string }[]>();
  for (const r of db.prepare(`select id, company_id, title from roles where status in ('picked','prepared')`).all() as any[]) {
    const k = Number(r.company_id);
    busy.set(k, [...(busy.get(k) ?? []), { id: String(r.id), title: String(r.title) }]);
  }
  const day = (iso: string) => iso.slice(0, 10);
  return {
    /** Roles at this company picked or in progress now (other than `except`). */
    active: (companyId: number, except?: string) => (busy.get(companyId) ?? []).filter((x) => x.id !== except),
    check(row: { id: string; company_id: number; title: string }): TrackerDrop | null {
      const c = Number(row.company_id);
      const until = cool.get(c);
      if (until) return { rule: 'cooldown', reason: `company in its cooldown until ${day(until)}` };
      const was = applied.get(c)?.get(titleKey(row.title));
      if (was) {
        const end = new Date(Date.parse(was) + rules.days * 86_400_000).toISOString();
        return { rule: 'cooldown', reason: `you applied to this title at this company on ${day(was)}: cooldown until ${day(end)} (scope: role)` };
      }
      const others = (busy.get(c) ?? []).filter((x) => x.id !== row.id);
      if (others.length >= rules.perCompany) {
        return { rule: 'active_pick', reason: rules.perCompany === 1 ? `company already has "${others[0].title}" picked or in progress` : `company already has ${others.length} roles picked or in progress (per_company: ${rules.perCompany})` };
      }
      return null;
    },
  };
}

/** The roles picked for `day` (the user's day): what `pick` calls "already" (pasted links are the person's own and not counted). */
export function todayPickIds(db: Db, day: string): string[] {
  return (db.prepare(`select id from roles where picked_on=? and source<>'pasted' and status in ('picked','prepared','applied') order by score desc, id`).all(day) as any[]).map((r) => String(r.id));
}
