// Gazetteer: which places contain which, so location rules work for anyone, anywhere ("EU only" passes for Berlin,
// "US only" passes for Texas). Data: src/jobs/data/places.yaml. Matching ignores case and accents, except short codes
// (US, UK, EU), which must be capitals, and US/Canadian abbreviations, which count only after a comma ("Austin, TX").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type PlaceKind = 'world' | 'region' | 'country' | 'state' | 'city' | 'custom';
export type Place = { id: string; name: string; kind: PlaceKind; parents: string[]; at?: [number, number] };
/** A place name found in text: where, and every place it can mean. */
export type Found = { index: number; end: number; text: string; ids: string[] };

type Raw = { id: string; name: string; aliases?: string[]; codes?: string[]; abbr?: string; in?: string[]; at?: [number, number] };

/** Accents off, typographic apostrophes straightened: the form every matcher works on (same length as the input for
 * ordinary text, so match positions line up across regexes). */
export const plain = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[‘’]/g, "'");
/** Lowercase, single-spaced plain text: how names are compared. */
export const fold = (s: string) => plain(s).toLowerCase().replace(/[\s_]+/g, ' ').trim();
/** How place names are keyed: folded, hyphens as spaces ("Tel-Aviv" = "Tel Aviv"). */
const nkey = (s: string) => fold(s).replace(/-/g, ' ').replace(/ +/g, ' ');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (s: string) => s.split(/[\s-]+/).filter(Boolean).map(esc).join('[\\s-]+');
const B = '(?<![\\p{L}\\p{N}])', E = '(?![\\p{L}\\p{N}])';

type G = {
  byId: Map<string, Place>;
  names: Map<string, string[]>;   // folded name/alias → ids
  codes: Map<string, string[]>;   // exact code → ids
  abbrs: Map<string, string[]>;   // exact abbreviation → ids
  lookup: Map<string, string[]>;  // folded name, alias, code or abbreviation → ids (for the user's own notes)
  nameRe: RegExp; codeRe: RegExp; abbrRe: RegExp;
  anc: Map<string, Set<string>>;
};
let G_: G | null = null;
const custom = new Map<string, Place>();

function load(): G {
  if (G_) return G_;
  const y = parse(readFileSync(join(import.meta.dirname, 'data', 'places.yaml'), 'utf8'));
  const byId = new Map<string, Place>(), names = new Map<string, string[]>(), codes = new Map<string, string[]>();
  const abbrs = new Map<string, string[]>(), lookup = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, id: string) => { const l = m.get(k) ?? []; if (!l.includes(id)) l.push(id); m.set(k, l); };
  const kinds: [string, PlaceKind][] = [['regions', 'region'], ['countries', 'country'], ['states', 'state'], ['cities', 'city']];
  for (const [list, kind] of kinds) {
    for (const r of (y[list] ?? []) as Raw[]) {
      const id = String(r.id);
      byId.set(id, { id, name: r.name, kind: id === 'world' ? 'world' : kind, parents: (r.in ?? []).map(String), at: r.at });
      for (const n of [r.name, ...(r.aliases ?? [])]) { add(names, nkey(n), id); add(lookup, nkey(n), id); }
      for (const c of r.codes ?? []) { add(codes, c, id); add(lookup, nkey(c), id); }
      if (r.abbr) { add(abbrs, String(r.abbr), id); add(lookup, nkey(String(r.abbr)), id); }
    }
  }
  for (const p of byId.values()) for (const q of p.parents) if (!byId.has(q)) throw new Error(`places.yaml: ${p.id} is in unknown ${q}`);
  const alt = (keys: string[], f: (s: string) => string) => keys.sort((a, b) => b.length - a.length).map(f).join('|');
  G_ = {
    byId, names, codes, abbrs, lookup, anc: new Map(),
    nameRe: new RegExp(`${B}(?:${alt([...names.keys()], phrase)})${E}`, 'gu'),
    codeRe: new RegExp(`${B}(?:${alt([...codes.keys()], esc)})(?![\\p{L}\\p{N}])`, 'gu'),
    abbrRe: new RegExp(`,[ \\t]*(${alt([...abbrs.keys()], esc)})${E}`, 'gu'),
  };
  return G_;
}

export const place = (id: string): Place | undefined => load().byId.get(id) ?? custom.get(id);
export const placeName = (id: string) => place(id)?.name ?? id;
export const isWorld = (id: string) => id === 'world';

