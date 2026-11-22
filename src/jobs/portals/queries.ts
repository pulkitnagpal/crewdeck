// What a portal is searched for (ADR-0008 §5): the person's target titles (the first title and up to two variants of
// each kind of job), crossed with where they can work (their on-site places the portal covers, and remote), in the
// portal's own URL format with its place, remote and recency (last 7 days) filters. Deterministic: the same notes give
// the same URLs, logged in the run state so the person (and the setup skill) can see exactly what was searched.
import type { Ctx } from '../ctx.ts';
import { notesOf } from '../ctx.ts';
import { planProfile } from '../planned-run.ts';
import type { WorkMode } from '../directory/plan.ts';
import { countryOf, lookupPlace, place, placeName, plain, within } from '../places.ts';
import { DEFAULT_MULTI_MAX, type Portal } from './catalog.ts';

export type PortalProfile = {
  /** Kinds of job, each with its titles in order (first = the main title). */ targets: { name: string; titles: string[] }[];
  /** Every title (when the notes have no targets). */ titles: string[];
  /** Place ids the person can work in or from (countries, regions). */ countries: string[];
  workModes: WorkMode[];
  /** On-site place names from jobs/search.md, as written. */ places: string[];
  /** Skills from the targets and me/career.md: a few of them (LLM, platform…) become title variants. */ skills?: string[];
};
export type Workplace = 'remote' | 'hybrid' | 'onsite' | 'any';
/** `titles`: the titles this one search covers (`keywords` is them joined in the portal's own syntax). */
export type PortalQuery = { keywords: string; titles: string[]; place?: string; country?: string; workplace: Workplace; url: string };

/** The ADR's default recency: postings from the last 7 days. */
export const RECENCY_DAYS = 7;

/** The person's search, as the portal queries need it (planProfile from the planned run, plus targets and places). */
export function portalProfile(ctx: Ctx): PortalProfile {
  const p = planProfile(ctx);
  const notes = notesOf(ctx);
  const s = notes.search.data;
  const skills = [...new Set([...s.roles.targets.flatMap((t: any) => (t.skills ?? []) as string[]), ...(((notes.career.data as any)?.skills ?? []) as string[])].map((x) => String(x).trim()).filter(Boolean))];
  return {
    targets: s.roles.targets.filter((t) => t.titles.length).map((t) => ({ name: t.name, titles: [...t.titles] })),
    titles: p.titles ?? [], countries: p.countries, workModes: p.workModes, places: [...s.places.onsite], skills,
  };
}

export const slug = (s: string) => plain(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Titles to search, in order: per kind of job its first title and up to two variants; else the first three titles. */
export function queryTitles(p: Pick<PortalProfile, 'targets' | 'titles'>): string[] {
  const out: string[] = [];
  const add = (t: string) => { const x = t.trim(); if (x && !out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x); };
  if (p.targets.length) for (const t of p.targets) t.titles.slice(0, 3).forEach(add);
  else p.titles.slice(0, 3).forEach(add);
  return out;
}

// ---- coverage: which titles, packed into how many searches, rotating across runs (ADR-0008 "Search coverage") ----

/** Words that mark a title as already levelled: no Senior/Staff/Founding is put in front of it. */
const LEVELLED = /\b(senior|sr\.?|staff|principal|lead|founding|junior|jr\.?|intern|head|director|manager|vp|chief)\b/i;
const LEVEL_WORDS = ['Senior', 'Staff', 'Founding'];
/** Skill words worth putting in front of a title ("LLM Software Engineer"), matched against the person's skills. */
const SKILL_WORDS = ['LLM', 'AI', 'ML', 'Platform', 'Data', 'Cloud', 'Infrastructure', 'Backend', 'Frontend', 'Full Stack', 'DevOps', 'Security', 'Mobile', 'Distributed Systems'];

const clean = (t: string) => t.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Variants of a main title in priority order: the person's own other titles, then Senior/Staff/Founding, then skills. */
export function titleVariants(main: string, own: string[], skills: string[] = []): string[] {
  const out: string[] = [];
  const add = (t: string) => { const x = clean(t); if (x && !same(x, main) && !out.some((o) => same(o, x))) out.push(x); };
  own.forEach(add);
  if (!LEVELLED.test(main)) LEVEL_WORDS.forEach((w) => add(`${w} ${main}`));
  // Skill flavours only go on a plain role ("Software Engineer"), not on a levelled one or one that already names a skill
  // area ("AI Engineer", "Platform Engineer"), where "LLM Founding Engineer" or "Platform AI Engineer" would be nonsense.
  const have = new Set(skills.map((k) => k.toLowerCase()));
  const named = (w: string) => new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'i').test(main);
  if (!LEVELLED.test(main) && !SKILL_WORDS.some(named)) for (const w of SKILL_WORDS) if (have.has(w.toLowerCase())) add(`${w} ${main}`);
  return out;
}

