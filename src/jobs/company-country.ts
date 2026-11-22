// The country a company is from (ADR-0008 §8), for the person's `companies.countries` preference in jobs/search.md.
// Known only from facts Crewdeck holds: the company directory's curated entries (an `hq`, or a single home country), then
// what a feed or a portal said about the company on one of its roles (`roles.company_country`). Never guessed from a
// name: unknown is null, and an unknown company passes the rules (the judge decides from the posting).
import type { Ctx } from './ctx.ts';
import { place } from './places.ts';
import { companyKey } from './rules.ts';
import { type Company, type Directory, loadDirectory } from './directory/seed.ts';
import { ISO2 } from './schema.ts';
export { countryAllowed, countryPrefText, noCountryPref } from './country-pref.ts';

export type CountryHints = {
  /** What a feed or portal said on the role (an ISO code), when it said. */ company_country?: string | null;
  /** A role id: its stored company_country is read when no hint is given. */ role?: string;
  /** A directory other than the shipped one (tests). */ directory?: Directory;
};

/** A two-letter ISO code the gazetteer knows as a country, lowercased; null for anything else. */
export function isoCountry(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toLowerCase();
  return ISO2.test(c) && place(c)?.kind === 'country' ? c : null;
}

/**
 * A directory entry's home country: its curated `hq`, else its curated regions when they name exactly one country.
 * Regions guessed from a company's name (seed rows) are where it may hire, not where it is from: never used here.
 */
export function directoryCountry(c: Company): string | null {
  if (c.hq) return isoCountry(c.hq);
  if (!c.curated || !c.regionFrom.includes('curated')) return null;
  const countries = c.regions.map(isoCountry);
  return countries.length === 1 ? countries[0] : null;
}

const indexes = new WeakMap<Directory, Map<string, string | null>>();
/** Company key → its country, when every directory entry with that key that knows one agrees (null on a conflict). */
function directoryIndex(dir: Directory): Map<string, string | null> {
  let idx = indexes.get(dir);
  if (idx) return idx;
  idx = new Map();
  for (const c of dir.companies) {
    const cc = directoryCountry(c);
    if (!cc) continue;
    const key = companyKey(c.name);
    if (!key) continue;
    if (!idx.has(key)) idx.set(key, cc);
    else if (idx.get(key) !== cc) idx.set(key, null);
  }
  indexes.set(dir, idx);
  return idx;
}

/** The company's country (ISO code) or null when Crewdeck doesn't know it: directory first, then the role's metadata. */
export function companyCountry(ctx: Pick<Ctx, 'db'> | null, name: string, hints: CountryHints = {}): string | null {
  const key = companyKey(name ?? '');
  if (key) {
    const fromDir = directoryIndex(hints.directory ?? loadDirectory()).get(key);
    if (fromDir) return fromDir;
  }
  const hinted = isoCountry(hints.company_country);
  if (hinted) return hinted;
  if (ctx && hints.role) {
    try {
      const r = ctx.db.prepare('select company_country c from roles where id = ?').get(hints.role) as any;
      const stored = isoCountry(r?.c);
      if (stored) return stored;
    } catch { /* an older database without the column */ }
  }
  if (ctx && key) {
    try {
      // Another role at the same company may carry it (a portal that shows the employer's country).
      const r = ctx.db.prepare(`select r.company_country c from roles r join companies co on co.id = r.company_id
        where co.key = ? and r.company_country is not null order by r.updated_at desc limit 1`).get(key) as any;
      const stored = isoCountry(r?.c);
      if (stored) return stored;
    } catch { /* an older database without the column */ }
  }
  return null;
}
