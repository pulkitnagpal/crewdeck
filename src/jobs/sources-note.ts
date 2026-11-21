// Writing jobs/sources.md (design D20, §24.2): one ordered `sources:` list, changed only through these operations, which
// the CLI (`crewdeck jobs sources …`) and the Jobs page share, so both write the same bytes for the same change. Each
// change is validated before the file is touched, written with the yaml Document API (comments and order kept) under
// the note's lock, and logged under "## Changes". The first change to a v1 note (boards: + watchlist:) moves both lists
// into `sources:` (boards first), keeping the keys they were read with.
import { existsSync, statSync } from 'node:fs';
import { type Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from 'yaml';
import { readNote, renderNote, writeAtomic } from './notes.ts';
import { addChangeLine } from './edit.ts';
import { withLock } from './memory.ts';
import { type SourceItem, SOURCE_KEY, slugOf, sourceItems, validate } from './schema.ts';
import { join } from 'node:path';
import { catalogEntry } from './catalog.ts';
import { type Ctx, notesOf, todayOf } from './ctx.ts';
import { NOTES } from './notes.ts';
import { type KeyState, readSourcesState } from './sources.ts';

export const SOURCES_COMMENT = ' Where to look, in priority order: the first is fetched first and ranks first. Change it on Jobs → Sources, or ask Claude.';
const TEMPLATE_FRONT = `tags: jobs\n#${SOURCES_COMMENT}\nsources: []\n`;

export type NewSource = { name?: string; provider?: string; careers_url?: string; url?: string; why?: string; employer?: boolean; linkedin?: boolean;
  /** A signed-in portal's id (ADR-0008 §7), added switched off with `enabled: false`. */ portal?: string; enabled?: boolean };
export type SourceOp =
  | { op: 'add'; source: NewSource; at?: number }
  | { op: 'remove'; key: string }
  | { op: 'move'; key: string; to: number }
  | { op: 'enable' | 'disable'; key: string }
  /** P9b: what resolve or Claude found (provider, careers_url, fetch: none and why). `null` removes a field. */
  | { op: 'set'; key: string; fields: Partial<Record<'provider' | 'careers_url' | 'url' | 'fetch' | 'why', string | null>>; line: string };
export type OpResult = { changed: boolean; key: string; line: string; items: SourceItem[]; migrated: boolean };

const MAX_SOURCES = 200;

/** A new key: the name's slug, never one in `used` (the note's keys, the state file's history, the tracker's). */
export function newKey(name: string, used: Set<string>): string {
  const base = slugOf(name).slice(0, 40);
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  return key;
}

const flowMap = (doc: Document, o: Record<string, unknown>) => { const n = doc.createNode(o) as YAMLMap; n.flow = true; return n; };

/** The `sources:` sequence, created from v1's boards then watchlist when the note has none. */
function sourcesSeq(doc: Document): { seq: YAMLSeq; migrated: boolean } {
  if (doc.contents === null || !isMap(doc.contents)) doc.contents = doc.createNode({}) as any;
  const root = doc.contents as YAMLMap;
  const have = root.get('sources', true);
  if (isSeq(have)) {
    // The template's empty `sources: []` becomes a block list once it has entries: one source per line.
    if (!have.items.length) have.flow = false;
    return { seq: have, migrated: false };
  }
  const js = doc.toJS() ?? {};
  const items = sourceItems(js).items;
  const seq = new YAMLSeq();
  const nodes: unknown[] = [];
  for (const k of ['boards', 'watchlist']) { const s = root.get(k, true); if (isSeq(s)) nodes.push(...s.items); }
  const migrated = items.length > 0 || root.has('boards') || root.has('watchlist');
  items.forEach((it, i) => {
    const node = nodes[i];
    if (isMap(node)) {
      // Keep the entry as written (options, quotes, comment); add the key it was read with, mark employers.
      if (!node.has('key')) node.items.unshift(doc.createPair('key', it.key) as any);
      if (it.employer && !node.has('employer')) node.set('employer', true);
      seq.items.push(node);
    } else seq.items.push(flowMap(doc, { key: it.key, ...it.entry }));
  });
  const pair = root.items.find((p: any) => p.key?.value === 'boards' || p.key?.value === 'watchlist');
  const before = (pair?.key as any)?.commentBefore;
  root.delete('boards');
  root.delete('watchlist');
  root.set('sources', seq);
  const sp = root.items.find((p: any) => p.key?.value === 'sources' || p.key === 'sources');
  if (sp) {
    const key = doc.createNode('sources') as any;
    key.commentBefore = before && /boards|watchlist/.test(before) ? SOURCES_COMMENT : before ?? SOURCES_COMMENT;
    sp.key = key;
  }
  return { seq, migrated };
}

const keyOf = (n: unknown) => (isMap(n) ? String((n as YAMLMap).get('key') ?? '') : '');

function describe(s: NewSource): string {
  if (s.linkedin) return 'LinkedIn (its switch stays in Jobs → Settings)';
  if (s.portal) return `the portal ${s.name ?? s.portal}${s.enabled === false ? ' (switched off)' : ''}`;
  if (s.provider) { const cat = catalogEntry(s.provider)?.name; return cat && cat !== s.name ? `${s.name} (${cat})` : String(s.name ?? s.provider); }
  return `${s.name} (${s.careers_url ?? s.url})`;
}

/** Apply one operation to the note's document; throws a plain message when it can't apply. */
export function applyOp(doc: Document, op: SourceOp, o: { today: string; used?: Set<string> }): { key: string; line: string; migrated: boolean } {
  const { seq, migrated } = sourcesSeq(doc);
  const idx = (key: string) => {
    const i = seq.items.findIndex((n) => keyOf(n) === key);
    if (i < 0) throw new Error(`no source with key ${key} (crewdeck jobs sources list shows the keys)`);
    return i;
  };
  if (op.op === 'add') {
    const s = op.source;
    if (seq.items.length >= MAX_SOURCES) throw new Error(`at most ${MAX_SOURCES} sources`);
    const current = sourceItems(doc.toJS()).items;
    if (s.linkedin) {
      if (current.some((x) => x.linkedin)) throw new Error('LinkedIn is already in your list: move it instead');
    } else if (s.portal) {
      if (s.provider || s.careers_url || s.url) throw new Error('a portal row takes no provider, careers page or web address');
      const dup = current.find((x) => x.portal === s.portal);
      if (dup) throw new Error(`the portal ${s.portal} is already in your list as ${dup.key}: switch it on or off instead`);
    } else {
      const n = [s.provider, s.careers_url, s.url].filter(Boolean).length;
      if (n !== 1 && !(s.provider && s.careers_url && !s.url)) throw new Error('give one of a provider, a careers page or a web address');
      if (s.provider && !s.careers_url && current.some((x) => x.provider === s.provider && !x.careers_url && !x.employer)) throw new Error(`${s.provider} is already in your list`);
      const same = (u?: string) => u && current.find((x) => x.careers_url === u || x.url === u);
      const dup = same(s.careers_url) || same(s.url);
      if (dup) throw new Error(`that page is already in your list as ${dup.key}`);
    }
    const used = new Set([...(o.used ?? []), ...current.map((x) => x.key)]);
    const name = s.linkedin ? 'LinkedIn' : s.portal ? (s.name?.trim() || s.portal) : (s.name?.trim() || catalogEntry(s.provider ?? '')?.name || s.provider || hostName(s.careers_url ?? s.url));
    const key = newKey(s.linkedin ? 'linkedin' : s.portal ? `portal-${s.portal}` : s.provider && !s.careers_url && !s.name?.trim() ? s.provider : name, used);
    const entry: Record<string, unknown> = { key, name };
    if (s.linkedin) entry.linkedin = 'search';
    if (s.portal) { entry.portal = s.portal; if (s.enabled === false) entry.enabled = false; }
    if (s.provider) entry.provider = s.provider;
    if (s.careers_url) entry.careers_url = s.careers_url;
    if (s.url) { entry.url = s.url; entry.fetch = 'none'; entry.why = s.why ?? 'not checked yet: crewdeck jobs sources resolve ' + key; }
    if (s.employer) entry.employer = true;
    entry.added = o.today;
    const at = op.at === undefined ? seq.items.length : Math.max(0, Math.min(seq.items.length, op.at));
    seq.items.splice(at, 0, flowMap(doc, entry));
    return { key, line: `added ${describe({ ...s, name })} at position ${at + 1}`, migrated };
  }
  const i = idx(op.key);
  const node = seq.items[i] as YAMLMap;
  const name = String(node.get('name') ?? op.key);
  if (op.op === 'remove') { seq.items.splice(i, 1); return { key: op.key, line: `removed ${name}`, migrated }; }
  if (op.op === 'move') {
    const to = Math.max(0, Math.min(seq.items.length - 1, op.to));
    if (to === i) return { key: op.key, line: '', migrated };
    seq.items.splice(i, 1);
    seq.items.splice(to, 0, node);
    return { key: op.key, line: `moved ${name} to position ${to + 1}`, migrated };
  }
  if (op.op === 'enable' || op.op === 'disable') {
    if (node.has('linkedin')) throw new Error('LinkedIn is switched on or off in Jobs → Settings (only you can change it): this list only orders it');
    const want = op.op === 'enable';
    const was = node.get('enabled') !== false;
    if (want === was) return { key: op.key, line: '', migrated };
    if (want) node.delete('enabled'); else node.set('enabled', false);
    return { key: op.key, line: `${want ? 'switched on' : 'switched off'} ${name}`, migrated };
  }
  if (op.op === 'set') {
    if (node.has('linkedin')) throw new Error('the LinkedIn row has nothing to set');
    let changed = false;
    for (const [k, v] of Object.entries(op.fields)) {
      if (v === null) { if (node.has(k)) { node.delete(k); changed = true; } }
      else if (node.get(k) !== v) { node.set(k, v); changed = true; }
    }
    return { key: op.key, line: changed ? op.line : '', migrated };
  }
  throw new Error('unknown operation');
}

// ---- the readable list in the note's body ----
// The sources live in the note's frontmatter, which Notes hides ("17 frontmatter lines hidden"): the body gets the same
// list in words, between these markers, rewritten by Crewdeck whenever the sources change. Text outside them is yours.
export const LIST_START = '<!-- crewdeck:sources -->';
export const LIST_END = '<!-- /crewdeck:sources -->';

const kindWords = (it: SourceItem) => (it.linkedin ? 'LinkedIn' : it.employer ? 'careers page' : it.url && !it.provider ? 'web address' : 'job board');

/** The list as Markdown: one line per source, in priority order, with what it is and whether it is on. */
export function sourcesList(items: SourceItem[]): string {
  const lines = items.map((it, i) => {
    const state = it.linkedin ? 'on or off in Jobs → Settings' : it.enabled ? 'on' : 'off';
    const where = it.careers_url ? ` (${hostName(it.careers_url)})` : it.url ? ` (${hostName(it.url)})` : '';
    return `${i + 1}. **${it.name.replace(/[*_`[\]<>]/g, '')}**${where}: ${kindWords(it)}, ${state}`;
  });
  return [LIST_START, '## Where Crewdeck looks', '',
    'In this order. Change it on Crewdeck → Jobs → Sources, or ask Claude; Crewdeck rewrites this list.', '',
    ...(lines.length ? lines : ['No sources yet: Crewdeck → Jobs → Sources, or ask Claude to suggest some.']), LIST_END].join('\n');
}

/** The body with the list in place: replaced between the markers, or added after the first heading (else at the top). */
export function withSourcesList(body: string, items: SourceItem[]): string {
  const list = sourcesList(items);
  const a = body.indexOf(LIST_START), b = body.indexOf(LIST_END);
  if (a >= 0 && b > a) return body.slice(0, a) + list + body.slice(b + LIST_END.length);
  const lines = body.split('\n');
  const h = lines.findIndex((l) => /^#\s/.test(l));
  if (h < 0) return `${list}\n\n${body}`;
  lines.splice(h + 1, 0, '', list);
  return lines.join('\n');
}

/** Bring the note's list up to date (on Crewdeck's start, after a hand edit). No Changes line: nothing about the sources changed. */
export function refreshSourcesList(file: string): boolean {
  if (!existsSync(file)) return false;
  return withLock(file, () => {
    const n = readNote(file);
    if (n.errors.length) return false;
    const before = statSync(file).mtimeMs;
    const body = withSourcesList(n.body, sourceItems(n.doc.toJS() ?? {}).items);
    if (body === n.body) return false;
    if (statSync(file).mtimeMs !== before) return false;
    writeAtomic(file, renderNote(n.doc, body));
    return true;
  });
}

function hostName(u?: string): string { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return 'source'; } }

/**
 * Change jobs/sources.md: one operation, validated, written atomically under the note's lock, logged under Changes. A
 * missing note starts from the template. The note's errors (if any) must be fixed first.
 */
export function editSources(file: string, op: SourceOp, o: { today: string; used?: Set<string> }): OpResult {
  return withLock(file, () => {
    const n = existsSync(file) ? readNote(file) : { exists: false, doc: parseDocument(TEMPLATE_FRONT), body: '# Job sources\n', errors: [] as string[] };
    if (n.errors.length) throw new Error(`jobs/sources.md can't be read (${n.errors[0]}): fix it in Notes first`);
    const before = existsSync(file) ? statSync(file).mtimeMs : 0;
    const old = validate('sources', n.doc.toJS() ?? {}).filter((i) => i.level === 'error');
    if (old.length) throw new Error(`jobs/sources.md has errors: ${old.map((i) => `${i.path}: ${i.message}`).join('; ')}. Fix them first (crewdeck jobs check)`);
    const r = applyOp(n.doc, op, o);
    const after = n.doc.toJS() ?? {};
    const errs = validate('sources', after).filter((i) => i.level === 'error');
    if (errs.length) throw new Error(errs.map((i) => `${i.path}: ${i.message}${i.fix ? ` (${i.fix})` : ''}`).join('\n'));
    const lines = [r.migrated ? `${o.today}: moved boards and watchlist into one ordered sources list` : '', r.line ? `${o.today}: ${r.line}` : ''].filter(Boolean);
    if (!lines.length) return { changed: false, key: r.key, line: '', items: sourceItems(after).items, migrated: false };
    let body = withSourcesList(n.body, sourceItems(after).items);
    for (const l of lines) body = addChangeLine(body, l);
    if (existsSync(file) && statSync(file).mtimeMs !== before) throw new Error('jobs/sources.md changed while Crewdeck was writing it: try again');
    writeAtomic(file, renderNote(n.doc, body));
    return { changed: true, key: r.key, line: r.line, items: sourceItems(after).items, migrated: r.migrated };
  });
}

