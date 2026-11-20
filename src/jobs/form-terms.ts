// Form terms per language (design §24.9, D32): data/form-terms.yaml turned into what the fill plan, drafting and the
// checks ask of a label. Which profile value a whole label is, whether a label is sensitive (only the user's answer)
// or never_fill (an ID, bank or tax number: never filled, drafted or stored), the parts of "Add another" blocks, the
// cover-letter upload, and the words a resume or letter uses in each language.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { plain } from './places.ts';
import { B, E, entryRe } from './rule-words.ts';

type Lang = {
  profile?: Record<string, string[]>; sensitive?: string[]; sensitive_exact?: string[]; never_fill?: string[]; never_fill_exact?: string[];
  groups?: Record<string, Record<string, string[]>>; group_words?: Record<string, string[]>; add?: string[]; letter?: string[];
};
type Data = { languages: Record<string, Lang>; documents: Record<string, Record<string, string>> };
export type FieldClass = 'never_fill' | 'sensitive' | null;
export type Group = 'employment' | 'education' | 'reference';
export const GROUPS: readonly Group[] = ['employment', 'education', 'reference'];

const FILE = join(import.meta.dirname, 'data', 'form-terms.yaml');
let data: Data | null = null;
export const formTermsData = (): Data => (data ??= parse(readFileSync(FILE, 'utf8')) as Data);

/**
 * A label as the terms compare it: lowercase, no accents, no required marks, "(optional)" or a leading "your", no
 * trailing colon, question mark or full stop.
 */
export function labelKey(label: string): string {
  return plain(String(label ?? '')).toLowerCase().replace(/[*✱]/g, ' ')
    .replace(/\((optional|required|freiwillig|optional|opcional|facultatif|facoltativo|optioneel|obligatorio|obligatoire|pflichtfeld)\)/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^your /, '').replace(/[\s:?.]+$/, '');
}

const all = (pick: (l: Lang) => string[] | undefined) => Object.values(formTermsData().languages).flatMap((l) => pick(l) ?? []);
const alt = (entries: string[]) => [...new Set(entries.map(entryRe))].sort((a, b) => b.length - a.length).join('|');
const containsRe = (entries: string[]) => (entries.length ? new RegExp(`${B}(?:${alt(entries)})${E}`, 'u') : /(?!)/);
const exactRe = (entries: string[]) => (entries.length ? new RegExp(`^(?:${alt(entries)})$`, 'u') : /(?!)/);

let compiled: { never: RegExp; neverExact: RegExp; sensitive: RegExp; sensitiveExact: RegExp; add: RegExp; letter: RegExp } | null = null;
function c() {
  return (compiled ??= {
    never: containsRe(all((l) => l.never_fill)), neverExact: exactRe(all((l) => l.never_fill_exact)),
    sensitive: containsRe(all((l) => l.sensitive)), sensitiveExact: exactRe(all((l) => l.sensitive_exact)),
    add: containsRe(all((l) => l.add)), letter: containsRe(all((l) => l.letter)),
  });
}

/** never_fill (government ID, bank or tax number), sensitive, or null, for a question's label in any language. */
export function classOf(label: string): FieldClass {
  const k = labelKey(label);
  if (!k) return null;
  const x = c();
  if (x.never.test(k) || x.neverExact.test(k)) return 'never_fill';
  if (x.sensitive.test(k) || x.sensitiveExact.test(k)) return 'sensitive';
  return null;
}
export const isNeverFill = (label: string) => classOf(label) === 'never_fill';
export const isSensitive = (label: string) => classOf(label) !== null;
/** A key (snake_case) read as words: "steuer_id" → never_fill. */
export const keyClass = (key: string) => classOf(String(key ?? '').replace(/_/g, ' '));
/** The stricter of two classes (Claude may raise a field to sensitive, never lower it). */
export const stricter = (a: FieldClass, b: FieldClass): FieldClass => (a === 'never_fill' || b === 'never_fill' ? 'never_fill' : a ?? b);

