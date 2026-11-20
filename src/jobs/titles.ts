// Title matching for every field (design §24.5, D26): one matcher for the gate, rank, LinkedIn's terms and the preview.
// A posting's title is cleaned (gender markers, ids), split into words, its seniority words set apart, and a target
// title matches when each of its words appears, in any order, as the same word, a plural or gendered form of it, or (in
// languages that compound) the tail of a longer word. What each language contributes is data
// (data/title-words.yaml), never per-language code. Nothing fuzzy: every pass can be explained word by word.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { plain } from './places.ts';
import type { Search } from './schema.ts';

export const MATCH_MODES = ['words', 'broad', 'off'] as const;
export const LEVELS_WANTED = ['entry', 'experienced', 'senior', 'any'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];
export type LevelWanted = (typeof LEVELS_WANTED)[number];
export type SeniorityClass = 'entry' | 'student' | 'mid' | 'senior' | 'none';

// ---- the data ----
type LangData = {
  seniority?: Record<string, [string, SeniorityClass]>; end_role?: string[]; stopwords?: string[]; prepositions?: string[];
  endings?: string[]; swaps?: [string, string][]; compound?: boolean; abbreviations?: Record<string, string[]>;
};
export type TitleWords = {
  seniority: Map<string, { canon: string; cls: SeniorityClass }>;
  phrases: Map<string, { canon: string; cls: SeniorityClass }>;
  endRole: Set<string>; stop: Set<string>; preps: Set<string>; endings: Set<string>; swaps: [string, string][];
  compound: Set<string>; abbreviations: Map<string, string[]>;
  genderBrackets: Set<string>; genderEndings: Set<string>; genderJoin: RegExp; languages: string[];
};

const FILE = join(import.meta.dirname, 'data', 'title-words.yaml');
let cached: TitleWords | null = null;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Folded like a title: accents gone, lower case. */
export const foldWord = (s: string) => plain(s).toLowerCase();

export function loadTitleWords(file = FILE): TitleWords {
  if (file === FILE && cached) return cached;
  const y = parse(readFileSync(file, 'utf8')) ?? {};
  const langs: Record<string, LangData> = y.languages ?? {};
  const w: TitleWords = {
    seniority: new Map(), phrases: new Map(), endRole: new Set(), stop: new Set(), preps: new Set(), endings: new Set(), swaps: [],
    compound: new Set((y.compound_only ?? []).map(String)), abbreviations: new Map(),
    genderBrackets: new Set((y.gender?.brackets ?? []).map((b: string) => foldWord(b))), genderEndings: new Set(), genderJoin: /$^/, languages: Object.keys(langs),
  };
  for (const [code, d] of Object.entries(langs)) {
    for (const [k, [canon, cls]] of Object.entries(d.seniority ?? {})) {
      const key = foldWord(String(k));
      (key.includes(' ') ? w.phrases : w.seniority).set(key, { canon: foldWord(canon), cls });
    }
    for (const x of d.end_role ?? []) w.endRole.add(foldWord(x));
    for (const x of d.stopwords ?? []) w.stop.add(foldWord(String(x)));
    for (const x of d.prepositions ?? []) w.preps.add(foldWord(x));
    for (const x of d.endings ?? []) w.endings.add(foldWord(x));
    for (const s of d.swaps ?? []) w.swaps.push([foldWord(s[0]), foldWord(s[1])]);
    if (d.compound) w.compound.add(code);
    for (const [k, v] of Object.entries(d.abbreviations ?? {})) w.abbreviations.set(foldWord(k), v.map(foldWord));
  }
  const joiners: string[] = y.gender?.joiners ?? [];
  const endings: string[] = (y.gender?.endings ?? []).map(foldWord).sort((a: string, b: string) => b.length - a.length);
  w.genderEndings = new Set(endings);
  // "Buchhalter*in", "Traductor/a", "Comptable(e)": an ending glued to a word (of 2+ letters) by a joiner, then a word end.
  const join_ = joiners.filter((j) => j !== '(').sort((a, b) => b.length - a.length).map(esc).join('|');
  w.genderJoin = new RegExp(`(?<=\\p{L}{2})(?:(?:${join_})(?:${endings.map(esc).join('|')})(?![\\p{L}\\p{N}-])|\\((?:${endings.map(esc).join('|')})\\))`, 'gu');
  if (file === FILE) cached = w;
  return w;
}

