// Greenhouse Job Board API (public, documented): GET boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true.
// ETag/If-None-Match → 304 (probed 2026-11-20 on a large public board). `content` is HTML escaped once more.
import { decodeEntities } from '../html.ts';
import { employmentType, isoDate } from '../normalize.ts';
import type { Adapter, Board } from '../types.ts';
import { enc, getFeed, mapEach, notFetched, parseJson, posting, sinceFilter } from './common.ts';

const apiHost = (b: Board) => (b.host === 'eu' ? 'boards-api.eu.greenhouse.io' : b.host && b.host.includes('.') ? b.host : 'boards-api.greenhouse.io');
const meta = (j: any, name: RegExp) => (Array.isArray(j.metadata) ? j.metadata.find((m: any) => name.test(String(m?.name ?? '')))?.value : undefined);

export const greenhouse: Adapter = {
  ats: 'greenhouse',
  status: 'verified',
  feedUrl: (b) => `https://${apiHost(b)}/v1/boards/${enc(b.slug)}/jobs?content=true`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    const { data, error } = parseJson(g.body);
    if (error || !Array.isArray(data?.jobs)) return { postings: [], errors: [error ?? 'no jobs list'], complete: false };
    const errors: string[] = [];
    const postings = mapEach(data.jobs as any[], (j) => {
      const offices = (j.offices ?? []).map((o: any) => o?.location || o?.name).filter(Boolean);
      const wp = meta(j, /workplace|remote/i);
      return posting(b, {
        atsJobId: String(j.id), company: j.company_name ?? '', title: j.title, url: j.absolute_url,
        html: decodeEntities(String(j.content ?? '')), // escaped once more than HTML
        place: { locations: [j.location?.name, ...offices], workplace: typeof wp === 'string' ? wp : undefined },
        employmentType: employmentType(meta(j, /employment|job type|commitment/i)),
        postedAt: isoDate(j.first_published), updatedAt: isoDate(j.updated_at),
        closesAt: isoDate(j.application_deadline) || undefined,
        department: j.departments?.[0]?.name,
        raw: { internal_job_id: j.internal_job_id, requisition_id: j.requisition_id, language: j.language },
      });
    }, errors, (j) => `job ${j?.id}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
