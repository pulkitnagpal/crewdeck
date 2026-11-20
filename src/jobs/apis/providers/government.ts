// Public-sector job APIs: USAJobs (US federal), NHS Jobs (England & Wales health), DfE Teaching Vacancies (England
// schools), Bundesagentur für Arbeit Jobsuche (Germany).
import { type ApiPosting, type ApiQuery, type Provider } from '../types.ts';
import { base, countryCode, iso, json, pay, payText, perTitle, periodOf, request, text, titleMatches, withinDays } from '../util.ts';

const first = (q: ApiQuery) => q.places?.map((p) => p.trim()).find(Boolean);
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return m ? decode(m[1]).trim() : ''; };
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => decode(m[1]).trim());

// ---------------------------------------------------------------- USAJobs
// https://developer.usajobs.gov/api-reference/get-api-search — key: "<email>:<Authorization-Key>" (the email the key
// was requested with goes in User-Agent, as the API requires).
function usajobsPosting(item: any): ApiPosting {
  const d = item?.MatchedObjectDescriptor ?? {};
  const details = d.UserArea?.Details ?? {};
  const remote = details.RemoteIndicator === true || details.RemoteIndicator === 'true';
  const telework = details.TeleworkEligible === true || details.TeleworkEligible === 'true';
  const locs = (d.PositionLocation ?? []).map((l: any) => String(l.LocationName ?? '')).filter(Boolean);
  const countries = [...new Set((d.PositionLocation ?? []).map((l: any) => countryCode(String(l.CountryCode ?? ''))).filter(Boolean) as string[])];
  const rem = d.PositionRemuneration?.[0];
  const desc = [details.JobSummary, d.QualificationSummary, ...(details.MajorDuties ?? [])].filter(Boolean).map(String).join('\n\n');
  return {
    ...base('usajobs'),
    sourceJobId: String(item.MatchedObjectId ?? d.PositionID),
    company: String(d.OrganizationName || d.DepartmentName || ''),
    title: String(d.PositionTitle ?? ''),
    url: String(d.PositionURI ?? ''),
    applyUrl: String(d.ApplyURI?.[0] ?? d.PositionURI ?? ''),
    descriptionText: text(desc),
    locations: locs.length ? locs : [String(d.PositionLocationDisplay ?? '')].filter(Boolean),
    workplace: remote ? 'remote' : telework ? 'hybrid' : locs.length ? 'onsite' : 'unknown',
    // Federal remote work is from the US (and its territories): the API has no wider remote.
    remoteCountries: remote ? ['US'] : [],
    countries: countries.length ? countries : ['US'],
    employmentType: [d.PositionSchedule?.[0]?.Name, d.PositionOfferingType?.[0]?.Name].filter(Boolean).join(', '),
    pay: rem ? pay(rem.MinimumRange, rem.MaximumRange, 'USD', periodOf(rem.RateIntervalCode)) : undefined,
    postedAt: iso(d.PublicationStartDate) ?? '',
    closesAt: iso(d.ApplicationCloseDate),
  };
}

export const usajobs: Provider = {
  id: 'usajobs', name: 'USAJOBS', countries: ['US'], fields: 'any',
  needsKey: { signupUrl: 'https://developer.usajobs.gov/apirequest/', format: '<the email you requested the key with>:<Authorization-Key>' },
  terms: 'Free key per person; the email it was issued to must be sent as User-Agent. US federal civilian jobs only.',
  rateLimit: { minIntervalMs: 1000, note: 'no published limit; 1 request/s' },
  fixture: 'unverified',
  async search(q, ctx) {
    const raw = ctx.keys.get('usajobs') ?? '';
    const i = raw.indexOf(':');
    const email = i > 0 ? raw.slice(0, i) : '', key = i > 0 ? raw.slice(i + 1) : raw;
    if (!email || !key) return { postings: [], errors: ['the USAJOBS key must be stored as <email>:<key> (crewdeck jobs keys set usajobs)'] };
    const page = q.page ?? 1;
    return perTitle(q, async (title) => {
      const u = new URL('https://data.usajobs.gov/api/search');
      u.searchParams.set('PositionTitle', title);
      u.searchParams.set('ResultsPerPage', '100');
      u.searchParams.set('Page', String(page));
      if (q.places?.length) u.searchParams.set('LocationName', q.places.join(';'));
      if (q.remote) u.searchParams.set('RemoteIndicator', 'True');
      if (q.daysBack) u.searchParams.set('DatePosted', String(Math.min(60, Math.max(0, Math.round(q.daysBack)))));
      const j = await json(ctx, { url: u.toString(), headers: { 'user-agent': email, 'authorization-key': key } });
      const sr = j?.SearchResult ?? {};
      return { postings: (sr.SearchResultItems ?? []).map(usajobsPosting), more: page < Number(sr.UserArea?.NumberOfPages ?? 0) };
    });
  },
};

