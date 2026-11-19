// The citation check (design §13 "no invented experience"): every claim in an answer cites sources (career facts,
// memory items in the user's words, profile values, or the posting for claims about the company), and no number or
// named term (technology, tool, certification, clinical or analytics term) may appear that its sources don't contain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { MemoryItem } from '../schema.ts';

export type Claim = { text: string; about: 'me' | 'company'; fact_ids: string[] };
export type Fact = { id: string; text: string };
export type CiteContext = { facts: Fact[]; memory: MemoryItem[]; postingText: string; profile: Record<string, string>; terms?: Term[] };
export type CiteResult = { ok: true } | { ok: false; reason: string };
export type Term = { name: string; res: RegExp[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CITABLE = new Set(['answer', 'fact', 'preference']);

/** One term: its names ("Go|Golang"); names of two letters or fewer, and every name when caseSensitive, match as written. */
function term(spec: string, caseSensitive: boolean): Term {
  const names = spec.split('|').map((n) => n.trim()).filter(Boolean);
  return {
    name: names[0],
    res: names.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, caseSensitive || n.length <= 2 ? 'u' : 'iu')),
  };
}

let builtIn: Term[] | null = null;
/** The built-in terms (src/jobs/data/terms.yaml) plus the user's own (career.md → terms.extra). */
export function termsFor(extra: string[] = []): Term[] {
  if (!builtIn) {
    const y = parse(readFileSync(join(import.meta.dirname, '..', 'data', 'terms.yaml'), 'utf8')) ?? {};
    builtIn = [...(y.case_insensitive ?? []).map((n: string) => term(n, false)), ...(y.case_sensitive ?? []).map((n: string) => term(n, true))];
  }
  return [...builtIn, ...extra.map((n) => term(n, false))];
}

