// Rule words per language (design D38): data/rule-words.yaml turned into the regular expressions the hard rules use.
// The shapes of the rules ("<places> only", "must reside in <places>", travel near its modifiers) are here; the words
// of every language are data, read once and joined, since a posting may be in any language.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fold, plain } from './places.ts';

type Lang = Partial<Record<
  'remote' | 'hybrid' | 'onsite' | 'travel' | 'frequent' | 'frequent_after' | 'frequent_phrases' | 'occasional' | 'occasional_after' |
  'occasional_phrases' | 'no_before' | 'no_after' | 'only_before' | 'places_after' | 'not_before' | 'only_after' | 'reside' | 'except' |
  'not_open' | 'not_open_places' | 'not_eligible' | 'filler', string[]>>;
type Data = { languages: Record<string, Lang>; industries: Record<string, Record<string, string[]> & { aliases?: string[] }> };

const FILE = join(import.meta.dirname, 'data', 'rule-words.yaml');
let cached: Data | null = null;
export function ruleWordsData(): Data {
  return (cached ??= parse(readFileSync(FILE, 'utf8')) as Data);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';

/** One alternative: words with a space or a hyphen between them; "word*" a prefix; "100%" with or without a space. */
function altRe(a: string): string {
  const t = plain(a).toLowerCase().trim();
  const star = t.endsWith('*');
  const words = (star ? t.slice(0, -1) : t).split(/[\s-]+/).filter(Boolean).map((w) => esc(w).replace(/%/g, '\\s?%'));
  return words.join('[\\s-]+') + (star ? '\\p{L}*' : '');
}
/** An entry: slots joined by " + " (each "a|b", "?" for optional), as one regular expression (no outer boundaries). */
export function entryRe(entry: string): string {
  const slots = String(entry).split(/\s\+\s/).map((s) => s.trim()).filter(Boolean);
  let out = '';
  let seenRequired = false;
  slots.forEach((slot, i) => {
    const optional = slot.endsWith('?');
    const alts = (optional ? slot.slice(0, -1) : slot).split('|').map(altRe).filter(Boolean).sort((x, y) => y.length - x.length);
    const body = `(?:${alts.join('|')})`;
    // An optional slot takes its own space with it, so "a + b?" matches "a" alone and "a? + b" matches "b" alone: the
    // slots before the first required one carry the space after them, the others the space before.
    if (!seenRequired && optional && i < slots.length - 1) out += `(?:${body}\\s+)?`;
    else if (!seenRequired) { out += body; seenRequired = true; }
    else out += optional ? `(?:\\s+${body})?` : `\\s+${body}`;
  });
  return out;
}
/** Every language's entries for a key, as one alternation (null when no language has any). */
export function wordsRe(key: keyof Lang): string | null {
  const all = Object.values(ruleWordsData().languages).flatMap((l) => l[key] ?? []);
  const res = [...new Set(all.map(entryRe))].sort((a, b) => b.length - a.length);
  return res.length ? `(?:${res.join('|')})` : null;
}
const W = (key: keyof Lang) => wordsRe(key) ?? '(?!)';

/** The built-in detectors, by rule name (each overridable in search.md → rules:). */
export function builtInRules() {
  const PLACES = '(?<places>[^.;:!?()\\n]{1,80})';
  const SPAN = '[^.;:!?()\\n]';
  const travel = `${B}${W('travel')}`;
  return {
    remote_words: [`${B}${W('remote')}${E}`],
    hybrid_words: [`${B}${W('hybrid')}${E}`],
    onsite_words: [`${B}${W('onsite')}${E}`],
    other_only: [
      // "<places> only", "US-only", "EU residents only"
      `(?<places>[^.;:!?()\\[\\]\\n]{1,80}?)[\\s-]*(?:based\\s+)?(?:residents|citizens|candidates|applicants|nationals)?\\s*${B}${W('only_after')}${E}`,
      // "must reside in <places>", "Wohnsitz in <places>"
      `${B}${W('reside')}\\s+${PLACES}`,
      // "only open to candidates in <places>", "nur Bewerber aus <places>" (not after "not": "nicht nur in Berlin")
      `${B}(?<!${W('not_before')}\\s)${W('only_before')}${E}${SPAN}{0,40}?${B}${W('places_after')}\\s+${PLACES}`,
    ],
    place_excluded: [
      // "not open to candidates in <places>", "cannot hire in <places>"
      `${B}${W('not_open')}${E}${SPAN}{0,30}?${B}${W('not_open_places')}\\s+${PLACES}`,
      // "excluding <places>", "außer <places>"
      `${B}${W('except')}\\s+${PLACES}`,
      // "<places> (residents) are not eligible"
      `(?<places>[^.;:!?()\\[\\]\\n]{1,80}?)[\\s-]*(?:based\\s+)?(?:candidates|applicants|residents)?\\s*(?:are|is)?\\s*${W('not_eligible')}${E}`,
    ],
    travel_frequent: [`${B}${W('frequent')}${E}[^.;\\n]{0,30}${travel}|${travel}[^.;\\n]{0,20}${B}${W('frequent_after')}${E}|${B}${W('frequent_phrases')}${E}`],
    travel_occasional: [`${B}${W('occasional')}${E}[^.;\\n]{0,30}${travel}|${travel}[^.;\\n]{0,25}${B}${W('occasional_after')}${E}|${B}${W('occasional_phrases')}${E}`],
  };
}

/** The keywords that end the two place rules whose places come first (the prefilter scans only before each one). */
export const ONLY_KEYWORD = () => new RegExp(`${B}${W('only_after')}${E}`, 'giu');
export const NOT_ELIGIBLE_KEYWORD = () => new RegExp(`${W('not_eligible')}${E}`, 'giu');

/** "No travel", "travel not required", "keine Reisetätigkeit": a sentence saying so has no travel. */
export const noTravelRe = () => new RegExp(`${B}${W('no_before')}\\s+(?:\\p{L}+\\s+){0,2}${W('travel')}|${B}${W('travel')}[^.;\\n]{0,25}${B}${W('no_after')}`, 'iu');
/** A travel noun in any language. */
export const travelNounRe = () => new RegExp(`${B}${W('travel')}`, 'giu');

/** Words between and around place names in a restriction, in every language. */
export const fillerWords = () => new Set(Object.values(ruleWordsData().languages).flatMap((l) => l.filler ?? []).map((w) => fold(w)));

/** The usual words for an industry in every language ("gambling" → betting, Sportwetten, apuestas …); else as written. */
export function industryWords(name: string): string[] {
  const k = fold(name);
  const inds = ruleWordsData().industries;
  const key = Object.keys(inds).find((i) => fold(i) === k || (inds[i].aliases ?? []).some((a) => fold(a) === k));
  if (!key) return [name];
  return [...new Set(Object.entries(inds[key]).filter(([l]) => l !== 'aliases').flatMap(([, ws]) => ws as string[]))];
}

const typeKey = (s: string) => fold(s).replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ').trim();
let typeMap: Map<string, string[]> | null = null;
/**
 * The kinds of employment a structured employment type can mean ("FULL_TIME" → [full-time]; "CONTRACTOR" →
 * [contract, freelance]), or null when any value it lists is unknown (VOLUNTEER, OTHER, anything new): then no rule.
 */
export function employmentKinds(value: string | null | undefined): string[] | null {
  if (!value || !String(value).trim()) return null;
  if (!typeMap) {
    typeMap = new Map();
    for (const [kind, words] of Object.entries((ruleWordsData() as any).employment_types ?? {}) as [string, string[]][]) {
      for (const w of words) { const k = typeKey(w); typeMap.set(k, [...new Set([...(typeMap.get(k) ?? []), kind])]); }
    }
  }
  const parts = String(value).split(/[,;|]|\band\b|\bor\b/i).map(typeKey).filter(Boolean);
  const kinds = new Set<string>();
  for (const p of parts) { const k = typeMap.get(p); if (!k) return null; k.forEach((x) => kinds.add(x)); }
  return kinds.size ? [...kinds] : null;
}
