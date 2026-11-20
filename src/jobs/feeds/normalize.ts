// Normalising what boards say about place, remoteness, employment type, pay and dates. Places go through the
// gazetteer (places.ts), so "Remote - India", "Remote (APAC)", "US only", "Anywhere" and "EMEA Remote" all become
// ISO-2 country lists; regions expand to the gazetteer's countries inside them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { countryOf, findPlaces, lookupPlace, place, reducePlaces, within } from '../places.ts';
import type { EmploymentType, Pay, PayPeriod, Workplace } from './types.ts';

let COUNTRIES: string[] | null = null;
/** Every country id (lower-case ISO-2) in the gazetteer. */
function allCountries(): string[] {
  if (COUNTRIES) return COUNTRIES;
  const y = parse(readFileSync(join(import.meta.dirname, '..', 'data', 'places.yaml'), 'utf8'));
  COUNTRIES = ((y.countries ?? []) as { id: string }[]).map((c) => String(c.id));
  return COUNTRIES;
}

const up = (ids: Iterable<string>) => [...new Set([...ids].map((c) => c.toUpperCase()))].sort();

/** A country name or code ("United States", "USA", "us", "Deutschland", "Türkiye") → ISO-2 upper case, or ''. */
export function countryCode(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) {
    const id = s.toLowerCase() === 'uk' ? 'gb' : s.toLowerCase();
    return place(id)?.kind === 'country' ? id.toUpperCase() : '';
  }
  const ids = lookupPlace(s.replace(/\bİ/g, 'I').replace(/ü/g, 'u')) ?? lookupPlace(s) ?? [];
  const cs = [...new Set(ids.map((i) => countryOf(i)).filter(Boolean) as string[])];
  return cs.length === 1 ? cs[0].toUpperCase() : '';
}

/** The places a text names, most specific first reading: each one's candidate ids. */
function placesIn(text: string): string[][] {
  return reducePlaces(findPlaces(String(text ?? '')));
}

/** ISO-2 countries a location text is in ("Bengaluru, India" → IN; "US, CA, Santa Clara" → US). Regions add nothing. */
export function countriesIn(text: string): string[] {
  const out = new Set<string>();
  for (const cands of placesIn(text)) {
    const cs = new Set(cands.map((c) => countryOf(c)).filter(Boolean) as string[]);
    if (cs.size === 1) out.add([...cs][0]);
  }
  return up(out);
}

/** Countries inside a place id (a region expands; a country or anything inside one is that country). */
function countriesOfPlace(id: string): string[] {
  if (id === 'world') return ['*'];
  const c = countryOf(id);
  if (c) return [c];
  return allCountries().filter((x) => within(x, id));
}

const REMOTE_RE = /\b(remote|remotely|anywhere|work from home|wfh|home[- ]?based|telecommut\w*|distributed|fully[- ]remote|worldwide|homeoffice|home office|télétravail|teletrabajo|remoto)\b/i;
const HYBRID_RE = /\bhybrid\b|\bhybride?\b|\bhíbrido\b/i;
const ONSITE_RE = /\b(on[- ]?site|in[- ]office|office[- ]based)\b/i;

/** Does a location text say remote? ("Remote - USA", "Anywhere", "US (Remote)") */
export const saysRemote = (text: string) => REMOTE_RE.test(String(text ?? ''));

/**
 * Where a remote role may be done from, read from one text: ['*'] for anywhere/worldwide, ISO-2 countries for named
 * countries and regions ("Remote (APAC)" → the APAC countries), [] when the text names no place.
 */
export function remoteScope(text: string): string[] {
  const t = String(text ?? '');
  if (/\b(anywhere|worldwide|world[- ]wide|global(ly)?|any location|any country)\b/i.test(t) && !/\banywhere in (the )?([A-Z])/.test(t)) return ['*'];
  const out = new Set<string>();
  for (const cands of placesIn(t)) {
    // An ambiguous name (Georgia) counts only when every reading is in the same country set.
    const sets = cands.map(countriesOfPlace);
    if (sets.some((s) => s[0] === '*')) return ['*'];
    const first = JSON.stringify(sets[0]);
    if (sets.every((s) => JSON.stringify(s) === first)) for (const c of sets[0]) out.add(c);
  }
  return up(out);
}

