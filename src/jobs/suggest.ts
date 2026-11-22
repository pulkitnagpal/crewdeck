// "Where to look" (design D25, D42, §24.4): score the catalog from the user's notes and say plainly what is covered.
// Only board-wide sources are proposed (boards, aggregators, national services, field boards: needs none or config);
// ATSes and single employers are for the employers the user names. The coverage line comes from here, so it reads the
// same in setup, on the Sources screen and in Find.
import { type CatalogEntry, covers, loadCatalog, userCountries, userTitles, fillEntry } from './catalog.ts';
import { lookupPlace, placeName, within } from './places.ts';
import type { JobNotes } from './notes.ts';

/** A query in place of (or on top of) the notes: presets (D39) and the Sources screen's filters use it. */
export type Query = { countries?: string[]; families?: string[]; workplace?: string[]; languages?: string[]; level?: 'entry' | 'experienced' | 'senior' | 'any' };
export type Profile = { countries: string[]; remote: string[]; families: string[]; workplace: string[]; languages: string[]; level: string; titles: string[] };
export type Suggestion = { id: string; name: string; kind: string; score: number; reasons: string[]; confidence: string; coverage: string; fill?: string[] };
export type Coverage = { covered: { country: string; family: string; sources: string[] }[]; missing: string[]; works: string[]; line: string };

/** Languages by the names people write in search.md (English names and a few endonyms) → ISO 639-1. */
const LANG: Record<string, string> = {
  english: 'en', german: 'de', deutsch: 'de', french: 'fr', 'français': 'fr', francais: 'fr', spanish: 'es', 'español': 'es', espanol: 'es',
  portuguese: 'pt', 'português': 'pt', italian: 'it', italiano: 'it', dutch: 'nl', nederlands: 'nl', polish: 'pl', polski: 'pl',
  swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', czech: 'cs', slovak: 'sk', hungarian: 'hu', romanian: 'ro',
  greek: 'el', turkish: 'tr', russian: 'ru', ukrainian: 'uk', hebrew: 'he', arabic: 'ar', hindi: 'hi', bengali: 'bn', tamil: 'ta',
  telugu: 'te', marathi: 'mr', urdu: 'ur', chinese: 'zh', mandarin: 'zh', cantonese: 'zh', japanese: 'ja', korean: 'ko',
  vietnamese: 'vi', thai: 'th', indonesian: 'id', 'bahasa indonesia': 'id', malay: 'ms', filipino: 'tl', tagalog: 'tl',
};
export const langCode = (name: string) => { const n = name.trim().toLowerCase(); return /^[a-z]{2}$/.test(n) ? n : LANG[n]; };

/** What the notes say about who the user is and where they can work, for scoring sources. */
export function profileOf(notes: Pick<JobNotes, 'search' | 'profile'>, q: Query = {}): Profile {
  const s = notes.search.data;
  const remoteIds: string[] = [];
  for (const p of s.places.remote_from) for (const id of lookupPlace(p) ?? []) if (!remoteIds.includes(id)) remoteIds.push(id);
  const countries = q.countries ?? userCountries(s, notes.profile.data.identity.country);
  const families = q.families ?? [...new Set(s.roles.targets.flatMap((t) => t.families))];
  const workplace = q.workplace ?? (s.workplace.length ? s.workplace : ['onsite', 'hybrid', 'remote']);
  const languages = q.languages ?? s.languages.map((l) => langCode(l.name)).filter((x): x is string => !!x);
  const level = q.level ?? String((notes.search.raw as any)?.roles?.level ?? 'any');
  return { countries, remote: remoteIds.length ? remoteIds : workplace.includes('remote') && !countries.length ? ['world'] : remoteIds, families, workplace, languages, level, titles: userTitles(s) };
}

const BOARD_KINDS = new Set(['board', 'aggregator', 'national', 'field']);
/** A source Crewdeck may propose board-wide: runnable, not retired or blocked, no careers page needed. */
export const proposable = (c: CatalogEntry) => c.runnable && !c.retired && !c.blocked && BOARD_KINDS.has(c.kind) && c.needs !== 'careers_url';