/** Keys a new source must not take: the note's, plus every key the state file or the tracker has seen. */
export function usedKeys(file: string, extra: Iterable<string> = []): Set<string> {
  const out = new Set<string>(extra);
  try { for (const it of sourceItems(readNote(file).doc.toJS() ?? {}).items) out.add(it.key); } catch {}
  return out;
}

export const isKey = (k: unknown): k is string => typeof k === 'string' && SOURCE_KEY.test(k);

// ---- what the CLI and the Jobs page share ----

export type SourceRow = {
  position: number; key: string; name: string; kind: string; enabled: boolean; employer: boolean;
  provider?: string; careers_url?: string; url?: string; fetch: 'auto' | 'none'; why?: string; regions: string[];
  confidence?: string; coverage?: string; last?: KeyState;
  /** The LinkedIn row: its three switches, which only the user changes (Jobs → Settings). */ switches?: Record<string, boolean>;
};

/** The user's sources in order, each with its catalog facts and its last fetch. */
export function listSources(ctx: Ctx): SourceRow[] {
  const notes = notesOf(ctx);
  const state = readSourcesState(ctx.home);
  return notes.sources.data.items.map((it, i) => {
    const cat = it.linkedin ? catalogEntry('linkedin') : it.provider ? catalogEntry(it.provider) : undefined;
    const kind = it.linkedin ? 'linkedin' : it.portal ? 'portal' : it.employer ? 'employer' : it.url ? 'custom' : cat?.kind ?? (it.careers_url ? 'careers page' : 'unknown');
    const last = state?.by_key?.[it.linkedin ? 'linkedin' : it.key];
    const row: SourceRow = {
      position: i + 1, key: it.key, name: it.name, kind, enabled: it.linkedin ? ctx.features.linkedin_search : it.enabled, employer: it.employer,
      fetch: it.fetch, regions: cat?.regions ?? [], ...(it.provider ? { provider: it.provider } : {}), ...(it.careers_url ? { careers_url: it.careers_url } : {}),
      ...(it.url ? { url: it.url } : {}), ...(it.why ? { why: it.why } : {}), ...(cat ? { confidence: cat.confidence, coverage: cat.coverage } : {}),
      ...(last ? { last: (({ history: _, ...l }) => l)(last) } : {}),
    };
    if (it.linkedin) row.switches = { linkedin_search: ctx.features.linkedin_search, linkedin_links: ctx.features.linkedin_links, easy_apply: ctx.features.easy_apply };
    return row;
  });
}

/** Every key a new source must avoid: the note's, the state file's (with history) and the tracker's. */
export function keysInUse(ctx: Ctx): Set<string> {
  const out = new Set<string>(Object.keys(readSourcesState(ctx.home)?.by_key ?? {}));
  for (const r of ctx.db.prepare('select distinct source_key k from roles where source_key is not null').all() as any[]) out.add(String(r.k));
  return usedKeys(join(ctx.vault, NOTES.sources), out);
}

/** One validated change to jobs/sources.md (CLI and page alike). */
export function changeSources(ctx: Ctx, op: SourceOp): OpResult {
  if ((op as any).key !== undefined && !isKey((op as any).key)) throw new Error('a source key is lowercase letters, digits and - (crewdeck jobs sources list shows them)');
  return editSources(join(ctx.vault, NOTES.sources), op, { today: todayOf(ctx), used: op.op === 'add' ? keysInUse(ctx) : undefined });
}
