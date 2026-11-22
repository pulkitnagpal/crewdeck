// Shared mapping helpers for the API adapters: requests through ctx.fetch, text, places, pay, dates.
import { plainText } from '../text.ts';
import { countryOf, lookupPlace, place, placeNames, within } from '../places.ts';
import { parsePay } from '../pay.ts';
import { redactUrl } from './keys.ts';
import { ApiError, type ApiCtx, type ApiPosting, type ApiQuery, type ApiRequest, type ApiResult, MAX_TITLES, type PayPeriod } from './types.ts';

export const UA = 'Crewdeck/0.8 (+https://github.com/pulkitnagpal/crewdeck)';

/** GET/POST through the runner's fetch; non-2xx → ApiError (URL redacted). */
export async function request(ctx: ApiCtx, req: ApiRequest): Promise<string> {
  const r = await ctx.fetch({ ...req, headers: { 'user-agent': UA, ...req.headers } });
  if (r.status >= 200 && r.status < 300) return r.body;
  const why = r.status === 401 || r.status === 403 ? 'the key was refused (or this client is blocked)' : r.status === 429 ? 'rate limited' : `HTTP ${r.status}`;
  throw new ApiError(r.status, `${why}: ${redactUrl(req.url)}`);
}

export async function json(ctx: ApiCtx, req: ApiRequest): Promise<any> {
  const body = await request(ctx, { ...req, headers: { accept: 'application/json', ...req.headers } });
  try { return JSON.parse(body); } catch { throw new ApiError(200, `not JSON: ${redactUrl(req.url)}`); }
}

/**
 * One request per title alternate (most providers have no OR across phrases), at most MAX_TITLES; results deduped by
 * job id. A failing title is an error, not a failure of the search; a refused key stops it (every title would fail).
 */
export async function perTitle(q: ApiQuery, one: (title: string) => Promise<{ postings: ApiPosting[]; more?: boolean }>): Promise<ApiResult> {
  const titles = [...new Set(q.titles.map((t) => t.trim()).filter(Boolean))].slice(0, MAX_TITLES);
  const seen = new Set<string>(), postings: ApiPosting[] = [], errors: string[] = [];
  let more = false;
  for (const t of titles) {
    try {
      const r = await one(t);
      more ||= !!r.more;
      for (const p of r.postings) if (!seen.has(p.sourceJobId)) { seen.add(p.sourceJobId); postings.push(p); }
    } catch (e: any) {
      errors.push(`"${t}": ${redactUrl(e?.message ?? String(e))}`);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) break;
      // A stopped run or a used-up request budget: every later title would fail the same way.
      if (e?.name === 'AbortError' || e?.name === 'BudgetError') break;
    }
  }
  return { postings: withinDays(postings, q.daysBack), next: more ? (q.page ?? 1) + 1 : undefined, errors };
}

/** Client-side `daysBack` for providers without a date filter (and a safety net for those with one). */
export function withinDays(ps: ApiPosting[], days?: number, now = Date.now()): ApiPosting[] {
  if (!days || days <= 0) return ps;
  const cut = now - days * 86_400_000;
  return ps.filter((p) => { const t = Date.parse(p.postedAt); return Number.isNaN(t) || t >= cut; });
}