/** Whole-label patterns per profile key, in every language (fields.ts adds links by name). */
let rows: { key: string; re: RegExp }[] | null = null;
export function profileRows(): { key: string; re: RegExp }[] {
  if (rows) return rows;
  const by = new Map<string, string[]>();
  for (const l of Object.values(formTermsData().languages)) for (const [k, v] of Object.entries(l.profile ?? {})) by.set(k, [...(by.get(k) ?? []), ...v]);
  return (rows = [...by].map(([key, entries]) => ({ key, re: exactRe(entries) })));
}

let groupRows: Map<Group, { part: string; re: RegExp }[]> | null = null;
let groupWords: Map<Group, RegExp> | null = null;
function loadGroups() {
  if (groupRows) return;
  groupRows = new Map(); groupWords = new Map();
  for (const g of GROUPS) {
    const parts = new Map<string, string[]>();
    for (const l of Object.values(formTermsData().languages)) for (const [p, v] of Object.entries(l.groups?.[g] ?? {})) parts.set(p, [...(parts.get(p) ?? []), ...v]);
    groupRows.set(g, [...parts].map(([part, entries]) => ({ part, re: exactRe(entries) })));
    groupWords.set(g, containsRe(all((l) => l.group_words?.[g])));
  }
}
/** Which part of an entry a field in a group is ("Employer" → org, "Start date" → start), or null. */
export function groupPart(group: Group, label: string): string | null {
  loadGroups();
  const k = labelKey(label).replace(/^(?:\d+\.?\s*|(?:previous|current|first|second|third)\s+)/, '');
  return groupRows!.get(group)!.find((r) => r.re.test(k))?.part ?? null;
}
/** The group a label speaks of ("Add another employer", "Employment history", "Referee 2 email"), or null. */
export function groupOf(label: string): Group | null {
  loadGroups();
  const k = labelKey(label);
  return GROUPS.find((g) => groupWords!.get(g)!.test(k)) ?? null;
}
/** An "Add another …" button. */
export const isAddButton = (label: string) => c().add.test(labelKey(label));
/** An upload for a cover letter or supporting statement. */
export const isLetterLabel = (label: string) => c().letter.test(labelKey(label));

// ---- availability grids (answered from work_pattern) ----
type Avail = { question: RegExp; weekday: RegExp; weekend: RegExp; options: [string, RegExp][] };
let avail: Avail | null = null;
function availability(): Avail {
  if (avail) return avail;
  const a = (formTermsData() as any).availability ?? {};
  return (avail = {
    question: containsRe(a.question ?? []), weekday: containsRe(a.weekdays ?? []), weekend: containsRe(a.weekend ?? []),
    options: Object.entries(a.options ?? {}).map(([k, v]) => [k, exactRe(v as string[])] as [string, RegExp]),
  });
}
/** "Monday", "Weekends", null: the day an availability question asks about, as weekday or weekend. */
export function availabilityDay(label: string): 'weekday' | 'weekend' | null {
  const k = labelKey(label), a = availability();
  if (!a.question.test(k) && !a.weekday.test(k) && !a.weekend.test(k)) return null;
  if (a.weekend.test(k)) return 'weekend';
  return a.weekday.test(k) ? 'weekday' : null;
}
/** What an option of an availability question means: day, evening, night, any, none, or null. */
export function availabilityOption(option: string): string | null {
  const k = labelKey(option);
  return availability().options.find(([, re]) => re.test(k))?.[0] ?? null;
}

/** The words a resume or letter uses in a language (English for anything a language lacks). */
export function documentWords(lang?: string | null): Record<string, string> {
  const d = formTermsData().documents;
  return { ...d.en, ...(lang ? d[lang.slice(0, 2).toLowerCase()] ?? {} : {}) };
}
/** "German" for de; the code itself for a language the data doesn't name. */
export const languageName = (code: string) => formTermsData().documents[code]?.name ?? code;
export const LANG_CODE = /^[a-z]{2}$/;
