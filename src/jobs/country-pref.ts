// The person's company-country preference (jobs/search.md → companies.countries, ADR-0008 §8) as plain checks and words,
// shared by the rules, the judge brief, the source planner and the portal filter. Pure: no notes, no database.
import { placeName } from './places.ts';
import type { CompanyCountries } from './schema.ts';

/** Empty lists on both sides: no preference. */
export const noCountryPref = (p: CompanyCountries | undefined | null): boolean => !p || (!p.only.length && !p.exclude.length);

/** Whether a known country passes the preference (exclude wins; `only`, when given, must name it). */
export function countryAllowed(code: string, p: CompanyCountries | undefined | null): boolean {
  if (!p) return true;
  const c = code.toLowerCase();
  if (p.exclude.includes(c)) return false;
  return !p.only.length || p.only.includes(c);
}

const names = (codes: string[], joiner: string) => {
  const n = codes.map((c) => placeName(c));
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} ${joiner} ${n[n.length - 1]}`;
};

/** The preference in words: "only companies headquartered outside India", "only companies headquartered in Germany or France". */
export function countryPrefText(p: CompanyCountries): string {
  if (p.only.length && p.exclude.length) return `only companies headquartered in ${names(p.only, 'or')} (never ${names(p.exclude, 'or')})`;
  if (p.only.length) return `only companies headquartered in ${names(p.only, 'or')}`;
  if (p.exclude.length) return `only companies headquartered outside ${names(p.exclude, 'and')}`;
  return 'companies from any country';
}
