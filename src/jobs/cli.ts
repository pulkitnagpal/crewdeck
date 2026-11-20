// crewdeck jobs <cmd>: the notes Claude and the user share, the rules compiled from them, and the risky switches.
// Text in the user's words (because, text, quote, company) comes from files or stdin, never from the command line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { type Config, CONFIG_PATH, FEATURE_CAPS, FEATURE_DEFAULTS, type JobsFeatures, ensureHome, featureValue, loadConfig, readToken, setFeature } from '../config.ts';
import { type Issue, MEMORY_KINDS } from './schema.ts';
import { type FileRoots, readChecked } from '../files.ts';
import { NOTES, NOTE_NAMES, loadJobNotes } from './notes.ts';
import { compileRules, describeRules, judgeBrief } from './rules.ts';
import { meTarget, parsePath, setField } from './edit.ts';
import { retire } from './memory.ts';
import { RISK, confirmText, featureChanges, widens } from './features.ts';

const say = (s: string) => console.log(s);
export const flag = (a: string[], n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
export const positional = (a: string[]) => a.filter((x, i) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));

/** Where `crewdeck jobs` reads and writes files named on its command line: Jobs' home and workspace (E5, src/files.ts). */
export const jobsFileRoots = (): FileRoots => { const c = loadConfig(); return { roots: [...new Set([c.jobs.home, c.jobs.workspace])] }; };

/** A file's text (inside Jobs' home or workspace), or stdin for "-". */
export function textFrom(path: string | undefined, what: string): string {
  if (!path) throw new Error(`${what} is required`);
  return readChecked(path, what, jobsFileRoots());
}

function context() {
  const c = loadConfig();
  ensureHome(c.jobs.home); // Jobs' own machine state: private (0700)
  return c;
}

/** Today in the user's time zone (jobs/search.md schedule.timezone), else the system's. */
function today(c: Config): string {
  const tz = loadJobNotes(c.vault, null).search.data.schedule.timezone;
  try { return new Date().toLocaleDateString('en-CA', tz ? { timeZone: tz } : {}); } catch { return new Date().toLocaleDateString('en-CA'); }
}

export function formatIssues(issues: Issue[]): string[] {
  return issues.map((i) => `   ${i.level === 'error' ? 'error  ' : 'warning'}  ${i.path}: ${i.message}${i.fix ? `. Fix: ${i.fix}` : ''}`);
}

function check() {
  const c = context();
  const notes = loadJobNotes(c.vault, c.jobs.home);
  say(`Jobs notes in ${c.vault}`);
  for (const n of NOTE_NAMES) {
    const l = notes[n];
    const errs = l.issues.filter((i) => i.level === 'error').length;
    say(`${errs ? '✗' : '✓'} ${NOTES[n]}${l.source === 'last-valid' ? '  (using its last valid version)' : ''}`);
    for (const line of formatIssues(l.issues)) say(line);
  }
  const e = notes.issues.filter((i) => i.level === 'error').length, w = notes.issues.length - e;
  say(`${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'}`);
  if (e) process.exitCode = 1;
}

function rulesCmd() {
  const c = context();
  const notes = loadJobNotes(c.vault, c.jobs.home);
  say(describeRules(compileRules(notes)));
  warnBroken(notes.issues);
}

function briefCmd() {
  const c = context();
  const notes = loadJobNotes(c.vault, c.jobs.home);
  process.stdout.write(judgeBrief(notes));
  warnBroken(notes.issues);
}

function warnBroken(issues: Issue[]) {
  const errs = issues.filter((i) => i.level === 'error');
  if (errs.length) console.error(`\n${errs.length} error(s) in your notes (run crewdeck jobs check); broken notes count as their last valid version or empty.`);
}

/** The value: positional, --value-file <f>, or "-" for stdin. */
function valueArg(args: string[]): string {
  const file = flag(args, 'value-file');
  if (file) return textFrom(file, '--value-file').replace(/\n$/, '');
  const v = positional(args)[2];
  if (v === undefined) throw new Error('give a value, --value-file <file>, or - for stdin');
  return v === '-' ? readFileSync(0, 'utf8').replace(/\n$/, '') : v;
}

function me(args: string[]) {
  const [verb, path] = positional(args);
  if (verb !== 'set' || !path) throw new Error('usage: crewdeck jobs me set <field.path> <value> | --value-file <f> | -');
  const c = context();
  const { note, segs } = meTarget(path);
  const r = setField(join(c.vault, NOTES[note]), note, segs, valueArg(args));
  say(r.changed ? `${NOTES[note]}: ${r.path} set` : `${NOTES[note]}: ${r.path} unchanged`);
}

