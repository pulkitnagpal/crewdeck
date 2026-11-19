// View models for the Jobs page (P3 renders them): Today (the queue and one role's answers with their sources),
// Applications, and What Claude knows (Profile, Career, Search, Memory, Answers, each pointing at its note). Money uses
// the user's pay.currency/pay.locale, dates their schedule.timezone; "applied today" is a local day, computed here.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { letterPath } from './letter-path.ts';
import { type Ctx, notesOf, todayBounds, tzOf } from './ctx.ts';
import type { Db } from './db.ts';
import { type JobNotes, NOTES } from './notes.ts';
import type { Career, MemoryItem, Profile } from './schema.ts';
import { copyOnlyHost, hostOf, isLinkedinHost, profileValues } from './fields.ts';
import { currentAnswers } from './kb/ops.ts';
import { targetsOf } from './titles.ts';
import { isActive } from './memory.ts';

const PERIOD: Record<string, string> = { year: 'a year', month: 'a month', week: 'a week', day: 'a day', hour: 'an hour' };

/** An amount in the user's currency and locale ("55.000 €", "$42.50"). */
export function money(n: number, currency: string, locale?: string): string {
  const digits = Math.abs(n) < 1000 && !Number.isInteger(n) ? 2 : 0;
  try { return new Intl.NumberFormat(locale || undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); }
  catch { return `${Math.round(n)} ${currency}`; }
}

/** A role's pay as the user reads it: the converted range when known, else the posting's words. */
export function payLine(r: { pay_min?: number | null; pay_max?: number | null; pay_currency?: string | null; pay_period?: string | null; pay_text?: string | null }, locale?: string): string {
  if (r.pay_currency && (r.pay_min != null || r.pay_max != null)) {
    const lo = r.pay_min != null ? money(r.pay_min, r.pay_currency, locale) : null, hi = r.pay_max != null ? money(r.pay_max, r.pay_currency, locale) : null;
    const range = lo && hi && lo !== hi ? `${lo}–${hi}` : lo && !hi ? `from ${lo}` : !lo && hi ? `up to ${hi}` : (lo ?? hi)!;
    return `${range}${r.pay_period ? ` ${PERIOD[r.pay_period] ?? ''}` : ''}`.trim();
  }
  return r.pay_text || 'pay not listed';
}

