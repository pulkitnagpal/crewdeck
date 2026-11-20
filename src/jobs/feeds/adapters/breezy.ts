// Breezy HR careers JSON: GET {company}.breezy.hr/json. UNVERIFIED: the one probe (2026-11-20) hit a company that
// had left Breezy (404), so the shape below follows Breezy's published portal JSON (id, friendly_id, name, url,
// published_date, type, location{country,state,city,is_remote}, department, salary). The list has no descriptions:
// descriptionText stays empty until the description fetcher reads the posting page.
import { employmentType, isoDate } from '../normalize.ts';
import type { Adapter } from '../types.ts';
import { getFeed, hostLabel, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

export const breezy: Adapter = {
  ats: 'breezy',
  status: 'unverified',
  feedUrl: (b) => `https://${hostLabel(b.slug)}.breezy.hr/json`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data)) return { postings: [], errors: [error ?? 'not a positions list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach(data as any[], (j) => {
      const l = j.location ?? {};
      const name = l.name || [l.city, l.state?.name, l.country?.name].filter(Boolean).join(', ');
      const url = j.url || `https://${hostLabel(b.slug)}.breezy.hr/p/${j.friendly_id ?? j.id}`;
      return posting(b, {
        atsJobId: String(j.id ?? j.friendly_id), company: j.company?.name ?? '', title: j.name, url, applyUrl: `${url.replace(/\/$/, '')}/apply`,
        html: String(j.description ?? ''),
        place: { locations: [name, ...(j.locations ?? []).map((x: any) => x?.name)], countries: [l.country?.id, l.country?.name], remote: l.is_remote === true ? true : null },
        employmentType: employmentType(j.type?.name ?? j.type?.id), postedAt: isoDate(j.published_date), updatedAt: isoDate(j.published_date),
        department: j.department,
        raw: { friendly_id: j.friendly_id, salary: j.salary, type: j.type?.id },
      });
    }, errors, (j) => `position ${j?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
