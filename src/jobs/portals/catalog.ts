// The signed-in portals catalog (ADR-0008 §6): src/jobs/data/portals.yaml, typed and validated on load. It ships in the
// repo and is never edited per person; the person's choice is a `portal: <id>` item in jobs/sources.md, and the
// connection state lives in <jobs.home>/state/portals.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { FAMILIES } from '../catalog.ts';
import { place } from '../places.ts';
import { hostAllowed } from '../net/netguard.ts';

export type Limits = { searches_per_run: number; pages_per_search: number; delay_ms: number | [number, number]; min_hours: number; pages_per_day: number };
/** A list of postings the page has: `url` a JSON response it loads (regex), or `state` a window value (e.g. __NEXT_DATA__.props); `list` is relative to it. */
export type JsonAdapter = { url: string; state?: string; list: string; where?: Record<string, string>; fields: Record<string, string>; url_template?: string };
export type Portal = {
  id: string; name: string; countries: string[]; fields: string[];
  hosts: string[]; cdn_hosts: string[]; auth_hosts: string[];
  signup_url: string; login_url: string;
  signed_in: { cookie?: string; url_pattern?: string; selector?: string };
  sign_in_wall: string[];
  search: {
    url: string; url_place?: string; url_remote?: string; remote?: string; hybrid?: string;
    recency?: Record<string, string>; page?: { start: number; step: number; omit_first?: boolean };
    place_aliases?: Record<string, string>; country_hosts?: Record<string, string>;
  };
  job_url: { pattern: string; keep_params?: string[]; canonical?: string };
  json: JsonAdapter[];
  /** Pane mode: the page's own job cards, read by CSS selectors (the page's text, no extra request). */
  cards?: CardAdapter[];
  limits: Limits; headful: boolean; risk: string; verified: boolean; notes?: string;
  /** A lightweight entry (`teach: true`): only who it is and where it lives. It has no reader (search, job_url, cards)
   * until Claude teaches one in the pane (readers.ts, <jobs.home>/portals/readers.yaml); until then it is never scanned. */
  teach: boolean;
  /** Its own address (teach entries: where connect opens when there is no login_url). */ home_url?: string;
  kind?: PortalKind; access?: 'signed-in' | 'public-search'; importance?: number;
  /** The effective entry carries a reader from the person's readers.yaml (readers.ts). */ reader?: boolean;
  /** The person added it themselves (readers.yaml `added`, an approved proposal). */ added?: boolean;
};
export const PORTAL_KINDS = ['portal', 'board', 'aggregator', 'niche', 'campus', 'staffing', 'freelance', 'government'] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];
/** A teach entry with a reader (or a full entry): search and job URLs to scan. */
export const canScan = (p: Portal) => !p.teach && !!p.search.url && !!p.job_url.pattern;
/** A job card: either CSS selectors for its parts, or `react` (the card component's prop holding the job record, read
 * from the page's own data with no request) mapped by `fields` like a JSON adapter. */
export type CardAdapter = {
  item: string; title?: string; company?: string; location?: string; posted_at?: string; description?: string; react?: string; fields?: Record<string, string>;
  /** The card's text names how it is applied to (LinkedIn's "Easy Apply"): pattern (regex, case-insensitive) → kind. */
  apply_hint?: { pattern: string; kind: 'linkedin_easy' };
  /** The job's id from an attribute of the card (id_pattern's first group), its link from url_template. */
  id_attr?: string; id_pattern?: string; url_template?: string;
  /** The parts as the card's paragraphs in order (the last line of each), when its classes are generated. */
  lines?: { selector: string; title: number; company?: number; location?: number };
};
export type PortalCatalog = { portals: Portal[]; byId: Map<string, Portal>; /** The file's own entries and defaults (readers overlay them). */ raw?: { defaults: any; byId: Map<string, any> };
  /** The person's own added portals' raw entries (readers.ts). */ added?: Map<string, any> };

const FILE = join(import.meta.dirname, '..', 'data', 'portals.yaml');
export const PORTAL_ID = /^[a-z][a-z0-9-]{1,30}$/;
const PLACEHOLDERS = new Set(['q', 'q_slug', 'place', 'place_slug', 'remote', 'recency', 'page', 'host', 'path']);
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').map(String) : []);
const rec = (v: unknown): Record<string, string> => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)])) : {});

