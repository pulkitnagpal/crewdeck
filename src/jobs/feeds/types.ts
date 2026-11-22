// Company job-board (ATS) feeds: the common adapter contract (design jobs-v2 §7.2 "Fetch engine", ADR-0002).
// Every adapter reads one company's public board and returns normalised postings; nothing here writes the database
// (see store.ts) and nothing fetches except through the FeedFetch it is given (netguard + politeness, http.ts).

export const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'personio', 'teamtailor', 'breezy', 'workday', 'keka', 'zoho'] as const;
export type Ats = (typeof ATS_KINDS)[number];

/**
 * One company's board. `slug` is the board token (Greenhouse board, Lever site, Ashby org, Workable account, the
 * Recruitee/Personio/Teamtailor/Breezy/Keka/Zoho subdomain, the Workday tenant). `host` overrides the API host
 * (Lever/Greenhouse EU: "eu"; Workday: "wd5" or the full "acme.wd5.myworkdayjobs.com"; a Teamtailor custom domain).
 * `site` is the Workday career site ("External") or the Keka portal id. `company` is the display name when the feed
 * does not carry one.
 */
export type Board = { ats: Ats; slug: string; host?: string; site?: string; company?: string };

export type Workplace = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'temporary' | 'internship' | 'other' | '';
export type PayPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';
export type Pay = { min: number | null; max: number | null; currency: string; period: PayPeriod | null };

export type Posting = {
  source: 'ats';
  ats: Ats;
  /** the board's key, `ats:slug[:site]` (boardKey) */
  board: string;
  atsJobId: string;
  company: string;
  title: string;
  url: string;
  applyUrl: string;
  /** the full description as plain text (paragraphs kept as line breaks), never clipped */
  descriptionText: string;
  descriptionHtml?: string;
  /** location strings as the board wrote them */
  locations: string[];
  workplace: Workplace;
  /** ISO-2 (upper case) countries a remote role may be done from: [] = unknown, ['*'] = anywhere */
  remoteCountries: string[];
  /** ISO-2 countries the role's locations are in */
  countries: string[];
  employmentType: EmploymentType;
  pay?: Pay;
  /** ISO timestamps; '' when the board does not say */
  postedAt: string;
  updatedAt: string;
  closesAt?: string;
  department?: string;
  /** a few source fields kept for debugging and future mapping (never the whole response) */
  raw: Record<string, unknown>;
  /** Workday: a posting already known whose detail was not fetched again (only last-seen is updated) */
  partial?: boolean;
};

export type FeedRequest = { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string };
export type FeedResponse = { status: number; url: string; headers: Record<string, string | string[] | undefined>; body: string };
/** The only way an adapter reaches the network (http.ts: netguard underneath, politeness around it). */
export type FeedFetch = (req: FeedRequest, signal?: AbortSignal) => Promise<FeedResponse>;

export type FetchBoardOptions = {
  /** the ETag from the last good fetch: sent as If-None-Match */
  etag?: string;
  /** drop postings last updated (or posted) before this ISO time */
  since?: string;
  signal?: AbortSignal;
  fetch: FeedFetch;
  /** atsJobIds already stored for this board (Workday fetches details only for new ones) */
  known?: ReadonlySet<string>;
  /** the time "now" (Workday's "Posted 3 Days Ago"); default Date.now() */
  now?: number;
  /** Workday: at most this many detail fetches per run (default 200) */
  maxDetails?: number;
};

export type FetchBoardResult = {
  postings: Posting[];
  etag?: string;
  /** the board answered 304: nothing changed since `etag` */
  notModified?: boolean;
  /** problems that did not stop the board (a bad posting, a failed detail page) or that did (status, network) */
  errors: string[];
  /** false when the list may be incomplete (paging stopped early, errors): closed-posting detection is skipped */
  complete?: boolean;
};

/** How sure we are of an adapter's request and response shape. */
export type AdapterStatus = 'verified' | 'undocumented' | 'unverified';

export type Adapter = {
  ats: Ats;
  /** verified = probed live and documented; undocumented = probed, but the endpoint is not a public API; unverified = from docs only */
  status: AdapterStatus;
  /** the board's main feed URL (robots check, logs) */
  feedUrl(board: Board): string;
  fetchBoard(board: Board, opts: FetchBoardOptions): Promise<FetchBoardResult>;
};

export const boardKey = (b: Board) => [b.ats, b.slug.toLowerCase(), ...(b.site ? [b.site] : [])].join(':');
