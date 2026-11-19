// `crewdeck jobs sources …` (design §24.2–24.4, D11): the user's ordered list of sources in jobs/sources.md. Names and
// web addresses come only from files (written with the Write tool); provider ids, keys and positions are checked words.
import { loadConfig } from '../config.ts';
import { type Ctx, notesOf, openCtx } from './ctx.ts';
import { flag, positional, textFrom } from './cli.ts';
import { catalogEntry } from './catalog.ts';
import { suggestSources } from './suggest.ts';
import { type SourceOp, changeSources, listSources } from './sources-note.ts';

const say = (s: string) => console.log(s);
const json = (v: unknown) => say(JSON.stringify(v, null, 1));

export const SOURCES_USAGE = `usage: crewdeck jobs sources <verb>
  list [--json]                            your sources in priority order, with their last fetch
  suggest [--json]                         sources that fit your notes, and what isn't covered
  add --provider <id> [--name-file f] [--at N]
  add --careers-url-file f --name-file f [--employer] [--at N]   an employer's careers page
  add --url-file f --name-file f [--at N]  any other job page (kept as "paste its postings" until a provider reads it)
  add --linkedin [--at N]                  place LinkedIn in the list (switching it on stays in Jobs → Settings)
  remove <key> | enable <key> | disable <key>
  move <key> up|down|first|last | move <key> --to N`;

/** One line of text from a file: trimmed, no line breaks, at most `max` characters. */
function oneLine(path: string | undefined, what: string, max: number): string {
  const t = textFrom(path, what).replace(/\r?\n$/, '').trim();
  if (!t) throw new Error(`${what} is empty`);
  if (/[\r\n]/.test(t)) throw new Error(`${what} must be one line`);
  if (t.length > max) throw new Error(`${what} is longer than ${max} characters`);
  return t;
}

/** A web address from a file: http(s), no spaces, ≤ 2000 characters. */
export function urlFrom(path: string | undefined, what: string): string {
  const u = oneLine(path, what, 2000);
  let p: URL;
  try { p = new URL(u); } catch { throw new Error(`${what}: not a web address (https://…)`); }
  if (!/^https?:$/.test(p.protocol) || /\s/.test(u)) throw new Error(`${what}: not a web address (https://…)`);
  return p.href;
}

function position(v: string | undefined, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,3}$/.test(v) || Number(v) < 1) throw new Error(`${what} is a position: 1 for the top`);
  return Number(v) - 1;
}

async function withCtx<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T> {
  const ctx = openCtx(loadConfig());
  try { return await fn(ctx); } finally { ctx.db.close(); }
}

function addOp(args: string[]): SourceOp {
  const at = position(flag(args, 'at'), '--at');
  const name = flag(args, 'name-file') ? oneLine(flag(args, 'name-file'), '--name-file', 200) : undefined;
  if (args.includes('--linkedin')) return { op: 'add', source: { linkedin: true }, at };
  const provider = flag(args, 'provider');
  if (provider !== undefined) {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(provider)) throw new Error('--provider is a provider id (crewdeck jobs sources suggest lists them)');
    const cat = catalogEntry(provider);
    if (cat?.needs === 'careers_url' && !flag(args, 'careers-url-file')) throw new Error(`${provider} reads one ${cat.kind === 'ats' ? 'employer' : 'page'} per entry: add it with --careers-url-file (the employer's careers page) and --name-file`);
    return { op: 'add', source: { provider, name, ...(flag(args, 'careers-url-file') ? { careers_url: urlFrom(flag(args, 'careers-url-file'), '--careers-url-file'), employer: args.includes('--employer') } : {}) }, at };
  }
  if (flag(args, 'careers-url-file')) {
    if (!name) throw new Error('--name-file is required (the employer\'s name)');
    return { op: 'add', source: { name, careers_url: urlFrom(flag(args, 'careers-url-file'), '--careers-url-file'), employer: args.includes('--employer') }, at };
  }
  if (flag(args, 'url-file')) {
    if (!name) throw new Error('--name-file is required (what to call this page)');
    return { op: 'add', source: { name, url: urlFrom(flag(args, 'url-file'), '--url-file') }, at };
  }
  throw new Error(SOURCES_USAGE);
}