/** "17 Nov" for an instant, in the user's zone. */
export const shortDay = (iso: string, tz: string, locale?: string) => new Date(iso).toLocaleDateString(locale || 'en-GB', { day: 'numeric', month: 'short', timeZone: tz });
/** "17 Nov" for a local date (YYYY-MM-DD) as written in a note. */
export const noteDay = (day: string, locale?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00Z`).toLocaleDateString(locale || 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : day);

/**
 * The tailored resume's file name from me/career.md (placeholders from me/profile.md), safe on every file system and in
 * an upload dialog: no path separators, control or reserved characters, no leading dots, at most 120 characters,
 * always ending in .pdf.
 */
export function resumeFileName(career: Career, profile: Profile): string {
  const id = profile.identity;
  const v: Record<string, string> = { first_name: id.first_name, last_name: id.last_name, preferred_name: id.preferred_name || id.first_name };
  const name = career.resume.file_name.replace(/\{(first_name|last_name|preferred_name)\}/g, (_, k) => v[k] ?? '')
    .normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/(\.pdf)+$/i, '').replace(/^[.\s-]+/, '').replace(/[.\s]+$/, '');
  if (!name) return 'Resume.pdf';
  return `${name.slice(0, 116).trim()}.pdf`;
}
export const resumePath = (ctx: Ctx, roleId: string, notes: Pick<JobNotes, 'career' | 'profile'>) => join(ctx.home, 'out', roleId, resumeFileName(notes.career.data, notes.profile.data));

/** Where each answer came from, in plain words. */
export function sourceLine(ids: string[], memory: MemoryItem[] = [], locale?: string): string {
  if (!ids.length) return '';
  const parts: string[] = [];
  const resume = ids.filter((i) => !i.startsWith('profile:') && !/^m-\d+$/.test(i) && i !== 'posting');
  if (resume.length) parts.push(`your resume (${resume.join(', ')})`);
  for (const id of ids.filter((i) => /^m-\d+$/.test(i))) {
    const m = memory.find((x) => x.id === id);
    parts.push(`your words${m?.created ? `, ${noteDay(m.created, locale)}` : ''}`);
  }
  if (ids.some((i) => i.startsWith('profile:'))) parts.push('your profile');
  if (ids.includes('posting')) parts.push('the posting');
  return `Sources: ${[...new Set(parts)].join(', ')}`;
}

/** Apply is enabled once the form was read, every required question has an answer, and it isn't applied yet. */
export function canApprove(db: Db, roleId: string): boolean {
  const r = db.prepare('select status from roles where id=?').get(roleId) as any;
  if (!r || r.status === 'applied') return false;
  const answers = currentAnswers(db, roleId);
  return answers.length > 0 && !answers.some((a) => a.required && (a.status === 'first_time' || !a.text));
}

/** Every answer as text to copy (copy-only sites, or LinkedIn with Easy Apply off). */
export function copyModel(db: Db, roleId: string) {
  return { mode: 'copy' as const, answers: currentAnswers(db, roleId).filter((a) => a.text && a.status !== 'first_time').map((a) => ({ label: a.label, text: a.text! })) };
}

/** Roles applied to within today's local bounds (the status event's time, never an SQL offset). */
export function appliedToday(ctx: Ctx, notes?: Pick<JobNotes, 'search'>): Set<string> {
  const [start, end] = todayBounds(ctx, notes);
  return new Set((ctx.db.prepare(`select distinct e.role_id from events e join roles r on r.id=e.role_id
      where e.kind='status' and e.detail like 'applied%' and e.at >= ? and e.at < ? and r.status='applied'`).all(start, end) as any[]).map((r) => r.role_id));
}

const appliedAt = (db: Db, id: string) => (db.prepare(`select at from events where role_id=? and kind='status' and detail like 'applied%' order by id desc limit 1`).get(id) as any)?.at as string | undefined;

function chipFor(db: Db, r: any, tz: string, locale?: string) {
  if (r.status === 'applied') return { kind: 'applied', text: 'Applied' };
  if (!db.prepare('select 1 from form_fields where role_id=? limit 1').get(r.id)) return { kind: 'muted', text: 'Preparing' };
  const first = currentAnswers(db, r.id).filter((a) => a.status === 'first_time' && a.required).length;
  if (first) return { kind: 'first', text: `${first} first-time question${first > 1 ? 's' : ''}` };
  const deadline = (db.prepare(`select detail from events where role_id=? and kind='deadline' order by id desc`).get(r.id) as any)?.detail;
  if (deadline && !Number.isNaN(Date.parse(deadline))) return { kind: 'warn', text: `Closes ${shortDay(deadline, tz, locale)}` };
  return { kind: 'ready', text: 'Ready to apply' };
}

/** How Apply works for a role: filled by Claude, or answers to copy (and why). */
export type ApplyMode = { mode: 'fill' | 'copy' | 'walk_in'; reason?: string; method?: string | null; note?: string | null };
/** What each apply method means on the page (D35): an email, a document or a chat assistant are filled by the user from the answers. */
const METHOD_COPY: Record<string, string> = {
  email: 'This employer takes applications by email: copy these answers into your email (Claude only drafts emails when you switched that on)',
  document: 'This application is a document to fill in: copy these answers into it',
  chatbot: 'This employer applies through a chat assistant: copy these answers into the chat',
};

export function applyMode(ctx: Ctx, r: { url: string; apply_url?: string | null; apply_method?: string | null; apply_note?: string | null }, profile: Profile): ApplyMode {
  const method = r.apply_method ?? null, note = r.apply_note ?? null;
  if (method === 'walk_in') return { mode: 'walk_in', reason: 'Apply in person', method, note };
  if (method && METHOD_COPY[method]) return { mode: 'copy', reason: METHOD_COPY[method], method, note };
  const urls = [r.apply_url, r.url].filter(Boolean) as string[];
  const host = urls.map((u) => copyOnlyHost(u, profile.copy_only_hosts)).find(Boolean);
  if (host) return { mode: 'copy', reason: `${host} doesn't allow automated filling` };
  if (isLinkedinHost(hostOf(r.apply_url ?? r.url))) {
    if (!ctx.features.easy_apply) return { mode: 'copy', reason: 'Easy Apply filling is off (Jobs → Settings)' };
    // On, but allowed 0 forms a day: say so, rather than "off" (review C11).
    if (!(ctx.features.daily_quick_apply > 0)) return { mode: 'copy', reason: 'Easy Apply filling is on, but its forms per day is 0 (Jobs → Settings)' };
  }
  return { mode: 'fill', ...(method ? { method, note } : {}) };
}

