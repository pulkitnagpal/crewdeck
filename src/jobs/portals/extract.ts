// Postings from a portal's search page (ADR-0008 §3), in three layers tried in order: the JSON the page itself loaded
// (the adapter's URL patterns and field paths), schema.org JobPosting JSON-LD, then links matching the portal's job-URL
// pattern with their card's text. Pure functions over what the browser captured, so fixtures test them. Page text is
// hostile input: bounded, and every scan is linear (indexOf, no backtracking regex over markup).
import { isoCountry } from '../company-country.ts';
import { htmlToText } from '../feeds/html.ts';
import { lookupPlace } from '../places.ts';
import { elements, plainText } from '../text.ts';
import type { JsonAdapter, Portal } from './catalog.ts';
import { RX, canonUrl, pathValue as runtimePathValue, workplaceOf as runtimeWorkplace } from './page-runtime.js';

export type Layer = 'json' | 'jsonld' | 'links';
export type Posting = {
  url: string; title: string; company: string; location: string; description?: string; posted_at?: string; workplace?: 'remote' | 'hybrid' | 'onsite';
  /** ADR-0008 §8: the company's own country (ISO code) when the portal shows it (JSON-LD hiringOrganization, an adapter field). */ company_country?: string;
};
export type Found = Posting & { by: Layer };
export type Captured = { url: string; body: string };
export type Extracted = { postings: Found[]; by: Record<Layer, number> };

/** The most of a page or response read (a portal's search page is large; still bounded). */
export const PAGE_MAX = 3_000_000;
const MAX_POSTINGS = 500;
const s = (v: unknown, max = 300) => (typeof v === 'string' ? plainText(v).slice(0, max) : typeof v === 'number' ? String(v) : '');

/**
 * The posting's address as Crewdeck keeps it: on the portal's own hosts, matching its job-URL pattern, with only the
 * query parameters that identify the posting (or the catalog's canonical form). Null for anything else.
 */
export function canonicalJobUrl(raw: string, base: string, portal: Portal): string | null {
  return canonUrl(raw, base, portal.job_url, portal.hosts);
}

/** "3 days ago", "today", an ISO date or an epoch (ms or s) → ISO; undefined when unreadable or in the future. */
export function postedAt(v: unknown, now = new Date()): string | undefined {
  let t: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string') {
    const x = v.trim().toLowerCase();
    const rel = /^(\d{1,3})\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago$/.exec(x);
    if (/^(just now|today|few hours ago|just posted)$/.test(x)) t = now.getTime();
    else if (x === 'yesterday') t = now.getTime() - 86_400_000;
    else if (rel) t = now.getTime() - Number(rel[1]) * ({ minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 } as Record<string, number>)[rel[2]];
    else if (/^\d{4}-\d{2}-\d{2}/.test(x)) t = Date.parse(v.trim());
  }
  if (t === undefined || !Number.isFinite(t) || t > now.getTime() + 86_400_000 || t < Date.UTC(1995, 0, 1)) return undefined;
  return new Date(t).toISOString();
}

export const workplaceOf: (text: string) => Posting['workplace'] = runtimeWorkplace;

// ---- layer 1: the JSON the page loaded ----

/**
 * A value at a path: `a.b.c`, `list[type=location].label` (the first item whose field equals the value), and an
 * optional ` ~ regex` that keeps the regex's first group of the value.
 */
export const pathValue: (obj: unknown, path: string) => unknown = runtimePathValue;

function fromAdapter(json: unknown, a: JsonAdapter, portal: Portal, base: string, now: Date): Posting[] {
  const list = pathValue(json, a.list);
  if (!Array.isArray(list)) return [];
  const out: Posting[] = [];
  for (const item of list.slice(0, MAX_POSTINGS)) {
    if (!item || typeof item !== 'object') continue;
    if (a.where && !Object.entries(a.where).every(([k, re]) => { const v = pathValue(item, k); try { return typeof v === 'string' && new RegExp(re).test(v); } catch { return false; } })) continue;
    const f = (k: string) => (a.fields[k] ? pathValue(item, a.fields[k]) : undefined);
    const id = s(f('id'), 100);
    const raw = a.fields.url ? s(f('url'), 2000) : a.url_template && /^[\w-]{1,100}$/.test(id) ? a.url_template.replace('{id}', encodeURIComponent(id)) : '';
    const url = raw ? canonicalJobUrl(raw, base, portal) : null;
    const title = s(f('title'));
    if (!url || !title) continue;
    const location = s(f('location'), 300);
    const description = typeof f('description') === 'string' ? plainText(f('description') as string).slice(0, 60_000) : undefined;
    const cc = isoCountry(f('company_country'));
    out.push({ url, title, company: s(f('company'), 200), location, ...(cc ? { company_country: cc } : {}), ...(description ? { description } : {}), ...(postedAt(f('posted_at'), now) ? { posted_at: postedAt(f('posted_at'), now) } : {}), ...(workplaceOf(`${location} ${s(f('workplace'))}`) ? { workplace: workplaceOf(`${location} ${s(f('workplace'))}`) } : {}) });
  }
  return out;
}

