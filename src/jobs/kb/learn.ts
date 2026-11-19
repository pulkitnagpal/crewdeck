// A question met on a live application form (one Prepare didn't see, or a form only readable in the pane) and,
// optionally, its answer. The user's own words are remembered; anything else must pass the citation check; sensitive
// and choice questions are answered only from the user's words. A question the profile or memory already answers is
// approved at once, so it never shows as first-time.
import { type Ctx, notesOf, nowIso } from '../ctx.ts';
import { getRole, tx } from '../db.ts';
import { activeMemory } from '../memory.ts';
import { profileFields } from '../fields.ts';
import { classOf } from '../form-terms.ts';
import { type Claim, checkAnswer } from './cite.ts';
import { ensureField, ensureQuestion, kbKind } from './questions.ts';
import { answerFirstTime, autoAnswer, changeAnswer, citeContext, currentAnswers, insertAnswer } from './ops.ts';

export type LearnInput = { label: string; answer?: string; options?: string[]; quote?: string; claims?: Claim[]; required?: boolean; kind?: string; /** Claude raised it (D32) */ sensitive?: boolean };
export type LearnResult =
  | { ok: true; fieldId: number; ref: string; saved: 'Remembered.' | 'Saved.' | 'Answered from what you already told Claude.' | 'Recorded as a first-time question.' }
  | { ok: false; reason: string };

export function learnField(ctx: Ctx, roleId: string, a: LearnInput): LearnResult {
  const role = getRole(ctx.db, roleId);
  const notes = notesOf(ctx);
  const label = String(a.label ?? '').replace(/\s+/g, ' ').trim();
  if (!label) return { ok: false, reason: 'the question has no label' };
  // D32: never recorded, never answered: the user types an ID, bank or tax number into the form.
  if (classOf(label) === 'never_fill') return { ok: false, reason: `Not recorded: "${label}" is an ID, bank or tax number. Crewdeck never stores these: leave it for the user to type in the form.` };
  const given = (a.options ?? []).map((o) => String(o).trim()).filter(Boolean);
  // A Yes/No question recorded without its options (a "needs you" question the user answered on the page): their Yes or
  // No makes it a choice about them, remembered for every company, not a written answer kept for this company only.
  const options = given.length || !/^(yes|no)$/i.test(String(a.answer ?? '').trim()) ? given : ['Yes', 'No'];
  const kind = kbKind({ label, kind: a.kind ?? (options.length ? 'radio' : 'text'), options, sensitive: a.sensitive }, notes.profile.data);
  if (a.answer) {
    // Sensitive and choice answers are about the user: only their own words (quote), or what they already told us.
    const claims = a.claims ?? [];
    const fromUser = claims.length > 0 && claims.every((c) => c.about === 'me' && c.fact_ids.length && c.fact_ids.every((id) => /^m-\d+$|^profile:/.test(id)));
    if ((kind === 'sensitive' || kind === 'choice') && !a.quote && !fromUser) return { ok: false, reason: `Not filled: "${label}" needs the user's own answer. Ask them, then call again with their words as the quote.` };
    if (!a.quote) {
      const check = checkAnswer({ text: a.answer, claims }, citeContext(ctx, roleId, notes));
      if (!check.ok) return { ok: false, reason: `Not filled: ${check.reason}. Ask the user, then answer with their words as the quote.` };
    }
  }
  const fieldId = tx(ctx.db, () => {
    const qid = ensureQuestion(ctx.db, label, kind, role.company);
    const ord = ((ctx.db.prepare('select max(ord) m from form_fields where role_id=?').get(roleId) as any)?.m ?? -1) + 1;
    const fid = ensureField(ctx.db, roleId, label, ord, qid, kind);
    if (options.length) ctx.db.prepare('update form_fields set options_json=? where id=?').run(JSON.stringify(options), fid);
    if (a.required !== undefined) ctx.db.prepare('update form_fields set required=? where id=?').run(a.required ? 1 : 0, fid);
    return fid;
  });
  const field = currentAnswers(ctx.db, roleId).find((f) => f.field_id === fieldId)!;
  if (!a.answer) {
    if (field.answer_id) return { ok: true, fieldId, ref: field.ref, saved: field.status === 'first_time' ? 'Recorded as a first-time question.' : 'Answered from what you already told Claude.' };
    const auto = autoAnswer(field, activeMemory(notes.memory.data.items, role.company), profileFields(notes.profile.data));
    if (auto) {
      insertAnswer(ctx, field, roleId, role.company, auto.text, auto.sources, 'approved');
      return { ok: true, fieldId, ref: field.ref, saved: 'Answered from what you already told Claude.' };
    }
    ctx.db.prepare(`insert into answers(role_id, form_field_id, question_id, company, text, status, reason, created_at) values (?,?,?,?,null,'first_time',?,?)`)
      .run(roleId, fieldId, field.question_id, role.company, kind === 'sensitive' ? 'sensitive: tell Claude once' : 'met on the live form', nowIso(ctx));
    return { ok: true, fieldId, ref: field.ref, saved: 'Recorded as a first-time question.' };
  }
  if (a.quote) {
    answerFirstTime(ctx, { role: roleId, question: field.ref, value: a.answer, quote: a.quote });
    return { ok: true, fieldId, ref: field.ref, saved: 'Remembered.' };
  }
  const r = changeAnswer(ctx, { role: roleId, question: field.ref, new_text: a.answer, claims: a.claims ?? [], instruction: 'question met on the live form' });
  if (!r.ok) return { ok: false, reason: `Not filled: ${r.reason}. Ask the user, then answer with their words as the quote.` };
  return { ok: true, fieldId, ref: field.ref, saved: 'Saved.' };
}