/** Today: what still needs the user, plus what they applied to today (so "I submitted it" shows its result). */
export function todayView(ctx: Ctx, selected?: string) {
  const notes = notesOf(ctx);
  const tz = tzOf(ctx, notes), locale = notes.search.data.pay?.locale || undefined;
  const today = appliedToday(ctx, notes);
  const roles = (ctx.db.prepare(`select r.*, c.name company from roles r join companies c on c.id=r.company_id
      where r.status in ('picked','prepared','applied') order by (r.status='applied'), r.picked_on desc, r.score desc, r.id`).all() as any[])
    .filter((r) => r.status !== 'applied' || today.has(r.id));
  const queue = roles.map((r) => ({ id: r.id, company: r.company, title: r.title, chip: chipFor(ctx.db, r, tz, locale) }));
  const r = roles.find((x) => x.id === selected) ?? roles[0];
  if (!r) return { queue, selected: null, detail: null };
  const memory = notes.memory.data.items;
  const answers = currentAnswers(ctx.db, r.id);
  const rank = (a: { status: string; required: boolean }) => (a.status === 'first_time' ? (a.required ? 0 : 2) : 1);
  const rows = answers.map((a) => ({ ...a, source: sourceLine(a.sources, memory, locale) })).sort((a, b) => rank(a) - rank(b) || a.field_id - b.field_id);
  const why = (ctx.db.prepare(`select detail from events where role_id=? and kind='why' order by id desc`).get(r.id) as any)?.detail ?? '';
  const pdf = resumePath(ctx, r.id, notes);
  const outreach = (ctx.db.prepare(`select m.channel, m.body, m.status, c.name, c.title from messages m left join contacts c on c.id=m.contact_id where m.role_id=? order by m.id`).all(r.id) as any[])
    .map((m) => ({ channel: m.channel, status: m.status, who: [m.name, m.title].filter(Boolean).join(', '), summary: m.channel === 'email' ? (m.body.split('\n')[0] ?? '').replace(/^Subject:\s*/i, '') : m.body.slice(0, 120) }));
  const questions = ctx.db.prepare(`select id, text from questions where role_id=? and answer is null order by id`).all(r.id) as any[];
  return {
    queue, selected: r.id,
    detail: {
      id: r.id, company: r.company, title: r.title, url: r.apply_url ?? r.url, status: r.status,
      meta: [r.location, payLine(r, locale)].filter(Boolean).join(' · '), why,
      apply: applyMode(ctx, r, notes.profile.data), approvable: canApprove(ctx.db, r.id),
      counts: { total: answers.length, known: answers.filter((a) => a.status === 'approved').length, drafted: answers.filter((a) => a.status === 'drafted').length, first: answers.filter((a) => a.status === 'first_time' && a.required).length },
      rows, resume: existsSync(pdf) ? { pdf, note: 'Tailored for this role' } : null, outreach,
      resume_word: notes.career.data.resume.word, letter: existsSync(letterPath(ctx, r.id, notes)) ? basename(letterPath(ctx, r.id, notes)) : null,
      questions: questions.map((q) => ({ id: Number(q.id), text: q.text })),
      applied: r.status === 'applied' ? shortDay(appliedAt(ctx.db, r.id) ?? r.updated_at, tz, locale) : null,
    },
  };
}

