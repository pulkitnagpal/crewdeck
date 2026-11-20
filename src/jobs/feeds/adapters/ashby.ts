// Ashby public posting API (documented): GET api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true.
// isRemote, workplaceType, secondaryLocations, postal addresses and compensation tiers (probed 2026-11-20).
import { employmentType, isoDate, pay } from '../normalize.ts';
import type { Adapter, Pay } from '../types.ts';
import { enc, getFeed, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

function salary(comp: any): Pay | undefined {
  const parts = [...(comp?.compensationTiers ?? []).flatMap((t: any) => t?.components ?? []), ...(comp?.summaryComponents ?? [])];
  const s = parts.find((c: any) => /salary/i.test(String(c?.compensationType ?? '')) && (c.minValue || c.maxValue));
  return s ? pay(s.minValue, s.maxValue, s.currencyCode, s.interval) : undefined;
}

export const ashby: Adapter = {
  ats: 'ashby',
  status: 'verified',
  feedUrl: (b) => `https://api.ashbyhq.com/posting-api/job-board/${enc(b.slug)}?includeCompensation=true`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data?.jobs)) return { postings: [], errors: [error ?? 'no jobs list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach((data.jobs as any[]).filter((j) => j?.isListed !== false), (j) => {
      const secondary = (j.secondaryLocations ?? []) as any[];
      const countries = [j.address?.postalAddress?.addressCountry, ...secondary.map((s) => s?.address?.postalAddress?.addressCountry)].filter(Boolean);
      return posting(b, {
        atsJobId: String(j.id), company: b.company ?? '', title: j.title, url: j.jobUrl, applyUrl: j.applyUrl,
        html: j.descriptionHtml ?? '', text: j.descriptionHtml ? undefined : j.descriptionPlain,
        place: { locations: [j.location, ...secondary.map((s) => s?.location)], countries, workplace: j.workplaceType, remote: j.workplaceType ? null : j.isRemote ?? null },
        employmentType: employmentType(j.employmentType), pay: salary(j.compensation),
        postedAt: isoDate(j.publishedAt), updatedAt: isoDate(j.updatedAt ?? j.publishedAt), department: j.department ?? j.team,
        raw: { team: j.team, isRemote: j.isRemote, workplaceType: j.workplaceType, compensation: j.compensation?.compensationTierSummary },
      });
    }, errors, (j) => `job ${j?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
