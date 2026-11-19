// The source catalog (design D18, §24.2): what each pinned provider is (kind, regions, fields, needs, limits) and how
// Crewdeck fills its keyword and country options from the user's notes at fetch time. The file ships in the repo and is
// never edited per user; the user's choice lives in jobs/sources.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ancestors, countryOf, lookupPlace, place, placeName } from './places.ts';
import type { Search } from './schema.ts';

export const KINDS = ['board', 'aggregator', 'ats', 'national', 'field', 'employer', 'feed'] as const;
export const NEEDS = ['none', 'careers_url', 'config'] as const;
export const CONFIDENCE = ['high', 'medium', 'low'] as const;
export const FILL_FROM = ['titles', 'first_title', 'onsite_place', 'country', 'country_name'] as const;

export type Fill = { from: (typeof FILL_FROM)[number]; max?: number; map?: Record<string, string>; format?: string; required?: boolean };
export type CatalogEntry = {
  id: string; name: string; kind: (typeof KINDS)[number]; needs: (typeof NEEDS)[number]; config: string[]; detect: boolean;
  regions: string[]; families: string[]; workplace: string[]; languages: string[]; seniority: string[];
  runnable: boolean; why?: string; retired?: boolean; blocked?: boolean; coverage: string; note?: string;
  confidence: (typeof CONFIDENCE)[number]; unsure?: string; fill?: Record<string, Fill>;
  /** Crewdeck's own LinkedIn entry only. */ switch?: string[];
};
export type Catalog = { families: Record<string, string>; kinds: Record<string, string>; linkedin: CatalogEntry; sources: CatalogEntry[]; byId: Map<string, CatalogEntry> };

const FILE = join(import.meta.dirname, 'data', 'sources-catalog.yaml');
let cached: Catalog | null = null;

export function loadCatalog(file = FILE): Catalog {
  if (file === FILE && cached) return cached;
  const y = parse(readFileSync(file, 'utf8'));
  const sources = (y.sources ?? []) as CatalogEntry[];
  const cat: Catalog = { families: y.families ?? {}, kinds: y.kinds ?? {}, linkedin: y.linkedin, sources, byId: new Map(sources.map((s) => [s.id, s])) };
  if (file === FILE) cached = cat;
  return cat;
}

export const catalogEntry = (id: string): CatalogEntry | undefined => (id === 'linkedin' ? loadCatalog().linkedin : loadCatalog().byId.get(id));
export const FAMILIES = (): string[] => Object.keys(loadCatalog().families);

const isRegion = (id: string) => { const p = place(id); return !!p && (p.kind === 'region' || p.kind === 'world' || p.kind === 'country'); };

/** Every problem with the catalog's shape (the test keeps this empty). */
export function catalogIssues(cat = loadCatalog()): string[] {
  const out: string[] = [];
  const fam = new Set(Object.keys(cat.families));
  const seen = new Set<string>();
  for (const s of [cat.linkedin, ...cat.sources]) {
    const at = `sources-catalog ${s?.id ?? '(no id)'}`;
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) { out.push(`${at}: bad id`); continue; }
    if (seen.has(s.id)) out.push(`${at}: listed twice`);
    seen.add(s.id);
    if (!s.name) out.push(`${at}: no name`);
    if (!(KINDS as readonly string[]).includes(s.kind)) out.push(`${at}: kind ${s.kind}`);
    if (!(NEEDS as readonly string[]).includes(s.needs)) out.push(`${at}: needs ${s.needs}`);
    if (!(CONFIDENCE as readonly string[]).includes(s.confidence)) out.push(`${at}: confidence ${s.confidence}`);
    if (s.confidence !== 'high' && !s.unsure) out.push(`${at}: ${s.confidence} confidence needs an unsure note`);
    if (typeof s.detect !== 'boolean' || typeof s.runnable !== 'boolean') out.push(`${at}: detect and runnable are true/false`);
    if (s.runnable === false && !s.why) out.push(`${at}: runnable: false needs a why`);
    for (const r of s.regions ?? []) if (!isRegion(r)) out.push(`${at}: region ${r} is not a gazetteer region or country`);
    if (!s.regions?.length) out.push(`${at}: no regions`);
    for (const f of s.families ?? []) if (!fam.has(f)) out.push(`${at}: family ${f}`);
    if (!s.families?.length) out.push(`${at}: no families`);
    for (const w of s.workplace ?? []) if (!['onsite', 'hybrid', 'remote'].includes(w)) out.push(`${at}: workplace ${w}`);
    for (const l of s.languages ?? []) if (!/^[a-z]{2}$/.test(l)) out.push(`${at}: language ${l}`);
    for (const l of s.seniority ?? []) if (!['any', 'entry', 'experienced'].includes(l)) out.push(`${at}: seniority ${l}`);
    for (const [k, f] of Object.entries(s.fill ?? {})) {
      if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)?$/.test(k)) out.push(`${at}: fill key ${k}`);
      if (!(FILL_FROM as readonly string[]).includes(f?.from)) out.push(`${at}: fill ${k} from ${f?.from}`);
      if (f.map) for (const c of Object.keys(f.map)) if (place(c)?.kind !== 'country') out.push(`${at}: fill ${k} map key ${c} is not a country`);
      if (f.format && !/\{(cc|CC)\}/.test(f.format)) out.push(`${at}: fill ${k} format has no {cc} or {CC}`);
    }
    if (s.needs === 'config' && s.runnable && !s.retired && !s.fill && s.kind !== 'feed') out.push(`${at}: needs config but has no fill rules`);
  }
  return out;
}

