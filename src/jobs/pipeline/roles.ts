// Roles found outside the scheduled sources (a pasted link, a job-alert email) and small tracker edits. A role enters
// the same gates as every other: prefilter, judging, picking.
import { type Ctx, nowIso } from '../ctx.ts';
import { type RoleInput, type Status, STATUSES, addEvent, getRole, setStatus, upsertRole, tx } from '../db.ts';
import { checkRoleUrl } from '../fields.ts';

const SOURCES = ['manual', 'pasted', 'alert', 'linkedin', 'board'];
/** easy = LinkedIn Easy Apply; external = the company's own form; unknown = not known yet. */
const APPLY_KINDS = ['easy', 'external', 'unknown'];
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Add (or refresh) a role from a checked address; text fields are data, trimmed and capped. */
export function addRole(ctx: Ctx, r: { url: string; title: string; company: string; location?: string; description?: string; pay_text?: string; posted_at?: string; source?: string; apply_url?: string; apply_kind?: string }) {
  const url = checkRoleUrl(r.url, ctx.features);
  const title = text(r.title, 300), company = text(r.company, 200);
  if (!title || !company) throw new Error('title and company are required');
  const source = r.source ?? 'manual';
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  if (r.apply_kind !== undefined && !APPLY_KINDS.includes(r.apply_kind)) throw new Error(`apply_kind must be one of ${APPLY_KINDS.join(', ')}`);
  const input: RoleInput = {
    url, title, company, source, location: text(r.location, 300), description: text(r.description, 200_000),
    pay_text: text(r.pay_text, 300) || null, posted_at: text(r.posted_at, 40) || null,
    apply_url: r.apply_url ? checkRoleUrl(r.apply_url, ctx.features, 'apply URL') : null, apply_kind: r.apply_kind ?? null,
  };
  return tx(ctx.db, () => {
    const res = upsertRole(ctx.db, input);
    if (res.isNew) addEvent(ctx.db, res.id, 'added', `from ${source}`, nowIso(ctx));
    return res;
  });
}

/** The application form's own address (the posting may link elsewhere). */
/** How an employer takes applications (D35), recorded by Claude at Prepare. */
export const APPLY_METHODS = ['form', 'email', 'document', 'walk_in', 'chatbot', 'account_needed'] as const;
export type ApplyMethod = (typeof APPLY_METHODS)[number];

/** Record the apply method (and a note from the posting: where and when to walk in, the address to email). */
export function setApplyMethod(ctx: Ctx, id: string, method: string, note?: string) {
  getRole(ctx.db, id);
  if (!(APPLY_METHODS as readonly string[]).includes(method)) throw new Error(`--apply-method must be one of ${APPLY_METHODS.join(', ')}`);
  const n = note === undefined ? null : String(note).replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  tx(ctx.db, () => {
    ctx.db.prepare('update roles set apply_method=?, apply_note=coalesce(?, apply_note), updated_at=? where id=?').run(method, n, nowIso(ctx), id);
    addEvent(ctx.db, id, 'apply_method', `${method}${n ? `: ${n}` : ''}`, nowIso(ctx));
  });
  return method as ApplyMethod;
}

/** The language of the role's application form (two letters), for drafting answers in it (D33). */
export function setFormLang(ctx: Ctx, id: string, lang: string) {
  getRole(ctx.db, id);
  const m = /^([a-z]{2})(?:[-_][a-z0-9]{2,8})?$/.exec(String(lang ?? '').trim().toLowerCase());
  if (!m) throw new Error('--lang must be a two-letter language code (en, de, es …)');
  const l = m[1];
  ctx.db.prepare('update roles set form_lang=? where id=?').run(l, id);
  return l;
}

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

/**
 * The moves `crewdeck jobs status` may make (C2). `picked` is reached only through `pick` (cooldowns, one role per company,
 * the daily count, the user's own override from a link request) and `applied` only through `applied` (cooldown and
 * journal); `prepared` only from `picked`. A prefiltered role comes back through `refilter`, which re-runs the rules.
 */
export const MANUAL_MOVES: Record<Status, Status[]> = {
  new: ['bench', 'skipped', 'expired', 'judged_out'],
  bench: ['new', 'skipped', 'expired', 'judged_out'],
  picked: ['prepared', 'bench', 'skipped', 'expired', 'judged_out'],
  prepared: ['skipped', 'expired', 'judged_out'],
  applied: [],
  skipped: ['new'],
  expired: ['new'],
  judged_out: ['new'],
  prefiltered_out: [],
};

/** Set a status by hand, along MANUAL_MOVES only. */
export function setRoleStatus(ctx: Ctx, roleId: string, status: string, reason = '') {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  if (status === 'applied') throw new Error('use crewdeck jobs applied <role>: it also starts the company cooldown and writes the journal line');
  const from = getRole(ctx.db, roleId).status as Status;
  if (from === status) return;
  if (status === 'picked') throw new Error('picked is set by crewdeck jobs pick (cooldowns, one role per company, the daily count), never by hand');
  if (!MANUAL_MOVES[from].includes(status as Status)) {
    const hint = from === 'prefiltered_out' ? ': run crewdeck jobs refilter after changing your notes' : MANUAL_MOVES[from].length ? ` (from ${from}: ${MANUAL_MOVES[from].join(', ')})` : '';
    throw new Error(`from ${from} to ${status} is not allowed${hint}`);
  }
  setStatus(ctx.db, roleId, status as Status, text(reason, 1000), nowIso(ctx));
}
