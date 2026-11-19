// Answers (in the tracker) and what Claude learned (in the user's jobs/memory.md), working together: each form field's
// answer has versions; the user's own answers are remembered in their words and reused on every later form; their edits
// are never redrafted behind their back; everything can be undone.
import { type Ctx, memoryFile, notesOf, todayOf, nowIso } from '../ctx.ts';
import { type Db, getRole, tx } from '../db.ts';
import { type JobNotes, loadNote } from '../notes.ts';
import { type MemoryInput, activeMemory, isActive, remember as rememberNote, undoRemember } from '../memory.ts';
import type { MemoryItem } from '../schema.ts';
import { type ProfileField, norm, profileAnswer, profileValues } from '../fields.ts';
import { type CiteContext, type Claim, checkAnswer, termsFor } from './cite.ts';
import { classOf } from '../form-terms.ts';

/** D32: never stored, so never answered here. */
const NEVER = 'Crewdeck never stores ID, bank or tax numbers: type it into the form yourself';
import { plainText } from '../text.ts';

export type AnswerStatus = 'first_time' | 'drafted' | 'approved';
export type AnswerView = {
  field_id: number; ref: string; label: string; section: string | null; kind: string | null; required: boolean;
  options: string[]; char_limit: number | null; question_id: number | null; canonical_key: string | null; answer_id: number | null;
  text: string | null; status: AnswerStatus; reason: string | null; sources: string[]; version: number;
};

/** Questions whose answer is about the user and the same for every company: a remembered answer fills them as is. */
export const DIRECT_KINDS = new Set(['choice', 'logistics', 'numeric', 'sensitive', 'contact']);
/** Roles still in play: answers learned now reach their forms. */
const OPEN = ['new', 'bench', 'picked', 'prepared'];

export function currentAnswers(db: Db, roleId: string): AnswerView[] {
  const fields = db.prepare(`select f.*, q.canonical_key from form_fields f left join kb_questions q on q.id=f.question_id where f.role_id=? order by f.ord, f.id`).all(roleId) as any[];
  return fields.map((f, i) => {
    const a = db.prepare('select * from answers where form_field_id=? order by version desc, id desc limit 1').get(f.id) as any;
    return {
      field_id: Number(f.id), ref: `Q${i + 1}`, label: f.label, section: f.section, kind: f.kind, required: !!f.required,
      options: f.options_json ? JSON.parse(f.options_json) : [], char_limit: f.char_limit ?? null, question_id: f.question_id ?? null,
      canonical_key: f.canonical_key ?? null, answer_id: a ? Number(a.id) : null, text: a?.text ?? null, status: a?.status ?? 'first_time',
      reason: a?.reason ?? null, sources: a ? JSON.parse(a.fact_ids_json || '[]') : [], version: a ? Number(a.version) : 0,
    };
  });
}

