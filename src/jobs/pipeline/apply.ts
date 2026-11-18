// The end of a role: the user submitted it (status, company cooldown, a line in today's journal), or isn't interested
// (their reason remembered for every later run; optional title words become a visible exclusion in jobs/search.md).
// Open requests for the role are closed by the server, which reconciles requests with role status (design D4, P3).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, notesOf, nowIso, todayOf } from '../ctx.ts';
import { getRole, setStatus, addEvent, tx } from '../db.ts';
import { NOTES, writeAtomic } from '../notes.ts';
import { setField } from '../edit.ts';
import { remember } from '../kb/ops.ts';

/** Append one line to the vault's journal page for a day (created if missing); the same line is never added twice. */
export function appendJournal(vault: string, day: string, line: string): boolean {
  const file = join(vault, 'journal', `${day}.md`);
  const entry = `- ${line}`;
  const have = existsSync(file) ? readFileSync(file, 'utf8') : `# ${day}\n`;
  if (have.split('\n').some((l) => l.trim() === entry)) return false;
  writeAtomic(file, `${have.replace(/\s*$/, '')}\n${have.trim() === `# ${day}` ? '\n' : ''}${entry}\n`);
  return true;
}

/** The user submitted the application: status applied, cooldown max(existing, now + cooldown_days), journal line. */
export function markApplied(ctx: Ctx, roleId: string) {
  const notes = notesOf(ctx);
  const r = getRole(ctx.db, roleId);
  const at = nowIso(ctx);
  const until = new Date(ctx.clock().getTime() + notes.search.data.schedule.cooldown_days * 86_400_000).toISOString();
  tx(ctx.db, () => {
    if (r.status !== 'applied') setStatus(ctx.db, roleId, 'applied', '', at);
    ctx.db.prepare(`update companies set cooldown_until=max(coalesce(cooldown_until,''), ?) where id=?`).run(until, r.company_id);
  });
  const day = todayOf(ctx, notes);
  const journal = appendJournal(ctx.vault, day, `Applied: ${r.company} — ${r.title}`);
  const cooldown = (ctx.db.prepare('select cooldown_until from companies where id=?').get(r.company_id) as any).cooldown_until as string;
  return { role: roleId, company: r.company, title: r.title, cooldown_until: cooldown, journal: journal ? `journal/${day}.md` : null, already: r.status === 'applied' };
}

const WORD = /^[\p{L}\p{N}][\p{L}\p{N} +#./&'-]{0,39}$/u;

/**
 * "Not interested": the role is skipped, the reason is remembered in the user's words (kind avoid, every company: it
 * describes roles, not one employer), and title words (optional) join roles.exclude_title_words with the reason logged.
 */
export function notInterested(ctx: Ctx, p: { role: string; reason: string; titleWords?: string[] }) {
  const r = getRole(ctx.db, p.role);
  if (r.status === 'applied') throw new Error('already applied: nothing to skip');
  const reason = String(p.reason ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('say why, in the user\'s words: later runs use it');
  const words = [...new Set((p.titleWords ?? []).map((w) => String(w).trim()).filter(Boolean))];
  for (const w of words) if (!WORD.test(w)) throw new Error(`"${w}" is not a title word (1-40 letters, digits, spaces; no commas)`);
  if (words.length > 5) throw new Error('at most 5 title words at a time');
  const at = nowIso(ctx);
  tx(ctx.db, () => {
    setStatus(ctx.db, r.id, 'skipped', `not interested: ${reason}`, at);
    addEvent(ctx.db, r.id, 'skip', reason, at);
  });
  const rem = remember(ctx, { kind: 'avoid', text: reason, quote: reason, scope: 'all' });
  let added: string[] = [];
  if (words.length) {
    const have = notesOf(ctx).search.data.roles.exclude_title_words;
    added = words.filter((w) => !have.some((h) => h.toLowerCase() === w.toLowerCase()));
    if (added.length) setField(join(ctx.vault, NOTES.search), 'search', ['roles', 'exclude_title_words'], [...have, ...added].join(','), { because: reason, today: todayOf(ctx) });
  }
  return { role: r.id, company: r.company, remembered: rem.item.id, title_words: added };
}
