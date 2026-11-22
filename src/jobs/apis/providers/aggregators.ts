// Keyed job aggregators (design A2/A3: optional per-user keys, never shipped): Reed (UK), Adzuna (19 countries),
// Jooble (many countries). Their descriptions are snippets; the description fetcher reads the full posting.
import { type ApiPosting, type Provider, type PayPeriod } from '../types.ts';
import { base, countryOfLocation, iso, json, pay, payText, perTitle, text } from '../util.ts';

const first = (places?: string[]) => places?.map((p) => p.trim()).find(Boolean);
/** Free-text location: "Remote" there is the only remote signal these APIs give. */
const remoteText = (s: string) => /\b(remote|home[- ]?based|work from home|wfh)\b/i.test(s);

// ---------------------------------------------------------------- Reed
// https://www.reed.co.uk/developers/jobseeker — Basic auth, the key as user name and an empty password.
/** Reed gives no pay period: small numbers are hourly or daily rates. */
const reedPeriod = (n: number | null): PayPeriod | null => (n === null ? null : n < 150 ? 'hour' : n < 1500 ? 'day' : 'year');

function reedPosting(r: any): ApiPosting {
  const loc = String(r.locationName ?? '');
  const hi = r.maximumSalary ?? r.minimumSalary ?? null;
  return {
    ...base('reed'),
    sourceJobId: String(r.jobId),
    company: String(r.employerName ?? ''),
    title: String(r.jobTitle ?? ''),
    url: String(r.jobUrl ?? ''),
    applyUrl: String(r.jobUrl ?? ''),
    descriptionText: text(r.jobDescription),
    locations: loc ? [loc] : [],
    workplace: remoteText(loc) ? 'remote' : 'unknown',
    remoteCountries: [],
    countries: ['GB'],
    employmentType: '',
    pay: pay(r.minimumSalary, r.maximumSalary, r.currency || 'GBP', reedPeriod(hi === null ? null : Number(hi))),
    postedAt: iso(r.date) ?? '',
    closesAt: iso(r.expirationDate),
  };
}

export const reed: Provider = {
  id: 'reed', name: 'Reed', countries: ['GB'], fields: 'any',
  needsKey: { signupUrl: 'https://www.reed.co.uk/developers/jobseeker', format: 'the API key from your Reed developer account' },
  terms: 'Free jobseeker API key per person; link each job to reed.co.uk. UK jobs.',
  attribution: { text: 'Jobs from Reed.co.uk', url: 'https://www.reed.co.uk', rule: 'link each posting to its reed.co.uk page' },
  rateLimit: { minIntervalMs: 1000, note: 'no published limit; 1 request/s' },
  fixture: 'unverified',
  async search(q, ctx) {
    const key = ctx.keys.get('reed') ?? '';
    const page = q.page ?? 1, take = 100;
    return perTitle(q, async (title) => {
      const u = new URL('https://www.reed.co.uk/api/1.0/search');
      u.searchParams.set('keywords', title);
      const where = first(q.places);
      if (where) { u.searchParams.set('locationName', where); u.searchParams.set('distanceFromLocation', '15'); }
      u.searchParams.set('resultsToTake', String(take));
      u.searchParams.set('resultsToSkip', String((page - 1) * take));
      const j = await json(ctx, { url: u.toString(), headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` } });
      return { postings: (j?.results ?? []).map(reedPosting), more: page * take < Number(j?.totalResults ?? 0) };
    });
  },
};

// ---------------------------------------------------------------- Adzuna
// https://developer.adzuna.com/docs/search — key: "<app_id>:<app_key>"; both go in the query string (redacted in logs).
export const ADZUNA_COUNTRIES = ['AT', 'AU', 'BE', 'BR', 'CA', 'CH', 'DE', 'ES', 'FR', 'GB', 'IN', 'IT', 'MX', 'NL', 'NZ', 'PL', 'SG', 'US', 'ZA'];
const ADZUNA_CURRENCY: Record<string, string> = { AT: 'EUR', AU: 'AUD', BE: 'EUR', BR: 'BRL', CA: 'CAD', CH: 'CHF', DE: 'EUR', ES: 'EUR', FR: 'EUR', GB: 'GBP', IN: 'INR', IT: 'EUR', MX: 'MXN', NL: 'EUR', NZ: 'NZD', PL: 'PLN', SG: 'SGD', US: 'USD', ZA: 'ZAR' };

function adzunaPosting(r: any, cc: string): ApiPosting {
  const loc = String(r.location?.display_name ?? '');
  // Adzuna estimates pay for many ads: an estimate is not the employer's number.
  const predicted = String(r.salary_is_predicted ?? '0') === '1';
  return {
    ...base('adzuna'),
    sourceJobId: String(r.id),
    company: String(r.company?.display_name ?? ''),
    title: text(r.title),
    url: String(r.redirect_url ?? ''),
    applyUrl: String(r.redirect_url ?? ''),
    descriptionText: text(r.description),
    locations: loc ? [loc] : [],
    workplace: remoteText(`${loc} ${r.title ?? ''}`) ? 'remote' : 'unknown',
    remoteCountries: [],
    countries: [cc],
    employmentType: [r.contract_time, r.contract_type].filter(Boolean).map((s: string) => s.replace(/_/g, '-')).join(', '),
    pay: predicted ? undefined : pay(r.salary_min, r.salary_max, ADZUNA_CURRENCY[cc], 'year'),
    postedAt: iso(r.created) ?? '',
    attribution: { text: 'Jobs by Adzuna', url: 'https://www.adzuna.com' },
  };
}

export const adzuna: Provider = {
  id: 'adzuna', name: 'Adzuna', countries: ADZUNA_COUNTRIES, fields: 'any',
  needsKey: { signupUrl: 'https://developer.adzuna.com/signup', format: '<app_id>:<app_key>' },
  terms: 'Free developer key per person; show "Jobs by Adzuna" with a link wherever results appear; send people to redirect_url (no deep links around it).',
  attribution: { text: 'Jobs by Adzuna', url: 'https://www.adzuna.com', rule: 'show "Jobs by Adzuna" linking to Adzuna wherever its results appear; link postings via redirect_url' },
  rateLimit: { minIntervalMs: 2500, maxPerRun: 25, note: 'default key limits: 25 requests/min, 250/day, 1,000/week' },
  fixture: 'unverified',
  async search(q, ctx) {
    const raw = ctx.keys.get('adzuna') ?? '';
    const i = raw.indexOf(':');
    if (i <= 0) return { postings: [], errors: ['the Adzuna key must be stored as <app_id>:<app_key> (crewdeck jobs keys set adzuna)'] };
    const cc = q.country.toUpperCase();
    const page = q.page ?? 1, per = 50;
    return perTitle(q, async (title) => {
      const u = new URL(`https://api.adzuna.com/v1/api/jobs/${cc.toLowerCase()}/search/${page}`);
      u.searchParams.set('app_id', raw.slice(0, i));
      u.searchParams.set('app_key', raw.slice(i + 1));
      u.searchParams.set('results_per_page', String(per));
      u.searchParams.set('title_only', title);
      const where = first(q.places);
      if (where) u.searchParams.set('where', where);
      if (q.daysBack) u.searchParams.set('max_days_old', String(Math.round(q.daysBack)));
      u.searchParams.set('sort_by', 'date');
      u.searchParams.set('content-type', 'application/json');
      const j = await json(ctx, { url: u.toString() });
      return { postings: (j?.results ?? []).map((r: any) => adzunaPosting(r, cc)), more: page * per < Number(j?.count ?? 0) };
    });
  },
};

// ---------------------------------------------------------------- Jooble
// https://jooble.org/api/about — POST https://jooble.org/api/<key> with a JSON body; the key sits in the URL path.
function joobleCountryName(cc: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) ?? cc; } catch { return cc; }
}

