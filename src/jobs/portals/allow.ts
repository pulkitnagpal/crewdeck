// Whether a signed-in job portal fits the person (ADR-0008 §8): the planner and the portals engine skip a portal that
// serves only countries the person can't work in, or only countries whose companies the person said they don't want
// ("only non-Indian companies" skips an India-only portal). A portal for several countries, or for anywhere, stays
// while one of its countries is still wanted. Pure: the caller passes the catalog's countries and the person's notes.
import { countryOf, place, within } from '../places.ts';
import { countryAllowed, countryPrefText, noCountryPref } from '../country-pref.ts';
import type { CompanyCountries } from '../schema.ts';

export type PortalVerdict = { allowed: boolean; why: string };

/** A place id as the country it is in (in/bengaluru → in); regions and 'world' stay as they are. */
const asCountry = (id: string) => { const c = id.toLowerCase(); return place(c)?.kind === 'country' ? c : countryOf(c) ?? c; };
const overlaps = (a: string, b: string) => a === b || within(a, b) || within(b, a);

/**
 * `portalCountries`: the catalog's countries for the portal ([] or ['world'] = anywhere). `prefs`: search.md →
 * companies.countries. `workCountries`: where the person may work (places.onsite, remote_from, relocate_to as place
 * ids); empty or 'world' = anywhere.
 */
export function portalVerdict(portalCountries: string[], prefs: CompanyCountries | null | undefined, workCountries: string[] = []): PortalVerdict {
  const portal = [...new Set(portalCountries.map(asCountry))];
  if (!portal.length || portal.includes('world')) return { allowed: true, why: 'a portal for anywhere' };
  const work = [...new Set(workCountries.map(asCountry))];
  const anywhere = !work.length || work.includes('world');
  const relevant = anywhere ? portal : portal.filter((pc) => work.some((w) => overlaps(pc, w)));
  if (!relevant.length) return { allowed: false, why: `it serves ${portal.join(', ')}, where you don't look for work` };
  if (noCountryPref(prefs)) return { allowed: true, why: `it serves ${relevant.join(', ')}` };
  // Only a country (not a region) can be barred by the company-country preference.
  const kept = relevant.filter((c) => place(c)?.kind !== 'country' || countryAllowed(c, prefs));
  if (!kept.length) return { allowed: false, why: `it lists jobs in ${relevant.join(', ')} only, and you want ${countryPrefText(prefs!)}` };
  return { allowed: true, why: `it serves ${kept.join(', ')}` };
}

/** True when the portal should be scanned (see portalVerdict for why not). */
export function portalAllowed(portalCountries: string[], prefs: CompanyCountries | null | undefined, workCountries: string[] = []): boolean {
  return portalVerdict(portalCountries, prefs, workCountries).allowed;
}
