// What Claude learned from the user (jobs/memory.md): answers, facts, preferences, style rules, "not interested"
// reasons and company rules, each in the user's words with their quote and date. Items are never deleted, only
// superseded (superseded_by: m-N) or retired, so undo and history work.
//
// Several writers can meet here (C10): two CLI calls from one session, the server's page actions, the user editing the
// note in SilverBullet. Every read-modify-write holds a lock file next to the note (O_EXCL, stale after 30 s), and the
// note's mtime and size are checked again just before the rename: a change by someone who doesn't take the lock (the
// editor) makes the write start over from the new text instead of overwriting it.
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';
import { readNote, renderNote, writeAtomic } from './notes.ts';
import { type MemoryItem, MEMORY_KINDS, validate } from './schema.ts';

export type MemoryInput = {
  kind: MemoryItem['kind']; text: string; quote: string; key?: string; scope?: 'all' | 'company'; company?: string;
  title_words?: string[]; supersedes?: string;
};
export type Remembered = { item: MemoryItem; existing: boolean; superseded: string[] };

const MAX = 2000;
const norm = (s?: string) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const TEMPLATE = '---\ntags: jobs\n# What Claude learned from you, in your words. Written by `crewdeck jobs remember`; items are never deleted.\nitems: []\n---\n# What Claude learned\n';

export const isActive = (m: MemoryItem) => !m.superseded_by;

/** Items that apply now: not superseded, and for everyone or for this company. */
export function activeMemory(items: MemoryItem[], company?: string): MemoryItem[] {
  return items.filter((m) => isActive(m) && (m.scope === 'all' || (!!company && norm(m.company) === norm(company))));
}

// ---- one writer at a time ----

const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 10_000, TRIES = 3;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const lockFile = (file: string) => join(dirname(file), `.${basename(file)}.lock`);

/** Run `fn` holding the note's lock file; a lock older than 30 s (a crashed writer) is taken over. */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = lockFile(file);
  const until = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, 'wx', 0o600); break; } catch (e: any) {
      if (e.code === 'ENOENT') throw new Error(`can't write ${basename(file)}: its folder is missing`);
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error(`${basename(file)} is being written by another Crewdeck command (${lock}): try again`);
      pause(15 + Math.random() * 30);
    }
  }
  try { writeSync(fd, String(process.pid)); return fn(); } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}

type Stamp = { mtimeMs: number; size: number } | null;
const stampOf = (file: string): Stamp => { try { const s = statSync(file); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } };
class Changed extends Error {}

/** Locked, and started over (up to 3 times) when the note changed under us. `afterRead` is a test hook. */
function update<T>(file: string, fn: (n: ReturnType<typeof open>) => T, hooks: Hooks = {}): T {
  mkdirSync(dirname(file), { recursive: true });
  return withLock(file, () => {
    for (let i = 1; ; i++) {
      try {
        const n = open(file);
        hooks.afterRead?.();
        return fn(n);
      } catch (e) {
        if (!(e instanceof Changed) || i >= TRIES) throw e instanceof Changed ? new Error('jobs/memory.md keeps changing while Crewdeck writes it (is it open in an editor?): try again') : e;
      }
    }
  });
}
export type Hooks = { afterRead?: () => void };

function open(file: string) {
  const stamp = stampOf(file);
  const n = readNote(file);
  // A missing note starts from the template (the user's vault may predate Jobs).
  if (!n.exists) return { ...n, stamp, doc: parseDocument(TEMPLATE.split('---\n')[1]), body: TEMPLATE.split('---\n').slice(2).join('---\n') };
  if (n.errors.length) throw new Error(`jobs/memory.md can't be read (${n.errors[0]}): fix it in Notes first`);
  const bad = validate('memory', n.doc.toJS() ?? {}).filter((i) => i.level === 'error');
  if (bad.length) throw new Error(`jobs/memory.md has errors (${bad[0].path}: ${bad[0].message}): fix it in Notes first, then try again`);
  return { ...n, stamp };
}

function itemsSeq(doc: Document) {
  let seq = doc.get('items', true) as any;
  if (!isSeq(seq)) { seq = doc.createNode([]); doc.set('items', seq); }
  seq.flow = false;
  return seq as YAMLSeq;
}

function check(input: MemoryInput) {
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new Error(`--kind must be one of ${MEMORY_KINDS.join(', ')}`);
  for (const [k, v] of [['text', input.text], ['quote', input.quote]] as const) {
    if (!v || !v.trim()) throw new Error(`the ${k} is empty`);
    if (v.length > MAX) throw new Error(`the ${k} is longer than ${MAX} characters`);
  }
  if (input.key !== undefined && !/^[a-z][a-z0-9_]*$/.test(input.key)) throw new Error('--key must be lowercase words joined by _ (e.g. notice_period)');
  if (input.kind === 'answer' && !input.key) throw new Error('an answer needs --key (the question it answers, e.g. notice_period)');
  const scope = input.scope ?? (input.kind === 'company_rule' ? 'company' : 'all');
  if (scope !== 'all' && scope !== 'company') throw new Error('--scope must be all or company');
  if (input.kind === 'company_rule' && scope !== 'company') throw new Error('a company_rule is about one company: use --scope company --company-file <file>');
  if (scope === 'company' && !input.company?.trim()) throw new Error('--scope company needs --company-file <file with the company name>');
  if (input.title_words?.length && input.kind !== 'avoid') throw new Error('title words only go with --kind avoid');
  if (input.title_words?.some((w) => !w.trim() || w.length > 40)) throw new Error('title words must be 1-40 characters each');
  return scope;
}

