// Workday career sites. UNDOCUMENTED: this is the JSON the public career site itself calls, not a published API
// (probed 2026-11-20 on a large public tenant: list + one detail). Board: { ats: 'workday', slug: '<tenant>',
// host: 'wd5' | '<tenant>.wd5.myworkdayjobs.com', site: '<career site>' }.
//   list:   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs  {limit:20, offset, …}, paged until empty
//   detail: GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath} — only for jobs not seen before
// No ETag; a big tenant is ~100 list pages, so the design runs Workday weekly, or daily for watchlisted employers.
import { employmentType, isoDate, postedAgo } from '../normalize.ts';
import type { Adapter, Board, FetchBoardOptions, FetchBoardResult, Posting } from '../types.ts';
import { enc, getFeed, hostLabel, parseJson, posting, sinceFilter } from './common.ts';

export const WORKDAY_PAGE = 20;
const MAX_PAGES = 100;

function origin(b: Board): string {
  const tenant = hostLabel(b.slug);
  const h = String(b.host ?? '').toLowerCase();
  if (/^[a-z0-9-]+\.wd\d{1,3}\.myworkdayjobs\.com$/.test(h)) return `https://${h}`;
  if (/^wd\d{1,3}$/.test(h)) return `https://${tenant}.${h}.myworkdayjobs.com`;
  throw new Error('a Workday board needs host "wdN" or "<tenant>.wdN.myworkdayjobs.com"');
}
const siteOf = (b: Board) => {
  if (!b.site || !/^[A-Za-z0-9_-]{1,100}$/.test(b.site)) throw new Error('a Workday board needs its career site name (site)');
  return b.site;
};
const cxs = (b: Board) => `${origin(b)}/wday/cxs/${enc(hostLabel(b.slug))}/${enc(siteOf(b))}`;
/** A job's stable id: its requisition id when shown, else the last path segment. */
const jobId = (j: any) => String(j?.bulletFields?.[0] || String(j?.externalPath ?? '').split('/').pop() || '');

export const workday: Adapter = {
  ats: 'workday',
  status: 'undocumented',
  feedUrl: (b) => `${cxs(b)}/jobs`,
  async fetchBoard(b: Board, opts: FetchBoardOptions): Promise<FetchBoardResult> {
    let base: string, site: string, root: string;
    try { base = cxs(b); site = siteOf(b); root = origin(b); } catch (e) { return { postings: [], errors: [(e as Error).message], complete: false }; }
    const errors: string[] = [];
    const listed: any[] = [];
    let complete = true;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { errors.push(`stopped after ${MAX_PAGES} pages`); complete = false; break; }
      const g = await getFeed(`${base}/jobs`, { ...opts, etag: undefined }, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: '' }),
      });
      if (!g.ok) { errors.push(g.error ?? 'failed'); complete = false; break; }
      const { data, error } = parseJson(g.body);
      if (error || !Array.isArray(data?.jobPostings)) { errors.push(error ?? 'no jobPostings'); complete = false; break; }
      if (!data.jobPostings.length) break;
      listed.push(...data.jobPostings);
      if (data.jobPostings.length < WORKDAY_PAGE) break;
    }
    if (!listed.length && !complete) return { postings: [], errors, complete: false };

    const now = opts.now ?? Date.now();
    let budget = opts.maxDetails ?? 200, deferred = 0;
    const seen = new Set<string>();
    const postings: Posting[] = [];
    for (const j of listed) {
      const id = jobId(j);
      if (!id || seen.has(id) || !j.externalPath) continue;
      seen.add(id);
      const url = `${root}/${site}${j.externalPath}`;
      const base0 = { atsJobId: id, company: b.company ?? '', title: j.title, url, applyUrl: `${url}/apply`, employmentType: '' as const, postedAt: postedAgo(j.postedOn, now), updatedAt: '', raw: { externalPath: j.externalPath } };
      if (opts.known?.has(id)) {
        postings.push(posting(b, { ...base0, place: { locations: [j.locationsText] }, partial: true }));
        continue;
      }
      if (budget <= 0) { deferred++; continue; }
      budget--;
      const g = await getFeed(`${base}${j.externalPath}`, { ...opts, etag: undefined }, { headers: { accept: 'application/json' } });
      const { data } = g.ok ? parseJson(g.body) : { data: undefined };
      const info = data?.jobPostingInfo;
      if (!info) { errors.push(`job ${id}: ${g.ok ? 'no jobPostingInfo' : (g as any).error}`); complete = false; continue; }
      const country = info.jobRequisitionLocation?.country?.alpha2Code || info.country?.descriptor;
      postings.push(posting(b, {
        ...base0, title: info.title || j.title, url: info.externalUrl || url, applyUrl: info.externalUrl ? `${info.externalUrl}/apply` : base0.applyUrl,
        html: String(info.jobDescription ?? ''),
        place: { locations: [info.location, ...(info.additionalLocations ?? [])], countries: [country], workplace: info.remoteType, hints: [j.title] },
        employmentType: employmentType(info.timeType), postedAt: isoDate(info.startDate) || base0.postedAt, updatedAt: isoDate(info.startDate) || base0.postedAt,
        closesAt: isoDate(info.endDate) || undefined, company: b.company ?? '',
        raw: { externalPath: j.externalPath, jobReqId: info.jobReqId, timeType: info.timeType, remoteType: info.remoteType, hiringOrganization: data?.hiringOrganization?.name },
      }));
    }
    if (deferred) { errors.push(`${deferred} new jobs left for the next run (detail limit)`); complete = false; }
    return { postings: sinceFilter(postings, opts.since), errors, complete };
  },
};
