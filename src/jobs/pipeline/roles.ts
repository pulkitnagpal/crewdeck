// Roles found outside the scheduled sources (a pasted link, a job-alert email) and small tracker edits. A role enters
// the same gates as every other: prefilter, judging, picking.
import { type Ctx, nowIso } from '../ctx.ts';
import { type RoleInput, type Status, STATUSES, addEvent, getRole, setStatus, upsertRole, tx } from '../db.ts';
import { checkRoleUrl } from '../fields.ts';

const SOURCES = ['manual', 'pasted', 'alert', 'linkedin', 'board'];
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Add (or refresh) a role from a checked address; text fields are data, trimmed and capped. */
export function addRole(ctx: Ctx, r: { url: string; title: string; company: string; location?: string; description?: string; pay_text?: string; posted_at?: string; source?: string; apply_url?: string }) {
  const url = checkRoleUrl(r.url, ctx.features);
  const title = text(r.title, 300), company = text(r.company, 200);
  if (!title || !company) throw new Error('title and company are required');
  const source = r.source ?? 'manual';
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  const input: RoleInput = {
    url, title, company, source, location: text(r.location, 300), description: text(r.description, 200_000),
    pay_text: text(r.pay_text, 300) || null, posted_at: text(r.posted_at, 40) || null,
    apply_url: r.apply_url ? checkRoleUrl(r.apply_url, ctx.features, 'apply URL') : null,
  };
  return tx(ctx.db, () => {
    const res = upsertRole(ctx.db, input);
    if (res.isNew) addEvent(ctx.db, res.id, 'added', `from ${source}`, nowIso(ctx));
    return res;
  });
}

/** The application form's own address (the posting may link elsewhere). */
export function setApplyUrl(ctx: Ctx, id: string, url: string) {
  getRole(ctx.db, id);
  const clean = checkRoleUrl(url, ctx.features, 'apply URL');
  tx(ctx.db, () => {
    ctx.db.prepare('update roles set apply_url=?, updated_at=? where id=?').run(clean, nowIso(ctx), id);
    addEvent(ctx.db, id, 'apply_url', clean, nowIso(ctx));
  });
  return clean;
}

/** A question for the user about a role (not a form field): shown on the role until answered. */
export function addQuestion(ctx: Ctx, roleId: string, q: string): number {
  getRole(ctx.db, roleId);
  const t = text(q, 2000);
  if (!t) throw new Error('the question is empty');
  return Number(ctx.db.prepare('insert into questions(role_id, text, asked_at) values (?,?,?)').run(roleId, t, nowIso(ctx)).lastInsertRowid);
}

export const EVENT_KINDS = ['why', 'deadline', 'note', 'reply', 'interview', 'rejected'] as const;

export function addRoleEvent(ctx: Ctx, roleId: string, kind: string, detail: string) {
  getRole(ctx.db, roleId);
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) throw new Error(`--kind must be one of ${EVENT_KINDS.join(', ')}`);
  const d = text(detail, 2000);
  if (!d) throw new Error('the detail is empty');
  addEvent(ctx.db, roleId, kind, d, nowIso(ctx));
}

/** Set a status by hand. `applied` goes through `crewdeck jobs applied` (cooldown and journal). */
export function setRoleStatus(ctx: Ctx, roleId: string, status: string, reason = '') {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  if (status === 'applied') throw new Error('use crewdeck jobs applied <role>: it also starts the company cooldown and writes the journal line');
  getRole(ctx.db, roleId);
  setStatus(ctx.db, roleId, status as Status, text(reason, 1000), nowIso(ctx));
}