// ---- reading a title ----
/** One word: `w` its canonical form (seniority words: "sr" → senior), `f` as written (folded). */
export type Word = { w: string; f: string; raw: string; stop?: boolean; seniority?: { canon: string; cls: SeniorityClass } };
export type ReadTitle = {
  /** Every word but stop words: what targets match against. */
  words: Word[];
  /** Words that aren't seniority words (canonical, in order). */
  role: string[];
  seniority: { word: string; canon: string; cls: SeniorityClass }[];
  /** The main part (before " - ", ",", "|" or a bracket) without seniority words: the near-miss label and its key. */
  label: string; key: string;
  /** The plain title's words, uncleaned (v1 titles match these with the old gate's reach). */
  flat: string[];
};

// A bracket of single letters joined by / , | or . : (m/w/d), (f/m/x), (h/f), (M/F/D).
const LETTERS_IN_BRACKET = /[([]\s*\p{L}(?:\s*[/,|.]\s*\p{L}){1,4}\s*[)\]]/gu;
const ID = /\p{N}.*\p{N}.*\p{N}/u;
const split = (s: string) => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Remove gender markers; keep everything else (extra words never block a match). */
export function cleanTitle(title: string, tw = loadTitleWords()): string {
  let t = plain(String(title ?? '')).replace(/[\u2010-\u2015]/g, '-');
  t = t.replace(LETTERS_IN_BRACKET, ' ');
  t = t.replace(/[([]([^()[\]]{1,30})[)\]]/g, (m, inner: string) => { const k = foldWord(inner).trim(); return tw.genderBrackets.has(k) || tw.genderEndings.has(k) ? ' ' : m; });
  return t.replace(tw.genderJoin, '').replace(/\s+/g, ' ').trim();
}

function wordsOf(text: string, tw: TitleWords): Word[] {
  const raw = split(text);
  const out: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = foldWord(raw[i]);
    if (ID.test(f)) continue; // requisition ids
    const pair = i + 1 < raw.length ? tw.phrases.get(`${f} ${foldWord(raw[i + 1])}`) : undefined;
    if (pair) { out.push({ w: pair.canon, f: `${f} ${foldWord(raw[i + 1])}`, raw: `${raw[i]} ${raw[i + 1]}`, seniority: pair }); i++; continue; }
    if (tw.stop.has(f)) { out.push({ w: f, f, raw: raw[i], stop: true }); continue; }
    const s = tw.seniority.get(f);
    out.push(s ? { w: s.canon, f, raw: raw[i], seniority: s } : { w: f, f, raw: raw[i] });
  }
  // "lead" at the end ("Tech Lead") is the role, not a seniority, when another word is there.
  const content = out.filter((x) => !x.stop);
  const last = content.at(-1);
  if (last?.seniority && tw.endRole.has(last.f) && content.some((x) => !x.seniority)) { last.w = last.f; delete last.seniority; }
  return out;
}

function labelOf(ws: Word[]): { label: string; key: string } {
  let a = 0, b = ws.length;
  while (a < b && ws[a].stop) a++;
  while (b > a && ws[b - 1].stop) b--;
  const part = ws.slice(a, b);
  return { label: part.map((x) => x.raw).join(' '), key: part.filter((x) => !x.stop).map((x) => x.w).join(' ') };
}