/** Applications: everything picked, in progress or applied, newest first. */
export function applicationsView(ctx: Ctx) {
  const notes = notesOf(ctx);
  const tz = tzOf(ctx, notes), locale = notes.search.data.pay?.locale || undefined;
  const rows = (ctx.db.prepare(`select r.id, r.title, r.status, r.updated_at, c.name company from roles r join companies c on c.id=r.company_id
      where r.status in ('picked','prepared','applied') order by (r.status<>'applied'), r.updated_at desc, r.id`).all() as any[]).map((r) => {
    const msgs = ctx.db.prepare('select channel, status from messages where role_id=? order by id').all(r.id) as any[];
    const at = r.status === 'applied' ? appliedAt(ctx.db, r.id) : undefined;
    return {
      id: r.id, company: r.company, title: r.title,
      status: r.status === 'applied' ? 'Applied' : r.status === 'prepared' ? 'Ready to review' : 'Preparing',
      applied: at ? shortDay(at, tz, locale) : '—',
      outreach: msgs.map((m) => `${m.channel === 'email' ? 'Email' : 'LinkedIn'}: ${m.status}`).join(' · ') || '—',
      next: r.status === 'applied' ? 'Wait for a reply' : 'Review in Today',
    };
  });
  return { rows };
}

export const KNOWLEDGE_TABS = ['profile', 'career', 'search', 'memory', 'answers'] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];
type Item = { id: string; title: string; text: string; source: string; used: string; quote?: string };

const usedCount = (db: Db, id: string) => Number((db.prepare(`select count(*) n from answers a where exists (select 1 from json_each(a.fact_ids_json) j where j.value = ?)`).get(id) as any).n);
const used = (db: Db, id: string) => { const n = usedCount(db, id); return n ? `used ${n} time${n > 1 ? 's' : ''}` : 'not used yet'; };
const words = (k: string) => k.replace(/_/g, ' ');

function profileItems(db: Db, p: Profile): Item[] {
  return Object.entries(profileValues(p)).map(([k, v]) => ({ id: `profile:${k}`, title: words(k), text: v, source: 'your profile', used: used(db, `profile:${k}`) }));
}

function careerItems(db: Db, c: Career): Item[] {
  const title = (id: string) => { const s = c.sections.find((x) => x.id === id.split('.')[0]); return s ? [s.title, s.org].filter(Boolean).join(', ') || s.id : id.split('.')[0]; };
  const facts = c.facts.map((f) => ({ id: f.id, title: title(f.id), text: f.text.replace(/\*\*/g, ''), source: 'your resume', used: used(db, f.id) }));
  return c.skills.length ? [...facts, { id: 'skills', title: 'skills', text: c.skills.join(', '), source: 'your resume', used: '' }] : facts;
}