// ---------------------------------------------------------------- NHS Jobs
// https://www.jobs.nhs.uk/api/v1/search_xml — public XML search (England and Wales). Descriptions are ~150-character
// teasers: the description fetcher reads the advert page.
function nhsPosting(x: string): ApiPosting {
  const locs = tags(x, 'location');
  return {
    ...base('nhs-jobs'),
    sourceJobId: tag(x, 'id') || tag(x, 'reference'),
    company: tag(x, 'employer'),
    title: tag(x, 'title'),
    url: tag(x, 'url'),
    applyUrl: tag(x, 'url'),
    descriptionText: tag(x, 'description'),
    locations: locs,
    // No structured workplace field in the XML.
    workplace: 'unknown',
    remoteCountries: [],
    countries: ['GB'],
    employmentType: tag(x, 'type'),
    pay: payText(tag(x, 'salary'), 'year'),
    postedAt: iso(tag(x, 'postDate')) ?? '',
    closesAt: iso(tag(x, 'closeDate')),
  };
}

export const nhsJobs: Provider = {
  id: 'nhs-jobs', name: 'NHS Jobs', countries: ['GB'], fields: ['health', 'care', 'admin', 'estates', 'it', 'any-nhs'],
  terms: 'Public search feed of NHS Jobs; link each posting to its NHS Jobs advert. No key.',
  attribution: { text: 'NHS Jobs', url: 'https://www.jobs.nhs.uk', rule: 'link each posting to its jobs.nhs.uk advert' },
  rateLimit: { minIntervalMs: 1000, note: 'no published limit; 1 request/s' },
  fixture: 'verified',
  async search(q, ctx) {
    const page = q.page ?? 1;
    return perTitle(q, async (title) => {
      const u = new URL('https://www.jobs.nhs.uk/api/v1/search_xml');
      u.searchParams.set('keyword', title);
      const where = first(q);
      if (where) { u.searchParams.set('location', where); u.searchParams.set('distance', '25'); }
      u.searchParams.set('page', String(page));
      const xml = await request(ctx, { url: u.toString(), headers: { accept: 'application/xml' } });
      const items = xml.match(/<vacancyDetails>[\s\S]*?<\/vacancyDetails>/g) ?? [];
      return { postings: items.map(nhsPosting), more: page < Number(tag(xml, 'totalPages') || 0) };
    });
  },
};

// ---------------------------------------------------------------- DfE Teaching Vacancies
// https://teaching-vacancies.service.gov.uk/api/v1/jobs.json — the open-data feed (schema.org JobPosting, Open
// Government Licence v3.0), 100 a page, newest first, no search: titles are matched here.
function address(l: any): { text: string; country?: string } {
  const a = l?.address ?? {};
  return { text: [a.addressLocality, a.addressRegion, a.postalCode].filter(Boolean).join(', '), country: a.addressCountry ? String(a.addressCountry).toUpperCase() : undefined };
}