// ---- fill: keys from the notes at fetch time ----

/** The user's titles, in order: v0.4 targets first (P9c adds their matching), then roles.titles. */
export function userTitles(search: Pick<Search, 'roles'>): string[] {
  const out: string[] = [];
  for (const t of search.roles.targets ?? []) for (const x of t.titles) if (!out.includes(x)) out.push(x);
  for (const x of search.roles.titles) if (!out.includes(x)) out.push(x);
  return out;
}

/** Countries (ISO ids) the user names, in order: on-site places, then remote-from, then their own country. */
export function userCountries(search: Pick<Search, 'places'>, homeCountry = ''): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    for (const id of lookupPlace(name) ?? []) { const c = countryOf(id); if (c && !out.includes(c)) out.push(c); }
  };
  for (const p of search.places.onsite) add(p);
  for (const p of search.places.remote_from) add(p);
  if (homeCountry) add(homeCountry);
  return out;
}

export type FillResult = { entry: Record<string, unknown>; filled: string[]; missing?: string };

const getPath = (o: Record<string, any>, key: string) => key.split('.').reduce<any>((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
function setPath(o: Record<string, any>, key: string, v: unknown) {
  const [a, b] = key.split('.');
  if (b === undefined) { o[a] = v; return; }
  o[a] = o[a] && typeof o[a] === 'object' && !Array.isArray(o[a]) ? { ...o[a] } : {};
  o[a][b] = v;
}
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * The entry with its catalog fill rules applied from the notes. Keys the user set keep their value. A required key
 * that can't be filled names why (the source is then skipped with that reason).
 */
export function fillEntry(entry: Record<string, unknown>, cat: CatalogEntry | undefined, notes: { search: Pick<Search, 'roles' | 'places'>; country?: string }): FillResult {
  const out: Record<string, unknown> = { ...entry };
  const filled: string[] = [];
  if (!cat?.fill) return { entry: out, filled };
  const titles = userTitles(notes.search);
  const countries = userCountries(notes.search, notes.country ?? '');
  for (const [key, f] of Object.entries(cat.fill)) {
    if (!empty(getPath(entry as any, key))) continue;
    let v: unknown;
    if (f.from === 'titles') v = titles.slice(0, f.max ?? 5);
    else if (f.from === 'first_title') v = titles[0];
    else if (f.from === 'onsite_place') v = notes.search.places.onsite[0];
    else {
      // A country the source covers: the map's keys, else its regions; the user's order decides.
      const c = countries.find((x) => (f.map ? Object.hasOwn(f.map, x) : covers(cat.regions, x) || cat.regions.includes('world')));
      if (c) v = f.map ? f.map[c] : f.from === 'country_name' ? placeName(c) : f.format ? f.format.replace(/\{CC\}/g, c.toUpperCase()).replace(/\{cc\}/g, c) : c;
    }
    if (empty(v)) {
      if (f.required) return { entry: out, filled, missing: missingWhy(key, f) };
      continue;
    }
    setPath(out, key, v);
    filled.push(key);
  }
  return { entry: out, filled };
}

/** A country is in a source's regions: listed, or inside a listed region other than the whole world. */
export const covers = (regions: string[], country: string) => regions.includes(country) || regions.some((r) => r !== 'world' && ancestors(country).has(r));

function missingWhy(key: string, f: Fill): string {
  if (f.from === 'titles' || f.from === 'first_title') return `needs keywords (${key}): they come from your job titles; add a title`;
  if (f.from === 'onsite_place') return `needs a place (${key}): it comes from your on-site places`;
  const where = f.map ? Object.keys(f.map).map((c) => placeName(c)).join(', ') : 'its countries';
  return `covers ${where}: none of your places is there`;
}
