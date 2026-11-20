// `crewdeck jobs me set` and `pref set`: change one field of a note, typed by the schema and validated before the
// file is touched. `pref set` also logs the change under "## Changes" in jobs/search.md, quoting the user.
import { parse, stringify } from 'yaml';
import { mergeListInDoc, readNote, renderNote, setInDoc, writeAtomic } from './notes.ts';
import { type Schema, didYouMean, keysAt, normalise, schemaAt, validate } from './schema.ts';
import { expandTitle, loadTitleWords, titleMatcher } from './titles.ts';

const PROFILE_ROOTS = ['identity', 'standard_answers', 'education', 'copy_only_hosts', 'references'];
const CAREER_ROOTS = ['resume', 'sections', 'facts', 'skills', 'terms', 'language'];

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
      if (t === '') return undefined; // cleared: the key is removed (its default applies)
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
  // Targets (and other named entries): one line, "Name (title, title); Name (…)", never a YAML block in Changes.
  if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    return v.map((x: any) => {
      const words = Array.isArray(x.titles) ? x.titles.join(', ') : '';
      return x.name ? `${x.name}${words ? ` (${words})` : ''}` : words || stringify(x, { collectionStyle: 'flow', lineWidth: 0 }).trim();
    }).join('; ');
  }
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
 * One field's new value as text. For a list of maps a form edits only part of, `keep[i]` names the existing entry item i
 * continues and `owns` the keys the form edits: the rest of that entry (and its comments) is kept.
 */
export type Change = { segs: (string | number)[]; raw: string; keep?: (number | null)[]; owns?: string[] };

/**
 * Set one field of a note. Refuses unknown paths, values of the wrong type, and anything that adds a validation
 * error; the note is untouched then. `because` (pref set) is the user's own words for the Changes line.
 */
export function setField(file: string, note: 'profile' | 'career' | 'search', segs: (string | number)[], raw: string, opts: { because?: string; today?: string } = {}): SetResult {
  return setFields(file, note, [{ segs, raw }], opts)[0];
}

const labelOf = (segs: (string | number)[]) => segs.map((s) => (typeof s === 'number' ? `[${s}]` : s)).join('.').replace(/\.\[/g, '[');

/**
 * Set several fields of one note at once (the Jobs page's Preferences form): every value is typed and the whole note
 * validated before one atomic write, so either all of them are saved or none. Errors name each field. With `because`,
 * each changed field gets its own Changes line.
 */
export function setFields(file: string, note: 'profile' | 'career' | 'search', changes: Change[], opts: { because?: string; today?: string } = {}): SetResult[] {
  if (!changes.length) return [];
  const { n, results } = applyFields(file, note, typeChanges(note, changes));
  let body = n.body;
  if (opts.because !== undefined) {
    const words = opts.because.replace(/\s+/g, ' ').trim();
    if (!words) throw new Error('--because-file is empty: it holds the user\'s own words for the change');
    if (words.length > 1000) throw new Error('--because-file is longer than 1000 characters');
    for (const r of results) if (r.changed) body = addChangeLine(body, `${opts.today}: ${r.path}: ${showValue(r.before)} → ${showValue(r.after)}. "${words}"`);
  }
  if (results.some((r) => r.changed)) writeAtomic(file, renderNote(n.doc, body));
  return results;
}

type Typed = { segs: (string | number)[]; label: string; value: unknown; keep?: (number | null)[]; owns?: string[] };

/** Each change typed by the schema (a value from the command line or a form is text until then). */
function typeChanges(note: 'profile' | 'career' | 'search', changes: Change[]): Typed[] {
  return changes.map(({ segs, raw, keep, owns }) => {
    const label = labelOf(segs);
    const schema = schemaAt(note, segs);
    if (!schema) {
      const parent = segs.slice(0, -1);
      const near = didYouMean(String(segs[segs.length - 1]), keysAt(note, parent));
      throw new Error(`${label} is not a field Crewdeck knows in ${noteFile(note)}${near ? `: did you mean "${[...parent, near].join('.')}"?` : ''}`);
    }
    const value = coerce(schema, raw, label);
    if (keep && (!Array.isArray(value) || keep.length !== value.length || !owns?.length)) throw new Error(`${label}: the entries to keep don't match the list`);
    return { segs, label, value, ...(keep ? { keep, owns } : {}) };
  });
}

/** Apply typed values to the note in memory and validate; nothing is written. Throws with every new error. */
function applyFields(file: string, note: 'profile' | 'career' | 'search', typed: Typed[]) {
  const n = readNote(file);
  if (!n.exists) throw new Error(`${noteFile(note)} is missing: copy it from vault-template in the Crewdeck repo first`);
  if (n.errors.length) throw new Error(`${noteFile(note)} can't be read (${n.errors[0]}): fix it in Notes first`);
  const beforeAll = n.doc.toJS() ?? {};
  const known = new Set(validate(note, beforeAll).filter((i) => i.level === 'error').map((i) => `${i.path}|${i.message}`));
  const js = (x: any) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
  const results: SetResult[] = typed.map(({ segs, label, value, keep, owns }) => {
    const beforeJs = js(n.doc.getIn(segs));
    if (keep && Array.isArray(value)) mergeListInDoc(n.doc, segs, value as Record<string, unknown>[], keep, owns!);
    else setInDoc(n.doc, segs, value);
    const after = keep ? js(n.doc.getIn(segs)) : value;
    return { file, path: label, before: beforeJs, after, changed: JSON.stringify(beforeJs) !== JSON.stringify(after) };
  });
  const fresh = validate(note, n.doc.toJS()).filter((i) => i.level === 'error' && !known.has(`${i.path}|${i.message}`));
  if (fresh.length) throw new Error(fresh.map((i) => `${i.path}: ${i.message}${i.fix ? `. Fix: ${i.fix}` : ''}`).join('\n'));
  return { n, results };
}

/**
 * The note's data with changes applied, validated the same way as `pref set`, never written (the preview, D27).
 * `changes` are form or command-line values (`raw`, typed by the schema) or an overlay of typed YAML values.
 */
export function overlayFields(file: string, note: 'search', changes: (Change | { segs: (string | number)[]; value: unknown })[]): unknown {
  const typed: Typed[] = changes.map((c) => ('raw' in c ? typeChanges(note, [c])[0] : (() => {
    const label = labelOf(c.segs);
    if (!schemaAt(note, c.segs)) throw new Error(`${label} is not a field Crewdeck knows in ${noteFile(note)}`);
    return { segs: c.segs, label, value: c.value };
  })()));
  return applyFields(file, note, typed).n.doc.toJS();
}

/** A partial note as YAML (`--search-file`) → one change per leaf: maps merge into the note, lists and values replace. */
export function overlayChanges(note: 'search', data: unknown, at: (string | number)[] = []): { segs: (string | number)[]; value: unknown }[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (!at.length) throw new Error('the search file holds a YAML map of jobs/search.md fields, e.g. roles: { titles: [...] }');
    return [{ segs: at, value: data }];
  }
  const s = at.length ? schemaAt(note, at) : { t: 'obj' };
  if (at.length && s?.t !== 'obj') return [{ segs: at, value: data }];
  return Object.entries(data as Record<string, unknown>).flatMap(([k, v]) => overlayChanges(note, v, [...at, k]));
}

