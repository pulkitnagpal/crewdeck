// Zoho Recruit careers page: GET {company}.zohorecruit.{com|in|eu}/jobs/Careers. UNVERIFIED (not probed): Zoho has
// no public jobs API, so this reads what the page embeds — schema.org JobPosting JSON-LD, and the jobs list Zoho
// puts in a hidden input (id="jobs", HTML-escaped JSON with Posting_Title, City, State, Country, Remote_Job,
// Job_Type, Date_Opened, Job_Description, id). `host` picks the data centre: 'in', 'eu', 'com.au' or a full host.
import { decodeEntities } from '../html.ts';
import { countryCode, employmentType, isoDate } from '../normalize.ts';
import { placeName } from '../../places.ts';
import type { Adapter, Board, Posting } from '../types.ts';
import { getFeed, hostLabel, mapEach, notFetched, posting, sinceFilter } from './common.ts';
import { elements } from '../../text.ts';

const origin = (b: Board) => {
  const h = String(b.host ?? '');
  if (h.includes('.zohorecruit.')) return `https://${h}`;
  return `https://${hostLabel(b.slug)}.zohorecruit.${['in', 'eu', 'com.au', 'jp', 'com.cn'].includes(h) ? h : 'com'}`;
};

/** JobPosting objects in JSON-LD scripts (also inside @graph or arrays). */
export function jsonLdJobs(html: string): any[] {
  const out: any[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const t = v['@type'];
    if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) out.push(v);
    if (v['@graph']) walk(v['@graph']);
  };
  for (const e of elements(html, 'script')) {
    if (!/application\/ld\+json/i.test(e.tag)) continue;
    try { walk(JSON.parse(e.inner.trim())); } catch { /* a broken block is skipped */ }
  }
  return out;
}

function hiddenJobs(html: string): any[] {
  const m = /<input\b[^>]{0,200}\bid=["']jobs["'][^>]{0,200}\bvalue=["']([^"']{0,5000000})["']/i.exec(html.slice(0, 6_000_000));
  if (!m) return [];
  try { const v = JSON.parse(decodeEntities(m[1])); return Array.isArray(v) ? v : []; } catch { return []; }
}

const ldPlace = (j: any): { text: string; country: string }[] =>
  [].concat(j.jobLocation ?? []).map((l: any) => {
    const a = l?.address ?? {};
    const country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry?.name ?? '';
    // "Pune, IN" would read as Indiana: write the country's name in the location text.
    const name = /^[A-Za-z]{2}$/.test(country) && countryCode(country) ? placeName(country.toLowerCase()) : country;
    return { text: [a.addressLocality, a.addressRegion, name].filter(Boolean).join(', '), country };
  });

export const zoho: Adapter = {
  ats: 'zoho',
  status: 'unverified',
  feedUrl: (b) => `${origin(b)}/jobs/Careers`,
  async fetchBoard(b, opts) {
    const g = await getFeed(this.feedUrl(b), opts, { headers: { accept: 'text/html' } });
    if (!g.ok) return notFetched(g);
    const errors: string[] = [];
    let postings: Posting[] = [];
    const hidden = hiddenJobs(g.body);
    if (hidden.length) {
      postings = mapEach(hidden.filter((j) => j?.Publish !== false), (j) => {
        const url = `${origin(b)}/jobs/Careers/${encodeURIComponent(String(j.id))}`;
        const loc = [j.City, j.State, j.Country].filter(Boolean).join(', ');
        return posting(b, {
          atsJobId: String(j.id), company: b.company ?? j.Client_Name ?? '', title: j.Posting_Title || j.Job_Opening_Name, url, applyUrl: `${url}?source=CareerSite`,
          html: String(j.Job_Description ?? ''),
          place: { locations: [loc], countries: [j.Country], remote: j.Remote_Job === true ? true : null, hints: [j.Posting_Title] },
          employmentType: employmentType(j.Job_Type), postedAt: isoDate(j.Date_Opened), updatedAt: isoDate(j.Date_Opened), department: j.Industry,
          raw: { Job_Type: j.Job_Type, Work_Experience: j.Work_Experience },
        });
      }, errors, (j) => `job ${j?.id}`);
    } else {
      postings = mapEach(jsonLdJobs(g.body), (j) => {
        const places = ldPlace(j);
        const url = String(j.url ?? '');
        return posting(b, {
          atsJobId: String(j.identifier?.value ?? j.identifier ?? url), company: b.company ?? j.hiringOrganization?.name ?? '', title: j.title, url,
          html: String(j.description ?? ''),
          place: { locations: places.map((p) => p.text), countries: places.map((p) => p.country), workplace: j.jobLocationType === 'TELECOMMUTE' ? 'remote' : undefined },
          employmentType: employmentType(...[].concat(j.employmentType ?? [])), postedAt: isoDate(j.datePosted), updatedAt: isoDate(j.datePosted),
          closesAt: isoDate(j.validThrough) || undefined, raw: {},
        });
      }, errors, (j) => `job ${j?.title}`);
    }
    if (!postings.length && !errors.length) errors.push('no jobs found on the careers page (layout unverified)');
    return { postings: sinceFilter(postings, opts.since), etag: g.etag, errors, complete: postings.length > 0 };
  },
};