/** `n` items of `pool` starting at `from` (wrapping). */
const take = <T>(pool: T[], from: number, n: number): T[] => pool.length <= n ? [...pool] : Array.from({ length: n }, (_, i) => pool[(from + i) % pool.length]);

/** The kinds of job as `{ main, own other titles }` (the notes' titles stand for one kind when there are no targets). */
function kinds(p: Pick<PortalProfile, 'targets' | 'titles'>): { main: string; own: string[] }[] {
  const ts = p.targets.length ? p.targets.map((t) => t.titles) : p.titles.length ? [p.titles] : [];
  return ts.map((t) => t.map(clean).filter(Boolean)).filter((t) => t.length).map((t) => ({ main: t[0], own: t.slice(1) }));
}

/** Every kind of job's main title, de-duplicated, in the person's order. */
export function mainTitles(p: Pick<PortalProfile, 'targets' | 'titles'>): string[] {
  const out: string[] = [];
  for (const k of kinds(p)) if (!out.some((x) => same(x, k.main))) out.push(k.main);
  return out;
}

/**
 * The titles of one run, most specific first: every kind's main title (starting from `mainOffset` when they can't all
 * fit in one run), then each kind's variants: up to two from its pool, which moves two places on every run (`rotation`).
 */
export function searchTitles(p: Pick<PortalProfile, 'targets' | 'titles' | 'skills'>, o: { rotation?: number; mainOffset?: number } = {}): string[] {
  const rot = Math.max(0, Math.floor(o.rotation ?? 0));
  const ks = kinds(p);
  const mains = mainTitles(p);
  const off = mains.length ? (o.mainOffset ?? 0) % mains.length : 0;
  const out: string[] = [];
  const add = (t: string | undefined) => { if (t && !out.some((x) => same(x, t))) out.push(t); };
  [...mains.slice(off), ...mains.slice(0, off)].forEach(add);
  const variants = ks.map((k) => take(titleVariants(k.main, k.own, p.skills), rot * 2, 2));
  for (let i = 0; i < 2; i++) variants.forEach((v) => add(v[i]));
  return out;
}

/** The keywords for a group of titles in the portal's syntax: `"a" OR "b"`, `a, b`, or the lone title as it is. */
export function joinTitles(portal: Portal, titles: string[]): string {
  if (titles.length === 1) return titles[0];
  return portal.search.multi === 'or' ? titles.map((t) => `"${t}"`).join(' OR ') : titles.join(', ');
}

/** Cut a title to `max` characters at a word end (a lone title longer than the portal takes). */
function fit(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trim();
}

/**
 * Titles in groups of one search each, at most `maxGroups`: with no `multi`, one title per group; with it, each title
 * in order goes into the first group whose keywords stay within `multi_max_chars`, so the fewest searches are used.
 * What doesn't fit in `maxGroups` groups is left for another run (rotation).
 */
export function packTitles(portal: Portal, titles: string[], maxGroups: number): string[][] {
  if (!portal.search.multi) return titles.slice(0, maxGroups).map((t) => [t]);
  const cap = portal.search.multi_max_chars ?? DEFAULT_MULTI_MAX;
  const groups: string[][] = [];
  for (const raw of titles) {
    const t = fit(raw, cap);
    if (groups.some((g) => g.some((x) => same(x, t)))) continue;
    const g = groups.find((g) => joinTitles(portal, [...g, t]).length <= cap);
    if (g) g.push(t); else if (groups.length < maxGroups) groups.push([t]);
  }
  return groups;
}

/** (group, where) pairs in diagonal order, cut at `max`. */
function diagonal(groups: number, wheres: number, max: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let g = 0; g < groups; g++) for (let w = 0; w < wheres; w++) pairs.push([g, w]);
  pairs.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
  return pairs.slice(0, max);
}

/** The ISO country of a place id ('in/bengaluru' → 'in'), or the id itself for a region. */
const countryId = (id: string) => countryOf(id) ?? id;
/** Does a portal's country list cover this place id (a city, a country, or a region such as the EU)? */
const covers = (portal: Portal, id: string) => portal.countries.includes('world') || portal.countries.some((c) => within(countryId(id), c) || within(c, id));

/** The recency value for ≈ `days` days: the smallest option at least that long, else the longest there is. */
export function recencyValue(portal: Portal, days = RECENCY_DAYS): string {
  const opts = Object.entries(portal.search.recency ?? {}).map(([d, v]) => [Number(d), v] as const).sort((a, b) => a[0] - b[0]);
  if (!opts.length) return '';
  return (opts.find(([d]) => d >= days) ?? opts[opts.length - 1])[1];
}

/** Drop `name=` (empty) pairs from a query string, keeping everything else exactly as written. */
function dropEmpty(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const kept = url.slice(q + 1).split('&').filter((pair) => pair && !/^[^=]*=$/.test(pair));
  return kept.length ? `${url.slice(0, q)}?${kept.join('&')}` : url.slice(0, q);
}