function moveOp(ctx: Ctx, key: string, args: string[]): SourceOp {
  const items = notesOf(ctx).sources.data.items;
  const i = items.findIndex((x) => x.key === key);
  if (i < 0) throw new Error(`no source with key ${key} (crewdeck jobs sources list shows the keys)`);
  const to = position(flag(args, 'to'), '--to');
  const where = positional(args)[2];
  const target = to !== undefined ? to : where === 'up' ? i - 1 : where === 'down' ? i + 1 : where === 'first' ? 0 : where === 'last' ? items.length - 1 : NaN;
  if (Number.isNaN(target)) throw new Error('usage: crewdeck jobs sources move <key> up|down|first|last | --to N');
  return { op: 'move', key, to: Math.max(0, Math.min(items.length - 1, target)) };
}

function printList(ctx: Ctx) {
  const rows = listSources(ctx);
  if (!rows.length) return say('No sources yet: crewdeck jobs sources suggest proposes some from your notes.');
  for (const r of rows) {
    const state = r.kind === 'linkedin' ? `${r.enabled ? 'on' : 'off'} (Jobs → Settings)` : r.enabled ? (r.fetch === 'none' ? 'not fetched' : 'on') : 'off';
    const last = r.last ? (r.last.ok ? `${r.last.jobs} roles, ${r.last.new} new, ${r.last.kept} kept by your rules · ${r.last.at.slice(0, 16).replace('T', ' ')} UTC` : r.last.error ?? r.last.why ?? 'failed') : 'not fetched yet';
    say(`${String(r.position).padStart(2)}. ${r.name} [${r.key}] ${r.kind}${r.provider ? ` · ${r.provider}` : ''} · ${state} · ${last}`);
    if (r.fetch === 'none' && r.why) say(`      ${r.why}`);
  }
}

export async function sourcesCmd(args: string[]) {
  const [verb, key] = positional(args);
  if (verb === 'list') return withCtx((ctx) => (args.includes('--json') ? json(listSources(ctx)) : printList(ctx)));
  if (verb === 'suggest') return withCtx((ctx) => {
    const notes = notesOf(ctx);
    const have = new Set(notes.sources.data.items.map((x) => x.provider).filter(Boolean));
    const r = suggestSources(notes, {}, { linkedinOn: ctx.features.linkedin_search });
    const sources = r.sources.map((s) => ({ ...s, added: have.has(s.id) }));
    if (args.includes('--json')) return json({ sources, coverage: r.coverage, profile: r.profile });
    for (const s of sources) say(`${s.added ? '✓' : '·'} ${s.id.padEnd(22)} ${s.name}: ${s.reasons.join('; ')}${s.confidence !== 'high' && !s.reasons.includes('not verified') ? ' (not fully verified)' : ''}`);
    say('');
    say(r.coverage.line);
  });
  return withCtx((ctx) => {
    let op: SourceOp;
    if (verb === 'add') op = addOp(args);
    else if (verb === 'remove' || verb === 'enable' || verb === 'disable') { if (!key) throw new Error(SOURCES_USAGE); op = { op: verb, key }; }
    else if (verb === 'move') { if (!key) throw new Error(SOURCES_USAGE); op = moveOp(ctx, key, args); }
    else throw new Error(SOURCES_USAGE);
    const r = changeSources(ctx, op);
    say(r.changed ? `jobs/sources.md: ${r.line || 'updated'}${r.migrated ? ' (boards and watchlist moved into one ordered list)' : ''}` : 'jobs/sources.md: unchanged');
    if (verb === 'add') say(`key: ${r.key}`);
  });
}
