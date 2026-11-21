// What a portal is searched for (ADR-0008 §5): the person's target titles (the first title and up to two variants of
// each kind of job), crossed with where they can work (their on-site places the portal covers, and remote), in the
// portal's own URL format with its place, remote and recency (last 7 days) filters. Deterministic: the same notes give
// the same URLs, logged in the run state so the person (and the setup skill) can see exactly what was searched.
import type { Ctx } from '../ctx.ts';
import { notesOf } from '../ctx.ts';
import { planProfile } from '../planned-run.ts';
import type { WorkMode } from '../directory/plan.ts';
import { countryOf, lookupPlace, place, placeName, plain, within } from '../places.ts';
import type { Portal } from './catalog.ts';

export type PortalProfile = {
  /** Kinds of job, each with its titles in order (first = the main title). */ targets: { name: string; titles: string[] }[];
  /** Every title (when the notes have no targets). */ titles: string[];
  /** Place ids the person can work in or from (countries, regions). */ countries: string[];
  workModes: WorkMode[];
  /** On-site place names from jobs/search.md, as written. */ places: string[];
};
export type Workplace = 'remote' | 'hybrid' | 'onsite' | 'any';
export type PortalQuery = { keywords: string; place?: string; country?: string; workplace: Workplace; url: string };

/** The ADR's default recency: postings from the last 7 days. */
export const RECENCY_DAYS = 7;

/** The person's search, as the portal queries need it (planProfile from the planned run, plus targets and places). */
export function portalProfile(ctx: Ctx): PortalProfile {
  const p = planProfile(ctx);
  const s = notesOf(ctx).search.data;
  return {
    targets: s.roles.targets.filter((t) => t.titles.length).map((t) => ({ name: t.name, titles: [...t.titles] })),
    titles: p.titles ?? [], countries: p.countries, workModes: p.workModes, places: [...s.places.onsite],
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
    q: encodeURIComponent(q.keywords), q_slug: slug(q.keywords), place: q.place ? encodeURIComponent(q.place) : '', place_slug: placeSlug,
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
 * The portal's searches for this person, at most `searches_per_run`: titles × wheres, taken along the diagonal (first
 * title in the first place, then the second title and the first title remote, …) so a small budget still covers both.
 */
export function portalQueries(p: PortalProfile, portal: Portal, o: { days?: number; max?: number } = {}): PortalQuery[] {
  const titles = queryTitles(p);
  const wheres = portalWheres(p, portal);
  const pairs: [number, number][] = [];
  titles.forEach((_, ti) => wheres.forEach((_w, wi) => pairs.push([ti, wi])));
  pairs.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
  const out: PortalQuery[] = [];
  const max = o.max ?? portal.limits.searches_per_run;
  for (const [ti, wi] of pairs) {
    if (out.length >= max) break;
    const q = { keywords: titles[ti], ...wheres[wi] };
    const url = searchUrl(portal, q, 0, o.days);
    if (url && !out.some((x) => x.url === url)) out.push({ ...q, url });
  }
  return out;
}