/** Lower-case title match on whole words (for whole-feed providers: DfE, Arbeitnow). */
export function titleMatches(title: string, titles: string[]): boolean {
  const norm = (s: string) => ` ${s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const t = norm(title);
  return titles.some((x) => { const n = norm(x); return n.trim() !== '' && t.includes(n); });
}

export const text = (html: string | null | undefined) => (html ? plainText(String(html)).trim() : '');

export function iso(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const s = String(v).trim();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s); // Reed: dd/mm/yyyy
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  // Nanosecond fractions (NHS); no zone given → read as UTC, so every machine maps it the same way.
  let d = s.replace(/(\.\d{3})\d+/, '$1');
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(d)) d += 'Z';
  const t = Date.parse(d);
  if (Number.isNaN(t)) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(t).toISOString();
}

// ---- places ----
let regionCountries: Map<string, string[]> | null = null;
/** Every country inside a gazetteer region ("europe", "latam", "apac"), from the shipped places data. */
function countriesIn(regionId: string): string[] {
  if (!regionCountries) {
    regionCountries = new Map();
    const countries = new Set<string>();
    for (const n of placeNames()) for (const id of lookupPlace(n) ?? []) if (place(id)?.kind === 'country') countries.add(id);
    regionCountries.set('__all', [...countries]);
  }
  const have = regionCountries.get(regionId);
  if (have) return have;
  const out = regionCountries.get('__all')!.filter((c) => within(c, regionId)).map((c) => c.toUpperCase()).sort();
  regionCountries.set(regionId, out);
  return out;
}

let dn: Intl.DisplayNames | null = null;
const display = (() => {
  const m = new Map<string, string>();
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn!.of(code);
      if (name && name !== code) m.set(name.toLowerCase(), code);
    }
  } catch { /* no ICU data: the gazetteer alone */ }
  return m;
})();
const ALIASES: Record<string, string> = { 'brunei darussalam': 'BN', 'lao people\'s democratic republic': 'LA', 'micronesia, federated states of': 'FM', 'korea, republic of': 'KR', 'viet nam': 'VN', 'iran, islamic republic of': 'IR', 'syrian arab republic': 'SY', 'tanzania, united republic of': 'TZ', 'moldova, republic of': 'MD', 'macao': 'MO', 'russia': 'RU', 'cocos (keeling) islands': 'CC' };

/** A country name or code ("India", "USA", "Deutschland", "GB") → ISO-2, else undefined. */
export function countryCode(name: string): string | undefined {
  const s = name.trim();
  if (!s) return undefined;
  if (/^[A-Z]{2}$/.test(s) && s !== 'UK') { const n = dn?.of(s); if (n && n !== s) return s; }
  const alias = ALIASES[s.toLowerCase()] ?? display.get(s.toLowerCase());
  if (alias) return alias;
  for (const id of lookupPlace(s) ?? []) if (place(id)?.kind === 'country') return id.toUpperCase();
  return undefined;
}

/** The country a location string is in ("Leeds, LS2 9LN" → GB with a default), else the default. */
export function countryOfLocation(loc: string, fallback?: string): string | undefined {
  for (const part of [loc, ...loc.split(',').map((s) => s.trim()).reverse()]) {
    const ids = lookupPlace(part.replace(/\s+[A-Z]{1,2}\d[\dA-Z]?\s*\d[A-Z]{2}$/i, '').trim()) ?? [];
    const c = ids.map(countryOf).find(Boolean);
    if (c) return c.toUpperCase();
  }
  return fallback;
}

/**
 * A free-text "where can I work from" ("Worldwide", "USA, Canada", "LATAM, Europe", "India") → ISO-2 list, ['*'] for
 * anywhere, [] when nothing is recognisable (time-zone-only phrases, "Remote").
 */
export function remoteFrom(textOrList: string | string[]): string[] {
  const parts = (Array.isArray(textOrList) ? textOrList : String(textOrList).split(/[,;/|]| or | and /i)).map((s) => s.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const p of parts) {
    if (/^(worldwide|anywhere|global|world|remote anywhere|international)$/i.test(p)) return ['*'];
    if (/time ?zones?$/i.test(p)) continue;
    const c = countryCode(p);
    if (c) { out.add(c); continue; }
    for (const id of lookupPlace(p) ?? []) {
      if (id === 'world') return ['*'];
      const k = place(id)?.kind;
      if (k === 'region') for (const x of countriesIn(id)) out.add(x);
    }
  }
  return [...out].sort();
}

/** Pay from structured numbers. */
export function pay(min: unknown, max: unknown, currency: unknown, period: PayPeriod | null): ApiPosting['pay'] | undefined {
  const n = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) || Number(v) <= 0 ? null : Number(v));
  const lo = n(min), hi = n(max);
  if (lo === null && hi === null) return undefined;
  return { min: lo, max: hi, currency: currency ? String(currency).toUpperCase() : null, period };
}

/** Pay from a provider's salary text ("£32,073 to £39,043", "$14 - $20/hour"); `period` when the text has none. */
export function payText(s: string | null | undefined, period: PayPeriod | null = null): ApiPosting['pay'] | undefined {
  const p = parsePay(s ?? '');
  if (!p || (p.min === null && p.max === null)) return undefined;
  return { min: p.min, max: p.max, currency: p.currencies[0] ?? null, period: (p.period as PayPeriod | null) ?? period };
}

export const periodOf = (s: unknown): PayPeriod | null => {
  const t = String(s ?? '').toLowerCase();
  if (/hour|^ph$|per hour/.test(t)) return 'hour';
  if (/day|daily|^pd$/.test(t)) return 'day';
  if (/week|^pw$/.test(t)) return 'week';
  if (/month|^pm$/.test(t)) return 'month';
  if (/year|annual|^pa$/.test(t)) return 'year';
  return null;
};

export const base = (provider: string): Pick<ApiPosting, 'source' | 'sourceKey'> => ({ source: 'api', sourceKey: provider });