export function readTitle(title: string, tw = loadTitleWords()): ReadTitle {
  const clean = cleanTitle(title, tw);
  const content = wordsOf(clean, tw).filter((x) => !x.stop);
  const mainText = clean.split(/\s[-|:]\s|[,([]|\s\/\s/)[0];
  return {
    words: content,
    role: content.filter((x) => !x.seniority).map((x) => x.w),
    seniority: content.filter((x) => x.seniority).map((x) => ({ word: x.raw, canon: x.seniority!.canon, cls: x.seniority!.cls })),
    ...labelOf(wordsOf(mainText, tw).filter((x) => !x.seniority)),
    flat: split(plain(String(title ?? ''))).map((x) => x.toLowerCase()),
  };
}

// ---- targets ----
export type Target = { name: string; titles: string[]; families: string[]; skills: string[]; /** v1 roles.titles */ legacy?: boolean; path: string };
type TWord = { w: string; f: string; whole: boolean };
type Variant = { title: string; words: TWord[]; flat: string[]; head: string | null; order: string[] };
export type CompiledTarget = Target & { variants: Variant[]; heads: string[]; own: Set<string> };
export type TitleMatcher = { mode: MatchMode; level: LevelWanted; targets: CompiledTarget[]; userCompound: boolean; tw: TitleWords };

/** The user's targets: roles.targets, then roles.titles (v1) as one more target. */
export function targetsOf(search: Pick<Search, 'roles'>): Target[] {
  const out: Target[] = (search.roles.targets ?? []).map((t, i) => ({
    name: t.name || t.titles[0] || `Target ${i + 1}`, titles: t.titles, families: t.families ?? [], skills: t.skills ?? [], path: `roles.targets[${i}].titles`,
  })).filter((t) => t.titles.length);
  if (search.roles.titles.length) out.push({ name: 'Your titles', titles: search.roles.titles, families: [], skills: [], legacy: true, path: 'roles.titles' });
  return out;
}

/** LinkedIn's search terms: each target's first three titles (D22), then roles.titles. */
export function searchTerms(search: Pick<Search, 'roles'>): string[] {
  const terms = [...(search.roles.targets ?? []).flatMap((t) => t.titles.slice(0, 3)), ...search.roles.titles].map((t) => t.trim()).filter(Boolean);
  return [...new Set(terms)];
}

const isWhole = (w: string, tw: TitleWords) => w.length < 4 || tw.abbreviations.has(w);

function variantOf(title: string, tw: TitleWords): Variant | null {
  const all = wordsOf(cleanTitle(title, tw), tw);
  const content = all.filter((x) => !x.stop);
  if (!content.length) return null;
  // The head: the last role word before the first preposition ("teacher of maths" → teacher; "profesor de
  // matematicas" → profesor), else the last role word.
  const prep = all.findIndex((x, i) => i > 0 && x.stop && tw.preps.has(x.w));
  const before = (prep > 0 ? all.slice(0, prep) : all).filter((x) => !x.stop && !x.seniority);
  const head = before.at(-1)?.w ?? content.filter((x) => !x.seniority).at(-1)?.w ?? null;
  return { title, words: content.map((x) => ({ w: x.w, f: x.f, whole: isWhole(x.w, tw) })), flat: split(plain(title)).map((x) => x.toLowerCase()), head, order: content.map((x) => x.w) };
}

/** Language names as people write them (English names and endonyms) → ISO 639-1, for the compound rule. */
const LANG_NAMES: Record<string, string> = {
  german: 'de', deutsch: 'de', dutch: 'nl', nederlands: 'nl', flemish: 'nl', swedish: 'sv', svenska: 'sv', danish: 'da', dansk: 'da',
  norwegian: 'no', norsk: 'no', finnish: 'fi', suomi: 'fi', english: 'en', french: 'fr', francais: 'fr', spanish: 'es', espanol: 'es',
  portuguese: 'pt', portugues: 'pt', italian: 'it', italiano: 'it',
};
const langOf = (name: string) => { const n = foldWord(name).trim(); return /^[a-z]{2}$/.test(n) ? n : LANG_NAMES[n]; };

export function titleMatcher(search: Pick<Search, 'roles'> & Partial<Pick<Search, 'languages'>>, tw = loadTitleWords()): TitleMatcher {
  const targets = targetsOf(search).map((t) => {
    const variants = t.titles.map((x) => variantOf(x, tw)).filter((v): v is Variant => !!v);
    return { ...t, variants, heads: [...new Set(variants.map((v) => v.head).filter((h): h is string => !!h))], own: new Set(variants.flatMap((v) => v.words.map((x) => x.w))) };
  });
  const langs = (search.languages ?? []).map((l) => langOf(l.name)).filter(Boolean) as string[];
  return { mode: search.roles.match ?? 'words', level: search.roles.level ?? 'any', targets, userCompound: langs.some((l) => tw.compound.has(l)), tw };
}

/** Does posting word `w` stand for target word `t`? Same word, an ending, a vowel swap, or a compound tail. */
export function wordHit(t: { w: string; whole: boolean }, w: string, compound: boolean, tw = loadTitleWords()): boolean {
  if (w === t.w) return true;
  if (t.whole) return t.w.length >= 2 && w === `${t.w}s`; // "RNs", "SREs": a plural, never a longer word

  if (w.startsWith(t.w) && tw.endings.has(w.slice(t.w.length))) return true;
  for (const [a, b] of tw.swaps) if (t.w.endsWith(a) && t.w.length - a.length >= 3 && w === t.w.slice(0, -a.length) + b) return true;
  if (compound && t.w.length >= 5 && w.length > t.w.length) {
    for (let i = w.indexOf(t.w, 1); i > 0; i = w.indexOf(t.w, i + 1)) {
      const rest = w.slice(i + t.w.length);
      if (rest === '' || tw.endings.has(rest)) return true;
    }
  }
  return false;
}
/** A target word against a posting word: by canonical form (seniority words), or as written. */
const hit = (t: TWord, p: Word, compound: boolean, tw: TitleWords) => t.w === p.w || wordHit(t, p.f, compound, tw) || (t.f !== t.w && wordHit({ w: t.f, whole: t.whole }, p.f, compound, tw));

export type TitleMatch = { target: number; name: string; title: string; variant: number; how: 'exact' | 'words' | 'broad'; skills: string[] };

const compoundFor = (m: TitleMatcher, lang?: string | null) => m.userCompound || (!!lang && m.tw.compound.has(foldWord(lang).slice(0, 2)));

/** Where each target word sits in the posting (-1: missing). */
function positions(v: Variant, read: ReadTitle, legacy: boolean, compound: boolean, tw: TitleWords): number[] {
  const pos = v.words.map((x) => read.words.findIndex((p) => hit(x, p, compound, tw)));
  if (!legacy || pos.every((p) => p >= 0)) return pos;
  // v1 titles keep the old gate's reach: every word also matches the start of a longer word, on the uncleaned title.
  return v.flat.map((x) => read.flat.findIndex((p) => p.startsWith(x)));
}

/** The best target title a posting matches (exact phrase first, then any order, then a head word in broad mode). */
export function matchTitle(m: TitleMatcher, title: string, lang?: string | null, read = readTitle(title, m.tw)): TitleMatch | null {
  const compound = compoundFor(m, lang);
  let best: TitleMatch | null = null;
  outer: for (let ti = 0; ti < m.targets.length; ti++) {
    const t = m.targets[ti];
    for (let vi = 0; vi < t.variants.length; vi++) {
      const pos = positions(t.variants[vi], read, !!t.legacy, compound, m.tw);
      if (pos.some((h) => h < 0)) continue;
      const how = pos.every((h, i) => i === 0 || h === pos[i - 1] + 1) ? 'exact' : 'words';
      if (!best || (best.how === 'words' && how === 'exact')) best = { target: ti, name: t.name, title: t.variants[vi].title, variant: vi, how, skills: t.skills };
      if (how === 'exact') break outer;
    }
  }
  if (best || m.mode !== 'broad') return best;
  const near = closest(m, read, lang);
  if (!near) return null;
  const t = m.targets[near.target];
  return { target: near.target, name: t.name, title: near.head, variant: Math.max(0, t.variants.findIndex((v) => v.head === near.head)), how: 'broad', skills: t.skills };
}

/** The seniority word that rules a posting out for the user's level, or null. Words the user wrote never do. */
export function levelBlock(m: TitleMatcher, read: ReadTitle): string | null {
  if (m.level === 'any') return null;
  const out: Record<Exclude<LevelWanted, 'any'>, SeniorityClass[]> = { entry: ['senior'], experienced: ['student'], senior: ['entry', 'student'] };
  const bad = read.seniority.find((s) => out[m.level as Exclude<LevelWanted, 'any'>].includes(s.cls) && !m.targets.some((t) => t.own.has(s.canon)));
  return bad ? bad.word : null;
}

/** The target head word a title shares (engineer, nurse, teacher), for broad mode, drop reasons and near misses. */
export function closest(m: TitleMatcher, read: ReadTitle, lang?: string | null): { target: number; head: string } | null {
  const compound = compoundFor(m, lang);
  for (let ti = 0; ti < m.targets.length; ti++) {
    for (const h of m.targets[ti].heads) {
      if (read.words.some((p) => !p.seniority && wordHit({ w: h, whole: isWhole(h, m.tw) }, p.f, compound, m.tw))) return { target: ti, head: h };
    }
  }
  return null;
}

/** Abbreviations whose long form is (part of) one of a target's titles: "RN" for "registered nurse". */
export function abbreviationsFor(m: TitleMatcher, ti: number): { abbr: string; long: string }[] {
  const t = m.targets[ti];
  const out: { abbr: string; long: string }[] = [];
  for (const [abbr, longs] of m.tw.abbreviations) {
    if (t.own.has(abbr)) continue;
    const long = longs.find((l) => t.variants.some((v) => ` ${v.order.join(' ')} `.includes(` ${l} `)));
    if (long) out.push({ abbr, long });
  }
  return out;
}

/** How the matcher reads the user's targets, for `crewdeck jobs rules`. */
export function describeMatcher(m: TitleMatcher): string {
  if (m.mode === 'off') return 'off (roles.match: off: every title goes to the judge)';
  const ts = m.targets.map((t) => `${t.name}: ${t.titles.join(', ')}${t.legacy ? ' (roles.titles: a word also matches the start of a longer word, as before)' : ''}`);
  return `every word of one of your titles, in any order (plurals and gendered forms${m.userCompound ? ', compound tails' : ''}; seniority words apart)${m.mode === 'broad' ? '; broad: a shared head word too' : ''}${m.level !== 'any' ? `; level: ${m.level}` : ''}: ${ts.join(' | ')}`;
}
