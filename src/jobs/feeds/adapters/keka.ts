// Keka Hire careers portal (India): GET {company}.keka.com/careers/api/embedjobs/default/active/{portal id}.
// This is the JSON the careers page's own embed script loads; not a documented public API, so `undocumented`.
// Probed 2026-11-20 on Keka's own public portal: the portal id is the GUID in the careers page
// ("/ats/documents/{guid}/careerportal/…"). Board: { ats: 'keka', slug: '<subdomain>', site: '<portal guid>' }.
import { employmentType, isoDate, pay } from '../normalize.ts';
import type { Adapter, Board } from '../types.ts';
import { enc, getFeed, hostLabel, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

const origin = (b: Board) => `https://${hostLabel(b.slug)}.keka.com`;
// salaryPeriod: Keka's enum is not published; 0 is seen with yearly INR ranges. Unverified beyond that.
const PERIOD: Record<number, string> = { 0: 'year', 1: 'month', 2: 'hour' };

export const keka: Adapter = {
  ats: 'keka',
  status: 'undocumented',
  feedUrl: (b) => {
    if (!b.site || !/^[0-9a-f-]{36}$/i.test(b.site)) throw new Error('a Keka board needs its careers portal id (site)');
    return `${origin(b)}/careers/api/embedjobs/default/active/${enc(b.site)}`;
  },
  async fetchBoard(b, opts) {
    let url: string;
    try { url = this.feedUrl(b); } catch (e) { return { postings: [], errors: [(e as Error).message], complete: false }; }
    const g = await getFeed(url, opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data)) return { postings: [], errors: [error ?? 'not a jobs list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach(data as any[], (j) => {
      const locs = (j.jobLocations ?? []) as any[];
      const s = j.salaryRange ?? {};
      const url = `${origin(b)}/careers/jobdetails/${enc(String(j.id))}`;
      return posting(b, {
        atsJobId: String(j.id), company: b.company ?? '', title: j.title, url, applyUrl: url,
        html: String(j.description ?? ''),
        place: { locations: locs.map((l) => [l.city || l.name, l.state, l.countryName].filter(Boolean).join(', ')), countries: locs.map((l) => l.countryCode || l.countryName), hints: [j.title] },
        employmentType: employmentType(j.employmentType), pay: pay(s.min ?? s.minSalary, s.max ?? s.maxSalary, s.currency, PERIOD[s.salaryPeriod]),
        postedAt: isoDate(j.publishedOn), updatedAt: isoDate(j.publishedOn), department: j.departmentName,
        raw: { jobNumber: j.jobNumber, jobType: j.jobType, experience: j.experience },
      });
    }, errors, (j) => `job ${j?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