/** One raw entry with the file's defaults applied. Validation is separate (portalIssues) so a test can show every problem. */
/** A teach entry's hosts from its home address: the host and its bare domain (subdomains are covered by hostIn). */
export function hostsFromUrl(url: string): string[] {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { return []; }
  const bare = h.replace(/^www\./, '');
  return [...new Set([h, bare, `www.${bare}`])];
}

export function normalise(e: any, d: any): Portal {
  const lim = { ...(d?.limits ?? {}), ...(e?.limits ?? {}) };
  const s = e?.search ?? {};
  const teach = e?.teach === true;
  const home = e?.home_url ?? e?.url;
  const hosts = strs(e?.hosts).length ? strs(e?.hosts) : typeof home === 'string' ? hostsFromUrl(home) : [];
  const login = String(e?.login_url ?? (typeof home === 'string' ? home : ''));
  return {
    id: String(e?.id ?? ''), name: String(e?.name ?? ''), countries: strs(e?.countries), fields: strs(e?.fields),
    hosts: hosts.map((h) => h.toLowerCase()), cdn_hosts: strs(e?.cdn_hosts).map((h) => h.toLowerCase()),
    auth_hosts: [...new Set([...strs(d?.auth_hosts), ...strs(e?.auth_hosts)].map((h) => h.toLowerCase()))],
    signup_url: String(e?.signup_url ?? login), login_url: login,
    signed_in: { ...(e?.signed_in?.cookie ? { cookie: String(e.signed_in.cookie) } : {}), ...(e?.signed_in?.url_pattern ? { url_pattern: String(e.signed_in.url_pattern) } : {}), ...(e?.signed_in?.selector ? { selector: String(e.signed_in.selector) } : {}) },
    sign_in_wall: strs(e?.sign_in_wall ?? d?.sign_in_wall),
    search: {
      url: String(s.url ?? ''), ...(s.url_place ? { url_place: String(s.url_place) } : {}), ...(s.url_remote ? { url_remote: String(s.url_remote) } : {}),
      ...(s.remote !== undefined ? { remote: String(s.remote) } : {}), ...(s.hybrid !== undefined ? { hybrid: String(s.hybrid) } : {}),
      ...(s.recency ? { recency: rec(s.recency) } : {}),
      ...(s.page ? { page: { start: Number(s.page.start ?? 0), step: Number(s.page.step ?? 1), omit_first: s.page.omit_first === true } } : {}),
      ...(s.place_aliases ? { place_aliases: rec(s.place_aliases) } : {}), ...(s.country_hosts ? { country_hosts: rec(s.country_hosts) } : {}),
    },
    job_url: { pattern: String(e?.job_url?.pattern ?? ''), ...(e?.job_url?.keep_params ? { keep_params: strs(e.job_url.keep_params) } : {}), ...(e?.job_url?.canonical ? { canonical: String(e.job_url.canonical) } : {}) },
    ...(e?.cards ? { cards: [].concat(e.cards).filter((c: any) => c && typeof c === 'object').map((c: any) => ({
      ...Object.fromEntries(['item', 'title', 'company', 'location', 'posted_at', 'description', 'react', 'id_attr', 'id_pattern', 'url_template'].filter((k) => typeof c[k] === 'string').map((k) => [k, String(c[k])])),
      ...(c.fields ? { fields: rec(c.fields) } : {}),
      ...(c.apply_hint && typeof c.apply_hint.pattern === 'string' ? { apply_hint: { pattern: String(c.apply_hint.pattern), kind: c.apply_hint.kind } } : {}),
      ...(c.lines && typeof c.lines.selector === 'string' ? { lines: { selector: String(c.lines.selector), title: Number(c.lines.title ?? 0), ...(c.lines.company !== undefined ? { company: Number(c.lines.company) } : {}), ...(c.lines.location !== undefined ? { location: Number(c.lines.location) } : {}) } } : {}),
    }) as CardAdapter) } : {}),
    json: (Array.isArray(e?.json) ? e.json : []).map((j: any) => ({ url: String(j?.url ?? ''), ...(j?.state ? { state: String(j.state) } : {}), list: String(j?.list ?? ''), fields: rec(j?.fields), ...(j?.where ? { where: rec(j.where) } : {}), ...(j?.url_template ? { url_template: String(j.url_template) } : {}) })),
    limits: { searches_per_run: Number(lim.searches_per_run), pages_per_search: Number(lim.pages_per_search), delay_ms: Array.isArray(lim.delay_ms) ? [Number(lim.delay_ms[0]), Number(lim.delay_ms[1])] : Number(lim.delay_ms), min_hours: Number(lim.min_hours), pages_per_day: Number(lim.pages_per_day) },
    headful: e?.headful === true, risk: String(e?.risk ?? ''), verified: e?.verified === true, ...(e?.notes ? { notes: String(e.notes) } : {}),
    teach, ...(typeof home === 'string' ? { home_url: String(home) } : {}),
    ...(e?.kind !== undefined ? { kind: String(e.kind) as PortalKind } : {}), ...(e?.access !== undefined ? { access: String(e.access) as Portal['access'] } : {}),
    ...(e?.importance !== undefined ? { importance: Number(e.importance) } : {}),
  };
}