/** Remember something the user said. Idempotent: the same active item comes back instead of a copy. A new answer
 * replaces the active answer for the same key (and company). */
export function remember(file: string, input: MemoryInput, today: string, hooks?: Hooks): Remembered {
  const scope = check(input);
  return update(file, (n) => rememberIn(file, n, input, scope, today), hooks);
}

function rememberIn(file: string, n: ReturnType<typeof open>, input: MemoryInput, scope: 'all' | 'company', today: string): Remembered {
  const doc = n.doc;
  const seq = itemsSeq(doc);
  const items = ((doc.toJS() as any)?.items ?? []) as MemoryItem[];
  const company = scope === 'company' ? input.company!.trim() : undefined;
  const same = items.find((m) => isActive(m) && m.kind === input.kind && norm(m.key) === norm(input.key) && norm(m.text) === norm(input.text)
    && m.scope === scope && norm(m.company) === norm(company));
  if (same && !input.supersedes) return { item: same, existing: true, superseded: [] };
  const replaced = new Set<string>();
  if (input.supersedes) {
    const old = items.find((m) => m.id === input.supersedes);
    if (!old) throw new Error(`no memory item ${input.supersedes}`);
    if (!isActive(old)) throw new Error(`${input.supersedes} was already replaced (superseded_by: ${old.superseded_by})`);
    replaced.add(old.id);
  }
  if (input.kind === 'answer') for (const m of items) {
    if (isActive(m) && m.kind === 'answer' && m.key === input.key && m.scope === scope && norm(m.company) === norm(company)) replaced.add(m.id);
  }
  // Ids are never reused: one past the highest, and never one already in the note in any spelling.
  const taken = new Set(items.map((m) => String(m.id).toLowerCase()));
  let next = items.reduce((max, m) => Math.max(max, Number(/^m-(\d+)$/i.exec(String(m.id))?.[1] ?? 0)), 0) + 1;
  while (taken.has(`m-${next}`)) next++;
  const item: MemoryItem = {
    id: `m-${next}`, kind: input.kind, ...(input.key ? { key: input.key } : {}), text: input.text.trim(), quote: input.quote.trim(), scope,
    ...(company ? { company } : {}), ...(input.title_words?.length ? { title_words: input.title_words.map((w) => w.trim()) } : {}), created: today,
  };
  seq.add(doc.createNode(item, { flow: true }));
  for (const node of seq.items) if (isMap(node) && replaced.has(String((node as YAMLMap).get('id')))) (node as YAMLMap).set('superseded_by', item.id);
  save(file, doc, n.body, n.stamp);
  return { item, existing: false, superseded: [...replaced] };
}

/** Retire an item without a replacement (used by undo): it stays in the note with superseded_by: retired. */
export function retire(file: string, id: string, hooks?: Hooks): MemoryItem {
  return update(file, (n) => {
    const seq = itemsSeq(n.doc);
    const node = seq.items.find((x) => isMap(x) && String((x as YAMLMap).get('id')) === id) as YAMLMap | undefined;
    if (!node) throw new Error(`no memory item ${id}`);
    if (node.get('superseded_by')) throw new Error(`${id} is already replaced (superseded_by: ${node.get('superseded_by')})`);
    node.set('superseded_by', 'retired');
    save(file, n.doc, n.body, n.stamp);
    return node.toJSON() as MemoryItem;
  }, hooks);
}

/** Undo a remembered item: it is retired and the items it replaced are in force again. */
export function undoRemember(file: string, id: string, hooks?: Hooks): string[] {
  return update(file, (n) => {
    const seq = itemsSeq(n.doc);
    const restored: string[] = [];
    for (const x of seq.items) {
      if (!isMap(x)) continue;
      const m = x as YAMLMap;
      if (String(m.get('id')) === id) m.set('superseded_by', 'retired');
      else if (String(m.get('superseded_by') ?? '') === id) { m.delete('superseded_by'); restored.push(String(m.get('id'))); }
    }
    save(file, n.doc, n.body, n.stamp);
    return restored;
  }, hooks);
}

function save(file: string, doc: Document, body: string, stamp: Stamp) {
  const bad = validate('memory', doc.toJS()).filter((i) => i.level === 'error');
  if (bad.length) throw new Error(`refusing to write jobs/memory.md: ${bad[0].path}: ${bad[0].message}`);
  // Changed since we read it (an editor saved it): start over from the new text rather than overwrite it.
  const now = stampOf(file);
  if (JSON.stringify(now) !== JSON.stringify(stamp)) throw new Changed();
  writeAtomic(file, renderNote(doc, body));
}