function pref(args: string[]) {
  const [verb, path] = positional(args);
  if (verb !== 'set' || !path) throw new Error('usage: crewdeck jobs pref set <field.path> <value> --because-file <file with the user\'s words>');
  const because = textFrom(flag(args, 'because-file'), '--because-file (the user\'s own words for the change)');
  const c = context();
  let segs = parsePath(path);
  if (segs[0] === 'search') segs = segs.slice(1);
  const r = setField(join(c.vault, NOTES.search), 'search', segs, valueArg(args), { because, today: today(c) });
  say(r.changed ? `jobs/search.md: ${r.path} set; change logged under ## Changes` : `jobs/search.md: ${r.path} unchanged`);
}

async function rememberCmd(args: string[]) {
  const c = context();
  const file = join(c.vault, NOTES.memory);
  const retireId = flag(args, 'retire');
  if (retireId) {
    retire(file, retireId);
    return say(`${retireId} retired (kept in jobs/memory.md as superseded_by: retired)`);
  }
  const kind = flag(args, 'kind') as (typeof MEMORY_KINDS)[number] | undefined;
  if (!kind) throw new Error(`usage: crewdeck jobs remember --kind ${MEMORY_KINDS.join('|')} --text-file <f> --quote-file <f> [--key k] [--scope all|company --company-file <f>] [--title-words-file <f>] [--supersedes m-N]  |  --retire m-N`);
  const words = flag(args, 'title-words-file');
  const input = {
    kind,
    text: textFrom(flag(args, 'text-file'), '--text-file'),
    quote: textFrom(flag(args, 'quote-file'), '--quote-file (the user\'s exact words)'),
    key: flag(args, 'key'),
    scope: flag(args, 'scope') as 'all' | 'company' | undefined,
    company: flag(args, 'company-file') ? textFrom(flag(args, 'company-file'), '--company-file').trim() : undefined,
    title_words: words ? textFrom(words, '--title-words-file').split(/[,\n]/).map((w) => w.trim()).filter(Boolean) : undefined,
    supersedes: flag(args, 'supersedes'),
  };
  // Through the knowledge base: the item is also applied to forms already read (and undoable with `jobs undo`).
  const { openCtx } = await import('./ctx.ts');
  const { remember: rememberKb } = await import('./kb/ops.ts');
  const ctx = openCtx(c);
  try {
    const r = rememberKb(ctx, input);
    if (r.existing) say(`already remembered as ${r.item.id}`);
    else say(`remembered ${r.item.id} (${r.item.kind})${r.superseded.length ? `; replaces ${r.superseded.join(', ')}` : ''}`);
    if (r.applied) say(`applied to ${r.applied} open question${r.applied > 1 ? 's' : ''}`);
  } finally { ctx.db.close(); }
}


async function features(args: string[]) {
  const [name, value] = positional(args);
  const c = loadConfig();
  if (!name) {
    for (const [k, v] of Object.entries(c.jobs.features)) say(`${k.padEnd(22)} ${String(typeof v === 'boolean' ? (v ? 'on' : 'off') : v).padEnd(4)} ${RISK[k as keyof JobsFeatures]}`);
    return say('\nOnly you can change these: Jobs → Settings, or crewdeck jobs features <name> <on|off|number> in your own terminal.');
  }
  if (!Object.hasOwn(FEATURE_DEFAULTS, name)) throw new Error(`unknown feature ${name} (known: ${Object.keys(FEATURE_DEFAULTS).join(', ')})`);
  // An agent's shell is not a terminal: risky switches change only when a person is at the keyboard (design D13).
  if (!process.stdin.isTTY) throw new Error('Only you can change feature switches: run this yourself in a terminal, or use Jobs → Settings.');
  if (value === undefined) throw new Error(`usage: crewdeck jobs features ${name} <${Object.hasOwn(FEATURE_CAPS, name) ? 'number' : 'on|off'}>`);
  const v: boolean | number = Object.hasOwn(FEATURE_CAPS, name) ? Number(value) : value === 'on' ? true : value === 'off' ? false : (() => { throw new Error('use on or off'); })();
  featureValue(name as keyof JobsFeatures, v);
  const changes = featureChanges(name as keyof JobsFeatures, v, c.jobs.features);
  if (widens(changes, c.jobs.features)) {
    // A terminal can be faked (`script`), so widening also needs a yes no agent can give: the system's own dialog, or
    // where there is none, the one-time code the Jobs page shows when you click the switch there.
    say(RISK[name as keyof JobsFeatures]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Type yes to switch it on: ')).trim().toLowerCase();
      if (answer !== 'yes') return say('Unchanged.');
      const { nativeConfirm, useCode } = await import('./confirm.ts');
      const native = await nativeConfirm()('Crewdeck', confirmText(changes));
      if (native === 'no') return say('Unchanged: the confirmation was cancelled.');
      if (native === 'unavailable') {
        const token = readToken();
        if (!token) throw new Error('No confirmation dialog on this system and no Crewdeck token: run crewdeck up, then click the switch in Jobs → Settings for a one-time code.');
        say('No confirmation dialog on this system. Click the switch in Jobs → Settings: the page shows a one-time code for this change.');
        const typed = await rl.question('Code from the Jobs page: ');
        if (!useCode(token, name, v, typed)) return say('Unchanged: that is not the code the Jobs page showed for this change (codes last 10 minutes).');
      }
    } finally { rl.close(); }
  }
  for (const ch of changes) setFeature(ch.name, ch.value, CONFIG_PATH);
  for (const ch of changes) say(`${ch.name}: ${typeof ch.value === 'boolean' ? (ch.value ? 'on' : 'off') : ch.value}`);
}

