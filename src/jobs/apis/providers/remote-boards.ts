// Public, keyless job boards: Himalayas and Remotive (remote jobs), Arbeitnow (Germany / Europe).
// Each asks for credit and a link back: postings keep the board's URL and carry `attribution`.
import { type ApiPosting, type Provider } from '../types.ts';
import { base, countryOfLocation, iso, json, pay, payText, perTitle, periodOf, remoteFrom, text, titleMatches, withinDays } from '../util.ts';

const notAnywhere = (cs: string[]) => cs.filter((c) => c !== '*');

// ---------------------------------------------------------------- Himalayas
// https://himalayas.app/api — /jobs/api/search?q=&country=<ISO-2>&page= (20 a page). locationRestrictions are the
// countries a role may be done from; empty = anywhere.
function himalayasPosting(j: any): ApiPosting {
  const restricted: string[] = (j.locationRestrictions ?? []).map(String);
  const remoteCountries = restricted.length ? remoteFrom(restricted) : ['*'];
  const url = String(j.guid ?? j.applicationLink ?? '');
  return {
    ...base('himalayas'),
    sourceJobId: url.replace(/^https?:\/\/[^/]+\/companies\//, '') || String(j.title),
    company: String(j.companyName ?? ''),
    title: String(j.title ?? ''),
    url,
    applyUrl: String(j.applicationLink ?? url),
    descriptionText: text(j.description ?? j.excerpt),
    locations: restricted.length ? restricted : ['Remote (anywhere)'],
    workplace: 'remote',
    remoteCountries,
    countries: notAnywhere(remoteCountries),
    employmentType: String(j.employmentType ?? ''),
    pay: pay(j.minSalary, j.maxSalary, j.currency, periodOf(j.salaryPeriod)),
    postedAt: iso(j.pubDate) ?? '',
    closesAt: iso(j.expiryDate),
    attribution: { text: 'Remote job from Himalayas', url },
  };
}

export const himalayas: Provider = {
  id: 'himalayas', name: 'Himalayas', countries: ['*'], fields: ['software', 'product', 'design', 'data', 'marketing', 'sales', 'support', 'operations', 'finance'],
  terms: 'Free public API; credit Himalayas and link to the job on himalayas.app; apply through its link. Do not resell the data.',
  attribution: { text: 'Remote jobs from Himalayas', url: 'https://himalayas.app', rule: 'credit Himalayas and link each posting (and Apply) through its himalayas.app link' },
  rateLimit: { minIntervalMs: 1000, note: 'rate limited (no number published); 1 request/s' },
  fixture: 'verified',
  async search(q, ctx) {
    const page = q.page ?? 1;
    return perTitle(q, async (title) => {
      const u = new URL('https://himalayas.app/jobs/api/search');
      u.searchParams.set('q', title);
      if (q.country) u.searchParams.set('country', q.country.toUpperCase());
      u.searchParams.set('page', String(page));
      const j = await json(ctx, { url: u.toString() });
      const jobs = j?.jobs ?? [];
      return { postings: jobs.map(himalayasPosting), more: jobs.length > 0 && Number(j?.offset ?? 0) + jobs.length < Number(j?.totalCount ?? 0) };
    });
  },
};

// ---------------------------------------------------------------- Remotive
// https://remotive.com/api-documentation — /api/remote-jobs?search=; jobs are delayed 24 h; the board asks for at most
// ~4 fetches a day and a credit + link back on every job.
function remotivePosting(j: any): ApiPosting {
  const where = String(j.candidate_required_location ?? '');
  const remoteCountries = remoteFrom(where);
  return {
    ...base('remotive'),
    sourceJobId: String(j.id),
    company: String(j.company_name ?? ''),
    title: String(j.title ?? ''),
    url: String(j.url ?? ''),
    applyUrl: String(j.url ?? ''),
    descriptionText: text(j.description),
    locations: where ? [where] : [],
    workplace: 'remote',
    remoteCountries,
    countries: notAnywhere(remoteCountries),
    employmentType: String(j.job_type ?? '').replace(/_/g, '-'),
    pay: payText(j.salary, 'year'),
    postedAt: iso(j.publication_date) ?? '',
    attribution: { text: 'Job from Remotive', url: String(j.url ?? 'https://remotive.com') },
  };
}

export const remotive: Provider = {
  id: 'remotive', name: 'Remotive', countries: ['*'], fields: ['software', 'product', 'design', 'data', 'marketing', 'sales', 'support', 'writing', 'finance', 'hr'],
  terms: 'Free public API for sharing jobs further: mention Remotive as the source and link to the Remotive URL; do not submit its jobs to other boards; no signup walls in front of them; at most ~4 fetches a day.',
  attribution: { text: 'Jobs from Remotive', url: 'https://remotive.com', rule: 'mention Remotive and link each posting to its remotive.com URL' },
  rateLimit: { minIntervalMs: 2000, maxPerRun: 3, note: 'Remotive asks for at most ~4 fetches a day; excessive requests are blocked' },
  fixture: 'verified',
  async search(q, ctx) {
    return perTitle(q, async (title) => {
      const u = new URL('https://remotive.com/api/remote-jobs');
      u.searchParams.set('search', title);
      u.searchParams.set('limit', '100');
      const j = await json(ctx, { url: u.toString() });
      return { postings: (j?.jobs ?? []).map(remotivePosting) };
    });
  },
};

// ---------------------------------------------------------------- Arbeitnow
// https://www.arbeitnow.com/api/job-board-api — the whole board, newest first, ~100–300 a page, no search: titles are
// matched here.
function arbeitnowPosting(j: any): ApiPosting {
  const loc = String(j.location ?? '');
  const remote = j.remote === true;
  const c = countryOfLocation(loc);
  return {
    ...base('arbeitnow'),
    sourceJobId: String(j.slug ?? j.url),
    company: String(j.company_name ?? ''),
    title: String(j.title ?? ''),
    url: String(j.url ?? ''),
    applyUrl: String(j.url ?? ''),
    descriptionText: text(j.description),
    locations: loc ? [loc] : [],
    // `remote` is structured; "Berlin (Hybrid)" only in the text.
    workplace: remote ? 'remote' : /hybrid/i.test(loc) ? 'hybrid' : loc && !/remote/i.test(loc) ? 'onsite' : 'unknown',
    remoteCountries: [],
    countries: c ? [c] : [],
    employmentType: (j.job_types ?? []).map(String).join(', '),
    postedAt: iso(j.created_at) ?? '',
    attribution: { text: 'Job from Arbeitnow', url: String(j.url ?? 'https://www.arbeitnow.com') },
  };
}

export const arbeitnow: Provider = {
  id: 'arbeitnow', name: 'Arbeitnow', countries: ['DE', 'AT', 'CH', 'NL'], fields: ['software', 'data', 'marketing', 'sales', 'operations', 'student'],
  terms: 'Free public API ("please do not abuse"); link back to arbeitnow.com; terms at arbeitnow.com.',
  attribution: { text: 'Jobs from Arbeitnow', url: 'https://www.arbeitnow.com', rule: 'link each posting to its arbeitnow.com page' },
  rateLimit: { minIntervalMs: 1500, note: 'x-ratelimit-limit: 50 (per minute); hourly updates, so a few pages a run' },
  fixture: 'verified',
  async search(q, ctx) {
    const page = q.page ?? 1;
    const j = await json(ctx, { url: `https://www.arbeitnow.com/api/job-board-api?page=${page}` });
    const all: ApiPosting[] = (j?.data ?? []).map(arbeitnowPosting);
    const fresh = withinDays(all, q.daysBack);
    const more = !!j?.links?.next && fresh.length === all.length;
    const postings = fresh.filter((p) => titleMatches(p.title, q.titles) && (!q.remote || p.workplace === 'remote'));
    return { postings, next: more ? page + 1 : undefined, errors: [] };
  },
};