/**
 * v1 → v0.4 (ADR-0007): move `roles.titles` into `roles.targets`, one target per occupation family (titles in no family
 * share one target), each with its titles and up to two synonym wordings per title. Additive and comment-preserving:
 * existing targets stay first and untouched, `titles` is emptied in place (its comment kept), and a dated Changes line
 * records the old list. Idempotent: nothing to do once `roles.titles` is empty. Never writes a note with errors.
 */
export function migrateTitles(file: string, today: string): { changed: boolean; targets: { name: string; titles: string[] }[]; line?: string } {
  const n = readNote(file);
  if (!n.exists || n.errors.length) return { changed: false, targets: [] };
  const raw = (n.doc.toJS() ?? {}) as any;
  const titles: string[] = Array.isArray(raw?.roles?.titles) ? raw.roles.titles.map((t: unknown) => String(t ?? '').trim()).filter(Boolean) : [];
  if (!titles.length) return { changed: false, targets: [] };
  if (validate('search', raw).some((i) => i.level === 'error')) return { changed: false, targets: [] };
  const existing: any[] = Array.isArray(raw.roles.targets) ? raw.roles.targets : [];
  const have = new Set(existing.flatMap((t) => (Array.isArray(t?.titles) ? t.titles : [])).map((t: unknown) => String(t).toLowerCase()));
  const tw = loadTitleWords();
  const groups = new Map<string, string[]>();
  for (const t of titles) {
    if (have.has(t.toLowerCase())) continue;
    const fam = titleMatcher(normalise.search({ roles: { targets: [{ name: t, titles: [t] }] }, languages: raw.languages ?? [] }), tw).targets[0]?.occupations[0] ?? '';
    const list = groups.get(fam) ?? [];
    for (const x of [t, ...expandTitle(t, tw).slice(0, 2)]) if (!list.some((y) => y.toLowerCase() === x.toLowerCase()) && !have.has(x.toLowerCase())) list.push(x);
    groups.set(fam, list);
  }
  const added = [...groups.values()].filter((l) => l.length).map((l) => ({ name: l[0].charAt(0).toUpperCase() + l[0].slice(1), titles: l }));
  if (added.length) {
    const seq = n.doc.getIn(['roles', 'targets'], true) as any;
    const items = added.map((t) => { const node = n.doc.createNode(t) as any; const ts = node.get('titles', true); if (ts) ts.flow = true; node.flow = true; return node; });
    if (seq && Array.isArray(seq.items)) { seq.items.push(...items); if (!seq.items.length || seq.flow) seq.flow = false; }
    else setInDoc(n.doc, ['roles', 'targets'], added);
  }
  setInDoc(n.doc, ['roles', 'titles'], []);
  if (validate('search', n.doc.toJS()).some((i) => i.level === 'error')) return { changed: false, targets: [] };
  const line = `${today}: roles.titles → roles.targets (automatic update to v0.4 kinds of job, with synonyms): was ${titles.join(', ')}; now ${added.map((t) => `${t.name} (${t.titles.join(', ')})`).join('; ') || 'already in your targets'}.`;
  writeAtomic(file, renderNote(n.doc, addChangeLine(n.body, line)));
  return { changed: true, targets: added, line };
}

const noteFile = (note: string) => ({ profile: 'me/profile.md', career: 'me/career.md', search: 'jobs/search.md' })[note] ?? note;
