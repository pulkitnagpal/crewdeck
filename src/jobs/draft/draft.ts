// Drafting a role's answers in two halves (design §2.3 step 4):
// 1. code: everything the profile and memory already answer is approved now (profile values with a `profile:<key>`
//    source, so name, email or phone never show as first-time questions); the brief lists the rest for Claude;
// 2. Claude writes answers from facts and memory only; `applyDraft` stores them after the citation check, and anything
//    unsupported becomes a first-time question for the user.
import { type Ctx, notesOf } from '../ctx.ts';
import { getRole, tx } from '../db.ts';
import { activeMemory } from '../memory.ts';
import { norm, profileFields, profileValues } from '../fields.ts';
import { type Claim, checkAnswer } from '../kb/cite.ts';
import { type AnswerView, autoAnswer, citeContext, currentAnswers, insertAnswer, matchOption } from '../kb/ops.ts';
import { clip, plainText } from '../text.ts';
import { DRAFT_SCHEMA, buildPrompt } from './prompt.ts';

export type DraftAnswer = { field_ref: string; label?: string; canonical_key?: string; answer: string | null; reason?: string; claims: Claim[] };
export type DraftOut = { answers: DraftAnswer[] };
export type Drafter = (prompt: string, schema: object, posting: string) => Promise<DraftOut>;

const SENSITIVE_REASON = 'sensitive: tell Claude once';
const CONTACT_REASON = 'not in your profile yet (me/profile.md)';
const STOP = new Set(['what', 'your', 'have', 'with', 'that', 'this', 'tell', 'about', 'they', 'were', 'will', 'would', 'which', 'when', 'where', 'there', 'their', 'from', 'into', 'more', 'some', 'like', 'please', 'share', 'describe', 'list', 'well', 'worked', 'faced', 'does', 'should']);

