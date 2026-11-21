// Quick apply (design §12, features easy_apply + daily_quick_apply): today's prepared Easy Apply picks whose every
// required screening question already has an answer, walked one by one in one fresh Jobs chat. It is the same Apply
// playbook, batched: Claude fills each form and stops at its "Submit application" for the person's click; nothing is
// ever submitted for them. Each role counts once a day against daily_quick_apply (planForRole records it), so the
// batch never offers more than what is left of today's number.
import { type Ctx, notesOf } from './ctx.ts';
import { detectApplyKind } from './apply-kind.ts';
import { quickAppliesToday } from './plan.ts';
import { applyMode, canApprove } from './views.ts';

export type QuickApply = {
  /** Switched on (easy_apply and a daily number above 0). */
  on: boolean;
  cap: number; used: number; left: number;
  /** The picks a Quick apply would walk now, best first, at most what is left today (roles counted today are free). */
  roles: { id: string; company: string; title: string }[];
  /** Eligible picks before the cap (for "3 more tomorrow"). */
  eligible: number;
};

/** Today's Quick apply: `busy` says a role already has an Apply (or a Quick apply) under way. */
export function quickApplyView(ctx: Ctx, busy: (role: string) => boolean = () => false): QuickApply {
  const cap = ctx.features.easy_apply ? ctx.features.daily_quick_apply : 0;
  const today = quickAppliesToday(ctx);
  const used = today.length;
  const off: QuickApply = { on: false, cap, used, left: Math.max(0, cap - used), roles: [], eligible: 0 };
  if (!ctx.features.easy_apply || cap <= 0) return off;
  const profile = notesOf(ctx).profile.data;
  const rows = (ctx.db.prepare(`select r.*, c.name company from roles r join companies c on c.id=r.company_id
      where r.status = 'prepared' order by r.picked_on desc, r.score desc, r.id`).all() as any[]);
  const eligible = rows.filter((r) => {
    const k = detectApplyKind(r);
    return k.kind === 'linkedin_easy' && k.sure && applyMode(ctx, r, profile).mode === 'fill' && canApprove(ctx.db, r.id) && !busy(r.id);
  });
  // A role already counted today costs nothing again; the rest take what is left of today's number.
  let left = Math.max(0, cap - used);
  const roles: QuickApply['roles'] = [];
  for (const r of eligible) {
    if (today.includes(r.id)) roles.push(r);
    else if (left > 0) { roles.push(r); left -= 1; }
  }
  return { on: true, cap, used, left: Math.max(0, cap - used), roles: roles.map((r) => ({ id: r.id, company: r.company, title: r.title })), eligible: eligible.length };
}