/** Postings from the JSON responses the page loaded that match one of the portal's adapters. */
export function fromJson(captured: Captured[], portal: Portal, base: string, now = new Date()): Posting[] {
  const out: Posting[] = [];
  for (const c of captured.slice(0, 50)) {
    for (const a of portal.json) {
      let re: RegExp;
      if (!a.url) continue;
      try { re = new RegExp(a.url); } catch { continue; }
      if (!re.test(c.url)) continue;
      let j: unknown;
      try { j = JSON.parse(String(c.body).slice(0, PAGE_MAX)); } catch { continue; }
      out.push(...fromAdapter(j, a, portal, base, now));
    }
  }
  return out;
}

// ---- layer 2: schema.org JSON-LD ----

const types = (n: any) => (Array.isArray(n?.['@type']) ? n['@type'] : [n?.['@type']]).map((t: unknown) => String(t ?? '').toLowerCase());
/** JobPosting nodes, and ItemList entries that name a posting, anywhere in a JSON-LD value. */
function ldNodes(v: any, depth = 0, out: any[] = []): any[] {
  if (!v || typeof v !== 'object' || depth > 6 || out.length > MAX_POSTINGS) return out;
  if (Array.isArray(v)) { for (const x of v) ldNodes(x, depth + 1, out); return out; }
  const t = types(v);
  if (t.includes('jobposting')) out.push(v);
  else if (t.includes('listitem')) { if (v.item && typeof v.item === 'object') ldNodes(v.item, depth + 1, out); else if (v.url) out.push({ '@listitem': true, ...v }); }
  else { ldNodes(v['@graph'], depth + 1, out); ldNodes(v.itemListElement, depth + 1, out); }
  return out;
}
const placeText = (l: any): string => {
  const a = l?.address ?? l;
  if (typeof a === 'string') return a.trim();
  const country = typeof a?.addressCountry === 'object' ? s(a.addressCountry?.name) : s(a?.addressCountry);
  return [s(a?.addressLocality), s(a?.addressRegion), country].filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).join(', ');
};

