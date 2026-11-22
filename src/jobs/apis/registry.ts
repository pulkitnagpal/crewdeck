// Every official / public job API Crewdeck can query (design §14 P2), with its coverage, key, attribution and terms.
import type { Provider } from './types.ts';
import { baJobsuche, dfeTeaching, nhsJobs, usajobs } from './providers/government.ts';
import { adzuna, jooble, reed } from './providers/aggregators.ts';
import { arbeitnow, himalayas, remotive } from './providers/remote-boards.ts';

export const PROVIDERS: Provider[] = [usajobs, nhsJobs, dfeTeaching, baJobsuche, reed, adzuna, jooble, himalayas, remotive, arbeitnow];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export const provider = (id: string): Provider | undefined => BY_ID.get(id);
export const providerIds = () => PROVIDERS.map((p) => p.id);
export const keyedProviders = () => PROVIDERS.filter((p) => p.needsKey);
/** Does the provider cover this ISO-2 country ('*' = any)? */
export const covers = (p: Provider, country: string) => p.countries.includes('*') || p.countries.includes(country.toUpperCase());
