// `crewdeck jobs me set` and `pref set`: change one field of a note, typed by the schema and validated before the
// file is touched. `pref set` also logs the change under "## Changes" in jobs/search.md, quoting the user.
import { parse, stringify } from 'yaml';
import { readNote, renderNote, setInDoc, writeAtomic } from './notes.ts';
import { type Schema, didYouMean, keysAt, schemaAt, validate } from './schema.ts';

const PROFILE_ROOTS = ['identity', 'standard_answers', 'education'];
const CAREER_ROOTS = ['resume', 'sections', 'facts', 'skills'];

/** Which note a `me set` path belongs to, and the path inside it. */
export function meTarget(path: string): { note: 'profile' | 'career'; segs: (string | number)[] } {
  let segs = parsePath(path);
  let note: 'profile' | 'career' | null = null;
  if (segs[0] === 'profile' || segs[0] === 'career') { note = segs[0]; segs = segs.slice(1); }
  const root = String(segs[0] ?? '');
  note ??= PROFILE_ROOTS.includes(root) ? 'profile' : CAREER_ROOTS.includes(root) ? 'career' : null;
  if (!note) {
    const near = didYouMean(root, [...PROFILE_ROOTS, ...CAREER_ROOTS]);
    throw new Error(`"${root}" is not in me/profile.md or me/career.md${near ? `: did you mean "${near}"?` : ` (use ${[...PROFILE_ROOTS, ...CAREER_ROOTS].join(', ')})`}`);
  }
  return { note, segs };
}

export function parsePath(path: string): (string | number)[] {
  if (!/^[A-Za-z0-9_.\[\]-]+$/.test(path)) throw new Error(`"${path}" is not a field path (e.g. pay.floor, identity.email, education.0.school)`);
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** The text the user gave, as the type the schema wants: lists from "a,b" or YAML flow, numbers, booleans. */
export function coerce(s: Schema, raw: string, path: string): unknown {
  const t = raw.trim();
  if (/^[\[{]/.test(t) && (s.t === 'list' || s.t === 'obj' || s.t === 'map')) {
    try { return parse(t); } catch (e: any) { throw new Error(`${path}: can't read ${t} as YAML (${e.message.split('\n')[0]})`); }
  }
  switch (s.t) {
    case 'list':
      if (t === '') return [];
      if (s.of.t === 'obj') throw new Error(`${path}: give the list as YAML, e.g. [{ name: …, level: … }]`);
      return t.split(',').map((x) => x.trim()).filter(Boolean).map((x) => coerce(s.of, x, path));
    case 'num': {
      const n = Number(t.replace(/[_,\s]/g, ''));
      if (t === '' || !Number.isFinite(n)) throw new Error(`${path}: "${t}" is not a number`);
      return n;
    }
    case 'bool':
      if (/^(true|yes|on)$/i.test(t)) return true;
      if (/^(false|no|off)$/i.test(t)) return false;
      throw new Error(`${path}: use true or false`);
    case 'obj': case 'map':
      throw new Error(`${path}: give a YAML map, e.g. { key: value }`);
    default:
      return t;
  }
}

const showValue = (v: unknown): string => {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '(none)';
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.join(', ');
  if (typeof v === 'object') return stringify(v, { collectionStyle: 'flow' }).trim();
  return String(v);
};

/** Append "- <date>: <text>" at the end of the "## Changes" section (made if missing). */
export function addChangeLine(body: string, line: string): string {
  const entry = `- ${line}`;
  const head = /^##[ \t]+Changes[ \t]*$/m.exec(body);
  if (!head) return `${body.replace(/\s*$/, '')}${body.trim() ? '\n\n' : ''}## Changes\n${entry}\n`;
  const start = head.index + head[0].length;
  const next = /^#{1,2}[ \t]/m.exec(body.slice(start));
  const end = next ? start + next.index : body.length;
  const section = body.slice(start, end).replace(/\s*$/, '');
  const after = body.slice(end);
  return `${body.slice(0, start)}${section}\n${entry}\n${after ? `\n${after}` : ''}`;
}

export type SetResult = { file: string; path: string; before: unknown; after: unknown; changed: boolean };

/**
 * Set one field of a note. Refuses unknown paths, values of the wrong type, and anything that adds a validation
 * error; the note is untouched then. `because` (pref set) is the user's own words for the Changes line.
 */
export function setField(file: string, note: 'profile' | 'career' | 'search', segs: (string | number)[], raw: string, opts: { because?: string; today?: string } = {}): SetResult {
  const label = segs.map((s) => (typeof s === 'number' ? `[${s}]` : s)).join('.').replace(/\.\[/g, '[');
  const schema = schemaAt(note, segs);
  if (!schema) {
    const parent = segs.slice(0, -1);
    const near = didYouMean(String(segs[segs.length - 1]), keysAt(note, parent));
    throw new Error(`${label} is not a field Crewdeck knows in ${noteFile(note)}${near ? `: did you mean "${[...parent, near].join('.')}"?` : ''}`);
  }
  const value = coerce(schema, raw, label);
  const n = readNote(file);
  if (!n.exists) throw new Error(`${noteFile(note)} is missing: copy it from vault-template in the Crewdeck repo first`);
  if (n.errors.length) throw new Error(`${noteFile(note)} can't be read (${n.errors[0]}): fix it in Notes first`);
  const beforeAll = n.doc.toJS() ?? {};
  const before = n.doc.getIn(segs) as any;
  const beforeJs = before && typeof before.toJSON === 'function' ? before.toJSON() : before;
  const known = new Set(validate(note, beforeAll).filter((i) => i.level === 'error').map((i) => `${i.path}|${i.message}`));
  setInDoc(n.doc, segs, value);
  const fresh = validate(note, n.doc.toJS()).filter((i) => i.level === 'error' && !known.has(`${i.path}|${i.message}`));
  if (fresh.length) throw new Error(fresh.map((i) => `${i.path}: ${i.message}${i.fix ? `. Fix: ${i.fix}` : ''}`).join('\n'));
  const changed = JSON.stringify(beforeJs) !== JSON.stringify(value);
  let body = n.body;
  if (opts.because !== undefined) {
    const words = opts.because.replace(/\s+/g, ' ').trim();
    if (!words) throw new Error('--because-file is empty: it holds the user\'s own words for the change');
    if (words.length > 1000) throw new Error('--because-file is longer than 1000 characters');
    if (changed) body = addChangeLine(body, `${opts.today}: ${label}: ${showValue(beforeJs)} → ${showValue(value)}. "${words}"`);
  }
  if (changed) writeAtomic(file, renderNote(n.doc, body));
  return { file, path: label, before: beforeJs, after: value, changed };
}

const noteFile = (note: string) => ({ profile: 'me/profile.md', career: 'me/career.md', search: 'jobs/search.md' })[note] ?? note;
