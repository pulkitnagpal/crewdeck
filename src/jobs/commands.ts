// crewdeck jobs <cmd>: the tracker, the knowledge base and the pipeline (P2a). Anything from a posting, a page or the
// user's words arrives through a file or stdin (design D11); arguments are only role ids, numbers and fixed words.
// Handlers parse files into plain objects and call the library, so P3 can hand them a request payload instead.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { type Ctx, notesOf, openCtx, todayOf } from './ctx.ts';
import { ROLE_ID } from './db.ts';
import { isDay } from './time.ts';
import { flag, positional, textFrom } from './cli.ts';
import { cleanQuestions, storeFormFields } from './kb/questions.ts';
import { answerFirstTime, changeAnswer, knowledge, resolveField, undoLast } from './kb/ops.ts';
import { learnField } from './kb/learn.ts';
import type { Claim } from './kb/cite.ts';
import { applyDraft, prepareDraft } from './draft/draft.ts';
import { planForRole } from './plan.ts';
import { addQuestion, addRole, addRoleEvent, setApplyUrl, setRoleStatus } from './pipeline/roles.ts';
import { refilter, runPrefilter } from './pipeline/prefilter.ts';
import { candidates, cleanVerdict, dailyPicks, judge, pick, pickPasted } from './pipeline/pick.ts';
import { markApplied, notInterested } from './pipeline/apply.ts';
import { addContact, addMessage, checkMessage, followups, markSent, recordFollowup } from './pipeline/outreach.ts';
import { KNOWLEDGE_TABS, type KnowledgeTab, applicationsView, knowledgeView, todayView } from './views.ts';

const say = (s: string) => console.log(s);
const json = (v: unknown) => say(JSON.stringify(v, null, 1));
const MAX = 2_000_000;

