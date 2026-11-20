// Offline, deterministic enrichment of the company directory (design §8.2, ADR-0002). The seed carries only a company
// name and a board slug, so everything here is a heuristic on those words: field families from industry keywords,
// hiring regions from place names and legal-entity suffixes, remote from the word "remote". Each label carries a
// confidence and the words that produced it. Unknown is a valid answer and the common one: most names say nothing.

export type Confidence = 'high' | 'medium' | 'low' | 'unknown';
export type Enrichment = {
  families: string[]; familyConfidence: Confidence; familyFrom: string[];
  regions: string[]; regionConfidence: Confidence; regionFrom: string[];
  remote: boolean | null; staffing: boolean;
};

/** The field families typical of a startup/scale-up board on Greenhouse, Lever or Ashby (market knowledge). */
export const TECH_BOARD_PRIOR = ['engineering-it', 'data', 'product-project', 'design', 'sales', 'marketing', 'customer-service', 'operations'];

/** Industry words (matched as whole words, case-insensitive, in the name and the slug) → families. */
const FAMILY_WORDS: [RegExp, string[]][] = [
  [/\b(hospitals?|health ?care|health|healthcare|medical|medicine|clinics?|clinical|nursing|nurses?|dental|dentistry|physicians?|pediatrics?|oncology|cardiology|orthopa?edics?|surgical|surgery|radiology|pharmacy|rx|hospice|rehab(ilitation)?|wellness|behavioral)\b/i, ['healthcare']],
  [/\b(therapeutics|bio|biotech|biosciences?|biologics|pharma|pharmaceuticals?|genomics|diagnostics)\b/i, ['science-research', 'healthcare']],
  [/\b(research|laborator(y|ies)|scientific|science|sciences)\b/i, ['science-research']],
  [/\b(ai|a\.i\.|ml|machine learning|data|analytics|intelligence)\b/i, ['data', 'engineering-it']],
  [/\b(software|cloud|cyber|security|systems|technolog(y|ies)|tech|digital|computing|dev|devops|saas|platforms?|networks?|it services)\b/i, ['engineering-it']],
  [/\b(bank|banking|capital|financial|finance|fintech|payments?|pay|credit|lending|loans?|insurance|invest(ments?|ors?)?|wealth|securities|asset management|accounting|accountants|tax|cpas?|trading|fund|funds)\b/i, ['finance-accounting']],
  [/\b(schools?|academy|academies|universit(y|ies)|college|education|educational|learning|edu|tutor(ing)?|campus|charter)\b/i, ['education']],
  [/\b(law|legal|attorneys?|lawyers?|llp|pllc|pc)\b/i, ['legal']],
  [/\b(retail|stores?|shops?|apparel|fashion|boutique|outlet|grocers?|grocery|supermarkets?)\b/i, ['retail']],
  [/\b(hotels?|hospitality|restaurants?|food|foods|kitchen|cafe|coffee|bakery|catering|resorts?|brewing|beverages?)\b/i, ['hospitality-food']],
  [/\b(logistics|freight|shipping|delivery|transport(ation)?|trucking|supply chain|warehous(e|ing)|fleet|aviation|airlines?)\b/i, ['logistics-transport']],
  [/\b(manufacturing|industries|industrial|aerospace|automotive|motors|robotics|semiconductors?|materials|packaging|chemicals?)\b/i, ['engineering-physical', 'manufacturing-production']],
  [/\b(energy|solar|power|electric|utilities|renewables?|nuclear|battery|batteries|oil|gas)\b/i, ['engineering-physical']],
  [/\b(construction|builders?|building|roofing|plumbing|hvac|contractors?|homes|cooling|electrical)\b/i, ['trades-construction']],
  [/\b(engineering|engineers)\b/i, ['engineering-physical']],
  [/\b(media|studios?|games|gaming|entertainment|publishing|music|films?|news|broadcast(ing)?|creative|content|translation|localization)\b/i, ['creative-media']],
  [/\b(marketing|advertising|agency|brands?|communications|pr)\b/i, ['marketing']],
  [/\b(staffing|recruit(ing|ment)|talent|workforce|careers? partners)\b/i, ['people-hr']],
  [/\b(senior living|home care|home health|social services|childcare|child care|daycare|foster|community services|disabilit(y|ies))\b/i, ['care-social']],
  [/\b(foundation|non-?profit|charity|city of|county|state of|government|federal|public)\b/i, ['public-sector']],
  [/\b(consulting|consultants|advisory|partners)\b/i, ['operations', 'finance-accounting']],
];