/** "Q4", or words from the question ("the notice question"). */
export function resolveField(db: Db, roleId: string, question: string): AnswerView {
  const all = currentAnswers(db, roleId);
  const q = String(question ?? '').trim();
  const byRef = /^q(\d+)$/i.exec(q);
  if (byRef) { const f = all[Number(byRef[1]) - 1]; if (f) return f; throw new Error(`no ${q.toUpperCase()} on this form (it has ${all.length} questions)`); }
  const words = norm(q).replace(/\b(the|question|answer|field|for)\b/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  const scored = all.map((f) => ({ f, s: words.filter((w) => norm(f.label).includes(w)).length })).sort((a, b) => b.s - a.s);
  if (!scored.length || scored[0].s === 0) throw new Error(`no question matching "${question}" on this form`);
  return scored[0].f;
}

const nextVersion = (db: Db, fieldId: number) => ((db.prepare('select max(version) v from answers where form_field_id=?').get(fieldId) as any)?.v ?? 0) + 1;

export function insertAnswer(ctx: Ctx, f: Pick<AnswerView, 'field_id' | 'question_id'>, roleId: string, company: string, text: string | null, ids: string[], status: AnswerStatus, reason: string | null = null): number {
  return Number(ctx.db.prepare(`insert into answers(role_id, form_field_id, question_id, company, text, fact_ids_json, status, reason, version, created_at) values (?,?,?,?,?,?,?,?,?,?)`)
    .run(roleId, f.field_id, f.question_id, company, text, JSON.stringify(ids), status, reason, nextVersion(ctx.db, f.field_id), nowIso(ctx)).lastInsertRowid);
}

export const memoryItems = (ctx: Ctx): MemoryItem[] => loadNote(ctx.vault, ctx.home, 'memory').data.items;

/** Everything a citation may point at, for one role. */
export function citeContext(ctx: Ctx, roleId: string, notes: Pick<JobNotes, 'career' | 'profile' | 'memory'> = notesOf(ctx)): CiteContext {
  const r = getRole(ctx.db, roleId);
  const memFacts = notes.memory.data.items;
  return {
    facts: notes.career.data.facts, memory: activeMemory(memFacts, r.company), postingText: plainText(r.description ?? ''),
    profile: profileValues(notes.profile.data), terms: termsFor(notes.career.data.terms.extra),
    lang: r.form_lang ?? null, factsLang: notes.career.data.language || null,
  };
}

/** An option that matches a value (exactly, then by its start), or null. */
export function matchOption(options: string[], value: string): string | null {
  return options.find((o) => norm(o) === norm(value)) ?? options.find((o) => norm(o).startsWith(norm(value))) ?? null;
}

/**
 * What the user already told us for a field, without Claude: a remembered answer for this question (as is when it is
 * about them, or was given for this company), else a profile value (sensitive questions only from an exact standard
 * answer). Choices only with an option that matches.
 */
export function autoAnswer(f: AnswerView, memory: MemoryItem[], pf: ProfileField[], o: { redraft?: boolean } = {}): { text: string; sources: string[] } | null {
  if (classOf(f.label) === 'never_fill') return null;
  const fit = (text: string, sources: string[]) => {
    if (!f.options.length) return { text, sources };
    const opt = matchOption(f.options, text);
    return opt ? { text: opt, sources } : null;
  };
  const mem = f.canonical_key ? [...memory].reverse().find((m) => ['answer', 'preference', 'fact'].includes(m.kind) && m.key === f.canonical_key) : undefined;
  if (mem && !o.redraft && (DIRECT_KINDS.has(f.kind ?? '') || mem.scope === 'company')) {
    const r = fit(mem.text, [mem.id]);
    if (r) return r;
  }
  const p = profileAnswer(pf, f.label, f.kind === 'sensitive');
  if (p) return fit(p.value, [`profile:${p.key}`]);
  return null;
}

/** The user's own corrections are never redrafted behind their back. */
const isUserCorrection = (db: Db, answerId: number | null) => !!answerId && !!db.prepare('select 1 from corrections where answer_id=?').get(answerId);

function logUndo(ctx: Ctx, kind: 'answer' | 'memory', ref: string, created: number[]): number {
  return Number(ctx.db.prepare('insert into undo_log(kind, ref, created_answers_json, at) values (?,?,?,?)').run(kind, ref, JSON.stringify(created), nowIso(ctx)).lastInsertRowid);
}
function addToUndo(ctx: Ctx, undoId: number, ids: number[]) {
  const row = ctx.db.prepare('select created_answers_json c from undo_log where id=?').get(undoId) as any;
  ctx.db.prepare('update undo_log set created_answers_json=? where id=?').run(JSON.stringify([...JSON.parse(row.c), ...ids]), undoId);
}

/** Claude's rewrite of one answer: stored only when every claim passes the citation check. */
export function changeAnswer(ctx: Ctx, i: { role: string; question: string; new_text: string; claims: Claim[]; instruction: string }) {
  const r = getRole(ctx.db, i.role);
  const f = resolveField(ctx.db, i.role, i.question);
  if (classOf(f.label) === 'never_fill') return { ok: false as const, reason: NEVER };
  const text = String(i.new_text ?? '').trim();
  if (!text) return { ok: false as const, reason: 'the answer is empty' };
  if (f.options.length && !matchOption(f.options, text)) return { ok: false as const, reason: `"${f.label}" takes one of: ${f.options.join(' | ')}` };
  const check = checkAnswer({ text, claims: i.claims }, citeContext(ctx, i.role));
  if (!check.ok) return { ok: false as const, reason: check.reason };
  const ids = [...new Set(i.claims.flatMap((c) => c.fact_ids))];
  tx(ctx.db, () => {
    const id = insertAnswer(ctx, f, i.role, r.company, f.options.length ? matchOption(f.options, text)! : text, ids, 'approved');
    ctx.db.prepare('insert into corrections(answer_id, instruction, before, after, at) values (?,?,?,?,?)').run(id, i.instruction, f.text, text, nowIso(ctx));
    logUndo(ctx, 'answer', String(id), [id]);
  });
  return { ok: true as const, answer: resolveField(ctx.db, i.role, f.ref) };
}

/** Open fields asking this question (on roles still in play), only this company's when the item is company-scoped. */
function openFieldsFor(db: Db, key: string, company?: string) {
  return (db.prepare(`select f.role_id, f.id field_id, c.name company from form_fields f
      join kb_questions q on q.id=f.question_id join roles r on r.id=f.role_id join companies c on c.id=r.company_id
      where q.canonical_key=? and r.status in (select value from json_each(?))`).all(key, JSON.stringify(OPEN)) as any[])
    .filter((x) => !company || norm(x.company) === norm(company));
}

/** Written answers on open roles that a key-less style rule re-drafts. */
function openNarrativeFields(db: Db) {
  return db.prepare(`select f.role_id, f.id field_id, c.name company from form_fields f join roles r on r.id=f.role_id
      join companies c on c.id=r.company_id where f.kind='narrative' and r.status in (select value from json_each(?))`).all(JSON.stringify(OPEN)) as any[];
}

/** Put a remembered item to work on forms already read: direct answers fill, written drafts are queued for a redraft. */
function applyMemory(ctx: Ctx, item: MemoryItem): number[] {
  const created: number[] = [];
  if (item.kind === 'avoid' || item.kind === 'company_rule') return created;
  const targets = item.key ? openFieldsFor(ctx.db, item.key, item.scope === 'company' ? item.company : undefined) : item.kind === 'style' ? openNarrativeFields(ctx.db) : [];
  for (const x of targets) {
    const f = currentAnswers(ctx.db, x.role_id).find((a) => a.field_id === Number(x.field_id));
    if (!f) continue;
    const style = item.kind === 'style';
    if (!style && (DIRECT_KINDS.has(f.kind ?? '') || item.scope === 'company')) {
      const text = f.options.length ? matchOption(f.options, item.text) : item.text;
      if (!text || (f.text === text && f.status === 'approved')) continue;
      created.push(insertAnswer(ctx, f, x.role_id, x.company, text, [item.id], 'approved'));
    } else if (f.text && f.status === 'drafted' && !isUserCorrection(ctx.db, f.answer_id)) {
      created.push(insertAnswer(ctx, f, x.role_id, x.company, f.text, f.sources, 'drafted', `redraft:${item.id}`));
    }
    // Empty questions stay first-time; the user's own answers stay as they wrote them.
  }
  return created;
}

/** Remember something in the user's words (jobs/memory.md) and apply it to open forms. Undoable. */
export function remember(ctx: Ctx, input: MemoryInput) {
  const r = rememberNote(memoryFile(ctx), input, todayOf(ctx));
  return tx(ctx.db, () => {
    const created = applyMemory(ctx, r.item);
    const undoId = !r.existing ? logUndo(ctx, 'memory', r.item.id, created) : created.length ? logUndo(ctx, 'answer', `memory:${r.item.id}`, created) : null;
    return { ...r, applied: created.length, undo_id: undoId };
  });
}

/**
 * The user answered a first-time question. Their words are remembered (an `answer` item with their quote): for every
 * company when the question is about them (choices, logistics, numbers, contact), for this company only when it is a
 * written answer (those name the company) or a sensitive one (D32: a salary expectation or a personal detail differs per
 * role and country), unless the user said to use it everywhere. The answer is approved here and on every open form
 * asking it. ID, bank and tax numbers are refused (never stored).
 */
export function answerFirstTime(ctx: Ctx, i: { role: string; question: string; value: string; quote: string; everywhere?: boolean }) {
  const r = getRole(ctx.db, i.role);
  const f = resolveField(ctx.db, i.role, i.question);
  if (classOf(f.label) === 'never_fill') throw new Error(NEVER);
  let value = String(i.value ?? '').trim();
  if (!value) throw new Error('the answer is empty');
  if (f.options.length) {
    const opt = matchOption(f.options, value);
    if (!opt) throw new Error(`"${f.label}" takes one of: ${f.options.join(' | ')}`);
    value = opt;
  }
  const shared = DIRECT_KINDS.has(f.kind ?? '') && (f.kind !== 'sensitive' || i.everywhere === true);
  const key = f.canonical_key ?? undefined;
  const rem = remember(ctx, { kind: 'answer', key, text: value, quote: i.quote, scope: shared ? 'all' : 'company', company: shared ? undefined : r.company });
  const now = currentAnswers(ctx.db, i.role).find((a) => a.field_id === f.field_id)!;
  if (!(now.text === value && now.status === 'approved')) {
    tx(ctx.db, () => {
      const id = insertAnswer(ctx, f, i.role, r.company, value, [rem.item.id], 'approved');
      if (rem.undo_id) addToUndo(ctx, rem.undo_id, [id]); else logUndo(ctx, 'answer', String(id), [id]);
    });
  }
  return { ok: true as const, remembered: rem.item, applied: rem.applied, answer: resolveField(ctx.db, i.role, f.ref) };
}

/** The user edited an answer themselves (Jobs page): their words, approved, remembered, and recorded as a correction. */
export function editAnswer(ctx: Ctx, p: { role: string; field_id: number; text: string }) {
  const f = currentAnswers(ctx.db, p.role).find((a) => a.field_id === p.field_id);
  if (!f) return { ok: false as const, reason: 'no such question' };
  const text = String(p.text ?? '').trim();
  if (!text) return { ok: false as const, reason: 'empty answer' };
  if (text === f.text && f.status === 'approved') return { ok: true as const, unchanged: true };
  answerFirstTime(ctx, { role: p.role, question: f.ref, value: text, quote: text });
  const latest = currentAnswers(ctx.db, p.role).find((a) => a.field_id === p.field_id);
  if (latest?.answer_id) ctx.db.prepare('insert into corrections(answer_id, instruction, before, after, at) values (?,?,?,?,?)').run(latest.answer_id, 'edited by the user', f.text, text, nowIso(ctx));
  return { ok: true as const };
}

/** Undo the latest answer change or memory: its answers go, the memory item is retired and what it replaced returns. */
export function undoLast(ctx: Ctx): { undone: string; fields: { role_id: string; field_id: number }[] } {
  const last = ctx.db.prepare('select * from undo_log order by id desc limit 1').get() as any;
  if (!last) return { undone: 'nothing to undo', fields: [] };
  const fields: { role_id: string; field_id: number }[] = [];
  tx(ctx.db, () => {
    for (const id of JSON.parse(last.created_answers_json || '[]')) {
      ctx.db.prepare('delete from corrections where answer_id=?').run(id);
      const a = ctx.db.prepare('select role_id, form_field_id from answers where id=?').get(id) as any;
      ctx.db.prepare('delete from answers where id=?').run(id);
      if (a) fields.push({ role_id: a.role_id, field_id: Number(a.form_field_id) });
    }
    ctx.db.prepare('delete from undo_log where id=?').run(last.id);
  });
  if (last.kind === 'memory') undoRemember(memoryFile(ctx), last.ref);
  return { undone: last.kind === 'memory' ? `memory ${last.ref}` : `answer change ${last.ref}`, fields };
}

/** Search what Claude knows: career facts, memory (every scope) and approved answers to similar questions. */
export function knowledge(ctx: Ctx, query: string) {
  const notes = notesOf(ctx);
  const q = String(query ?? '').trim().toLowerCase();
  const facts = notes.career.data.facts.filter((f) => f.text.toLowerCase().includes(q) || f.id.includes(q));
  const memory = notes.memory.data.items.filter(isActive).filter((m) => `${m.text} ${m.key ?? ''} ${m.quote} ${m.company ?? ''}`.toLowerCase().includes(q));
  const terms = q.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 12);
  const answers = terms.length ? ctx.db.prepare(`select w.text question, a.text answer, a.company, a.fact_ids_json sources from question_fts
      join question_wordings w on w.id=question_fts.rowid join answers a on a.question_id=w.question_id
      where question_fts match ? and a.status='approved' and a.text is not null group by a.id order by a.id desc limit 20`).all(terms.map((t) => `"${t}"`).join(' OR ')) as any[] : [];
  return { facts, memory, answers: answers.map((a) => ({ question: a.question, answer: a.answer, company: a.company, sources: JSON.parse(a.sources || '[]') })) };
}