/** Approved answers to similar questions on other forms (never contact or profile values: those are about the user only). */
function shortlist(ctx: Ctx, label: string, fieldId: number) {
  const terms = norm(label).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 3 && !STOP.has(t)).slice(0, 8);
  if (!terms.length) return [];
  const rows = ctx.db.prepare(`select w.text question, a.text answer, a.fact_ids_json sources from question_fts join question_wordings w on w.id=question_fts.rowid
      join answers a on a.question_id=w.question_id join kb_questions q on q.id=w.question_id
      where question_fts match ? and a.status='approved' and a.text is not null and a.form_field_id<>? and q.kind in ('narrative','choice','numeric')
      order by bm25(question_fts) limit 10`).all(terms.map((t) => `"${t}"`).join(' OR '), fieldId) as any[];
  const seen = new Set<string>();
  return rows.filter((r) => !JSON.parse(r.sources || '[]').some((s: string) => s.startsWith('profile:')))
    .filter((r) => { const k = `${r.question}\n${r.answer}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5).map((r) => ({ question: r.question as string, answer: r.answer as string }));
}

const isRedraft = (f: AnswerView) => (f.reason ?? '').startsWith('redraft:');
/** Fields that still need an answer: never answered, first-time, or queued for a redraft by a style rule. */
const isOpen = (f: AnswerView) => !f.answer_id || f.status === 'first_time' || isRedraft(f);

/** Code half: fill what the profile and memory answer, and build the brief for Claude. */
export function prepareDraft(ctx: Ctx, roleId: string) {
  const role = getRole(ctx.db, roleId);
  const notes = notesOf(ctx);
  const memory = activeMemory(notes.memory.data.items, role.company);
  const pf = profileFields(notes.profile.data);
  const res = { answered: 0, first_time: 0, kept: 0 };
  const forClaude: AnswerView[] = [];
  tx(ctx.db, () => {
    for (const f of currentAnswers(ctx.db, roleId)) {
      if (!isOpen(f)) { res.kept++; continue; }
      const auto = autoAnswer(f, memory, pf, { redraft: isRedraft(f) });
      if (auto) { insertAnswer(ctx, f, roleId, role.company, auto.text, auto.sources, 'approved'); res.answered++; continue; }
      // Sensitive questions and the user's own contact details are never drafted: only the user can give them.
      const reason = f.kind === 'sensitive' ? SENSITIVE_REASON : f.kind === 'contact' ? CONTACT_REASON : null;
      if (reason) {
        if (!(f.status === 'first_time' && f.reason === reason)) insertAnswer(ctx, f, roleId, role.company, null, [], 'first_time', reason);
        res.first_time++;
        continue;
      }
      forClaude.push(f);
    }
  });
  const id = notes.profile.data.identity;
  const name = [id.preferred_name || id.first_name, id.last_name].filter(Boolean).join(' ');
  const shortlists = Object.fromEntries(forClaude.map((f) => [f.ref, shortlist(ctx, f.label, f.field_id)]));
  const existingKeys = (ctx.db.prepare('select canonical_key from kb_questions order by id').all() as any[]).map((r) => r.canonical_key);
  const prompt = forClaude.length ? buildPrompt({
    name, company: role.company, title: role.title, fields: forClaude, facts: notes.career.data.facts, memory,
    profileKeys: Object.keys(profileValues(notes.profile.data)), shortlists, existingKeys,
  }) : '';
  return { role: roleId, res, refs: forClaude.map((f) => f.ref), prompt, schema: DRAFT_SCHEMA, posting: clip(plainText(role.description ?? ''), 12000) };
}

/** Claude half: store Claude's answers after the citation check; unsupported ones become first-time questions. */
export function applyDraft(ctx: Ctx, roleId: string, out: DraftOut) {
  const role = getRole(ctx.db, roleId);
  const cite = citeContext(ctx, roleId);
  const res = { drafted: 0, first_time: 0, skipped: 0 };
  if (!out || !Array.isArray(out.answers)) throw new Error('the answers file must be { "answers": [ … ] } (see the schema in the brief)');
  const fields = currentAnswers(ctx.db, roleId).filter(isOpen);
  tx(ctx.db, () => {
    for (const a of out.answers) {
      const f = fields.find((x) => x.ref === a?.field_ref);
      // Only fields that were asked for, and only if the label still matches (the form may have been re-read).
      if (!f || (a.label !== undefined && norm(a.label) !== norm(f.label))) { res.skipped++; continue; }
      if (typeof a.canonical_key === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(a.canonical_key) && a.canonical_key !== f.canonical_key && f.question_id) {
        const existing = ctx.db.prepare('select id, kind from kb_questions where canonical_key=?').get(a.canonical_key) as any;
        // Merge into a known question only of the same kind (a written answer never becomes a choice's key).
        if (existing && existing.kind === f.kind) ctx.db.prepare('update form_fields set question_id=? where id=?').run(existing.id, f.field_id);
        else if (!existing) ctx.db.prepare('update kb_questions set canonical_key=? where id=?').run(a.canonical_key, f.question_id);
      }
      const claims = Array.isArray(a.claims) ? a.claims : [];
      const first = (reason: string) => { insertAnswer(ctx, f, roleId, role.company, null, [], 'first_time', reason); res.first_time++; };
      if (!a.answer || typeof a.answer !== 'string') { first(a.reason ? String(a.reason).slice(0, 300) : 'not in your resume or memory yet'); continue; }
      let text = a.answer.trim();
      if (f.options.length) {
        const opt = matchOption(f.options, text);
        if (!opt) { first('no supported option'); continue; }
        text = opt;
      }
      if (f.char_limit && text.length > f.char_limit) { first(`draft longer than ${f.char_limit} characters`); continue; }
      const check = f.kind === 'choice' && claims.length === 0 ? { ok: false as const, reason: 'choice without a source' } : checkAnswer({ text, claims }, cite);
      if (!check.ok) { first(check.reason); continue; }
      insertAnswer(ctx, f, roleId, role.company, text, [...new Set(claims.flatMap((c) => c.fact_ids))], 'drafted');
      res.drafted++;
    }
  });
  return res;
}

/** Both halves around a drafter (tests pass a fixture; in use, Claude in the session writes the answers file). */
export async function draftRole(ctx: Ctx, roleId: string, claude: Drafter) {
  const brief = prepareDraft(ctx, roleId);
  if (!brief.refs.length) return { ...brief.res, drafted: 0 };
  const out = await claude(brief.prompt, brief.schema, brief.posting);
  const r = applyDraft(ctx, roleId, out);
  return { answered: brief.res.answered, drafted: r.drafted, first_time: brief.res.first_time + r.first_time, kept: brief.res.kept };
}
