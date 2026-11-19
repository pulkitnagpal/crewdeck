// The fill plan (design §2.3a step 3): given the fields Claude read on a live application page, exactly what to put in
// each. Per-role answers first, then whole-label profile matches; sensitive questions only from an explicit answer;
// never a guess for a choice with no matching option. The plan never contains a submit or review action: its only
// actions are fill, select, choose, upload, add and skip. Password, CAPTCHA and button fields are always skipped, and so
// are ID, bank and tax numbers (never_fill, D32): the user types those. `add` presses an "Add another …" button a capped
// number of times (D35) so each of the user's jobs, schools or referees gets a block.
import { existsSync } from 'node:fs';
import { type Ctx, notesOf, nowIso, todayBounds } from './ctx.ts';
import { addEvent, getRole } from './db.ts';
import type { Career, Profile, Search } from './schema.ts';
import { SENSITIVE, copyOnlyHost, hostOf, isLinkedinHost, norm, profileAnswer, profileFields } from './fields.ts';
import { type Group, availabilityDay, availabilityOption, classOf, groupOf, isAddButton, isLetterLabel } from './form-terms.ts';
import { blockField, entriesFor } from './entries.ts';
import { currentAnswers } from './kb/ops.ts';
import { letterPath } from './letter-path.ts';

export type PageField = {
  label: string; type: string; options?: string[]; required?: boolean;
  /** Claude raised it to sensitive (never lowers what the words say). */ sensitive?: boolean;
  /** A field inside a repeated block: which kind and which entry (0-based). */ group?: Group; index?: number;
};
export type PlanAction = 'fill' | 'select' | 'choose' | 'upload' | 'add' | 'skip';
export const PLAN_ACTIONS: readonly PlanAction[] = ['fill', 'select', 'choose', 'upload', 'add', 'skip'];
export type PlanItem = { label: string; action: PlanAction; value?: string; reason?: string; required?: boolean; times?: number };
/** At most this many "Add another" presses per page. */
export const MAX_ADDS = 10;
export const NEVER_FILL_REASON = 'you type this yourself: Crewdeck never fills or stores ID, bank or tax numbers';
export type PlanContext = { career?: Career | null; letter?: boolean; workPattern?: Search['work_pattern'] | null };

/**
 * An availability grid's answer for one day from work_pattern (D30), only from what the user listed: the shifts they
 * can work (day, evening, night), weekends unless they can't work them. A single choice is answered only when one
 * option fits; checkboxes tick every fitting option.
 */
export function availabilityAnswer(label: string, type: string, options: string[], wp: Search['work_pattern'] | null | undefined): { value?: string; reason: string } | null {
  const day = availabilityDay(label);
  if (!day) return null;
  if (!wp || (!wp.shifts.length && !wp.shifts_avoid.length)) return { reason: 'your shifts aren\'t in jobs/search.md (work_pattern.shifts): the user\'s to answer' };
  const times = (['day', 'evening', 'night'] as const).filter((t) => wp.shifts.includes(t) && !wp.shifts_avoid.includes(t));
  const meant = options.map((o) => ({ o, m: availabilityOption(o) }));
  const none = meant.find((x) => x.m === 'none')?.o;
  if (day === 'weekend' && wp.shifts_avoid.includes('weekend')) return none ? { value: none, reason: 'you can\'t work weekends (work_pattern)' } : { reason: 'you can\'t work weekends: no "not available" option' };
  if (day === 'weekend' && wp.shifts.length && !wp.shifts.includes('weekend') && !times.length) return { reason: 'weekends aren\'t in your work pattern: the user\'s to answer' };
  if (!times.length) return { reason: 'which times of day you can work isn\'t in work_pattern.shifts (day, evening, night)' };
  const fit = meant.filter((x) => x.m && (times as string[]).includes(x.m)).map((x) => x.o);
  const any = meant.find((x) => x.m === 'any')?.o;
  if (type === 'checkbox') return fit.length ? { value: fit.join(' | '), reason: 'tick each: the shifts you can work (work_pattern)' } : { reason: 'no option names your shifts' };
  if (times.length === 3 && any) return { value: any, reason: 'any time: you can work days, evenings and nights (work_pattern)' };
  if (fit.length === 1) return { value: fit[0], reason: 'your shift (work_pattern)' };
  return { reason: fit.length ? 'several of your shifts fit: the user picks one' : 'no option names your shifts' };
}
export type Plan =
  | { mode: 'fill'; role: string; items: PlanItem[]; quick_apply?: { used: number; cap: number } }
  | { mode: 'copy'; role: string; reason: string; answers: { label: string; text: string }[] };

