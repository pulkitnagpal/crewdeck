// Outreach records (opt-in, design §12): contacts at a company, the drafts written for them and follow-up reminders.
// Crewdeck never sends anything: email is drafts only (verified address, one per role, a daily cap), LinkedIn is text the
// user sends themselves. Both are off until the user switches them on.
import { type Ctx, notesOf, nowIso, todayBounds, todayOf, tzOf } from '../ctx.ts';
import { addEvent, companyId, getRole, tx } from '../db.ts';
import { FEATURE_CAPS } from '../../config.ts';
import { dayIn, daysBetween } from '../time.ts';

export type ContactInput = { company: string; name: string; title?: string; email?: string; email_verified?: boolean; linkedin_url?: string; source?: string };
export type MessageInput = { role_id: string; contact_id: number; channel: 'email' | 'linkedin'; body: string; gmail_draft_id?: string };

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function addContact(ctx: Ctx, c: ContactInput): number {
  const name = text(c.name, 200), company = text(c.company, 200);
  if (!name || !company) throw new Error('a contact needs a name and a company');
  const email = text(c.email, 320);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('the email address is not valid');
  const li = text(c.linkedin_url, 500);
  if (li && !/^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^\s/]+\/?$/i.test(li)) throw new Error('linkedin_url must be a profile address (https://www.linkedin.com/in/<name>)');
  return tx(ctx.db, () => Number(ctx.db.prepare(`insert into contacts(company_id, name, title, email, email_verified, linkedin_url, source, created_at) values (?,?,?,?,?,?,?,?)`)
    .run(companyId(ctx.db, company), name, text(c.title, 200) || null, email || null, c.email_verified ? 1 : 0, li || null, text(c.source, 200), nowIso(ctx)).lastInsertRowid));
}

/** Every outreach limit. Run before creating anything outside the tracker (e.g. a Gmail draft). */
export function checkMessage(ctx: Ctx, m: Pick<MessageInput, 'role_id' | 'contact_id' | 'channel'>) {
  if (m.channel !== 'email' && m.channel !== 'linkedin') throw new Error('--channel must be email or linkedin');
  getRole(ctx.db, m.role_id);
  const c = ctx.db.prepare('select email, email_verified from contacts where id=?').get(m.contact_id) as any;
  if (!c) throw new Error(`no contact ${m.contact_id}`);
  if (m.channel === 'email') {
    if (!ctx.features.email_drafts) throw new Error('email drafts are off: the user can switch them on in Jobs → Settings');
    if (!c.email || !c.email_verified) throw new Error('email address not verified: use a LinkedIn message instead');
    if (ctx.db.prepare(`select 1 from messages where role_id=? and channel='email'`).get(m.role_id)) throw new Error('an email for this role already exists');
    const cap = Math.min(ctx.features.max_emails_per_day, FEATURE_CAPS.max_emails_per_day);
    const [start, end] = todayBounds(ctx);
    const n = Number((ctx.db.prepare(`select count(*) n from messages where channel='email' and created_at >= ? and created_at < ?`).get(start, end) as any).n);
    if (n >= cap) throw new Error(`limit reached: ${cap} email drafts per day`);
  } else {
    if (!ctx.features.linkedin_message_text) throw new Error('LinkedIn message text is off: the user can switch it on in Jobs → Settings');
    if (ctx.db.prepare('select 1 from messages where role_id=? and contact_id=? and channel=?').get(m.role_id, m.contact_id, m.channel)) throw new Error('a linkedin message for this role and contact already exists');
  }
}

export function addMessage(ctx: Ctx, m: MessageInput): number {
  const body = text(m.body, 10_000);
  if (!body) throw new Error('the message is empty');
  return tx(ctx.db, () => {
    checkMessage(ctx, m);
    const id = Number(ctx.db.prepare(`insert into messages(role_id, contact_id, channel, body, gmail_draft_id, created_at) values (?,?,?,?,?,?)`)
      .run(m.role_id, m.contact_id, m.channel, body, text(m.gmail_draft_id, 200) || null, nowIso(ctx)).lastInsertRowid);
    addEvent(ctx.db, m.role_id, 'message', `${m.channel} drafted`, nowIso(ctx));
    return id;
  });
}

/** The user sent it themselves. */
export function markSent(ctx: Ctx, id: number, at = nowIso(ctx)) {
  const r = ctx.db.prepare(`update messages set status='sent', sent_at=? where id=?`).run(at, id);
  if (!r.changes) throw new Error(`no message ${id}`);
}

export function recordFollowup(ctx: Ctx, messageId: number, step: 'nudge' | 'final') {
  const m = ctx.db.prepare('select role_id from messages where id=?').get(messageId) as any;
  if (!m) throw new Error(`no message ${messageId}`);
  addEvent(ctx.db, m.role_id, `followup_${step}`, String(messageId), nowIso(ctx));
}

/** Sent emails due a nudge (days 3–4) or a final note (days 10–12), counted in local days; replied roles are skipped. */
export function followups(ctx: Ctx, day = todayOf(ctx)): { message_id: number; role_id: string; step: 'nudge' | 'final'; days: number }[] {
  const tz = tzOf(ctx, notesOf(ctx));
  const rows = ctx.db.prepare(`select m.id, m.role_id, m.sent_at from messages m where m.channel='email' and m.status='sent' and m.sent_at is not null
      and not exists (select 1 from events e where e.role_id=m.role_id and e.kind='reply') order by m.id`).all() as any[];
  const done = (step: string, id: number) => !!ctx.db.prepare('select 1 from events where kind=? and detail=?').get(`followup_${step}`, String(id));
  return rows.flatMap((r) => {
    const days = daysBetween(dayIn(tz, r.sent_at), day);
    if ((days === 3 || days === 4) && !done('nudge', r.id)) return [{ message_id: Number(r.id), role_id: r.role_id, step: 'nudge' as const, days }];
    if (days >= 10 && days <= 12 && !done('final', r.id)) return [{ message_id: Number(r.id), role_id: r.role_id, step: 'final' as const, days }];
    return [];
  });
}
