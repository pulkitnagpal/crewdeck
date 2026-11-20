// Lever Postings API (public, documented): GET api.lever.co/v0/postings/{site}?mode=json (EU: api.eu.lever.co).
// ETag → 304 (probed 2026-11-20). Structured workplaceType (remote/hybrid/onsite/unspecified) and country (ISO-2).
import { employmentType, isoDate, pay } from '../normalize.ts';
import type { Adapter, Board } from '../types.ts';
import { enc, getFeed, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

const apiHost = (b: Board) => (b.host === 'eu' ? 'api.eu.lever.co' : b.host && b.host.includes('.') ? b.host : 'api.lever.co');

export const lever: Adapter = {
  ats: 'lever',
  status: 'verified',
  feedUrl: (b) => `https://${apiHost(b)}/v0/postings/${enc(b.slug)}?mode=json`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data)) return { postings: [], errors: [error ?? (data?.message ? String(data.message) : 'not a postings list')], complete: false };
    const errors: string[] = [];
    const postings = mapEach(data as any[], (j) => {
      const c = j.categories ?? {};
      const lists = (j.lists ?? []).map((l: any) => `<h3>${l.text ?? ''}</h3><ul>${l.content ?? ''}</ul>`).join('');
      const html = `${j.description ?? ''}${lists}${j.additional ?? ''}`;
      const s = j.salaryRange;
      return posting(b, {
        atsJobId: String(j.id), company: b.company ?? '', title: j.text, url: j.hostedUrl, applyUrl: j.applyUrl,
        html,
        place: { locations: c.allLocations?.length ? c.allLocations : [c.location], countries: j.country ? [j.country] : [], workplace: j.workplaceType },
        employmentType: employmentType(c.commitment), pay: s ? pay(s.min, s.max, s.currency, s.interval) : undefined,
        postedAt: isoDate(j.createdAt), updatedAt: isoDate(j.updatedAt ?? j.createdAt), department: c.department ?? c.team,
        raw: { team: c.team, commitment: c.commitment, workplaceType: j.workplaceType, country: j.country },
      });
    }, errors, (j) => `posting ${j?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
