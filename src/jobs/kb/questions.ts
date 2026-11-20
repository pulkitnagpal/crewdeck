// The question index: every wording of a question (per company) points at one canonical question, so an answer the
// user gave once is found again on the next form; and the per-role fields read from an application form.
import type { Db } from '../db.ts';
import { tx } from '../db.ts';
import type { Profile } from '../schema.ts';
import { SENSITIVE, norm, profileFields } from '../fields.ts';
import { classOf, labelKey } from '../form-terms.ts';

export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'combobox' | 'file';
/** A question read from a form (headless in P2b, or by Claude in the pane). */
export type FormQuestion = {
  label: string; kind: FieldKind | string; required?: boolean; options?: string[]; char_limit?: number; section?: string;
  /** Claude raised it (D32): stricter than the words alone; never lowers what the words say. */ sensitive?: boolean;
};
export type QuestionKind = 'contact' | 'logistics' | 'numeric' | 'choice' | 'narrative' | 'sensitive';
export const QUESTION_KINDS: readonly QuestionKind[] = ['contact', 'logistics', 'numeric', 'choice', 'narrative', 'sensitive'];

/** A canonical key from a label: snake_case, starting with a letter (memory keys must), at most 60 characters. */
export function slugKey(label: string): string {
  const s = norm(label).normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 58).replace(/_+$/, '');
  if (!s) return 'question';
  return /^[a-z]/.test(s) ? s : `q_${s}`;
}

const CONTACT = /^(legal |preferred )?(first |last |full |given |family )?name$|^surname$|e-?mail|phone|mobile|linkedin|github|website|portfolio/;

/** What kind of question a label is: decides whether a remembered answer is reused as is or adapted per company. */
export function kbKind(q: FormQuestion, profile: Profile): QuestionKind {
  const l = labelKey(q.label);
  if (q.sensitive === true || SENSITIVE.test(q.label)) return 'sensitive';
  if (profileFields(profile, { withEmpty: true }).some((f) => !f.exact && f.re.test(l))) return CONTACT.test(l) ? 'contact' : 'logistics';
  if (['radio', 'select', 'checkbox', 'combobox'].includes(String(q.kind))) return 'choice';
  if (/\b(years|how many|number of)\b/.test(l) && q.kind !== 'textarea') return 'numeric';
  return 'narrative';
}

/** The canonical question for a wording (same wording = same question), recording this company's wording. */
export function ensureQuestion(db: Db, label: string, kind: QuestionKind = 'narrative', company?: string): number {
  return tx(db, () => {
    const same = db.prepare('select question_id from question_wordings where lower(text)=lower(?) order by id limit 1').get(label) as any;
    if (same) {
      db.prepare('insert or ignore into question_wordings(question_id, text, company) values (?,?,?)').run(same.question_id, label, company ?? null);
      return Number(same.question_id);
    }
    const base = slugKey(label);
    let key = base;
    // A different question that slugs the same (rare): keep both apart.
    for (let n = 2; db.prepare('select 1 from kb_questions where canonical_key=?').get(key); n++) key = `${base.slice(0, 55)}_${n}`;
    const id = Number(db.prepare('insert into kb_questions(canonical_key, kind, text) values (?,?,?)').run(key, kind, label).lastInsertRowid);
    db.prepare('insert or ignore into question_wordings(question_id, text, company) values (?,?,?)').run(id, label, company ?? null);
    return id;
  });
}

export function ensureField(db: Db, roleId: string, label: string, ord: number, questionId: number, kind: QuestionKind = 'narrative'): number {
  db.prepare('insert or ignore into form_fields(role_id, ord, label, kind, question_id) values (?,?,?,?,?)').run(roleId, ord, label, kind, questionId);
  return Number((db.prepare('select id from form_fields where role_id=? and label=?').get(roleId, label) as any).id);
}

/** Validate questions from a file or a reader: labels and kinds as text, options as a list. */
export function cleanQuestions(raw: unknown): FormQuestion[] {
  if (!Array.isArray(raw)) throw new Error('the fields file must hold a JSON list of { label, kind, required?, options? }');
  return raw.map((f: any, i) => {
    if (!f || typeof f !== 'object') throw new Error(`field ${i + 1}: not an object`);
    const label = String(f.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const kind = String(f.kind ?? f.type ?? 'text').toLowerCase();
    const options = Array.isArray(f.options) ? f.options.map((o: unknown) => String(o).trim()).filter(Boolean).slice(0, 200) : [];
    return { label, kind, required: !!f.required, options, char_limit: Number.isInteger(f.char_limit) && f.char_limit > 0 ? f.char_limit : undefined, section: typeof f.section === 'string' ? f.section.slice(0, 200) : undefined, ...(f.sensitive === true ? { sensitive: true } : {}) };
  });
}

/**
 * Store the questions read from a role's form. A re-read drops questions that are no longer on the form. ID, bank and
 * tax numbers (never_fill, D32) are never stored: the user types them into the form; the fill plan skips them.
 */
export function storeFormFields(db: Db, roleId: string, profile: Profile, fields: FormQuestion[]) {
  const role = db.prepare('select c.name company from roles r join companies c on c.id=r.company_id where r.id=?').get(roleId) as any;
  if (!role) throw new Error(`no role ${roleId}`);
  const keep = fields.filter((f) => f.kind !== 'file' && f.label.trim() !== '' && classOf(f.label) !== 'never_fill');
  const labels = new Set(keep.map((f) => f.label));
  tx(db, () => {
    for (const old of db.prepare('select id, label from form_fields where role_id=?').all(roleId) as any[]) {
      if (labels.has(old.label)) continue;
      db.prepare('delete from corrections where answer_id in (select id from answers where form_field_id=?)').run(old.id);
      db.prepare('delete from answers where form_field_id=?').run(old.id);
      db.prepare('delete from form_fields where id=?').run(old.id);
    }
    keep.forEach((f, ord) => {
      const kind = kbKind(f, profile);
      const qid = ensureQuestion(db, f.label, kind, role.company);
      db.prepare(`insert into form_fields(role_id, ord, section, label, kind, required, options_json, char_limit, question_id) values (?,?,?,?,?,?,?,?,?)
          on conflict(role_id, label) do update set ord=excluded.ord, section=excluded.section, kind=excluded.kind, required=excluded.required,
          options_json=excluded.options_json, char_limit=excluded.char_limit`)
        .run(roleId, ord, f.section ?? null, f.label, kind, f.required ? 1 : 0, JSON.stringify(f.options ?? []), f.char_limit ?? null, qid);
    });
  });
  return keep.length;
}