/** Every place that contains `id` (transitively), not including itself. */
export function ancestors(id: string): Set<string> {
  const g = load();
  const have = g.anc.get(id);
  if (have) return have;
  const out = new Set<string>();
  const walk = (x: string) => { for (const p of place(x)?.parents ?? []) if (!out.has(p)) { out.add(p); walk(p); } };
  walk(id);
  if (id !== 'world') out.add('world');
  g.anc.set(id, out);
  return out;
}

/** a is b or inside b. */
export const within = (a: string, b: string) => a === b || b === 'world' || ancestors(a).has(b);

export function countryOf(id: string): string | undefined {
  if (place(id)?.kind === 'country') return id;
  return [...ancestors(id)].find((a) => place(a)?.kind === 'country');
}

function km(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180, [la1, lo1] = a, [la2, lo2] = b;
  const h = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Could someone at/for the user's place `u` take a role tied to place `p`? Yes when either contains the other
 * ("US only" for Texas; a Berlin posting for "remote from Germany"), or two cities are within commuting distance.
 * Cities without coordinates in the same country count as compatible: not near-certain, so the judge decides.
 */
export function compatible(u: string, p: string, commuteKm = 50): boolean {
  if (within(u, p) || within(p, u)) return true;
  const a = place(u), b = place(p);
  const cityish = (x?: Place) => x?.kind === 'city' || x?.kind === 'custom';
  if (!cityish(a) || !cityish(b)) return false;
  if (a!.at && b!.at) return km(a!.at, b!.at) <= commuteKm;
  const ca = countryOf(u), cb = countryOf(p);
  return !!ca && ca === cb;
}

/**
 * The user's own place name → candidate ids, or null when unknown. "Town, Country" works for towns the gazetteer
 * lacks (a custom place inside that country); "Cambridge, MA" picks the reading inside Massachusetts.
 */
export function lookupPlace(name: string): string[] | null {
  const g = load();
  const key = nkey(name);
  if (!key) return null;
  const direct = g.lookup.get(key);
  if (direct) return [...direct];
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const rest = lookupPlace(parts.slice(1).join(', '));
  if (!rest) return null;
  const head = g.lookup.get(nkey(parts[0]));
  if (head) {
    const inside = head.filter((h) => rest.some((r) => within(h, r)));
    return inside.length ? inside : null;
  }
  const id = `custom:${key}`;
  custom.set(id, { id, name: parts[0], kind: 'custom', parents: rest });
  return [id];
}

/** Gazetteer names in (plain) text, with positions. */
export function findPlaces(text: string): Found[] {
  const g = load();
  const t = plain(text), lower = t.toLowerCase();
  const out: Found[] = [];
  for (const m of lower.matchAll(g.nameRe)) out.push({ index: m.index!, end: m.index! + m[0].length, text: t.slice(m.index!, m.index! + m[0].length), ids: [...(g.names.get(nkey(m[0])) ?? [])] });
  for (const m of t.matchAll(g.codeRe)) out.push({ index: m.index!, end: m.index! + m[0].length, text: m[0], ids: [...(g.codes.get(m[0]) ?? [])] });
  for (const m of t.matchAll(g.abbrRe)) {
    const at = m.index! + m[0].length - m[1].length;
    out.push({ index: at, end: at + m[1].length, text: m[1], ids: [...(g.abbrs.get(m[1]) ?? [])] });
  }
  // Drop matches inside a longer one ("Washington, DC" over "DC"), keep reading order.
  out.sort((a, b) => a.index - b.index || b.end - a.end);
  return out.filter((f, i) => f.ids.length && !out.some((o, j) => j !== i && o.index <= f.index && o.end >= f.end && o.end - o.index > f.end - f.index));
}

/**
 * The most specific places named: qualifiers narrow ambiguous names ("Cambridge, MA"), and containers of another
 * named place are dropped ("Munich, Germany" is Munich). Returns one candidate list per remaining name.
 */
export function reducePlaces(found: Found[]): string[][] {
  let sets = found.map((f) => [...f.ids]);
  sets = sets.map((c, i) => {
    const narrowed = c.filter((id) => sets.some((o, j) => j !== i && o.some((x) => x !== id && within(id, x))));
    return narrowed.length ? narrowed : c;
  });
  return sets.filter((c, i) => !c.every((id) => sets.some((o, j) => j !== i && o.some((x) => x !== id && ancestors(x).has(id)))));
}

/** Names of every place in the gazetteer (for did-you-mean on the user's notes). */
export const placeNames = () => [...load().names.keys()];
