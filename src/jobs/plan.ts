// The fill plan (design §2.3a step 3): given the fields Claude read on a live application page, exactly what to put in
// each. Per-role answers first, then whole-label profile matches; sensitive questions only from an explicit answer;
// never a guess for a choice with no matching option. The plan never contains a submit or review action: its only
// actions are fill, select, choose, upload and skip, and password, CAPTCHA and button fields are always skipped.
import { type Ctx, notesOf, nowIso, todayBounds } from './ctx.ts';
import { addEvent, getRole } from './db.ts';
import type { Profile } from './schema.ts';
import { SENSITIVE, copyOnlyHost, hostOf, isLinkedinHost, norm, profileAnswer, profileFields } from './fields.ts';
import { currentAnswers } from './kb/ops.ts';

export type PageField = { label: string; type: string; options?: string[]; required?: boolean };
export type PlanAction = 'fill' | 'select' | 'choose' | 'upload' | 'skip';
export const PLAN_ACTIONS: readonly PlanAction[] = ['fill', 'select', 'choose', 'upload', 'skip'];
export type PlanItem = { label: string; action: PlanAction; value?: string; reason?: string; required?: boolean };
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

export function fillPlan(fields: PageField[], answers: Record<string, string>, profile: Profile): PlanItem[] {
  const pf = profileFields(profile);
  return fields.map((f): PlanItem => {
    const label = String(f?.label ?? '').replace(/\s+/g, ' ').trim();
    const base = { label, required: !!f?.required };
    const type = String(f?.type ?? 'text').toLowerCase();
    if (BUTTON.has(type) || (type === 'link' && ACTION_WORDS.test(label))) return { ...base, action: 'skip', reason: 'a button: Claude presses Next only between pages of questions, never Submit or Review' };
    if (type === 'password' || PASSWORD.test(label)) return { ...base, action: 'skip', reason: 'password or code: only the user types it' };
    if (type === 'captcha' || CAPTCHA.test(label)) return { ...base, action: 'skip', reason: 'CAPTCHA: only the user solves it' };
    if (type === 'file') {
      if (/autofill|auto-fill|parse/i.test(label)) return { ...base, action: 'skip', reason: 'resume-parsing uploader: it would overwrite the answers' };
      return /resume|\bcv\b|curriculum|lebenslauf/i.test(label)
        ? { ...base, action: 'upload', value: 'tailored resume PDF', reason: 'the user attaches it with the upload button' }
        : { ...base, action: 'skip', reason: /cover/i.test(label) ? 'cover letter (optional)' : 'file upload' };
    }
    let value = answerFor(label, answers);
    if (value === undefined) {
      const p = profileAnswer(pf, label);
      if (!p && SENSITIVE.test(label)) return { ...base, action: 'skip', reason: 'sensitive (pay, visa, EEO…): the user\'s to answer' };
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
  const items = fillPlan(fields, answers, notes.profile.data);
  return { mode: 'fill', role: roleId, items, ...(quick ? { quick_apply: quick } : {}) };
}
