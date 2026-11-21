// crewdeck jobs <cmd>: the tracker, the knowledge base and the pipeline (P2a). Anything from a posting, a page or the
// user's words arrives through a file or stdin (design D11); arguments are only role ids, numbers and fixed words.
// Handlers parse files into plain objects and call the library, so P3 can hand them a request payload instead.
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { type Ctx, makeCtx, notesOf, openCtx, todayOf } from './ctx.ts';
import { ROLE_ID, getRole, openJobsDb, openJobsDbReadOnly } from './db.ts';
import { checkRoleUrl } from './fields.ts';
import { isDay } from './time.ts';
import { flag, jobsFileRoots, positional, textFrom } from './cli.ts';
import { checkedPath } from '../files.ts';
import { cleanQuestions, storeFormFields } from './kb/questions.ts';
import { answerFirstTime, changeAnswer, currentAnswers, knowledge, resolveField, undoLast } from './kb/ops.ts';
import { learnField } from './kb/learn.ts';
import type { Claim } from './kb/cite.ts';
import { applyDraft, prepareDraft } from './draft/draft.ts';
import { planForRole } from './plan.ts';
import { APPLY_METHODS, addQuestion, addRole, addRoleEvent, setApplyMethod, setApplyUrl, setFormLang, setRoleStatus } from './pipeline/roles.ts';
import { refilter, runPrefilter } from './pipeline/prefilter.ts';
import { candidates, cleanVerdict, dailyPicks, judge, pick, pickPasted } from './pipeline/pick.ts';
import { markApplied, notInterested } from './pipeline/apply.ts';
import { addContact, addMessage, checkMessage, followups, markSent, recordFollowup } from './pipeline/outreach.ts';
import { KNOWLEDGE_TABS, type KnowledgeTab, applicationsView, knowledgeView, todayView } from './views.ts';
import { showRequest } from '../agent-client.ts';

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

/**
 * A request-scoped command's payload (design D11): the page's data comes from the server by request id, never through
 * the shell. The request must be open and of the kind the command works.
 */
async function requestPayload(args: string[], kind: string): Promise<{ id: number; payload: any; ref: string | null }> {
  const r = await showRequest(flag(args, 'request'));
  if (r.kind !== kind) throw new Error(`request ${r.id} is ${r.kind ? `kind ${r.kind}` : 'not a Jobs request'}: this command works ${kind} requests`);
  if (r.status !== 'new' && r.status !== 'picked') throw new Error(`request ${r.id} is already ${r.status}`);
  return { id: r.id, payload: r.payload ?? {}, ref: r.ref };
}

/**
 * The user's "Add it anyway" is never a command-line flag (C2): an agent could pass it. It arrives only in the payload
 * of the link request the page sends when the user clicks it.
 */
function noForceFlag(args: string[]) {
  if (args.includes('--force')) throw new Error('--force is not taken from the command line: the user\'s "Add it anyway" on the Jobs page sends a link request that carries it (crewdeck jobs link --request <id>, or pick --role <id> --request <id>)');
}

/** Open the user's tracker for one command and close it after. */
async function withCtx<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T> {
  const ctx = openCtx(loadConfig());
  try { return await fn(ctx); } finally { ctx.db.close(); }
}

const answerUsage = 'usage: crewdeck jobs answer <role> --question Qn --text-file <f> (--quote-file <the user\'s words> [--everywhere] | --claims-file <f> [--instruction-file <f>])  |  answer --request <id> --text-file <f> --claims-file <f>';
const answerCmd = (args: string[]) => withCtx((ctx) => {
  const usage = answerUsage;
  const role = roleArg(positional(args)[0], usage);
  const question = flag(args, 'question') ?? optText(args, 'question-file');
  if (!question) throw new Error(usage);
  const value = text(flag(args, 'text-file'), '--text-file');
  const quote = optText(args, 'quote-file');
  if (quote !== undefined) {
    // "use this everywhere" (D32): a sensitive answer is otherwise kept for this company only.
    const r = answerFirstTime(ctx, { role, question, value, quote, everywhere: args.includes('--everywhere') });
    return json({ ok: true, answer: r.answer.text, remembered: r.remembered.id, also_filled: r.applied });
  }
  if (!flag(args, 'claims-file')) throw new Error(usage);
  const r = changeAnswer(ctx, { role, question, new_text: value, claims: jsonFile(flag(args, 'claims-file'), '--claims-file') as Claim[], instruction: optText(args, 'instruction-file') ?? 'Claude rewrite' });
  json(r.ok ? { ok: true, ref: resolveField(ctx.db, role, question).ref, answer: r.answer.text } : r);
  if (!r.ok) process.exitCode = 1;
});

