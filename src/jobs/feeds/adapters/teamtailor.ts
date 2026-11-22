// Teamtailor RSS (public, documented): GET {company}.teamtailor.com/jobs.rss (or the company's career domain in
// `host`). Probed 2026-11-20: <remoteStatus> (none/hybrid/fully/temporary), <tt:locations> with city and country,
// <tt:department>, the description as escaped HTML, ETag.
import { xmlAll, xmlText } from '../html.ts';
import { isoDate } from '../normalize.ts';
import type { Adapter, Board } from '../types.ts';
import { getFeed, hostLabel, mapEach, notFetched, posting, sinceFilter } from './common.ts';

const origin = (b: Board) => (b.host && b.host.includes('.') ? `https://${b.host}` : `https://${hostLabel(b.slug)}.teamtailor.com`);

export const teamtailor: Adapter = {
  ats: 'teamtailor',
  status: 'verified',
  feedUrl: (b) => `${origin(b)}/jobs.rss`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    if (!/<rss\b/.test(g.body)) return { postings: [], errors: ['not an RSS feed'], complete: false };
    const channel = xmlAll(g.body, 'channel')[0] ?? '';
    const company = b.company ?? xmlText(channel.split('<item>')[0], 'title');
    const errors: string[] = [];
    const postings = mapEach(xmlAll(g.body, 'item'), (x) => {
      const locs = xmlAll(x, 'tt:location').map((l) => ({ name: xmlText(l, 'tt:name'), city: xmlText(l, 'tt:city'), country: xmlText(l, 'tt:country') }));
      const link = xmlText(x, 'link');
      return posting(b, {
        atsJobId: xmlText(x, 'guid') || link, company, title: xmlText(x, 'title'), url: link, applyUrl: link,
        html: xmlText(x, 'description'),
        place: { locations: locs.map((l) => [l.city || l.name, l.country].filter(Boolean).join(', ')), countries: locs.map((l) => l.country), workplace: xmlText(x, 'remoteStatus'), hints: [xmlText(x, 'title')] },
        employmentType: '', postedAt: isoDate(xmlText(x, 'pubDate')), updatedAt: isoDate(xmlText(x, 'pubDate')),
        department: xmlText(x, 'tt:department') || undefined,
        raw: { remoteStatus: xmlText(x, 'remoteStatus'), role: xmlText(x, 'tt:role'), division: xmlText(x, 'tt:division') },
      });
    }, errors, (x) => `item ${xmlText(x, 'guid')}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
