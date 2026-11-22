// Recruitee careers site API (public, documented): GET {company}.recruitee.com/api/offers/.
// remote/hybrid/on_site flags, structured locations with country_code, salary, close_at (probed 2026-11-20).
import { employmentType, isoDate, pay } from '../normalize.ts';
import type { Adapter } from '../types.ts';
import { getFeed, hostLabel, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

export const recruitee: Adapter = {
  ats: 'recruitee',
  status: 'verified',
  feedUrl: (b) => `https://${hostLabel(b.slug)}.recruitee.com/api/offers/`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data?.offers)) return { postings: [], errors: [error ?? 'no offers list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach((data.offers as any[]).filter((o) => !o?.status || o.status === 'published'), (o) => {
      const locs = (o.locations ?? []) as any[];
      const s = o.salary ?? {};
      return posting(b, {
        atsJobId: String(o.id), company: o.company_name ?? '', title: o.title, url: o.careers_url, applyUrl: o.careers_apply_url,
        html: [o.description, o.requirements].filter(Boolean).join(''),
        place: {
          locations: locs.length ? locs.map((l) => [l.city, l.country].filter(Boolean).join(', ')) : [o.location],
          countries: [...locs.map((l) => l.country_code), o.country_code], remote: o.remote === true ? true : null, hybrid: o.hybrid === true ? true : null,
          onsite: o.on_site === true ? true : null, hints: [o.location],
        },
        employmentType: employmentType(o.employment_type_code), pay: pay(s.min, s.max, s.currency, s.period),
        postedAt: isoDate(o.published_at || o.created_at), updatedAt: isoDate(o.updated_at), closesAt: isoDate(o.close_at) || undefined,
        department: o.department,
        raw: { slug: o.slug, category_code: o.category_code, experience_code: o.experience_code, min_hours: o.min_hours, max_hours: o.max_hours },
      });
    }, errors, (o) => `offer ${o?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