/** One search URL in the portal's format. `page` counts from 0; null when the portal can't page that far. */
export function searchUrl(portal: Portal, q: Omit<PortalQuery, 'url'>, page = 0, days = RECENCY_DAYS): string | null {
  const s = portal.search;
  if (page > 0 && !s.page) return null;
  const tpl = q.workplace === 'remote' && s.url_remote ? s.url_remote : q.place && s.url_place ? s.url_place : s.url;
  const placeSlug = q.place ? (s.place_aliases?.[slug(q.place)] ?? slug(q.place)) : '';
  const pageValue = !s.page || (page === 0 && s.page.omit_first) ? '' : String(s.page.start + page * s.page.step);
  const hosts = s.country_hosts ?? {};
  const host = (q.country && hosts[q.country]) || Object.values(hosts)[0] || '';
  const values: Record<string, string> = {
    q: encodeURIComponent(q.keywords), q_slug: slug(q.titles?.[0] ?? q.keywords), place: q.place ? encodeURIComponent(q.place) : '', place_slug: placeSlug,
    remote: q.workplace === 'remote' ? s.remote ?? '' : q.workplace === 'hybrid' ? s.hybrid ?? '' : '',
    recency: recencyValue(portal, days), page: pageValue, host,
  };
  return dropEmpty(tpl.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? ''));
}

type Where = { place?: string; country?: string; workplace: Workplace };

/** Where to search on this portal: its covered on-site places, then remote; nothing when it covers none of the person's places. */
export function portalWheres(p: Pick<PortalProfile, 'countries' | 'workModes' | 'places'>, portal: Portal): Where[] {
  const ids = [...p.countries];
  const placeIds = p.places.map((name) => ({ name, id: (lookupPlace(name) ?? [])[0] })).filter((x): x is { name: string; id: string } => !!x.id);
  for (const x of placeIds) if (!ids.includes(x.id)) ids.push(x.id);
  if (ids.length && !ids.some((id) => covers(portal, id))) return [];
  const modes = p.workModes.length ? p.workModes : (['onsite', 'hybrid', 'remote'] as WorkMode[]);
  const out: Where[] = [];
  const local = modes.includes('onsite') ? 'onsite' : modes.includes('hybrid') ? 'hybrid' : null;
  if (local) for (const x of placeIds) {
    if (!covers(portal, x.id)) continue;
    const c = countryOf(x.id);
    out.push({ place: placeName(x.id), ...(c ? { country: c } : {}), workplace: local === 'onsite' && modes.includes('hybrid') ? 'any' : local });
  }
  if (modes.includes('remote')) {
    // Remote from the person's first covered country (its host on a multi-country portal, its name as the place on a
    // worldwide one, where "remote" alone would mean anywhere).
    const from = p.countries.find((id) => covers(portal, id) && place(countryId(id))?.kind === 'country');
    const c = from ? countryId(from) : undefined;
    out.push({ workplace: 'remote', ...(c ? { country: c } : {}), ...(c && portal.countries.includes('world') ? { place: placeName(c) } : {}) });
  }
  if (!out.length && !ids.length) out.push({ workplace: 'any' });
  return out;
}

/**
 * The portal's searches for this person, at most `searches_per_run`: title groups × wheres, taken along the diagonal
 * (first group in the first place, then the second group and the first group remote, …) so a small budget covers both.
 * `rotation` (the portal's count of finished scans) moves the variants and, when not every main title fits, which
 * mains go first, so consecutive runs cover different wordings. Deterministic: same notes + rotation = same URLs.
 */
export function portalQueries(p: PortalProfile, portal: Portal, o: { days?: number; max?: number; rotation?: number } = {}): PortalQuery[] {
  const wheres = portalWheres(p, portal);
  const max = o.max ?? portal.limits.searches_per_run;
  if (!wheres.length || max < 1) return [];
  const rotation = o.rotation ?? 0;
  // The most groups this budget can use (with 2 places, 3 searches = 2 groups).
  const maxGroups = new Set(diagonal(max, wheres.length, max).map(([g]) => g)).size;
  // How many main titles one run holds; each run moves on by that many so every kind of job gets its turn.
  const mains = mainTitles(p);
  const held = packTitles(portal, mains, maxGroups).flat().length;
  const mainOffset = held > 0 && held < mains.length ? (rotation * held) % mains.length : 0;
  const groups = packTitles(portal, searchTitles(p, { rotation, mainOffset }), maxGroups);
  const out: PortalQuery[] = [];
  for (const [gi, wi] of diagonal(groups.length, wheres.length, max)) {
    const titles = groups[gi];
    const q = { keywords: joinTitles(portal, titles), titles, ...wheres[wi] };
    const url = searchUrl(portal, q, 0, o.days);
    if (url && !out.some((x) => x.url === url)) out.push({ ...q, url });
  }
  return out;
}