export function fromJsonLd(html: string, portal: Portal, base: string, now = new Date()): Posting[] {
  const out: Posting[] = [];
  for (const el of elements(String(html ?? '').slice(0, PAGE_MAX), 'script')) {
    if (!/\btype\s*=\s*["']?application\/ld\+json\b/i.test(el.tag.slice(0, 2000))) continue;
    let j: unknown;
    try { j = JSON.parse(el.inner.trim()); } catch { continue; }
    for (const n of ldNodes(j)) {
      const url = canonicalJobUrl(s(n.url ?? n.sameAs ?? n['@id'], 2000), base, portal);
      const title = s(n.title ?? n.name);
      if (!url || !title) continue;
      const org = typeof n.hiringOrganization === 'string' ? n.hiringOrganization : n.hiringOrganization?.name;
      const remote = [n.jobLocationType].flat().some((t) => /telecommute|remote/i.test(String(t ?? '')));
      const location = [n.jobLocation].flat().filter(Boolean).map(placeText).filter(Boolean).join(' · ').slice(0, 300);
      const description = typeof n.description === 'string' ? htmlToText(n.description, 200_000).slice(0, 60_000) : undefined;
      const posted = postedAt(n.datePosted, now);
      const oa = n.hiringOrganization?.address;
      const cc = isoCountry(typeof oa?.addressCountry === 'object' ? oa.addressCountry?.name : oa?.addressCountry);
      out.push({ url, title, company: s(org, 200), ...(cc ? { company_country: cc } : {}), location: location || (remote ? 'Remote' : ''), ...(description ? { description } : {}), ...(posted ? { posted_at: posted } : {}), ...(remote ? { workplace: 'remote' as const } : workplaceOf(location) ? { workplace: workplaceOf(location) } : {}) });
    }
  }
  return out;
}

// ---- layer 3: job links and their card text ----

/** Link texts that are buttons, not titles; time and noise lines (shared with the pane's in-page code, page-runtime.js). */
const BUTTON = RX.button, TIMEISH = RX.time, NOISE = RX.noise;

function hrefOf(tag: string): string | null {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag.slice(0, 3000));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&') : null;
}

/** The lines of a card's text after its title: company first, then a place (or Remote/Hybrid), then a posting time. */
function cardFields(lines: string[], title: string, now: Date): Pick<Posting, 'company' | 'location' | 'posted_at' | 'workplace'> {
  const rest = lines.map((l) => l.replace(/^-\s+/, '').trim()).filter((l) => l && l.length <= 160 && l.toLowerCase() !== title.toLowerCase() && !BUTTON.test(l));
  let location = '', posted: string | undefined, company = '';
  for (const l of rest) {
    if (!posted && TIMEISH.test(l) && postedAt(l.replace(/^posted\s+(on\s+)?/i, ''), now)) { posted = postedAt(l.replace(/^posted\s+(on\s+)?/i, ''), now); continue; }
    if (!location && (RX.where.test(l) || (lookupPlace(l.split(/[,(·|]/)[0].trim()) ?? []).length)) { location = l; continue; }
    if (!company && !NOISE.test(l) && !TIMEISH.test(l) && /\p{L}/u.test(l)) company = l;
  }
  const wp = workplaceOf(`${location} ${rest.join(' ').slice(0, 500)}`);
  return { company: company.slice(0, 200), location: location.slice(0, 300), ...(posted ? { posted_at: posted } : {}), ...(wp ? { workplace: wp } : {}) };
}

/** Postings from links that match the portal's job-URL pattern: the link's text is the title, the card's lines the rest. */
export function fromLinks(html: string, portal: Portal, base: string, now = new Date()): Posting[] {
  const page = String(html ?? '').slice(0, PAGE_MAX);
  const anchors: { url: string; start: number; end: number; text: string }[] = [];
  const open = /<a\b/gi;
  for (let m; (m = open.exec(page)) && anchors.length < 2000;) {
    const gt = page.indexOf('>', m.index);
    if (gt < 0) break;
    const href = hrefOf(page.slice(m.index, gt));
    const close = page.indexOf('</a', gt);
    const end = close < 0 || close - gt > 8000 ? gt + 1 : close;
    open.lastIndex = end;
    const url = href ? canonicalJobUrl(href, base, portal) : null;
    if (url) anchors.push({ url, start: m.index, end, text: plainText(page.slice(gt + 1, end)).slice(0, 300) });
  }
  const out: Posting[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length && out.length < MAX_POSTINGS; i++) {
    const a = anchors[i];
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    // The card: from this posting's first link to the next link to another posting (at most 4000 characters).
    let j = i + 1;
    while (j < anchors.length && anchors[j].url === a.url) j++;
    const stop = Math.min(j < anchors.length ? anchors[j].start : page.length, a.start + 4000);
    const same = anchors.slice(i, j).map((x) => x.text).filter((t) => t && !BUTTON.test(t));
    const title = same.find((t) => t.length >= 3 && t.length <= 200) ?? '';
    if (!title) continue;
    const lines = htmlToText(page.slice(a.start, stop), 8000).split('\n');
    out.push({ url: a.url, title, ...cardFields(lines, title, now) });
  }
  return out;
}

// ---- all three ----

/** Every posting on the page, each once (first layer wins; later layers fill its empty fields), with counts by layer. */
export function extractPostings(input: { html: string; url: string; captured?: Captured[] }, portal: Portal, now = new Date()): Extracted {
  const by: Record<Layer, number> = { json: 0, jsonld: 0, links: 0 };
  const map = new Map<string, Found>();
  const layers: [Layer, () => Posting[]][] = [
    ['json', () => fromJson(input.captured ?? [], portal, input.url, now)],
    ['jsonld', () => fromJsonLd(input.html, portal, input.url, now)],
    ['links', () => fromLinks(input.html, portal, input.url, now)],
  ];
  for (const [layer, run] of layers) {
    for (const p of run()) {
      const have = map.get(p.url);
      if (!have) { if (map.size < MAX_POSTINGS) { map.set(p.url, { ...p, by: layer }); by[layer]++; } continue; }
      for (const k of ['company', 'location', 'description', 'posted_at', 'workplace', 'company_country'] as const) if (!have[k] && p[k]) (have as any)[k] = p[k];
    }
  }
  return { postings: [...map.values()], by };
}
