// The rule prefilter over new roles (design §2.4 step 1, §7.8): P1's compiled rules from the notes, plus the two drops
// only the tracker knows: a company in its cooldown and a company that already has a role picked or in progress.
// `refilter` re-checks roles dropped recently against the current notes (after a preference change, §2.5).
import { type Ctx, notesOf, nowIso } from '../ctx.ts';
import { type Db, setStatus, tx } from '../db.ts';
import { type Compiled, compileRules, prefilter } from '../rules.ts';
import { payCheck } from '../pay.ts';

export type Drop = { keep: true } | { keep: false; rule: string; reason: string };

/** The drops only the tracker knows. */
export function trackerDrop(db: Db, row: { id: string; company_id: number }, at: string): Drop {
  const c = db.prepare('select cooldown_until from companies where id=?').get(row.company_id) as any;
  if (c?.cooldown_until && c.cooldown_until > at) return { keep: false, rule: 'cooldown', reason: `company in its cooldown until ${String(c.cooldown_until).slice(0, 10)}` };
  const busy = db.prepare(`select title from roles where company_id=? and id<>? and status in ('picked','prepared')`).get(row.company_id, row.id) as any;
  if (busy) return { keep: false, rule: 'active_pick', reason: `company already has "${busy.title}" picked or in progress` };
  return { keep: true };
}

/** One role through every drop; records its pay in the user's currency and period. */
function check(ctx: Ctx, row: any, compiled: Compiled, at: string): Drop {
  const pay = compiled.pay ? payCheck(row.pay_text, row.description, compiled.pay) : null;
  ctx.db.prepare('update roles set pay_min=?, pay_max=?, pay_currency=?, pay_period=?, pay_status=? where id=?').run(
    pay?.min ?? null, pay?.max ?? null, pay?.currency ?? null, compiled.pay && pay?.currency ? compiled.pay.period : null, pay?.status ?? null, row.id);
  const v = prefilter({ title: row.title, company: row.company, location: row.location, description: row.description, pay_text: row.pay_text }, compiled);
  if (!v.keep) return v;
  return trackerDrop(ctx.db, row, at);
}

/** Run the prefilter over every `new` role that hasn't been judged. */
export function runPrefilter(ctx: Ctx) {
  const compiled = compileRules(notesOf(ctx));
  const at = nowIso(ctx);
  const dropped: { id: string; rule: string; reason: string }[] = [];
  let kept = 0;
  tx(ctx.db, () => {
    for (const row of ctx.db.prepare(`select r.*, c.name company from roles r join companies c on c.id=r.company_id where r.status='new' and r.eligibility is null order by r.first_seen`).all() as any[]) {
      const v = check(ctx, row, compiled, at);
      if (v.keep) { kept++; continue; }
      setStatus(ctx.db, row.id, 'prefiltered_out', `${v.rule}: ${v.reason}`, at);
      dropped.push({ id: row.id, rule: v.rule, reason: v.reason });
    }
  });
  return { kept, dropped: dropped.length, drops: dropped };
}

/** Re-check roles the prefilter dropped in the last `days` days; the ones the current notes allow are `new` again. */
export function refilter(ctx: Ctx, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be a whole number from 1 to 365');
  const compiled = compileRules(notesOf(ctx));
  const at = nowIso(ctx);
  const since = new Date(ctx.clock().getTime() - days * 86_400_000).toISOString();
  const back: { id: string; title: string; company: string; was: string }[] = [];
  let still = 0;
  tx(ctx.db, () => {
    for (const row of ctx.db.prepare(`select r.*, c.name company from roles r join companies c on c.id=r.company_id where r.status='prefiltered_out' and r.updated_at >= ? order by r.updated_at`).all(since) as any[]) {
      const v = check(ctx, row, compiled, at);
      if (v.keep) {
        setStatus(ctx.db, row.id, 'new', 'refilter: allowed by your current notes', at);
        back.push({ id: row.id, title: row.title, company: row.company, was: row.status_reason ?? '' });
      } else {
        still++;
        const reason = `${v.rule}: ${v.reason}`;
        if (reason !== row.status_reason) ctx.db.prepare('update roles set status_reason=? where id=?').run(reason, row.id);
      }
    }
  });
  return { checked: back.length + still, restored: back.length, roles: back };
}
