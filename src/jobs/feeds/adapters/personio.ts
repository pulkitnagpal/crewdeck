// Personio XML feed (public, documented for career-site integrations): GET {company}.jobs.personio.de/xml.
// Probed 2026-11-20 (Personio's own board: office, department, employmentType, schedule, createdAt; that board left
// jobDescriptions empty). Descriptions, when present, are <jobDescription><name/><value>CDATA html</value>.
import { unwrapCdata, xmlAll, xmlText } from '../html.ts';
import { employmentType, isoDate } from '../normalize.ts';
import type { Adapter, Board } from '../types.ts';
import { getFeed, hostLabel, mapEach, notFetched, posting, sinceFilter } from './common.ts';

const origin = (b: Board) => (b.host && b.host.includes('.') ? `https://${b.host}` : `https://${hostLabel(b.slug)}.jobs.personio.${b.host === 'com' ? 'com' : 'de'}`);

export const personio: Adapter = {
  ats: 'personio',
  status: 'verified',
  feedUrl: (b) => `${origin(b)}/xml`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts);
    if (!g.ok) return notFetched(g);
    if (!/<workzag-jobs\b/.test(g.body)) return { postings: [], errors: ['not a Personio jobs feed'], complete: false };
    const errors: string[] = [];
    const postings = mapEach(xmlAll(g.body, 'position'), (whole) => {
      // Top-level fields are read with the descriptions cut out (each description has its own <name>).
      const cut = whole.indexOf('<jobDescriptions'), end = whole.indexOf('</jobDescriptions>');
      const x = cut >= 0 && end > cut ? whole.slice(0, cut) + whole.slice(end + 18) : whole;
      const id = xmlText(x, 'id');
      const descs = xmlAll(whole, 'jobDescription').map((d) => {
        const name = xmlText(d, 'name'), value = unwrapCdata(xmlAll(d, 'value')[0] ?? '');
        return `${name ? `<h3>${name}</h3>` : ''}${value}`;
      });
      const offices = [xmlText(x, 'office'), ...xmlAll(xmlAll(x, 'additionalOffices')[0] ?? '', 'office').map(unwrapCdata)].filter(Boolean);
      const url = `${origin(b)}/job/${encodeURIComponent(id)}`;
      const schedule = xmlText(x, 'schedule');
      return posting(b, {
        atsJobId: id, company: b.company ?? (xmlText(x, 'subcompany') || ''), title: xmlText(x, 'name'), url, applyUrl: `${url}#apply`,
        html: descs.join(''),
        place: { locations: offices, hints: [xmlText(x, 'name')] },
        employmentType: employmentType(/part/i.test(schedule) ? schedule : '', xmlText(x, 'employmentType'), schedule),
        postedAt: isoDate(xmlText(x, 'createdAt')), updatedAt: isoDate(xmlText(x, 'createdAt')), department: xmlText(x, 'department') || undefined,
        raw: { seniority: xmlText(x, 'seniority'), schedule, occupation: xmlText(x, 'occupation'), occupationCategory: xmlText(x, 'occupationCategory'), recruitingCategory: xmlText(x, 'recruitingCategory') },
      });
    }, errors, (x) => `position ${xmlText(x, 'id')}`);
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: true };
  },
};