/** Place words → place ids (places.yaml). Strong words (a country or city named) are medium confidence. */
const PLACE_WORDS: [RegExp, string][] = [
  [new RegExp(`\\b(${[
    'india',
    'bangalore',
    'bengaluru',
    'mumbai',
    'pune',
    'hyderabad',
    'chennai',
    'delhi',
    'noida',
    'kolkata',
    'ahmedabad',
  ].join('|')})\\b`, 'i'), 'in'],
  [/\b(uk|u\.k\.|united kingdom|london|manchester|edinburgh|glasgow|england|scotland|wales|britain|british)\b/i, 'gb'],
  [/\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne)\b/i, 'de'],
  [/\b(france|paris|lyon)\b/i, 'fr'],
  [/\b(netherlands|amsterdam|rotterdam|nederland)\b/i, 'nl'],
  [/\b(ireland|dublin)\b/i, 'ie'],
  [/\b(spain|madrid|barcelona)\b/i, 'es'],
  [/\b(sweden|stockholm)\b/i, 'se'],
  [/\b(poland|warsaw|krakow)\b/i, 'pl'],
  [/\b(canada|canadian|toronto|vancouver|montreal|ottawa|calgary)\b/i, 'ca'],
  [/\b(australia|australian|sydney|melbourne|brisbane|perth)\b/i, 'au'],
  [/\b(new zealand|auckland)\b/i, 'nz'],
  [/\b(singapore)\b/i, 'sg'],
  [/\b(japan|tokyo)\b/i, 'jp'],
  [/\b(brazil|brasil|são paulo|sao paulo)\b/i, 'br'],
  [/\b(mexico|méxico)\b/i, 'mx'],
  [/\b(israel|tel aviv)\b/i, 'il'],
  [/\b(uae|dubai|abu dhabi)\b/i, 'ae'],
  [/\b(philippines|manila)\b/i, 'ph'],
  [/\b(europe|european|emea)\b/i, 'europe'],
  [/\b(latam|latin america)\b/i, 'americas'],
  [/\b(apac|asia pacific)\b/i, 'apac'],
  [/\b(usa|u\.s\.a?\.?|united states|america|american|new york|nyc|san francisco|boston|chicago|texas|california|florida|seattle|atlanta)\b/i, 'us'],
];

/** Legal-entity suffixes: weak evidence of the registering country (low confidence). */
const SUFFIX_WORDS: [RegExp, string][] = [
  [/\b(private limited|pvt\.? ?ltd\.?|pvt)\b/i, 'in'],
  [/\b(gmbh|ag)\b/i, 'dach'],
  [/\b(b\.v\.|bv)\b/i, 'nl'],
  [/\b(sas|sarl)\b/i, 'fr'],
  [/\b(pty\.? ?ltd\.?|pty)\b/i, 'au'],
  [/\b(inc\.?|llc|l\.l\.c\.|corp\.?|corporation|pbc)\b/i, 'us'],
];

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Words to classify: the display name plus the slug split on - and _ (slugs are often the name run together). */
export function wordsOf(name: string, slug = ''): string {
  return `${name} ${slug.replace(/[-_]+/g, ' ')}`.replace(/[’']/g, '').trim();
}

/** Classify one company from its name and slug. Pure and deterministic. */
export function enrich(name: string, slug = ''): Enrichment {
  const text = wordsOf(name, slug);
  const fams: string[] = [], famFrom: string[] = [];
  for (const [re, f] of FAMILY_WORDS) { const m = text.match(re); if (m) { fams.push(...f); famFrom.push(m[0].toLowerCase()); } }
  const strong: string[] = [], weak: string[] = [], regFrom: string[] = [];
  for (const [re, id] of PLACE_WORDS) { const m = text.match(re); if (m) { strong.push(id); regFrom.push(m[0]); } }
  if (!strong.length) for (const [re, id] of SUFFIX_WORDS) { const m = text.match(re); if (m) { weak.push(id); regFrom.push(m[0]); } }
  const remote = /\bremote\b/i.test(text) ? true : null;
  const staffing = /\b(staffing|recruit(ing|ment|ers?)|talent partners|workforce solutions)\b/i.test(text);
  return {
    families: uniq(fams), familyConfidence: fams.length ? 'low' : 'unknown', familyFrom: uniq(famFrom),
    regions: uniq(strong.length ? strong : weak), regionConfidence: strong.length ? 'medium' : weak.length ? 'low' : 'unknown', regionFrom: uniq(regFrom),
    remote, staffing,
  };
}