/** Score one catalog entry for a profile; null when it doesn't fit. */
export function scoreSource(c: CatalogEntry, p: Profile): { score: number; reasons: string[] } | null {
  if (!proposable(c)) return null;
  const reasons: string[] = [];
  let score = 0;
  // Where: an on-site/hybrid country it covers (not just "worldwide"), or remote work from a place it covers.
  const onsiteOk = p.workplace.some((w) => w !== 'remote') && c.workplace.some((w) => w !== 'remote');
  const local = onsiteOk ? p.countries.filter((x) => covers(c.regions, x)) : [];
  const remoteOk = p.workplace.includes('remote') && c.workplace.includes('remote');
  // A remote job on a country's board is usually for people in that country: the user's remote place must be inside
  // the board's region (or, for a wider remote area such as the EU, the board's country inside it). Never via "world".
  const remoteHit = remoteOk ? p.remote.find((r) => r !== 'world' && c.regions.some((g) => g !== 'world' && (within(r, g) || within(g, r)))) : undefined;
  const worldRemote = remoteOk && c.regions.includes('world') && (p.remote.length > 0 || p.countries.length > 0);
  if (local.length) { score += 4; reasons.push(`covers ${local.map(placeName).join(', ')}`); }
  else if (remoteHit) { score += 3; reasons.push(`remote jobs open to ${placeName(remoteHit)}`); }
  else if (worldRemote) { score += 1; reasons.push('remote jobs from many countries (most are limited to the US or Europe)'); }
  else return null;
  // What: a board for the user's field beats a general one; a board for other fields is left out.
  if (p.families.length) {
    const hit = c.families.filter((f) => p.families.includes(f));
    if (hit.length) { score += 3; reasons.push(`for ${hit.join(', ')}`); }
    // A general board reached only as "remote from anywhere" is too thin a fit for someone with a field.
    else if (c.families.includes('any') && (local.length || remoteHit)) { score += 1; reasons.push('any field'); }
    else return null;
  } else if (c.families.includes('any')) { score += 1; reasons.push('any field'); }
  else reasons.push(`mostly ${c.families.slice(0, 3).join(', ')}`);
  // Posting languages the user reads (when they listed any).
  if (p.languages.length && c.languages.length && !c.languages.some((l) => p.languages.includes(l))) return null;
  // Level: entry-only boards only for entry level; graduates get a small push towards them.
  if (c.seniority.includes('entry') && !c.seniority.includes('any') && !['entry', 'any'].includes(p.level)) return null;
  if (c.seniority.includes('experienced') && !c.seniority.includes('any') && p.level === 'entry') return null;
  if (p.level === 'entry' && c.seniority.includes('entry')) { score += 1; reasons.push('entry-level roles'); }
  if (c.confidence === 'high') score += 0.5;
  if (c.confidence === 'low') { score -= 0.5; reasons.push('not verified'); }
  return { score, reasons };
}