function text(path: string | undefined, what: string): string {
  const t = textFrom(path, what);
  if (t.length > MAX) throw new Error(`${what} is larger than 2 MB`);
  return t.replace(/\r\n/g, '\n').replace(/\n$/, '');
}
const optText = (args: string[], name: string) => (flag(args, name) ? text(flag(args, name), `--${name}`) : undefined);
function jsonFile(path: string | undefined, what: string): any {
  const t = text(path, what);
  try { return JSON.parse(t); } catch (e: any) { throw new Error(`${what}: not valid JSON (${e.message})`); }
}
function roleArg(v: string | undefined, usage: string): string {
  if (!v) throw new Error(usage);
  if (!ROLE_ID.test(v)) throw new Error(`"${v}" is not a role id (12 hex characters, from crewdeck jobs view today or candidates)`);
  return v;
}
function intArg(v: string | undefined, name: string, d?: number): number {
  if (v === undefined) { if (d === undefined) throw new Error(`--${name} is required`); return d; }
  if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a whole number`);
  return Number(v);
}

/** Open the user's tracker for one command and close it after. */
async function withCtx<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T> {
  const ctx = openCtx(loadConfig());
  try { return await fn(ctx); } finally { ctx.db.close(); }
}

const cmds: Record<string, (args: string[]) => unknown> = {
  prefilter: () => withCtx((ctx) => json(runPrefilter(ctx))),

  refilter: (args) => withCtx((ctx) => {
    const r = refilter(ctx, intArg(flag(args, 'days'), 'days', 14));
    json(r);
    if (r.restored) say(`${r.restored} role${r.restored > 1 ? 's are' : ' is'} back for judging.`);
  }),

  candidates: (args) => withCtx((ctx) => json(candidates(ctx, intArg(flag(args, 'limit'), 'limit', 40)))),

  judge: (args) => withCtx((ctx) => {
    const raw = jsonFile(flag(args, 'results-file'), 'usage: crewdeck jobs judge --results-file <f> ([{ role, eligible, score, evidence, reason? }])');
    json(judge(ctx, (Array.isArray(raw) ? raw : [raw]).map(cleanVerdict)));
  }),

  pick: (args) => withCtx((ctx) => {
    const day = flag(args, 'day') ?? todayOf(ctx);
    if (!isDay(day)) throw new Error('--day must be YYYY-MM-DD');
    const role = flag(args, 'role');
    if (role) {
      const warnings = pickPasted(ctx, roleArg(role, 'usage: crewdeck jobs pick --role <id> [--force]'), day, args.includes('--force'));
      if (warnings.length) { json({ picked: false, warnings }); process.exitCode = 2; return; }
      return json({ picked: true, role, day });
    }
    const ids = pick(ctx, intArg(flag(args, 'n'), 'n', dailyPicks(ctx)), day);
    for (const id of ids) {
      const r = ctx.db.prepare('select c.name company, r.title from roles r join companies c on c.id=r.company_id where r.id=?').get(id) as any;
      say(`${id}  ${r.company} — ${r.title}`);
    }
    if (!ids.length) say('nothing to pick: no eligible roles (judge candidates first)');
  }),

  status: (args) => withCtx((ctx) => {
    const [role, status] = positional(args);
    setRoleStatus(ctx, roleArg(role, 'usage: crewdeck jobs status <role> <status> [--reason-file f]'), status ?? '', optText(args, 'reason-file') ?? '');
    say(`${role}: ${status}`);
  }),

  event: (args) => withCtx((ctx) => {
    const [verb, role] = positional(args);
    const usage = 'usage: crewdeck jobs event add <role> --kind why|deadline|note|reply|interview|rejected --detail-file <f>';
    if (verb !== 'add') throw new Error(usage);
    addRoleEvent(ctx, roleArg(role, usage), flag(args, 'kind') ?? '', text(flag(args, 'detail-file'), '--detail-file'));
    say('recorded');
  }),

  question: (args) => withCtx((ctx) => {
    const [verb, role] = positional(args);
    const usage = 'usage: crewdeck jobs question add <role> --text-file <f>';
    if (verb !== 'add') throw new Error(usage);
    say(String(addQuestion(ctx, roleArg(role, usage), text(flag(args, 'text-file'), '--text-file'))));
  }),

  applied: (args) => withCtx((ctx) => {
    const r = markApplied(ctx, roleArg(positional(args)[0], 'usage: crewdeck jobs applied <role>'));
    say(`${r.company} — ${r.title}: applied${r.already ? ' (already marked)' : ''}; cooldown until ${r.cooldown_until.slice(0, 10)}${r.journal ? `; noted in ${r.journal}` : ''}`);
  }),

  'not-interested': (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs not-interested <role> --reason-file <f with the user\'s words> [--title-words-file <f>]';
    const role = roleArg(positional(args)[0], usage);
    const words = optText(args, 'title-words-file');
    const r = notInterested(ctx, { role, reason: text(flag(args, 'reason-file'), '--reason-file'), titleWords: words ? words.split(/[,\n]/) : undefined });
    say(`skipped; remembered as ${r.remembered}${r.title_words.length ? `; titles with ${r.title_words.join(', ')} are now excluded (jobs/search.md)` : ''}`);
  }),

  'add-role': (args) => withCtx((ctx) => {
    const r = jsonFile(flag(args, 'role-file'), 'usage: crewdeck jobs add-role --role-file <f.json | -> ({ url, title, company, location?, description?, pay_text?, source? })');
    const res = addRole(ctx, r);
    say(`${res.isNew ? 'added' : 'already known'}: ${res.id}`);
  }),

  role: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs role <id> --apply-url-file <f>';
    const role = roleArg(positional(args)[0], usage);
    say(`apply URL set: ${setApplyUrl(ctx, role, text(flag(args, 'apply-url-file'), usage).trim())}`);
  }),

  form: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs form <role> --fields-file <f> ([{ label, kind, required?, options? }])';
    const role = roleArg(positional(args)[0], usage);
    if (!flag(args, 'fields-file')) throw new Error(`${usage}\n(reading a form from its page arrives in a later version)`);
    const n = storeFormFields(ctx.db, role, notesOf(ctx).profile.data, cleanQuestions(jsonFile(flag(args, 'fields-file'), '--fields-file')));
    say(`${n} question${n === 1 ? '' : 's'} stored for ${role}`);
  }),

  draft: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs draft <role> --brief <out.json> | --answers <claude-answers.json>';
    const role = roleArg(positional(args)[0], usage);
    const brief = flag(args, 'brief'), answers = flag(args, 'answers');
    if (brief) {
      const b = prepareDraft(ctx, role);
      writeFileSync(brief, JSON.stringify(b, null, 1), { mode: 0o600 });
      say(`${b.res.answered} answered from your profile and memory; ${b.res.first_time} need you; ${b.refs.length ? `brief written: ${b.refs.length} for Claude (${b.refs.join(', ')})` : 'nothing for Claude'}`);
    } else if (answers) json(applyDraft(ctx, role, jsonFile(answers, '--answers')));
    else throw new Error(usage);
  }),

  answer: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs answer <role> --question Qn --text-file <f> (--quote-file <the user\'s words> | --claims-file <f> [--instruction-file <f>])';
    const role = roleArg(positional(args)[0], usage);
    const question = flag(args, 'question') ?? optText(args, 'question-file');
    if (!question) throw new Error(usage);
    const value = text(flag(args, 'text-file'), '--text-file');
    const quote = optText(args, 'quote-file');
    if (quote !== undefined) {
      const r = answerFirstTime(ctx, { role, question, value, quote });
      return json({ ok: true, answer: r.answer.text, remembered: r.remembered.id, also_filled: r.applied });
    }
    if (!flag(args, 'claims-file')) throw new Error(usage);
    const r = changeAnswer(ctx, { role, question, new_text: value, claims: jsonFile(flag(args, 'claims-file'), '--claims-file') as Claim[], instruction: optText(args, 'instruction-file') ?? 'Claude rewrite' });
    json(r.ok ? { ok: true, ref: resolveField(ctx.db, role, question).ref, answer: r.answer.text } : r);
    if (!r.ok) process.exitCode = 1;
  }),

  learn: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs learn <role> --label-file <f> [--answer-file f] [--quote-file f] [--options-file f] [--claims-file f] [--required]';
    const role = roleArg(positional(args)[0], usage);
    const opts = optText(args, 'options-file');
    const options = opts === undefined ? undefined : opts.trim().startsWith('[') ? (JSON.parse(opts) as unknown[]).map(String) : opts.split('\n');
    const r = learnField(ctx, role, {
      label: text(flag(args, 'label-file'), '--label-file'), answer: optText(args, 'answer-file'), quote: optText(args, 'quote-file'), options,
      claims: flag(args, 'claims-file') ? jsonFile(flag(args, 'claims-file'), '--claims-file') : undefined, required: args.includes('--required') ? true : undefined,
    });
    json(r);
    if (!r.ok) process.exitCode = 1;
  }),

  undo: () => withCtx((ctx) => json(undoLast(ctx))),

  knowledge: (args) => withCtx((ctx) => {
    const words = positional(args).join(' ');
    const q = optText(args, 'query-file') ?? words;
    if (!q.trim()) throw new Error('usage: crewdeck jobs knowledge <words> | --query-file <f>');
    if (!flag(args, 'query-file') && !/^[\p{L}\p{N} _.+#-]+$/u.test(words)) throw new Error('use --query-file for anything but plain words');
    json(knowledge(ctx, q));
  }),

  'fill-plan': (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs fill-plan <role> --fields-file <f> [--page-url-file <f>]';
    const role = roleArg(positional(args)[0], usage);
    const fields = jsonFile(flag(args, 'fields-file'), usage);
    json(planForRole(ctx, role, fields, optText(args, 'page-url-file')?.trim() || undefined));
  }),

  contact: (args) => withCtx((ctx) => {
    if (positional(args)[0] !== 'add') throw new Error('usage: crewdeck jobs contact add --file <f.json> ({ company, name, title?, email?, email_verified?, linkedin_url?, source? })');
    say(String(addContact(ctx, jsonFile(flag(args, 'file'), '--file'))));
  }),

  message: (args) => withCtx((ctx) => {
    const [verb, a] = positional(args);
    const usage = 'usage: crewdeck jobs message add|check <role> --contact <id> --channel email|linkedin [--body-file <f>] [--gmail-draft-id <id>] | message sent <id>';
    if (verb === 'sent') { markSent(ctx, intArg(a, 'message id')); return say('marked sent'); }
    if (verb !== 'add' && verb !== 'check') throw new Error(usage);
    const m = { role_id: roleArg(a, usage), contact_id: intArg(flag(args, 'contact'), 'contact'), channel: flag(args, 'channel') as 'email' | 'linkedin' };
    if (verb === 'check') { checkMessage(ctx, m); return say('ok'); }
    say(String(addMessage(ctx, { ...m, body: text(flag(args, 'body-file'), '--body-file'), gmail_draft_id: flag(args, 'gmail-draft-id') })));
  }),

  followups: () => withCtx((ctx) => json(followups(ctx))),

  followup: (args) => withCtx((ctx) => {
    const [verb, id, step] = positional(args);
    if (verb !== 'done' || !['nudge', 'final'].includes(step ?? '')) throw new Error('usage: crewdeck jobs followup done <message-id> nudge|final');
    recordFollowup(ctx, intArg(id, 'message id'), step as 'nudge' | 'final');
    say('recorded');
  }),

  view: (args) => withCtx((ctx) => {
    const [which] = positional(args);
    if (which === 'today') return json(todayView(ctx, flag(args, 'role')));
    if (which === 'applications') return json(applicationsView(ctx));
    if (which === 'knowledge') {
      const tab = (flag(args, 'tab') ?? 'profile') as KnowledgeTab;
      if (!(KNOWLEDGE_TABS as readonly string[]).includes(tab)) throw new Error(`--tab must be one of ${KNOWLEDGE_TABS.join(', ')}`);
      return json(knowledgeView(ctx, tab));
    }
    throw new Error('usage: crewdeck jobs view today [--role <id>] | applications | knowledge [--tab profile|career|search|memory|answers]');
  }),
};

export const COMMANDS = cmds;

export const USAGE = `
tracker and pipeline (text from postings and the user's words only through files or - for stdin):
  prefilter | refilter --days N           drop roles your notes rule out / bring back ones they now allow
  candidates [--limit N]                  unjudged roles, best first (JSON)
  judge --results-file f                  store verdicts [{ role, eligible: yes|no|unclear, score, evidence, reason? }]
  pick [--n N] [--day D] | pick --role <id> [--force]
  add-role --role-file f | role <id> --apply-url-file f | status <role> <status> [--reason-file f]
  event add <role> --kind k --detail-file f | question add <role> --text-file f
  applied <role> | not-interested <role> --reason-file f [--title-words-file f]
knowledge and answers:
  form <role> --fields-file f             store the questions read from a form
  draft <role> --brief out.json | --answers f
  answer <role> --question Qn --text-file f (--quote-file f | --claims-file f [--instruction-file f])
  learn <role> --label-file f [--answer-file f] [--quote-file f] [--options-file f] [--claims-file f] [--required]
  undo | knowledge <words>
  fill-plan <role> --fields-file f [--page-url-file f]
outreach (off until you switch it on): contact add --file f | message add|check <role> … | message sent <id> | followups | followup done <id> nudge|final
views: view today [--role id] | applications | knowledge [--tab t]`;