/** An "Ask Claude" (improve) request: Claude's rewrite, through the citation check; the question and instruction come from the page. */
async function answerForRequest(args: string[]) {
  const { payload } = await requestPayload(args, 'improve');
  if (!flag(args, 'text-file') || !flag(args, 'claims-file')) throw new Error(answerUsage);
  return withCtx((ctx) => {
    const role = roleArg(String(payload.role ?? ''), answerUsage);
    const f = currentAnswers(ctx.db, role).find((a) => a.field_id === Number(payload.field_id));
    if (!f) throw new Error('that question is no longer on the role\'s form');
    const r = changeAnswer(ctx, { role, question: f.ref, new_text: text(flag(args, 'text-file'), '--text-file'), claims: jsonFile(flag(args, 'claims-file'), '--claims-file') as Claim[], instruction: String(payload.instruction || 'Ask Claude on the Jobs page') });
    json(r.ok ? { ok: true, ref: f.ref, answer: r.answer.text } : r);
    if (!r.ok) process.exitCode = 1;
  });
}

function fillPlanCmd(ctx: Ctx, args: string[], role: string, usage: string) {
  const fields = jsonFile(flag(args, 'fields-file'), usage);
  json(planForRole(ctx, role, fields, optText(args, 'page-url-file')?.trim() || undefined));
}