// ---- numbers (C3) ----
// A number is compared by value, not by spelling: "1,5" and "1.5" are one and a half (never 15), "5,000", "5.000" and
// "5000" are five thousand, "50K" is 50 000 and "5M" five million, but only when the letter is attached to the digits
// ("5 month" is 5). Number words count as numbers in English and in the languages of the people Crewdeck ships presets
// for (German, French, Spanish, Portuguese); words that are also everyday words or articles ("ein", "un", "once", "six"
// as French, "sept", "cent", "dos", "mil", "neuf") are left out so prose isn't refused.
type Num = { label: string; values: string[]; atLeast?: number; below?: number };

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // German
  eins: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, zwoelf: 12,
  zwanzig: 20, 'dreißig': 30, dreissig: 30, vierzig: 40, 'fünfzig': 50, fuenfzig: 50,
  // French
  deux: 2, trois: 3, quatre: 4, cinq: 5, huit: 8, dix: 10, onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50,
  // Spanish and Portuguese
  tres: 3, 'três': 3, cuatro: 4, quatro: 4, cinco: 5, seis: 6, siete: 7, sete: 7, ocho: 8, oito: 8, nueve: 9, nove: 9, diez: 10, dez: 10,
  doce: 12, doze: 12, quince: 15, veinte: 20, vinte: 20, treinta: 30, trinta: 30, cuarenta: 40, quarenta: 40, cincuenta: 50, cinquenta: 50,
};
const SCALES: Record<string, number> = {
  dozen: 12, dutzend: 12, douzaine: 12, docena: 12, 'dúzia': 12, hundred: 100, hundert: 100, cien: 100, ciento: 100, cem: 100,
  thousand: 1e3, tausend: 1e3, mille: 1e3, million: 1e6, millionen: 1e6, millones: 1e6, 'milhão': 1e6, billion: 1e9, milliarde: 1e9,
};
const PLURALS: Record<string, number> = { dozens: 12, hundreds: 100, thousands: 1e3, millions: 1e6, billions: 1e9 };
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...Object.keys(WORDS), ...Object.keys(SCALES)].sort((a, b) => b.length - a.length).join('|')})(?:[\\s-]+(?:and\\s+|und\\s+|et\\s+|y\\s+|e\\s+)?(?:${[...Object.keys(WORDS), ...Object.keys(SCALES)].sort((a, b) => b.length - a.length).join('|')}))*(?![\\p{L}\\p{N}])`, 'giu');
const PLURAL_RE = new RegExp(`(?<![\\p{L}])(${Object.keys(PLURALS).join('|')})(?![\\p{L}])`, 'giu');
// "no one", "one of", "one another", "one-on-one", "one-off": not a count.
const NOT_A_COUNT = /(?<![\p{L}])(?:no one|one of|one another|one[- ]on[- ]one|one[- ]off)(?![\p{L}])/giu;
const SUFFIX: [RegExp, number][] = [[/^(?:k)(?![\p{L}])/iu, 1e3], [/^(?:mm|mn|mio|m)(?![\p{L}])/iu, 1e6], [/^(?:bn|b)(?![\p{L}])/iu, 1e9]];
const SCALE_AFTER = new RegExp(`^\\s+(${Object.keys(SCALES).filter((w) => SCALES[w] >= 100).join('|')})(?![\\p{L}])`, 'iu');

const CONNECTORS = new Set(['and', 'und', 'et', 'y', 'e']);
const key = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** The text's decimal style when it shows one unambiguously: "1,5" or "1.234,5" → comma; "1.5" or "1,234.5" → dot. */
function decimalStyle(text: string): 'comma' | 'dot' | null {
  const comma = /\d,\d{1,2}(?!\d)|\d\.\d{3},\d/.test(text), dot = /\d\.\d{1,2}(?![\d.])|\d,\d{3}\.\d/.test(text);
  return comma && !dot ? 'comma' : dot && !comma ? 'dot' : null;
}

/** The values a written number can mean: one, or two when "1,500" / "1.500" could be either style. */
function readings(raw: string, style: 'comma' | 'dot' | null): number[] | string {
  const t = raw.replace(/['’]/g, '');
  const seps = t.match(/[.,]/g) ?? [];
  if (!seps.length) return [Number(t)];
  const groups = t.split(/[.,]/);
  const kinds = new Set(seps);
  if (kinds.size === 2) {
    // "1,234.5" / "1.234,5": the last separator is the decimal one.
    const dec = seps[seps.length - 1];
    const i = t.lastIndexOf(dec);
    return [Number(t.slice(0, i).replace(/[.,]/g, '') + '.' + t.slice(i + 1))];
  }
  const sep = seps[0];
  if (seps.length > 1) return groups.slice(1).every((g) => g.length === 3) ? [Number(groups.join(''))] : t; // "1.000.000"; "1.2.3" stays as written
  if (groups[1].length !== 3) return [Number(`${groups[0]}.${groups[1]}`)]; // "1,5", "2.25"
  const thousands = Number(groups.join('')), decimal = Number(`${groups[0]}.${groups[1]}`);
  if (style === 'comma') return [sep === '.' ? thousands : decimal];
  if (style === 'dot') return [sep === ',' ? thousands : decimal];
  return [thousands, decimal];
}

/** The value of a run of number words ("forty-five", "three hundred and twenty", "zwei tausend"). */
function wordValue(run: string): number {
  let total = 0, current = 0;
  for (const w of run.toLowerCase().split(/[\s-]+/).filter((x) => x && !CONNECTORS.has(x))) {
    if (Object.hasOwn(WORDS, w)) current += WORDS[w];
    else if (SCALES[w] < 1000) current = (current || 1) * SCALES[w];
    else { total += (current || 1) * SCALES[w]; current = 0; }
  }
  return total + current;
}

/** Every number in a text with the values it can mean. */
function numbers(text: string): Num[] {
  const style = decimalStyle(text);
  const out: Num[] = [];
  for (const m of text.matchAll(/\d+(?:[.,'’]\d+)*/g)) {
    const r = readings(m[0], style);
    const rest = text.slice(m.index! + m[0].length, m.index! + m[0].length + 24);
    let factor = 1;
    for (const [re, f] of SUFFIX) if (re.test(rest)) { factor = f; break; }
    const scale = factor === 1 ? SCALE_AFTER.exec(rest) : null;
    if (scale) factor = SCALES[scale[1].toLowerCase()];
    out.push(typeof r === 'string' ? { label: r, values: [r] } : { label: key(r[0] * factor), values: r.map((v) => key(v * factor)) });
  }
  const prose = text.replace(NOT_A_COUNT, ' ');
  for (const m of prose.matchAll(WORD_RE)) {
    // A scale word right after digits ("5 million") was read with them.
    if (/\d\s*$/.test(prose.slice(Math.max(0, m.index! - 3), m.index!)) && Object.hasOwn(SCALES, m[0].toLowerCase())) continue;
    // "and" joins a number only after a scale ("three hundred and twenty"); "two and three" are two numbers.
    const groups: string[][] = [[]];
    let prev = '';
    for (const w of m[0].toLowerCase().split(/[\s-]+/).filter(Boolean)) {
      if (CONNECTORS.has(w)) { if (!Object.hasOwn(SCALES, prev)) groups.push([]); }
      else groups[groups.length - 1].push(w);
      prev = w;
    }
    for (const g of groups) if (g.length) out.push({ label: g.join(' '), values: [key(wordValue(g.join(' ')))] });
  }
  for (const m of prose.matchAll(PLURAL_RE)) {
    const unit = PLURALS[m[1].toLowerCase()];
    out.push({ label: m[0], values: [], atLeast: 2 * unit, below: 1000 * unit });
  }
  return out;
}

/** Numbers in a text as values ("5,000+" → "5000", "50K" → "50000", "p99" → "99", "1,5" → "1.5"). */
export function numbersIn(text: string): string[] {
  return numbers(text).filter((n) => n.values.length).map((n) => n.values[0]);
}

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|my|me|mine|myself)\b/i;

function unsupported(text: string, pool: string, terms: Term[]): string | null {
  const have = new Set(numbers(pool).flatMap((n) => n.values));
  const values = [...have].map(Number).filter(Number.isFinite);
  for (const n of numbers(text)) {
    const ok = n.atLeast !== undefined ? values.some((v) => v >= n.atLeast! && v < n.below!) || have.has(n.label.toLowerCase()) : n.values.some((v) => have.has(v));
    if (!ok) return `"${n.label}"`;
  }
  for (const t of terms) if (t.res.some((r) => r.test(text)) && !t.res.some((r) => r.test(pool))) return `"${t.name}"`;
  return null;
}

const same = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’]+/g, ' ').replace(/[\s.!?,;:]+$/, '').trim();

export function checkAnswer(a: { text: string; claims: Claim[] }, ctx: CiteContext): CiteResult {
  const terms = ctx.terms ?? termsFor();
  const claims = Array.isArray(a.claims) ? a.claims : [];
  if (a.text.trim() && !claims.length) return { ok: false, reason: 'answer has no cited claims' };
  const facts = new Map(ctx.facts.map((f) => [f.id, f.text.replace(/\*\*/g, '')]));
  const mem = new Map(ctx.memory.map((m) => [m.id, m]));
  // The user's own sources (facts, memory, profile) from every claim; the posting only for the company claims citing it.
  const ownSources: string[] = [];
  const postingClaims: string[] = [];
  for (const c of claims) {
    if (!c || typeof c.text !== 'string' || !Array.isArray(c.fact_ids) || !['me', 'company'].includes(c.about)) return { ok: false, reason: 'a claim needs text, about (me | company) and fact_ids' };
    const sources: string[] = [];
    let cites = false;
    for (const id of c.fact_ids) {
      if (id === 'posting') {
        if (c.about !== 'company') return { ok: false, reason: `a claim about the user can't cite the posting: "${c.text}"` };
        sources.push(ctx.postingText);
        cites = true;
        continue;
      }
      if (typeof id === 'string' && id.startsWith('profile:')) {
        const v = Object.hasOwn(ctx.profile, id.slice(8)) ? ctx.profile[id.slice(8)] : undefined;
        if (v == null) return { ok: false, reason: `unknown profile field ${id}` };
        sources.push(v);
        continue;
      }
      if (facts.has(id)) { sources.push(facts.get(id)!); continue; }
      const m = mem.get(id);
      if (!m) return { ok: false, reason: `unknown source ${id}` };
      if (m.superseded_by) return { ok: false, reason: `source ${id} was replaced` };
      if (!CITABLE.has(m.kind)) return { ok: false, reason: `${id} is a ${m.kind} item, not a fact about the user` };
      sources.push(`${m.text} ${m.quote}`);
    }
    if (!sources.length) return { ok: false, reason: `no source for: "${c.text}"` };
    if (c.about === 'company' && FIRST_PERSON.test(c.text)) return { ok: false, reason: `a claim about the user can't cite the posting: "${c.text}"` };
    const bad = unsupported(c.text, sources.join('\n'), terms);
    if (bad) return { ok: false, reason: `${bad} isn't in the cited sources for: "${c.text}"` };
    ownSources.push(...sources.filter((x) => x !== ctx.postingText));
    if (cites && same(c.text).length >= 8) postingClaims.push(same(c.text));
  }
  // The whole answer, not just the listed claims: every sentence needs the user's own sources. Only a sentence that is
  // (or contains) a company claim citing the posting may also use the posting, and never one in the first person (an
  // English-only extra check: the gate is the match with the claim, which works in any language).
  for (const sentence of a.text.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim())) {
    const s = same(sentence);
    const company = !FIRST_PERSON.test(sentence) && postingClaims.some((c) => s.includes(c) || (s.length >= 8 && c.includes(s)));
    const pool = [...ownSources, ...(company ? [ctx.postingText] : [])].join('\n');
    const bad = unsupported(sentence, pool, terms);
    if (bad) return { ok: false, reason: `${bad} isn't in any source you cited: "${sentence.trim()}"` };
  }
  return { ok: true };
}