function dfePosting(p: any): ApiPosting {
  const where = (Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation]).filter(Boolean).map(address);
  const remote = String(p.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
  const url = String(p.url ?? '');
  const salary = p.baseSalary;
  const countries = [...new Set(where.map((w: any) => w.country).filter(Boolean) as string[])];
  return {
    ...base('dfe-teaching-vacancies'),
    // The page slug: it ends in a UUID for most postings, not all.
    sourceJobId: /\/jobs\/([^/?#]+)/.exec(url)?.[1] ?? url,
    company: String(p.hiringOrganization?.name ?? ''),
    title: String(p.title ?? ''),
    url, applyUrl: url,
    descriptionText: text(p.description),
    locations: where.map((w: any) => w.text).filter(Boolean),
    workplace: remote ? 'remote' : where.length ? 'onsite' : 'unknown',
    remoteCountries: remote ? ['GB'] : [],
    countries: countries.length ? countries : ['GB'],
    employmentType: [].concat(p.employmentType ?? []).map((t: string) => t.toLowerCase().replace(/_/g, '-')).join(', '),
    pay: salary ? payText(String(salary.value?.value ?? ''), periodOf(salary.value?.unitText)) : undefined,
    postedAt: iso(p.datePosted) ?? '',
    closesAt: iso(p.validThrough),
    attribution: { text: 'Contains public sector information licensed under the Open Government Licence v3.0 (Teaching Vacancies, DfE)', url },
  };
}

export const dfeTeaching: Provider = {
  id: 'dfe-teaching-vacancies', name: 'Teaching Vacancies (DfE)', countries: ['GB'], fields: ['teaching', 'education', 'school-support'],
  terms: 'Open Government Licence v3.0: attribute the source; API terms at teaching-vacancies.service.gov.uk/pages/terms-and-conditions. England only. No key.',
  attribution: { text: 'Contains public sector information licensed under the Open Government Licence v3.0', url: 'https://teaching-vacancies.service.gov.uk', rule: 'show the OGL attribution and link each posting to its Teaching Vacancies page' },
  rateLimit: { minIntervalMs: 1000, note: 'no published limit; 1 request/s' },
  fixture: 'verified',
  async search(q, ctx) {
    const page = q.page ?? 1;
    const j = await json(ctx, { url: `https://teaching-vacancies.service.gov.uk/api/v1/jobs.json?page=${page}` });
    const all: ApiPosting[] = (j?.data ?? []).map(dfePosting);
    const fresh = withinDays(all, q.daysBack);
    // Newest first: once a page reaches past daysBack, later pages are older still.
    const more = !!j?.links?.next && fresh.length === all.length;
    return { postings: fresh.filter((p) => titleMatches(p.title, q.titles)), next: more ? page + 1 : undefined, errors: [] };
  },
};

// ---------------------------------------------------------------- Bundesagentur für Arbeit Jobsuche
// rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs with X-API-Key: jobboerse-jobsuche — the endpoint the
// BA's own site uses; documented only by the community (github.com/bundesAPI/jobsuche-api). No descriptions in the list.
function baPosting(s: any, telework: boolean): ApiPosting {
  const o = s.arbeitsort ?? {};
  const url = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(String(s.refnr ?? ''))}`;
  return {
    ...base('ba-jobsuche'),
    sourceJobId: String(s.refnr ?? ''),
    company: String(s.arbeitgeber ?? ''),
    title: String(s.titel || s.beruf || ''),
    url,
    applyUrl: s.externeUrl ? String(s.externeUrl) : url,
    descriptionText: '',
    locations: [[o.ort, o.region !== o.ort ? o.region : undefined].filter(Boolean).join(', ')].filter(Boolean),
    // Searched with arbeitszeit=ho: home office is possible, usually part of the week.
    workplace: telework ? 'hybrid' : 'unknown',
    remoteCountries: [],
    countries: [countryCode(String(o.land ?? '')) ?? 'DE'],
    employmentType: '',
    postedAt: iso(s.aktuelleVeroeffentlichungsdatum) ?? '',
    updatedAt: iso(s.modifikationsTimestamp),
  };
}

export const baJobsuche: Provider = {
  id: 'ba-jobsuche', name: 'Bundesagentur für Arbeit Jobsuche', countries: ['DE'], fields: 'any',
  undocumented: true,
  terms: 'Public client key of the BA job board (not issued to us); no published terms for third-party use. Germany only.',
  attribution: { text: 'Bundesagentur für Arbeit', url: 'https://www.arbeitsagentur.de/jobsuche/', rule: 'link each posting to its Jobsuche page' },
  rateLimit: { minIntervalMs: 1500, note: 'undocumented endpoint: 1 request per 1.5 s' },
  fixture: 'unverified',
  async search(q, ctx) {
    const page = q.page ?? 1, size = 50;
    return perTitle(q, async (title) => {
      const u = new URL('https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs');
      u.searchParams.set('was', title);
      const where = first(q);
      if (where) { u.searchParams.set('wo', where); u.searchParams.set('umkreis', '25'); }
      u.searchParams.set('angebotsart', '1');
      if (q.remote) u.searchParams.set('arbeitszeit', 'ho');
      if (q.daysBack) u.searchParams.set('veroeffentlichtseit', String(Math.min(100, Math.round(q.daysBack))));
      u.searchParams.set('page', String(page));
      u.searchParams.set('size', String(size));
      const j = await json(ctx, { url: u.toString(), headers: { 'x-api-key': 'jobboerse-jobsuche' } });
      return { postings: (j?.stellenangebote ?? []).map((s: any) => baPosting(s, !!q.remote)), more: page * size < Number(j?.maxErgebnisse ?? 0) };
    });
  },
};