/** The catalog's proposal for these notes, best first, and the coverage line. */
export function suggestSources(notes: Pick<JobNotes, 'search' | 'profile'>, q: Query = {}, o: { linkedinOn?: boolean } = {}): { profile: Profile; sources: Suggestion[]; coverage: Coverage } {
  const cat = loadCatalog();
  const p = profileOf(notes, q);
  const out: Suggestion[] = [];
  for (const c of cat.sources) {
    const s = scoreSource(c, p);
    if (!s) continue;
    // A source whose keywords or country come from the notes needs them now (e.g. Arbeitsagentur without titles).
    const f = fillEntry({ provider: c.id }, c, { search: notes.search.data, country: notes.profile.data.identity.country });
    if (f.missing && p.titles.length) continue;
    if (f.missing) s.reasons.push(f.missing);
    out.push({ id: c.id, name: c.name, kind: c.kind, score: s.score, reasons: s.reasons, confidence: c.confidence, coverage: c.coverage, ...(c.fill ? { fill: Object.keys(c.fill) } : {}) });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { profile: p, sources: out, coverage: coverageOf(p, out, o.linkedinOn ?? false) };
}

const join = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/**
 * The coverage line (D25, D42): what is covered per country × field, what isn't, and what still works there. It never
 * names a source the catalog doesn't have.
 */
export function coverageOf(p: Profile, sources: Suggestion[], linkedinOn: boolean): Coverage {
  const cat = loadCatalog();
  const fams = p.families.length ? p.families : ['any'];
  const places = p.countries.length ? p.countries : p.remote.length ? p.remote : ['world'];
  const covered: Coverage['covered'] = [];
  const missing: string[] = [];
  for (const country of places) for (const family of fams) {
    const where = (c: CatalogEntry) => covers(c.regions, country) || (c.regions.includes('world') && c.workplace.includes('remote') && p.workplace.includes('remote'));
    const hits = sources.filter((s) => { const c = cat.byId.get(s.id)!; return where(c) && (family === 'any' || c.families.includes(family) || c.families.includes('any')); }).map((s) => s.name);
    // A field with only general (any-field) boards is still named as not covered by a board of its own.
    const specific = family === 'any' ? hits : sources.filter((s) => { const c = cat.byId.get(s.id)!; return where(c) && c.families.includes(family); }).map((s) => s.name);
    covered.push({ country, family, sources: hits });
    if (!specific.length) missing.push(family === 'any' ? `no job board for ${placeName(country)}` : `no job board for ${familyWords(family)} in ${placeName(country)}`);
  }
  // What still works: employers' careers pages on systems common there (named from the catalog), public-sector
  // portals, LinkedIn if switched on, pasted links.
  const atsThere = cat.sources.filter((c) => c.kind === 'ats' && c.runnable && !c.retired && c.detect && places.some((x) => x !== 'world' && covers(c.regions.filter((r) => r !== 'world'), x)));
  const prefer = (c: CatalogEntry) => (c.families.some((f) => fams.includes(f) && f !== 'any') ? 0 : c.families.includes('any') ? 1 : 2) + (c.confidence === 'high' ? 0 : 0.5);
  const atsNames = atsThere.sort((a, b) => prefer(a) - prefer(b) || a.name.localeCompare(b.name)).slice(0, 5).map((c) => shortName(c.name));
  const works: string[] = [];
  if (atsNames.length) works.push(`employers' careers pages work when they use ${join(atsNames)}: tell me the employers and I'll check each`);
  else works.push('employers\' careers pages work when they use a system Crewdeck reads: tell me the employers and I\'ll check each');
  works.push(linkedinOn ? 'LinkedIn search is on' : 'LinkedIn search is available if you switch it on in Jobs → Settings (it reads LinkedIn as a guest, which LinkedIn may limit)');
  works.push('paste any posting you find');
  const names = places.map((x) => (x === 'world' ? 'anywhere' : placeName(x))).join(', ');
  const where = p.workplace.length === 1 && p.workplace[0] === 'remote' ? `remote work from ${names}` : names;
  const forFam = p.families.filter((f) => f !== 'any');
  const fam = forFam.length ? ` for ${join(forFam.map(familyWords))}` : '';
  const thin = sources.length > 0 && sources.every((x) => x.reasons.some((r) => r.startsWith('remote jobs from many countries')));
  const has = sources.length ? `${sources.length} job board${sources.length > 1 ? "s fit" : " fits"} ${where}${fam}${thin ? ' (most of their remote jobs are limited to the US or Europe)' : ''}` : `Crewdeck has no job board that fits ${where}${fam}`;
  const line = !p.countries.length && !p.remote.length
    ? `Tell me where you can work (cities, or countries for remote work) and Crewdeck proposes job boards for it. ${capital(works.join('; '))}.`
    : `${has}${missing.length && sources.length && forFam.length ? ` (${missing.join('; ')})` : ''}. ${capital(works.join('; '))}.`;
  return { covered, missing, works, line };
}

const shortName = (n: string) => n.replace(/\s*\(.*\)\s*$/, '');

/** Field ids in plain words for the coverage line (the ids stay in notes and the catalog). */
const FAMILY_WORDS: Record<string, string> = {
  'engineering-it': 'software and IT', data: 'data and analytics', 'product-project': 'product and project management',
  design: 'design', 'creative-media': 'writing, content and media', marketing: 'marketing', sales: 'sales',
  'customer-service': 'customer service', 'finance-accounting': 'finance and accounting', legal: 'legal and compliance',
  'people-hr': 'HR and recruiting', 'office-admin': 'office and admin work', operations: 'operations', healthcare: 'healthcare',
  'care-social': 'care and social work', education: 'education', 'science-research': 'science and research',
  'engineering-physical': 'mechanical, civil and electrical engineering', 'trades-construction': 'trades and construction',
  'manufacturing-production': 'manufacturing', 'logistics-transport': 'warehouse, driving and transport', retail: 'retail',
  'hospitality-food': 'hospitality and food', 'public-sector': 'public-sector jobs',
};
export const familyWords = (id: string) => FAMILY_WORDS[id] ?? id;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The four retired presets as catalog queries (D39), with the search.md defaults they still seed. */
export const PRESET_QUERIES: Record<string, Query> = {
  'remote-any-country': { workplace: ['remote'] },
  'onsite-city': { workplace: ['onsite', 'hybrid'] },
  'healthcare-us': { families: ['healthcare'], countries: ['us'] },
  'non-engineering': { families: ['any'] },
};