/** A board's workplace word ("Remote", "OnSite", "on-site", "hybrid", "none", "fully") → Workplace, or '' if unknown. */
export function workplaceWord(v: unknown): Workplace | '' {
  const s = String(v ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return '';
  if (['remote', 'fullyremote', 'fully', 'remoteonly', 'telecommute', 'wfh'].includes(s)) return 'remote';
  if (['hybrid', 'flexible', 'temporary', 'partiallyremote'].includes(s)) return 'hybrid';
  if (['onsite', 'office', 'inoffice', 'none', 'notremote', 'inperson'].includes(s)) return 'onsite';
  if (s === 'unspecified' || s === 'unknown') return '';
  return '';
}

export type PlaceFacts = {
  /** location texts as written (the first is the primary) */
  locations: string[];
  /** structured country names or codes from the board (Lever country, Ashby addressCountry, Workable countryCode) */
  countries?: unknown[];
  /** the board's own workplace word (Lever workplaceType, Ashby workplaceType, Teamtailor remoteStatus …) */
  workplace?: unknown;
  /** a plain remote flag (Ashby isRemote, Workable telecommuting, Recruitee remote) */
  remote?: boolean | null;
  hybrid?: boolean | null;
  onsite?: boolean | null;
  /** extra text that may scope remoteness ("… - EMEA Remote" in a title) */
  hints?: string[];
};

/** Locations, countries, workplace and remote countries from what a board says. */
export function normalisePlace(f: PlaceFacts): { locations: string[]; countries: string[]; workplace: Workplace; remoteCountries: string[] } {
  const locations = [...new Set(f.locations.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const structured = up((f.countries ?? []).map(countryCode).filter(Boolean));
  const hints = (f.hints ?? []).filter(Boolean);
  let workplace: Workplace = workplaceWord(f.workplace) || '';
  if (!workplace) {
    if (f.remote === true) workplace = 'remote';
    else if (f.hybrid === true) workplace = 'hybrid';
    else if (f.onsite === true) workplace = 'onsite';
    else if (locations.some(saysRemote) || hints.some((h) => /\bremote\b/i.test(h))) workplace = locations.some((l) => HYBRID_RE.test(l)) ? 'hybrid' : 'remote';
    else if (locations.some((l) => HYBRID_RE.test(l))) workplace = 'hybrid';
    else if (locations.some((l) => ONSITE_RE.test(l))) workplace = 'onsite';
    else workplace = 'unknown';
  }
  // Countries of the places named (a remote line's region adds nothing here: it is not where the office is).
  const named = new Set<string>(structured);
  for (const l of locations) for (const c of countriesIn(l)) named.add(c);
  const countries = up(named);

  let remoteCountries: string[] = [];
  if (workplace === 'remote') {
    // A remote role's locations are its scope ("North America", "Remote - India", or the office cities it is tied
    // to), plus any hint that says remote ("… - EMEA Remote" in the title).
    const scoped = [...locations, ...hints.filter((h) => /\bremote\b/i.test(h))];
    const fromText = new Set<string>();
    for (const t of scoped) for (const c of remoteScope(t)) fromText.add(c);
    if (fromText.has('*')) remoteCountries = ['*'];
    else if (fromText.size) remoteCountries = up(fromText);
    else remoteCountries = structured; // "Remote" alone: the board's own country field, else unknown
  }
  return { locations, countries, workplace, remoteCountries };
}

const ET: [RegExp, EmploymentType][] = [
  [/intern|trainee|apprentic|werkstudent|working[_ ]?student|praktik|graduate program/i, 'internship'],
  [/part[\s_-]?time|teilzeit|parttime/i, 'part_time'],
  [/contract|freelanc|contractor|consultant|self[_ -]?employed/i, 'contract'],
  [/temp|fixed[_ -]?term|seasonal|befristet/i, 'temporary'],
  [/full[\s_-]?time|fulltime|permanent|vollzeit|regular|unbefristet/i, 'full_time'],
];
/** "Full-time", "FullTime", "fulltime_permanent", "Intern", "contract" … → EmploymentType ('' if unknown). */
export function employmentType(...vals: unknown[]): EmploymentType {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    for (const [re, t] of ET) if (re.test(s)) return t;
    return 'other';
  }
  return '';
}

/** "1 YEAR", "per-year-salary", "yearly", "hour", "month" … → PayPeriod or null. */
export function payPeriod(v: unknown): PayPeriod | null {
  const s = String(v ?? '').toLowerCase();
  if (/year|annual|annum|yearly/.test(s)) return 'year';
  if (/month/.test(s)) return 'month';
  if (/week/.test(s)) return 'week';
  if (/day|daily/.test(s)) return 'day';
  if (/hour/.test(s)) return 'hour';
  return null;
}

/** A pay range when the board gives at least one number. */
export function pay(min: unknown, max: unknown, currency: unknown, period: unknown): Pay | undefined {
  const n = (x: unknown) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) || Number(x) <= 0 ? null : Number(x));
  const lo = n(min), hi = n(max);
  if (lo === null && hi === null) return undefined;
  return { min: lo, max: hi, currency: String(currency ?? '').toUpperCase().slice(0, 3), period: payPeriod(period) };
}

/** A board's date (ISO, "2026-11-18 16:23:32 UTC", epoch ms, RFC 822) → ISO, or '' when unreadable. */
export function isoDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  let d: Date;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else {
    const s = String(v).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(:\d{2})?) ?UTC$/, '$1T$2Z');
    d = new Date(s);
  }
  return Number.isFinite(d.getTime()) ? d.toISOString() : '';
}

/** Workday's "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago" → ISO date (approximate). */
export function postedAgo(v: unknown, now = Date.now()): string {
  const s = String(v ?? '').toLowerCase();
  const day = 86_400_000;
  if (/today/.test(s)) return new Date(now).toISOString();
  if (/yesterday/.test(s)) return new Date(now - day).toISOString();
  const m = /(\d+)\+?\s*days?/.exec(s);
  return m ? new Date(now - Number(m[1]) * day).toISOString() : '';
}