/** crewdeck jobs init [--preset <name>] [--home <dir>] [--workspace <dir>]: switch Jobs on and set it up (idempotent). */
async function init(args: string[]) {
  const { jobsInit, PRESETS } = await import('./setup.ts');
  const preset = flag(args, 'preset'), home = flag(args, 'home'), workspace = flag(args, 'workspace');
  if ((args.includes('--preset') && !preset) || (args.includes('--home') && !home) || (args.includes('--workspace') && !workspace)) throw new Error(`usage: crewdeck jobs init [--preset ${PRESETS.join('|')}] [--home <dir>] [--workspace <dir>] [--no-providers]`);
  for (const l of await jobsInit({ preset, home, workspace, providers: args.includes('--no-providers') ? false : undefined })) say(l);
}

const USAGE = `usage: crewdeck jobs <command>
  init [--preset <name>] [--home <dir>] [--workspace <dir>] [--no-providers]
                                          switch Jobs on: notes, tracker, guard rails, job-board providers
  check                                   validate your job notes (errors and warnings)
  rules                                   the hard drops compiled from your notes
  judge-brief                             the judging instructions built from your notes
  me set <field.path> <value>             me/profile.md or me/career.md (value, --value-file <f> or -)
  pref set <field.path> <value> --because-file <f>   jobs/search.md, logged under ## Changes
  remember --kind <kind> --text-file <f> --quote-file <f> [--key k] [--scope all|company --company-file <f>]
           [--title-words-file <f>] [--supersedes m-N]  |  remember --retire m-N
  features [<name> <on|off|number>]       risky switches (changing needs your own terminal)
  keys list|set|remove [<provider>]       your own job-API keys (set reads the key from stdin)`;

/** P2a's commands, loaded only when one of them runs (they open the tracker). */
const P2 = ['prefilter', 'refilter', 'candidates', 'judge', 'pick', 'status', 'event', 'question', 'applied', 'not-interested', 'add-role', 'role',
  'form', 'draft', 'answer', 'learn', 'undo', 'knowledge', 'fill-plan', 'contact', 'message', 'followups', 'followup', 'view',
  'link', 'linkedin', 'resume', 'letter', 'request', 'source', 'providers', 'sources', 'preview'];

/** Every `crewdeck jobs` command (the skills lint checks commands against this). */
export const JOBS_COMMANDS = ['init', 'check', 'rules', 'judge-brief', 'me', 'pref', 'remember', 'features', 'keys', ...P2];

export async function main(args: string[]) {
  const [cmd, ...rest] = args;
  // --help never runs a command (init would otherwise set Jobs up).
  if (rest.includes('--help') || rest.includes('-h')) {
    if (cmd === 'sources') return say((await import('./sources-cmd.ts')).SOURCES_USAGE);
    say(USAGE); say((await import('./commands.ts')).USAGE); return;
  }
  const run: Record<string, (a: string[]) => unknown> = { init, check, rules: rulesCmd, 'judge-brief': briefCmd, me, pref, remember: rememberCmd, features,
    keys: async (a) => (await import('./apis/keys-cmd.ts')).keysCmd(a) };
  if (cmd && P2.includes(cmd)) {
    const m = await import('./commands.ts');
    return await m.COMMANDS[cmd](rest);
  }
  if (!cmd || !Object.hasOwn(run, cmd)) {
    say(USAGE);
    if (cmd !== undefined) process.exitCode = 1;
    if (cmd === undefined || cmd === 'help') say((await import('./commands.ts')).USAGE);
    return;
  }
  await run[cmd](rest);
}