/** The per-role answer for a label: an exact label match, else the longest saved label (8+ chars) the label contains. */
export function answerFor(label: string, answers: Record<string, string>): string | undefined {
  const l = norm(label);
  const entries = Object.entries(answers).map(([k, v]) => [norm(k), v] as const);
  const exact = entries.find(([k]) => k === l);
  if (exact) return exact[1];
  return entries.filter(([k]) => k.length >= 8 && l.includes(k)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
}

const CHOICE = new Set(['select', 'radio', 'checkbox', 'combobox', 'buttons']);
const BUTTON = new Set(['submit', 'button', 'reset', 'image']);
const PASSWORD = /password|passcode|\bpin\b|one[- ]time code|verification code/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile|not a robot|i'?m human/i;
const ACTION_WORDS = /^(submit|send|apply|review|confirm|finish|done|next|continue)\b/i;

/** A date from career.md (YYYY or YYYY-MM) as a field of this type wants it, or null when it can't be exact. */
function dateFor(v: string | undefined, type: string): string | null {
  if (!v) return null;
  if (type === 'month') return /^\d{4}-\d{2}$/.test(v) ? v : null;
  if (type === 'date') return null; // a full date: the day isn't in the notes
  if (type === 'number') return /^\d{4}/.test(v) ? v.slice(0, 4) : null;
  return v;
}

export function fillPlan(fields: PageField[], answers: Record<string, string>, profile: Profile, o: PlanContext = {}): PlanItem[] {
  const pf = profileFields(profile);
  const entries = (g: Group) => entriesFor(g, o.career ?? null, profile);
  // Blocks already on the page per group: the most entries its fields name.
  const present = new Map<Group, number>();
  for (const f of fields) {
    const b = f && !BUTTON.has(String(f.type ?? '').toLowerCase()) ? blockField(String(f.label ?? ''), f) : null;
    if (b) present.set(b.group, Math.max(present.get(b.group) ?? 0, b.index + 1));
  }
  let adds = 0;
  return fields.map((f): PlanItem => {
    const label = String(f?.label ?? '').replace(/\s+/g, ' ').trim();
    const base = { label, required: !!f?.required };
    const type = String(f?.type ?? 'text').toLowerCase();
    if ((BUTTON.has(type) || type === 'link') && isAddButton(label) && !ACTION_WORDS.test(label)) {
      const g = f.group ?? groupOf(label);
      if (!g) return { ...base, action: 'skip', reason: 'an "add" button for something the notes don\'t list' };
      const need = entries(g).length - (present.get(g) ?? 1);
      const times = Math.max(0, Math.min(need, MAX_ADDS - adds));
      if (!times) return { ...base, action: 'skip', reason: need > 0 ? `at most ${MAX_ADDS} added blocks a page` : `every ${g === 'reference' ? 'referee' : g === 'education' ? 'school' : 'job'} in your notes has a block` };
      adds += times;
      present.set(g, (present.get(g) ?? 1) + times);
      return { ...base, action: 'add', times, value: `${times} more`, reason: `press it ${times} time${times === 1 ? '' : 's'}, then read the page again and plan the new fields` };
    }
    if (BUTTON.has(type) || (type === 'link' && ACTION_WORDS.test(label))) return { ...base, action: 'skip', reason: 'a button: Claude presses Next only between pages of questions, never Submit or Review' };
    if (type === 'password' || PASSWORD.test(label)) return { ...base, action: 'skip', reason: 'password or code: only the user types it' };
    if (type === 'captcha' || CAPTCHA.test(label)) return { ...base, action: 'skip', reason: 'CAPTCHA: only the user solves it' };
    // D32: ID, bank and tax numbers, whatever the notes or the role's answers hold.
    if (classOf(label) === 'never_fill') return { ...base, action: 'skip', reason: NEVER_FILL_REASON };
    if (type === 'file') {
      if (/autofill|auto-fill|parse/i.test(label)) return { ...base, action: 'skip', reason: 'resume-parsing uploader: it would overwrite the answers' };
      if (isLetterLabel(label)) return o.letter ? { ...base, action: 'upload', value: 'cover letter PDF', reason: 'the user attaches it with the upload button' } : { ...base, action: 'skip', reason: 'cover letter or statement: crewdeck jobs letter makes a cited one' };
      return /resume|\bcv\b|curriculum|curriculo|lebenslauf/i.test(label)
        ? { ...base, action: 'upload', value: 'tailored resume PDF', reason: 'the user attaches it with the upload button' }
        : { ...base, action: 'skip', reason: /cover/i.test(label) ? 'cover letter (optional)' : 'file upload' };
    }
    const raised = f.sensitive === true;
    // A field in a repeated block (a job, a school, a referee): its entry from the notes, never the user's own values
    // (a referee's "Name" is not the user's name); referees fill only these.
    const block = blockField(label, f);
    if (block) {
      const e = entries(block.group)[block.index];
      const who = block.group === 'reference' ? `referee ${block.index + 1}` : block.group === 'education' ? `school ${block.index + 1}` : `job ${block.index + 1}`;
      if (!e) {
        // A reference question the user answered on the page themselves (no referees in the notes).
        const own = f.group ? undefined : answerFor(label, answers);
        return own ? { ...base, action: 'fill', value: own } : { ...base, action: 'skip', reason: `no ${who} in your notes${block.group === 'reference' ? ' (me/profile.md → references: ask them first)' : ''}` };
      }
      const raw = block.part === 'start' || block.part === 'end' ? dateFor(e[block.part], type) : e[block.part];
      if (!raw) return { ...base, action: 'skip', reason: block.part === 'end' && !e.end && block.group === 'employment' ? `${who} goes on: leave it, or tick "current" if the form has it` : `${who} has no ${block.part.replace('_', ' ')}${block.part === 'start' || block.part === 'end' ? ' as this field wants it (YYYY-MM in me/career.md)' : ''}` };
      if (CHOICE.has(type)) {
        const opt = (f.options ?? []).map((x) => String(x).trim()).find((x) => norm(x) === norm(raw));
        return opt ? { ...base, action: type === 'select' || type === 'combobox' ? 'select' : 'choose', value: opt } : { ...base, action: 'skip', reason: `no option matches "${raw}"` };
      }
      return { ...base, action: 'fill', value: raw, reason: block.group === 'reference' ? `${who} from me/profile.md: another person's details (ask them first)` : `${who} from your notes` };
    }
    let value = answerFor(label, answers);
    // An availability grid: from work_pattern, only what the user listed.
    if (value === undefined && (CHOICE.has(type) || type === 'checkbox')) {
      const av = availabilityAnswer(label, type, (f.options ?? []).map((x) => String(x).trim()).filter(Boolean), o.workPattern);
      if (av) return av.value ? { ...base, action: type === 'select' || type === 'combobox' ? 'select' : 'choose', value: av.value, reason: av.reason } : { ...base, action: 'skip', reason: av.reason };
    }
    if (value === undefined) {
      const p = profileAnswer(pf, label, raised);
      if (!p && (raised || SENSITIVE.test(label))) return { ...base, action: 'skip', reason: 'sensitive (pay, visa, personal details, EEO…): the user\'s to answer' };
      value = p?.value;
    }
    if (value === undefined || value === '') return { ...base, action: 'skip', reason: f?.required ? 'required, no answer yet' : 'optional, left empty' };
    if (CHOICE.has(type)) {
      const opts = (f.options ?? []).map((o) => String(o).trim()).filter(Boolean);
      if (type === 'combobox' && !opts.length) return { ...base, action: 'select', value, reason: 'type it, then pick the suggestion that matches exactly' };
      const opt = opts.find((o) => norm(o) === norm(value!)) ?? opts.find((o) => norm(o).startsWith(norm(value!)));
      if (!opt) return { ...base, action: 'skip', reason: `no option matches "${value}"` };
      return { ...base, action: type === 'select' || type === 'combobox' ? 'select' : 'choose', value: opt };
    }
    return { ...base, action: 'fill', value };
  });
}

/** Easy Apply forms planned today (each role counts once a day, in the user's time zone). */
export function quickAppliesToday(ctx: Ctx): string[] {
  const [start, end] = todayBounds(ctx);
  return (ctx.db.prepare(`select distinct role_id from events where kind='quick_apply' and at >= ? and at < ?`).all(start, end) as any[]).map((r) => r.role_id);
}

/**
 * The plan for a role's live form. Copy mode instead of filling when the site is copy-only (built in or the user's
 * profile `copy_only_hosts`), or when it is LinkedIn and Easy Apply filling is off or today's cap is used.
 */
export function planForRole(ctx: Ctx, roleId: string, fields: PageField[], pageUrl?: string): Plan {
  if (!Array.isArray(fields)) throw new Error('the fields file must hold a JSON list of { label, type, options?, required? }');
  const r = getRole(ctx.db, roleId);
  const notes = notesOf(ctx);
  const answered = currentAnswers(ctx.db, roleId).filter((a) => a.text && a.status !== 'first_time');
  const copy = (reason: string): Plan => ({ mode: 'copy', role: roleId, reason, answers: answered.map((a) => ({ label: a.label, text: a.text! })) });
  const urls = [r.apply_url, r.url, pageUrl].filter(Boolean) as string[];
  const page = pageUrl ?? r.apply_url ?? r.url;
  const host = urls.map((u) => copyOnlyHost(u, notes.profile.data.copy_only_hosts)).find(Boolean);
  if (host) return copy(`${host} doesn't allow automated filling: copy these answers into the form yourself`);
  let quick: { used: number; cap: number } | undefined;
  if (isLinkedinHost(hostOf(page))) {
    const cap = ctx.features.easy_apply ? ctx.features.daily_quick_apply : 0;
    if (!ctx.features.easy_apply || cap <= 0) return copy('Easy Apply filling is off (Jobs → Settings): copy these answers into the form yourself');
    const today = quickAppliesToday(ctx);
    if (!today.includes(roleId)) {
      if (today.length >= cap) return copy(`today's Easy Apply limit (${cap}) is used: copy these answers, or continue tomorrow`);
      addEvent(ctx.db, roleId, 'quick_apply', '', nowIso(ctx));
      today.push(roleId);
    }
    quick = { used: today.length, cap };
  }
  const answers = Object.fromEntries(answered.map((a) => [a.label, a.text!]));
  const items = fillPlan(fields, answers, notes.profile.data, { career: notes.career.data, letter: existsSync(letterPath(ctx, roleId, notes)), workPattern: notes.search.data.work_pattern });
  return { mode: 'fill', role: roleId, items, ...(quick ? { quick_apply: quick } : {}) };
}
