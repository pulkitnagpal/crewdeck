// Shared adapter plumbing: conditional GET, status/JSON errors, the `since` filter and a Posting builder.
import { errText, header } from '../http.ts';
import { htmlToText } from '../html.ts';
import { type PlaceFacts, normalisePlace } from '../normalize.ts';
import { type Board, type FeedRequest, type FetchBoardOptions, type FetchBoardResult, type Posting, boardKey } from '../types.ts';

export type Got = { ok: true; body: string; etag?: string } | { ok: false; notModified?: true; etag?: string; error?: string };

/** GET (or POST) one feed URL with If-None-Match; 304 → notModified; other non-2xx → an error line. */
export async function getFeed(url: string, opts: FetchBoardOptions, req: Partial<FeedRequest> = {}): Promise<Got> {
  const headers: Record<string, string> = { ...req.headers };
  if (opts.etag) headers['if-none-match'] = opts.etag;
  try {
    const r = await opts.fetch({ url, method: req.method, body: req.body, headers }, opts.signal);
    const etag = header(r.headers, 'etag');
    if (r.status === 304) return { ok: false, notModified: true, etag: etag ?? opts.etag };
    if (r.status < 200 || r.status > 299) return { ok: false, error: `${new URL(url).host} answered ${r.status}${r.status === 404 ? ' (not found)' : ''}` };
    return { ok: true, body: r.body, etag };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export function parseJson(body: string): { data?: any; error?: string } {
  try { return { data: JSON.parse(body) }; } catch (e) { return { error: `not JSON (${(e as Error).message.slice(0, 80)})` }; }
}

/** The result for a failed or unchanged fetch. */
export function notFetched(g: Exclude<Got, { ok: true }>): FetchBoardResult {
  return g.notModified ? { postings: [], etag: g.etag, notModified: true, errors: [], complete: true } : { postings: [], errors: [g.error ?? 'failed'], complete: false };
}

/** Drop postings older than `since` (when the caller asked) — closed detection is then off. */
export function sinceFilter(ps: Posting[], since?: string): Posting[] {
  if (!since) return ps;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return ps;
  return ps.filter((p) => { const d = Date.parse(p.updatedAt || p.postedAt); return !Number.isFinite(d) || d >= t; });
}

export type PostingIn = Omit<Posting, 'source' | 'ats' | 'board' | 'descriptionText' | 'locations' | 'countries' | 'workplace' | 'remoteCountries' | 'applyUrl'> & {
  applyUrl?: string; place: PlaceFacts; html?: string; text?: string;
};

/** Build a Posting: description text from HTML (or given text), place facts normalised, strings trimmed. */
export function posting(board: Board, p: PostingIn): Posting {
  const where = normalisePlace(p.place);
  const html = p.html && p.html.trim() ? p.html : undefined;
  const text = p.text?.trim() || (html ? htmlToText(html) : '');
  const out: Posting = {
    source: 'ats', ats: board.ats, board: boardKey(board), atsJobId: String(p.atsJobId), company: (p.company || board.company || board.slug).trim(),
    title: String(p.title ?? '').replace(/\s+/g, ' ').trim(), url: p.url, applyUrl: p.applyUrl || p.url,
    descriptionText: text, ...(html ? { descriptionHtml: html } : {}),
    ...where, employmentType: p.employmentType, postedAt: p.postedAt, updatedAt: p.updatedAt || p.postedAt,
    raw: p.raw,
  };
  if (p.pay) out.pay = p.pay;
  if (p.closesAt) out.closesAt = p.closesAt;
  if (p.department) out.department = String(p.department).trim();
  if (p.partial) out.partial = true;
  return out;
}

/** Run a per-item mapper, turning a throw into an error line instead of losing the board. */
export function mapEach<T>(items: T[], f: (x: T) => Posting | null, errors: string[], label: (x: T) => string): Posting[] {
  const out: Posting[] = [];
  for (const x of items) {
    try { const p = f(x); if (p && p.title && p.url) out.push(p); }
    catch (e) { errors.push(`${label(x)}: ${(e as Error).message}`); }
  }
  return out;
}

export const enc = encodeURIComponent;
/** A slug safe in a host name label. */
export function hostLabel(slug: string): string {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) throw new Error(`"${slug}" is not a valid board name`);
  return s;
}
