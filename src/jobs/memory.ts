// What Claude learned from the user (jobs/memory.md): answers, facts, preferences, style rules, "not interested"
// reasons and company rules, each in the user's words with their quote and date. Items are never deleted, only
// superseded (superseded_by: m-N) or retired, so undo and history work.
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

function open(file: string) {
  const n = readNote(file);
  // A missing note starts from the template (the user's vault may predate Jobs).
  if (!n.exists) return { ...n, doc: parseDocument(TEMPLATE.split('---\n')[1]), body: TEMPLATE.split('---\n').slice(2).join('---\n') };
  if (n.errors.length) throw new Error(`jobs/memory.md can't be read (${n.errors[0]}): fix it in Notes first`);
  const bad = validate('memory', n.doc.toJS() ?? {}).filter((i) => i.level === 'error');
  if (bad.length) throw new Error(`jobs/memory.md has errors (${bad[0].path}: ${bad[0].message}): fix it in Notes first, then try again`);
  return n;
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
export function remember(file: string, input: MemoryInput, today: string): Remembered {
  const scope = check(input);
  const n = open(file);
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
  const next = items.reduce((max, m) => Math.max(max, Number(/^m-(\d+)$/.exec(m.id)?.[1] ?? 0)), 0) + 1;
  const item: MemoryItem = {
    id: `m-${next}`, kind: input.kind, ...(input.key ? { key: input.key } : {}), text: input.text.trim(), quote: input.quote.trim(), scope,
    ...(company ? { company } : {}), ...(input.title_words?.length ? { title_words: input.title_words.map((w) => w.trim()) } : {}), created: today,
  };
  seq.add(doc.createNode(item, { flow: true }));
  for (const node of seq.items) if (isMap(node) && replaced.has(String((node as YAMLMap).get('id')))) (node as YAMLMap).set('superseded_by', item.id);
  save(file, doc, n.body);
  return { item, existing: false, superseded: [...replaced] };
}

/** Retire an item without a replacement (used by undo): it stays in the note with superseded_by: retired. */
export function retire(file: string, id: string): MemoryItem {
  const n = open(file);
  const seq = itemsSeq(n.doc);
  const node = seq.items.find((x) => isMap(x) && String((x as YAMLMap).get('id')) === id) as YAMLMap | undefined;
  if (!node) throw new Error(`no memory item ${id}`);
  if (node.get('superseded_by')) throw new Error(`${id} is already replaced (superseded_by: ${node.get('superseded_by')})`);
  node.set('superseded_by', 'retired');
  save(file, n.doc, n.body);
  return node.toJSON() as MemoryItem;
}

/** Undo a remembered item: it is retired and the items it replaced are in force again. */
export function undoRemember(file: string, id: string): string[] {
  const n = open(file);
  const seq = itemsSeq(n.doc);
  const restored: string[] = [];
  for (const x of seq.items) {
    if (!isMap(x)) continue;
    const m = x as YAMLMap;
    if (String(m.get('id')) === id) m.set('superseded_by', 'retired');
    else if (String(m.get('superseded_by') ?? '') === id) { m.delete('superseded_by'); restored.push(String(m.get('id'))); }
  }
  save(file, n.doc, n.body);
  return restored;
}

function save(file: string, doc: Document, body: string) {
  const bad = validate('memory', doc.toJS()).filter((i) => i.level === 'error');
  if (bad.length) throw new Error(`refusing to write jobs/memory.md: ${bad[0].path}: ${bad[0].message}`);
  writeAtomic(file, renderNote(doc, body));
}