const regexOk = (s: string) => { try { new RegExp(s); return true; } catch { return false; } };
const httpsUrl = (s: string) => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };
/** Hosts of a URL template, when its host isn't a placeholder. */
const templateHost = (t: string) => { const m = /^https:\/\/([^/?#{}]+)[/?]/.exec(t + '/'); return m ? m[1].toLowerCase() : null; };
export const hostIn = hostAllowed;

/** Every problem with one entry (the catalog test keeps this empty for the shipped file). */
export function portalIssues(p: Portal): string[] {
  const out: string[] = [];
  const at = `portals ${p.id || '(no id)'}`;
  if (p.kind !== undefined && !(PORTAL_KINDS as readonly string[]).includes(p.kind)) out.push(`${at}: kind is one of ${PORTAL_KINDS.join(', ')}`);
  if (p.access !== undefined && p.access !== 'signed-in' && p.access !== 'public-search') out.push(`${at}: access is signed-in or public-search`);
  if (p.importance !== undefined && ![1, 2, 3].includes(p.importance)) out.push(`${at}: importance is 1, 2 or 3`);
  if (p.home_url !== undefined && (!httpsUrl(p.home_url) || !hostIn(new URL(p.home_url).hostname, p.hosts))) out.push(`${at}: home_url is an https address on the portal's hosts`);
  if (p.teach) return [...out, ...teachIssues(p, at)];
  if (!PORTAL_ID.test(p.id)) out.push(`${at}: bad id`);
  if (!p.name) out.push(`${at}: no name`);
  if (!p.countries.length) out.push(`${at}: no countries`);
  for (const c of p.countries) if (c !== 'world' && place(c)?.kind !== 'country') out.push(`${at}: country ${c} is not an ISO country id`);
  const fams = new Set(FAMILIES());
  if (!p.fields.length) out.push(`${at}: no fields`);
  for (const f of p.fields) if (f !== 'any' && !fams.has(f)) out.push(`${at}: field ${f}`);
  if (!p.hosts.length) out.push(`${at}: no hosts`);
  for (const h of [...p.hosts, ...p.cdn_hosts, ...p.auth_hosts]) if (!HOST.test(h)) out.push(`${at}: host ${h}`);
  for (const h of p.cdn_hosts) if (p.hosts.includes(h)) out.push(`${at}: ${h} is in hosts and cdn_hosts`);
  for (const k of ['signup_url', 'login_url'] as const) {
    if (!httpsUrl(p[k])) out.push(`${at}: ${k} is not an https URL`);
    else if (!hostIn(new URL(p[k]).hostname, p.hosts)) out.push(`${at}: ${k} is not on the portal's hosts`);
  }
  if (!p.signed_in.cookie && !p.signed_in.url_pattern && !p.signed_in.selector && p.access !== 'public-search') out.push(`${at}: signed_in needs a cookie, url_pattern or selector`);
  if (p.signed_in.url_pattern && !regexOk(p.signed_in.url_pattern)) out.push(`${at}: signed_in.url_pattern is not a regex`);
  for (const w of p.sign_in_wall) if (!regexOk(w)) out.push(`${at}: sign_in_wall ${w} is not a regex`);
  for (const k of ['url', 'url_place', 'url_remote'] as const) {
    const t = p.search[k];
    if (t === undefined) continue;
    if (!t.startsWith('https://')) out.push(`${at}: search.${k} is not https`);
    for (const m of t.matchAll(/\{(\w+)\}/g)) if (!PLACEHOLDERS.has(m[1]) || m[1] === 'path') out.push(`${at}: search.${k} has an unknown placeholder {${m[1]}}`);
    const h = templateHost(t);
    if (h && !hostIn(h, p.hosts)) out.push(`${at}: search.${k} is not on the portal's hosts`);
    if (!h && !t.startsWith('https://{host}')) out.push(`${at}: search.${k} has no host`);
    if (t.includes('{host}') && !p.search.country_hosts) out.push(`${at}: search.${k} uses {host} without country_hosts`);
  }
  if (!p.search.url) out.push(`${at}: no search.url`);
  for (const [c, h] of Object.entries(p.search.country_hosts ?? {})) {
    if (!p.countries.includes(c)) out.push(`${at}: country_hosts ${c} is not one of its countries`);
    if (!hostIn(h, p.hosts)) out.push(`${at}: country_hosts ${c} → ${h} is not on the portal's hosts`);
  }
  for (const d of Object.keys(p.search.recency ?? {})) if (!/^\d{1,3}$/.test(d)) out.push(`${at}: recency key ${d} is not a number of days`);
  if (p.search.page && !(p.search.page.step > 0 && p.search.page.start >= 0)) out.push(`${at}: search.page needs start ≥ 0 and step > 0`);
  if (!p.job_url.pattern || !regexOk(p.job_url.pattern)) out.push(`${at}: job_url.pattern is missing or not a regex`);
  for (const c of p.cards ?? []) {
    if (!c.item) out.push(`${at}: cards need an item selector`);
    if (c.react ? !(c.fields?.title && c.fields?.url) : !(c.title || c.lines)) out.push(`${at}: cards need a title selector, lines, or react with fields.title and fields.url`);
    if (c.id_attr && !(c.id_pattern && regexOk(c.id_pattern) && c.url_template?.includes('{id}'))) out.push(`${at}: cards id_attr needs an id_pattern regex and a url_template with {id}`);
    if (c.apply_hint && (!regexOk(c.apply_hint.pattern) || c.apply_hint.kind !== 'linkedin_easy')) out.push(`${at}: cards apply_hint needs a regex pattern and kind linkedin_easy`);
    if (c.react && !/^[A-Za-z_$][\w$]*$/.test(c.react)) out.push(`${at}: cards react is a prop name`);
  }
  for (const j of p.json) {
    if (!j.url && !j.state) out.push(`${at}: json needs a url (a response pattern) or a state path`);
    if (j.url && !regexOk(j.url)) out.push(`${at}: json url is not a regex`);
    if (j.state && !/^[A-Za-z_$][\w$]*(\.[\w$-]+)*$/.test(j.state)) out.push(`${at}: json state is a dotted path from a window value`);
    if (!j.list) out.push(`${at}: json has no list path`);
    if (!j.fields.title) out.push(`${at}: json fields need a title`);
    if (!j.fields.url && !j.url_template) out.push(`${at}: json needs fields.url or url_template`);
  }
  const l = p.limits;
  const delays = Array.isArray(l.delay_ms) ? l.delay_ms : [l.delay_ms];
  if (!(l.searches_per_run >= 1 && l.searches_per_run <= 10)) out.push(`${at}: searches_per_run is 1 to 10`);
  if (!(l.pages_per_search >= 1 && l.pages_per_search <= 5)) out.push(`${at}: pages_per_search is 1 to 5`);
  if (!delays.every((x) => Number.isFinite(x) && x >= 3000) || (Array.isArray(l.delay_ms) && l.delay_ms[0] > l.delay_ms[1])) out.push(`${at}: delay_ms is at least 3000 (or [min, max])`);
  if (!(l.min_hours >= 1)) out.push(`${at}: min_hours is at least 1`);
  if (!(l.pages_per_day >= 1 && l.pages_per_day <= 100)) out.push(`${at}: pages_per_day is 1 to 100`);
  if (!p.risk) out.push(`${at}: no risk note`);
  if (!p.verified && !p.notes) out.push(`${at}: verified: false needs a note saying what wasn't checked`);
  return out;
}

/** A lightweight entry: who it is and where it lives, nothing to scan yet (a reader adds that, readers.ts). */
function teachIssues(p: Portal, at: string): string[] {
  const out: string[] = [];
  if (!PORTAL_ID.test(p.id)) out.push(`${at}: bad id`);
  if (!p.name) out.push(`${at}: no name`);
  if (!p.countries.length) out.push(`${at}: no countries`);
  for (const c of p.countries) if (c !== 'world' && place(c)?.kind !== 'country') out.push(`${at}: country ${c} is not an ISO country id`);
  const fams = new Set(FAMILIES());
  if (!p.fields.length) out.push(`${at}: no fields`);
  for (const f of p.fields) if (f !== 'any' && !fams.has(f)) out.push(`${at}: field ${f}`);
  if (!p.home_url) out.push(`${at}: a teach entry needs its home url`);
  if (!p.hosts.length) out.push(`${at}: no hosts`);
  for (const h of p.hosts) if (!HOST.test(h)) out.push(`${at}: host ${h}`);
  if (!httpsUrl(p.login_url) || !hostIn(new URL(p.login_url).hostname, p.hosts)) out.push(`${at}: login_url is not an https address on the portal's hosts`);
  if (!p.kind) out.push(`${at}: a teach entry needs a kind`);
  if (!p.access) out.push(`${at}: a teach entry needs access (signed-in or public-search)`);
  if (p.importance === undefined) out.push(`${at}: a teach entry needs importance (1 to 3)`);
  if (!p.risk) out.push(`${at}: no risk note`);
  if (p.verified) out.push(`${at}: a teach entry is never verified (it has nothing to check yet)`);
  if (!p.notes) out.push(`${at}: a teach entry needs a note`);
  if (p.search.url || p.job_url.pattern || p.cards?.length || p.json.length) out.push(`${at}: a teach entry has no search, job_url, cards or json (the person's reader adds them)`);
  return out;
}

export function catalogProblems(cat: PortalCatalog): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of cat.portals) {
    if (seen.has(p.id)) out.push(`portals ${p.id}: listed twice`);
    seen.add(p.id);
    out.push(...portalIssues(p));
  }
  return out;
}

let cached: PortalCatalog | null = null;
/** The catalog; throws when the file has a problem (a broken shipped file is a bug, not a person's mistake). */
export function loadPortals(file = FILE): PortalCatalog {
  if (file === FILE && cached) return cached;
  const y = parse(readFileSync(file, 'utf8')) ?? {};
  const list = Array.isArray(y.portals) ? y.portals : [];
  const portals = list.map((e: any) => normalise(e, y.defaults));
  const cat: PortalCatalog = { portals, byId: new Map(portals.map((p: Portal) => [p.id, p])), raw: { defaults: y.defaults ?? {}, byId: new Map(list.map((e: any) => [String(e?.id ?? ''), e])) } };
  const bad = catalogProblems(cat);
  if (bad.length) throw new Error(`${file}: ${bad.join('; ')}`);
  if (file === FILE) cached = cat;
  return cat;
}

/** Parse a catalog from text without throwing (tests, and `portalIssues` over a hand-made entry). */
export function parsePortals(text: string): { cat: PortalCatalog; problems: string[] } {
  const y = parse(text) ?? {};
  const list = Array.isArray(y.portals) ? y.portals : [];
  const portals = list.map((e: any) => normalise(e, y.defaults));
  const cat: PortalCatalog = { portals, byId: new Map(portals.map((p: Portal) => [p.id, p])), raw: { defaults: y.defaults ?? {}, byId: new Map(list.map((e: any) => [String(e?.id ?? ''), e])) } };
  return { cat, problems: catalogProblems(cat) };
}

export const portalById = (id: string): Portal | undefined => loadPortals().byId.get(id);
export const portalIds = (): string[] => loadPortals().portals.map((p) => p.id);

/** The hosts a profile may reach for this portal: its own and its CDNs; the sign-in window also its sign-in helpers. */
export const allowedHosts = (p: Portal, o: { signIn?: boolean } = {}) => [...p.hosts, ...p.cdn_hosts, ...(o.signIn ? p.auth_hosts : [])];

/** The delay before the next page load: delay_ms ±40%, or uniform in [min, max]. */
export function delayMs(l: Pick<Limits, 'delay_ms'>, rnd = Math.random): number {
  if (Array.isArray(l.delay_ms)) return Math.round(l.delay_ms[0] + (l.delay_ms[1] - l.delay_ms[0]) * rnd());
  return Math.round(l.delay_ms * (0.6 + 0.8 * rnd()));
}