const cmds: Record<string, (args: string[]) => unknown> = {
  prefilter: () => withCtx((ctx) => json(runPrefilter(ctx))),

  refilter: (args) => withCtx((ctx) => {
    const r = refilter(ctx, intArg(flag(args, 'days'), 'days', 14));
    json(r);
    if (r.restored) say(`${r.restored} role${r.restored > 1 ? 's are' : ' is'} back for judging.`);
  }),

  candidates: (args) => withCtx(async (ctx) => {
    if (flag(args, 'budget') === undefined) return json(candidates(ctx, intArg(flag(args, 'limit'), 'limit', 40)));
    // A Find within a budget: the next batch in rank order, and where the run stands (design §2.4 step 3).
    const { budgetedCandidates } = await import('./pipeline/rank.ts');
    json(budgetedCandidates(ctx, { budget: intArg(flag(args, 'budget'), 'budget'), batch: intArg(flag(args, 'batch'), 'batch', 10), need: intArg(flag(args, 'need'), 'need', dailyPicks(ctx) || 5), start: args.includes('--start') }));
  }),

  judge: (args) => withCtx(async (ctx) => {
    const raw = jsonFile(flag(args, 'results-file'), 'usage: crewdeck jobs judge --results-file <f> ([{ role, eligible, score, evidence, reason? }])');
    const out = judge(ctx, (Array.isArray(raw) ? raw : [raw]).map(cleanVerdict));
    const { recordJudged } = await import('./pipeline/rank.ts');
    recordJudged(ctx, out.filter((r) => r.stored).map((r) => r.role));
    json(out);
  }),

  source: (args) => withCtx(async (ctx) => {
    const since = intArg(flag(args, 'since'), 'since', 14);
    if (since < 1 || since > 90) throw new Error('--since must be from 1 to 90 days');
    const { runSources } = await import('./sources.ts');
    const { realLaunch } = await import('./portals/profile.ts');
    const r = await runSources(ctx, { sinceDays: since, trigger: args.includes('--scheduled') ? 'scheduled' : 'command', onlyNew: args.includes('--only-new-sources'), planned: !args.includes('--no-planned'),
      // ADR-0008: connected, switched-on portals in Crewdeck's own browser profile (--no-portals skips them).
      ...(args.includes('--no-portals') ? {} : { portals: { launch: realLaunch(ctx.home, loadConfig().jobs.browser) } }) });
    if (args.includes('--json')) return json(r);
    const p = r.providers as any;
    if (p?.ran) {
      say(`boards: ${p.fetched} postings, ${p.new} new${p.refused ? `, ${p.refused} refused by the checks` : ''}`);
      for (const e of p.entries) say(`  ${e.ok ? '✓' : '✗'} ${e.name}${e.provider ? ` (${e.provider})` : ''}: ${e.ok ? `${e.jobs} postings, ${e.new} new${r.by_key?.[e.key] ? `, ${r.by_key[e.key].kept} kept by your rules` : ''}` : e.error}`);
      for (const s of p.skipped) say(`  · ${s.name}: ${s.why}`);
    } else say(`boards: not run (${p?.why})`);
    const l = r.linkedin;
    const pr = r.portals as any;
    if (pr?.ran) for (const x of pr.portals) say(`  ${x.ran && !x.stopped ? '✓' : '✗'} ${x.name} (signed-in portal): ${x.ran ? `${x.found} found, ${x.new} new${x.stopped ? ` (${x.stopped})` : ''}` : x.why}`);
    else if (pr?.why && !/no portals switched on/.test(pr.why)) say(`portals: not run (${pr.why})`);
    say(l?.ran ? `LinkedIn: ${l.stored} new of ${l.cards} found${l.partial ? `, ${l.partial} kept from their cards (details later)` : ''}${l.stopped ? ` (${l.stopped})` : ''}` : `LinkedIn: not run (${l?.why})`);
    const d = r.details;
    if (d?.tried || d?.deferred) say(`descriptions: ${d.found} full descriptions read of ${d.tried} tried, ${d.closed} closed postings set aside${d.errors ? `, ${d.errors} not read` : ''}${d.deferred ? `, ${d.deferred} left for the next run${d.backed_off?.length ? ` (${d.backed_off.join(', ')} asked us to back off)` : ''}` : ''}`);
    say(`after your rules: ${r.prefilter?.kept} waiting to be judged, ${r.prefilter?.dropped} dropped`);
    if (r.error) { say(`error: ${r.error}`); process.exitCode = 1; }
  }),

  sources: async (args) => (await import('./sources-cmd.ts')).sourcesCmd(args),
  portals: async (args) => (await import('./portals/cmd.ts')).portalsCmd(args),

  // A dry run of the rules over the postings already fetched (design §24.6): read-only.
  preview: async (args) => {
    const { parse } = await import('yaml');
    const { previewLines, runPreview, searchFileChanges } = await import('./preview.ts');
    const file = flag(args, 'search-file'), source = flag(args, 'source');
    if (source !== undefined && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(source)) throw new Error('--source is a source key (crewdeck jobs sources list)');
    let data: unknown;
    if (file) { try { data = parse(text(file, '--search-file')); } catch (e: any) { throw new Error(`--search-file: not valid YAML (${String(e.message).split('\n')[0]})`); } }
    // The tracker is opened read-only (no migration, and closing it never checkpoints the WAL into the file).
    const c = loadConfig();
    const db = openJobsDbReadOnly(c.jobs.home) ?? openJobsDb(c.jobs.home);
    try {
      const p = runPreview(makeCtx({ db, vault: c.vault, home: c.jobs.home, features: c.jobs.features }), { days: intArg(flag(args, 'days'), 'days', 14), source, changes: file ? searchFileChanges(data) : [] });
      if (args.includes('--json')) return json(p);
      for (const l of previewLines(p)) say(l);
    } finally { db.close(); }
  },

  providers: async (args) => {
    const [verb] = positional(args);
    const usage = 'usage: crewdeck jobs providers install | status | verify';
    const c = loadConfig();
    const p = await import('./providers.ts');
    if (verb === 'install') {
      const r = await p.installProviders(c);
      say(r.message);
      if (!r.ready) process.exitCode = 1;
      return;
    }
    if (verb === 'status') {
      const r = p.providersStatus(c);
      const m = p.loadManifest();
      say(r.message);
      say(`pinned: ${m.repo}@${m.commit} (${m.license.spdx}, ${m.license.copyright})`);
      say(`excluded: ${Object.entries(m.excluded).filter(([f]) => /^providers\/[^_]/.test(f)).map(([f]) => f.slice(10, -4)).join(', ')}`);
      if (!r.ready) process.exitCode = 1;
      return;
    }
    if (verb === 'verify') {
      const r = p.verifyProviders(c);
      if (r.ok) return say(`all ${r.checked} provider files match the pinned manifest`);
      for (const b of r.bad.slice(0, 20)) say(`✗ ${b}`);
      say(`${r.bad.length} problem${r.bad.length > 1 ? 's' : ''}: run crewdeck jobs providers install`);
      process.exitCode = 1;
      return;
    }
    throw new Error(usage);
  },

  pick: (args) => withCtx(async (ctx) => {
    noForceFlag(args);
    const day = flag(args, 'day') ?? todayOf(ctx);
    if (!isDay(day)) throw new Error('--day must be YYYY-MM-DD');
    const role = flag(args, 'role');
    if (role) {
      const id = roleArg(role, 'usage: crewdeck jobs pick --role <id> [--request <link request id>]');
      let force = false;
      if (args.includes('--request')) {
        // A role read from the page by hand (the link's `needs` path): the override is the request's, and only for the
        // posting that request carries.
        const r = await requestPayload(args, 'link');
        const want = checkRoleUrl(String(r.payload.url ?? ''), ctx.features);
        if (getRole(ctx.db, id).url !== want) throw new Error(`role ${id} is not the posting of request ${r.id} (${want})`);
        force = r.payload.force === true;
      }
      const warnings = pickPasted(ctx, id, day, force);
      if (warnings.length) { json({ picked: false, warnings }); process.exitCode = 2; return; }
      return json({ picked: true, role, day });
    }
    const ids = pick(ctx, intArg(flag(args, 'n'), 'n', dailyPicks(ctx)), day);
    for (const id of ids) {
      const r = ctx.db.prepare('select c.name company, r.title from roles r join companies c on c.id=r.company_id where r.id=?').get(id) as any;
      say(`${id}  ${r.company} — ${r.title}`);
    }
    if (!ids.length) say('nothing to pick: no eligible roles (judge candidates first)');
    // A Find's funnel is stored with its run; picking changes its last number.
    const { refreshFunnel } = await import('./pipeline/rank.ts');
    const f = refreshFunnel(ctx);
    if (f && f.picked < f.need) say(`funnel: ${f.line}${f.rules_line ? `. ${f.rules_line}` : ''}`);
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
    const usage = `usage: crewdeck jobs role <id> [--apply-url-file <f>] [--apply-method ${APPLY_METHODS.join('|')} [--apply-note-file <f>]] [--lang <xx>]`;
    const role = roleArg(positional(args)[0], usage);
    const url = flag(args, 'apply-url-file'), method = flag(args, 'apply-method'), lang = flag(args, 'lang');
    if (!url && !method && !lang) throw new Error(usage);
    if (url) say(`apply URL set: ${setApplyUrl(ctx, role, text(url, usage).trim())}`);
    // D35: how the employer takes applications; the note (where and when to walk in, the address to email) from a file.
    if (method) say(`apply method: ${setApplyMethod(ctx, role, method, optText(args, 'apply-note-file'))}`);
    if (lang) say(`form language: ${setFormLang(ctx, role, lang)}`);
  }),

  form: (args) => withCtx(async (ctx) => {
    const usage = 'usage: crewdeck jobs form <role> [--url-file <f with the form\'s address>] | --fields-file <f> ([{ label, kind, required?, options?, sensitive? }]) [--lang <xx>]';
    const role = roleArg(positional(args)[0], usage);
    if (flag(args, 'lang')) say(`form language: ${setFormLang(ctx, role, flag(args, 'lang')!)}`);
    if (flag(args, 'fields-file')) {
      const fields = cleanQuestions(jsonFile(flag(args, 'fields-file'), '--fields-file'));
      const n = storeFormFields(ctx.db, role, notesOf(ctx).profile.data, fields);
      const left = fields.filter((f) => f.kind !== 'file' && f.label).length - n;
      return say(`${n} question${n === 1 ? '' : 's'} stored for ${role}${left > 0 ? `; ${left} ID, bank or tax number question${left === 1 ? '' : 's'} not stored (the user types those)` : ''}`);
    }
    // Headless: the role's form through the guarded browser.
    const { readForm } = await import('./read-form.ts');
    const r = await readForm(ctx, role, { url: optText(args, 'url-file')?.trim() || undefined, browser: loadConfig().jobs.browser });
    json({ ...r, questions: r.questions.map((q) => ({ label: q.label, kind: q.kind, required: q.required, options: q.options?.length ? q.options : undefined })) });
    if (r.needs) process.exitCode = 2;
  }),

  link: (args) => withCtx(async (ctx) => {
    noForceFlag(args);
    const usage = 'usage: crewdeck jobs link --request <id> | --url-file <f with the posting\'s address>';
    const { link } = await import('./link.ts');
    let input: { url: string; force: boolean };
    if (flag(args, 'request')) {
      // The link and the user's "add anyway" come from the page's request; --force is not taken from the command line here.
      const { payload } = await requestPayload(args, 'link');
      input = { url: String(payload.url ?? ''), force: payload.force === true };
    } else if (flag(args, 'url-file')) input = { url: text(flag(args, 'url-file'), '--url-file').trim(), force: false };
    else throw new Error(usage);
    const r = await link(ctx, input);
    json(r);
    if (r.warnings.length && !r.picked && !r.closed) process.exitCode = 2;
  }),

  linkedin: (args) => withCtx(async (ctx) => {
    const usage = 'usage: crewdeck jobs linkedin search [--days N] [--max-requests N]';
    if (positional(args)[0] !== 'search') throw new Error(usage);
    const days = intArg(flag(args, 'days'), 'days', 7);
    if (days < 1 || days > 30) throw new Error('--days must be from 1 to 30');
    const { searchLinkedin } = await import('./linkedin.ts');
    const r = await searchLinkedin(ctx, { days, maxRequests: intArg(flag(args, 'max-requests'), 'max-requests', 30) });
    say(`LinkedIn: ${r.cards} postings found, ${r.stored} stored, ${r.skipped} skipped by your rules or closed, ${r.known} already known (${r.requests} requests)`);
    if (r.stopped) say(r.stopped);
    for (const e of r.errors) say(`error: ${e}`);
    if (r.stored) say('next: crewdeck jobs prefilter, then candidates');
  }),

  resume: (args) => withCtx(async (ctx) => {
    const usage = 'usage: crewdeck jobs resume <role> --variant-file <f.json> ({ "sections": { "<section id>": ["<fact id>", …] }, "skills"?: [...] })';
    const role = roleArg(positional(args)[0], usage);
    if (!flag(args, 'variant-file')) throw new Error(usage);
    const { renderResume } = await import('./resume.ts');
    const r = await renderResume(ctx, role, jsonFile(flag(args, 'variant-file'), '--variant-file'), { browser: loadConfig().jobs.browser });
    json({ pdf: r.pdf, pages: r.pages, facts: r.facts, ...(r.warnings.length ? { warnings: r.warnings } : {}) });
  }),

  letter: (args) => withCtx(async (ctx) => {
    const usage = 'usage: crewdeck jobs letter <role> --text-file <f> --claims-file <f> [--lang <xx>]';
    const role = roleArg(positional(args)[0], usage);
    if (!flag(args, 'text-file') || !flag(args, 'claims-file')) throw new Error(usage);
    const { renderLetter } = await import('./letter.ts');
    const r = await renderLetter(ctx, role, text(flag(args, 'text-file'), '--text-file'), jsonFile(flag(args, 'claims-file'), '--claims-file') as Claim[], { browser: loadConfig().jobs.browser, lang: flag(args, 'lang') });
    json({ pdf: r.pdf, pages: r.pages, lang: r.lang });
  }),

  draft: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs draft <role> --brief <out.json> | --answers <claude-answers.json>';
    const role = roleArg(positional(args)[0], usage);
    const brief = flag(args, 'brief'), answers = flag(args, 'answers');
    if (brief) {
      const out = checkedPath(brief, '--brief', jobsFileRoots(), 'write');
      const b = prepareDraft(ctx, role);
      writeFileSync(out, JSON.stringify(b, null, 1), { mode: 0o600 });
      say(`${b.res.answered} answered from your profile and memory; ${b.res.first_time} need you; ${b.refs.length ? `brief written: ${b.refs.length} for Claude (${b.refs.join(', ')})` : 'nothing for Claude'}`);
    } else if (answers) json(applyDraft(ctx, role, jsonFile(answers, '--answers')));
    else throw new Error(usage);
  }),

  answer: async (args) => {
    if (flag(args, 'request')) return answerForRequest(args);
    return answerCmd(args);
  },
  learn: (args) => withCtx((ctx) => {
    const usage = 'usage: crewdeck jobs learn <role> --label-file <f> [--answer-file f] [--quote-file f] [--options-file f] [--claims-file f] [--required] [--sensitive]';
    const role = roleArg(positional(args)[0], usage);
    const opts = optText(args, 'options-file');
    const options = opts === undefined ? undefined : opts.trim().startsWith('[') ? (JSON.parse(opts) as unknown[]).map(String) : opts.split('\n');
    const r = learnField(ctx, role, {
      label: text(flag(args, 'label-file'), '--label-file'), answer: optText(args, 'answer-file'), quote: optText(args, 'quote-file'), options,
      claims: flag(args, 'claims-file') ? jsonFile(flag(args, 'claims-file'), '--claims-file') : undefined, required: args.includes('--required') ? true : undefined,
      sensitive: args.includes('--sensitive') ? true : undefined,
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

  'fill-plan': async (args) => {
    const usage = 'usage: crewdeck jobs fill-plan <role> | --request <id> --fields-file <f> [--page-url-file <f>]';
    // An apply request names its role; the Easy Apply cap is counted inside planForRole either way.
    const role = flag(args, 'request') ? String((await requestPayload(args, 'apply')).payload.role ?? '') : positional(args)[0];
    return withCtx((ctx) => fillPlanCmd(ctx, args, roleArg(role, usage), usage));
  },

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

  // What the page asked for: the payload (a link, a role, a question) and its context, read by request id (design D11).
  request: async (args) => {
    const [verb, id] = positional(args);
    if (verb !== 'show' || !/^\d+$/.test(id ?? '')) throw new Error('usage: crewdeck jobs request show <id>');
    json(await showRequest(id));
  },

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
  source [--since N] [--only-new-sources] [--no-portals]  fetch new roles from your sources in priority order (sandboxed), then your rules
  sources list|suggest|add|remove|move|enable|disable   your ordered list of sources (crewdeck jobs sources --help)
  portals list|connect <id> [--signup]|disconnect <id>|test <id>|on <id>|off <id>   signed-in job portals (you sign in yourself)
  preview [--search-file f] [--days N] [--source key] [--json]   what your rules (or a change to them) catch, read-only
  providers install | status | verify     the pinned job-board providers (download, check, re-hash)
  candidates [--limit N]                  unjudged roles, best first (JSON)
  candidates --budget N [--batch 10] [--need N] [--start]   the next batch for a Find within a budget (≤ 40)
  judge --results-file f                  store verdicts [{ role, eligible: yes|no|unclear, score, evidence, reason? }]
  pick [--n N] [--day D] | pick --role <id> [--request <link request id>]   ("Add it anyway" only from the request)
  add-role --role-file f | status <role> <status> [--reason-file f]
  role <id> [--apply-url-file f] [--apply-method form|email|document|walk_in|chatbot|account_needed [--apply-note-file f]] [--lang xx]
  event add <role> --kind k --detail-file f | question add <role> --text-file f
  applied <role> | not-interested <role> --reason-file f [--title-words-file f]
page requests (the payload comes from Crewdeck by id, never through the shell):
  request show <id>                       what the Jobs page asked for (payload and context, as JSON)
  link --request <id>                     a pasted link from the page
  answer --request <id> --text-file f --claims-file f      an "Ask Claude" rewrite (citation check)
  fill-plan --request <id> --fields-file f [--page-url-file f]   the plan for an apply request's live form
the web (through the SSRF guard; addresses only from files):
  link --url-file f                       read a pasted posting, add it, pick it for today
  linkedin search [--days N]              LinkedIn guest search (only when you switched it on)
  form <role> [--url-file f]              read the application form headlessly and store its questions
  resume <role> --variant-file f          render the tailored resume PDF from fact ids (in resume.language)
  letter <role> --text-file f --claims-file f [--lang xx]   a cited cover letter or statement PDF
knowledge and answers:
  form <role> --fields-file f [--lang xx]   store questions read from a form by hand (ID, bank, tax numbers never)
  draft <role> --brief out.json | --answers f
  answer <role> --question Qn --text-file f (--quote-file f [--everywhere] | --claims-file f [--instruction-file f])
  learn <role> --label-file f [--answer-file f] [--quote-file f] [--options-file f] [--claims-file f] [--required] [--sensitive]
  undo | knowledge <words>
  fill-plan <role> --fields-file f [--page-url-file f]
outreach (off until you switch it on): contact add --file f | message add|check <role> … | message sent <id> | followups | followup done <id> nudge|final
views: view today [--role id] | applications | knowledge [--tab t]`;