function jooblePosting(r: any, cc: string): ApiPosting {
  const loc = String(r.location ?? '');
  const remote = remoteText(`${loc} ${r.type ?? ''}`);
  return {
    ...base('jooble'),
    sourceJobId: String(r.id),
    company: String(r.company ?? ''),
    title: text(r.title),
    url: String(r.link ?? ''),
    applyUrl: String(r.link ?? ''),
    descriptionText: text(r.snippet),
    locations: loc ? [loc] : [],
    workplace: remote ? 'remote' : 'unknown',
    remoteCountries: [],
    countries: [countryOfLocation(loc, cc) ?? cc],
    employmentType: String(r.type ?? ''),
    pay: payText(r.salary),
    postedAt: iso(r.updated) ?? '',
    attribution: { text: `Jobs via Jooble (${r.source ?? 'Jooble'})`, url: String(r.link ?? 'https://jooble.org') },
  };
}

export const jooble: Provider = {
  id: 'jooble', name: 'Jooble', countries: ['*'], fields: 'any',
  needsKey: { signupUrl: 'https://jooble.org/api/about', format: 'the API key Jooble emails you' },
  terms: 'Free partner key per person on request; keep Jooble\'s links (they carry the referral); results aggregate other boards.',
  attribution: { text: 'Jobs via Jooble', url: 'https://jooble.org', rule: 'link each posting through its Jooble link' },
  rateLimit: { minIntervalMs: 1000, note: 'no published limit; 1 request/s' },
  fixture: 'unverified',
  async search(q, ctx) {
    const key = ctx.keys.get('jooble') ?? '';
    const cc = q.country.toUpperCase();
    const page = q.page ?? 1;
    return perTitle(q, async (title) => {
      const body: Record<string, string> = { keywords: title, location: first(q.places) ? `${first(q.places)}, ${joobleCountryName(cc)}` : joobleCountryName(cc), page: String(page), ResultOnPage: '50' };
      if (q.daysBack) body.datecreatedfrom = new Date(Date.now() - q.daysBack * 86_400_000).toISOString().slice(0, 10);
      const j = await json(ctx, { url: `https://jooble.org/api/${encodeURIComponent(key)}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { postings: (j?.jobs ?? []).map((r: any) => jooblePosting(r, cc)), more: page * 50 < Number(j?.totalCount ?? 0) };
    });
  },
};
