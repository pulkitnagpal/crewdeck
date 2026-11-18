// Notes Claude and the user share: Markdown with YAML frontmatter. Crewdeck reads and writes only the keys it owns,
// through the yaml Document API (comments and key order survive), keeps the body as it is and replaces the file
// atomically. A note the user broke falls back to its last valid version (machine state in <jobs.home>/state/).
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { type Document, isCollection, isNode, parseDocument } from 'yaml';
import { ensureHome } from '../config.ts';
import { type Issue, type Career, type Memory, type Profile, type Search, type Sources, NOTE_FILES, normalise, validate } from './schema.ts';

export const NOTES = NOTE_FILES as { profile: string; career: string; search: string; memory: string; sources: string };
export type NoteName = keyof typeof NOTES;
export const NOTE_NAMES = Object.keys(NOTES) as NoteName[];

/** Split a note into its frontmatter text (null when it has none) and its body, byte for byte. */
export function splitNote(text: string): { front: string | null; body: string; unterminated?: boolean } {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { front: null, body: text };
  const rest = text.slice(open[0].length);
  const close = /(^|\n)(?:---|\.\.\.)[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { front: null, body: text, unterminated: true };
  const cut = close.index + close[1].length;
  return { front: rest.slice(0, cut), body: rest.slice(close.index + close[0].length) };
}

export type Note = { path: string; exists: boolean; doc: Document; body: string; errors: string[] };

/** Read a note; YAML problems come back as messages with the file's own line numbers. */
export function readNote(path: string): Note {
  if (!existsSync(path)) return { path, exists: false, doc: parseDocument(''), body: '', errors: [] };
  const text = readFileSync(path, 'utf8');
  const { front, body, unterminated } = splitNote(text);
  const doc = parseDocument(front ?? '');
  const errors = unterminated ? ['the frontmatter has no closing --- line'] : doc.errors.map((e) => {
    const line = e.linePos?.[0]?.line;
    return `YAML: ${e.message.split('\n')[0]}${line ? ` (line ${line + 1})` : ''}`;
  });
  return { path, exists: true, doc, body, errors };
}

/** The note as text: frontmatter (from the document) and the untouched body. */
export function renderNote(doc: Document, body: string): string {
  let y = doc.contents === null ? '' : doc.toString({ lineWidth: 0 });
  if (y && !y.endsWith('\n')) y += '\n';
  return `---\n${y}---\n${body}`;
}

/** Write via a hidden temp file in the same folder and rename, so readers never see half a note. New notes are 0600. */
export function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** Set a value, keeping the old value's comment and flow/block style. */
export function setInDoc(doc: Document, path: (string | number)[], value: unknown) {
  const old = doc.getIn(path, true);
  const node = doc.createNode(value) as any;
  if (isNode(old)) {
    node.comment = old.comment;
    node.commentBefore = old.commentBefore;
    if (isCollection(old) && isCollection(node)) node.flow = old.flow;
  }
  if (doc.contents === null) doc.contents = doc.createNode({}) as any;
  doc.setIn(path, node);
}

// ---- the five job notes, validated, with the last-valid fallback ----

export type Loaded<T> = { name: NoteName; file: string; exists: boolean; source: 'note' | 'last-valid' | 'empty'; data: T; raw: unknown; issues: Issue[] };
export type JobNotes = {
  profile: Loaded<Profile>; career: Loaded<Career>; search: Loaded<Search>; memory: Loaded<Memory>; sources: Loaded<Sources>;
  /** Every issue, all notes. */
  issues: Issue[];
};

const cacheFile = (home: string, name: string) => join(home, 'state', 'last-valid', `${name}.json`);

function readCache(home: string | null, name: string): { saved: string; raw: unknown } | null {
  if (!home) return null;
  try { return JSON.parse(readFileSync(cacheFile(home, name), 'utf8')); } catch { return null; }
}

function writeCache(home: string, name: string, raw: unknown) {
  const json = JSON.stringify(raw ?? {});
  const hash = createHash('sha256').update(json).digest('hex');
  const have = readCache(home, name) as any;
  if (have?.hash === hash) return;
  ensureHome(home);
  ensureHome(join(home, 'state'));
  ensureHome(join(home, 'state', 'last-valid'));
  writeAtomic(cacheFile(home, name), JSON.stringify({ saved: new Date().toISOString(), hash, raw: raw ?? {} }) + '\n');
}

/** Load one note: validated data, or its last valid version when it is broken now (with the errors). */
export function loadNote<N extends NoteName>(vault: string, home: string | null, name: N): Loaded<ReturnType<(typeof normalise)[N]>> {
  const file = join(vault, NOTES[name]);
  const n = readNote(file);
  const norm = normalise[name] as (d: unknown) => any;
  const out = (source: 'note' | 'last-valid' | 'empty', raw: unknown, issues: Issue[]) => ({ name, file, exists: n.exists, source, data: norm(raw), raw, issues });
  if (!n.exists) {
    return out('empty', {}, [{ level: 'error', note: NOTES[name], path: '(file)', message: 'is missing', fix: `copy vault-template/${NOTES[name]} from the Crewdeck repo into your vault (crewdeck jobs init will do this)` }]);
  }
  const issues: Issue[] = n.errors.map((m) => ({ level: 'error' as const, note: NOTES[name], path: '(frontmatter)', message: m, fix: 'fix the YAML (indentation, quotes, colons)' }));
  const raw = n.errors.length ? null : n.doc.toJS() ?? {};
  if (raw !== null) issues.push(...validate(name, raw));
  if (!issues.some((i) => i.level === 'error')) {
    if (home) writeCache(home, name, raw);
    return out('note', raw, issues);
  }
  const cached = readCache(home, name);
  if (cached) {
    issues.push({ level: 'warning', note: NOTES[name], path: '(file)', message: `has errors: using its last valid version (${cached.saved.slice(0, 16).replace('T', ' ')} UTC)`, fix: 'fix the errors above; the note itself is unchanged' });
    return out('last-valid', cached.raw, issues);
  }
  issues.push({ level: 'warning', note: NOTES[name], path: '(file)', message: 'has errors and no earlier valid version: treated as empty', fix: 'fix the errors above' });
  return out('empty', {}, issues);
}

/** All five job notes. `home` (jobs.home) keeps the last valid versions; null reads without caching. */
export function loadJobNotes(vault: string, home: string | null): JobNotes {
  const notes = {
    profile: loadNote(vault, home, 'profile'), career: loadNote(vault, home, 'career'), search: loadNote(vault, home, 'search'),
    memory: loadNote(vault, home, 'memory'), sources: loadNote(vault, home, 'sources'),
  } as JobNotes;
  notes.issues = NOTE_NAMES.flatMap((k) => notes[k].issues);
  return notes;
}