function searchItems(n: JobNotes): Item[] {
  const s = n.search.data;
  const row = (id: string, title: string, text: string): Item => ({ id: `search:${id}`, title, text: text || '(not set)', source: 'your search note', used: '' });
  const items = [
    row('roles.titles', 'titles', targetsOf(s).map((t) => `${t.legacy ? '' : `${t.name}: `}${t.titles.join(', ')}`).join('; ')),
    row('workplace', 'workplace', s.workplace.join(', ') || 'any'),
    row('places', 'places', [s.places.onsite.length ? `on-site/hybrid: ${s.places.onsite.join(', ')}` : '', s.places.remote_from.length ? `remote from: ${s.places.remote_from.join(', ')}` : '', s.places.relocate_to.length ? `would move to: ${s.places.relocate_to.join(', ')}` : '', s.places.authorized_in.length ? `may work without sponsorship in: ${s.places.authorized_in.join(', ')}` : ''].filter(Boolean).join('; ')),
    row('pay', 'pay', s.pay ? `${s.pay.floor > 0 ? `floor ${money(s.pay.floor, s.pay.currency, s.pay.locale || undefined)} ${PERIOD[s.pay.period]}` : `in ${s.pay.currency}, no floor`}` : ''),
    row('languages', 'languages', s.languages.map((l) => `${l.name}${l.level ? ` (${l.level})` : ''}`).join(', ')),
    row('employment_types', 'employment', s.employment_types.join(', ')),
    row('work_pattern', 'how you work', [s.work_pattern.shifts.length ? `shifts: ${s.work_pattern.shifts.join(', ')}` : '', s.work_pattern.shifts_avoid.length ? `not: ${s.work_pattern.shifts_avoid.join(', ')}` : '', s.work_pattern.hours_per_week.min !== null || s.work_pattern.hours_per_week.max !== null ? `${s.work_pattern.hours_per_week.min ?? 0}–${s.work_pattern.hours_per_week.max ?? 'any'} hours a week` : '', s.work_pattern.term_time_only ? 'term-time only' : ''].filter(Boolean).join('; ')),
    row('licenses', 'licences', s.licenses.join(', ')),
    row('exclude', 'excluded', [s.roles.exclude_title_words.length ? `title words: ${s.roles.exclude_title_words.join(', ')}` : '', s.exclude.companies.length ? `companies: ${s.exclude.companies.join(', ')}` : '', s.exclude.industries.length ? `industries: ${s.exclude.industries.join(', ')}` : ''].filter(Boolean).join('; ')),
    row('schedule', 'daily', `${s.schedule.daily_picks} picks a day; ${s.schedule.cooldown_days}-day cooldown after applying${s.schedule.cooldown_scope === 'role' ? ' (the same title only)' : ''}${s.schedule.per_company > 1 ? `; up to ${s.schedule.per_company} roles per company` : ''}; time zone ${s.schedule.timezone || 'system'}`),
  ];
  if (s.judge_notes.trim()) items.push(row('judge_notes', 'notes for the judge', s.judge_notes.trim()));
  return items;
}

function memoryItems(db: Db, items: MemoryItem[], locale?: string): Item[] {
  return items.filter(isActive).map((m) => ({
    id: m.id, title: m.key ? `${m.kind}: ${words(m.key)}` : m.kind, text: m.text, quote: m.quote,
    source: `your words, ${noteDay(m.created, locale)}${m.scope === 'company' ? ` · ${m.company} only` : ''}`, used: used(db, m.id),
  }));
}

function answerItems(db: Db): Item[] {
  // The latest approved version of each field's answer.
  return (db.prepare(`select a.id, q.text question, a.text, a.company from answers a join kb_questions q on q.id=a.question_id
      where a.status='approved' and a.text is not null
        and a.version = (select max(version) from answers b where b.form_field_id=a.form_field_id)
      order by a.id desc`).all() as any[]).map((a) => ({ id: `a${a.id}`, title: a.question, text: a.text, source: a.company ?? '', used: '' }));
}

/** What Claude knows, by tab; each tab names the note to open in Notes (answers live in the tracker). */
export function knowledgeView(ctx: Ctx, tab: KnowledgeTab = 'profile') {
  if (!(KNOWLEDGE_TABS as readonly string[]).includes(tab)) throw new Error(`tab must be one of ${KNOWLEDGE_TABS.join(', ')}`);
  const notes = notesOf(ctx);
  const locale = notes.search.data.pay?.locale || undefined;
  const lists: Record<KnowledgeTab, () => Item[]> = {
    profile: () => profileItems(ctx.db, notes.profile.data), career: () => careerItems(ctx.db, notes.career.data), search: () => searchItems(notes),
    memory: () => memoryItems(ctx.db, notes.memory.data.items, locale), answers: () => answerItems(ctx.db),
  };
  const note: Record<KnowledgeTab, string | null> = { profile: NOTES.profile, career: NOTES.career, search: NOTES.search, memory: NOTES.memory, answers: null };
  const counts = Object.fromEntries(KNOWLEDGE_TABS.map((t) => [t, t === tab ? -1 : lists[t]().length])) as Record<KnowledgeTab, number>;
  const items = lists[tab]();
  counts[tab] = items.length;
  return { tab, note: note[tab], notes: note, items, counts };
}

