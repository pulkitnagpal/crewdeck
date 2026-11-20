// Workable careers widget (public, documented for embedding): GET apply.workable.com/api/v1/widget/accounts/{account}?details=true.
// Account name, telecommuting flag, structured locations with ISO-2 countryCode (probed 2026-11-20).
import { employmentType, isoDate } from '../normalize.ts';
import type { Adapter } from '../types.ts';
import { enc, getFeed, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

export const workable: Adapter = {
  ats: 'workable',
  status: 'verified',
  feedUrl: (b) => `https://apply.workable.com/api/v1/widget/accounts/${enc(b.slug)}?details=true`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data?.jobs)) return { postings: [], errors: [error ?? 'no jobs list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach(data.jobs as any[], (j) => {
      const locs = (j.locations?.length ? j.locations : [{ city: j.city, region: j.state, country: j.country }]) as any[];
      const text = (l: any) => [l?.city, l?.region, l?.country].filter(Boolean).join(', ');
      return posting(b, {
        atsJobId: String(j.shortcode), company: data.name ?? '', title: j.title, url: j.url || j.shortlink, applyUrl: j.application_url,
        html: [j.description, j.requirements, j.benefits].filter(Boolean).join(''),
        place: { locations: locs.map(text), countries: locs.map((l) => l?.countryCode || l?.country), remote: j.telecommuting === true ? true : null, hints: [j.title] },
        employmentType: employmentType(j.employment_type), postedAt: isoDate(j.published_on || j.created_at), updatedAt: isoDate(j.published_on || j.created_at),
        department: j.department,
        raw: { function: j.function, industry: j.industry, experience: j.experience, telecommuting: j.telecommuting },
      });
    }, errors, (j) => `job ${j?.shortcode}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
