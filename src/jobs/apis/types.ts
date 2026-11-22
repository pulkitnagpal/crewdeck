// Official and public job APIs (design §4.1 item 4, §11, §14 P2): one contract for every provider.
// `ApiPosting` mirrors the feeds' `Posting` (src/jobs/feeds/types.ts) field for field, so the two merge without a mapper.

export type Workplace = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type PayPeriod = 'year' | 'month' | 'week' | 'day' | 'hour';

export type ApiPosting = {
  /** 'api' for every posting from this folder (the feeds use their ATS kind) */
  source: string;
  /** the provider id ("adzuna", "nhs-jobs", …): with sourceJobId, the posting's identity */
  sourceKey: string;
  sourceJobId: string;
  company: string;
  title: string;
  /** the posting page (on the provider's site: attribution) */
  url: string;
  /** where to apply (the provider's link when its terms ask for it) */
  applyUrl: string;
  /** plain text; may be a provider's snippet only (the description fetcher fills the rest) */
  descriptionText: string;
  locations: string[];
  workplace: Workplace;
  /** ISO-2 (upper case) where a remote role may be done from; ['*'] anywhere; [] unknown or not remote */
  remoteCountries: string[];
  /** ISO-2 countries of the locations */
  countries: string[];
  employmentType: string;
  pay?: { min: number | null; max: number | null; currency: string | null; period: PayPeriod | null };
  /** ISO 8601 */
  postedAt: string;
  updatedAt?: string;
  closesAt?: string;
  attribution?: { text: string; url: string };
};

export type ApiQuery = {
  /** alternates of one target ("Staff nurse", "Registered nurse"); adapters query at most MAX_TITLES of them */
  titles: string[];
  /** ISO-2 */
  country: string;
  places?: string[];
  remote?: boolean;
  daysBack?: number;
  /** 1-based */
  page?: number;
};

export type ApiRequest = { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string };
export type ApiResponse = { status: number; url: string; headers: Record<string, string | string[] | undefined>; body: string };
/** The only way an adapter reaches the network: netguard underneath, paced, timed out and retried by the runner. */
export type ApiFetch = (req: ApiRequest) => Promise<ApiResponse>;
export type KeyReader = { get(provider: string): string | undefined };
export type ApiCtx = { keys: KeyReader; fetch: ApiFetch; signal?: AbortSignal };
export type ApiResult = { postings: ApiPosting[]; next?: number; errors: string[] };

export type Provider = {
  id: string;
  name: string;
  /** ISO-2 country codes it covers; ['*'] = any (remote boards, global aggregators) */
  countries: string[];
  /** occupation families it is good for: 'any', or a list ('health', 'teaching', 'software', 'public-sector', …) */
  fields: 'any' | string[];
  /** a per-user key the person gets themselves (never shipped); `format` says what `keys set` expects */
  needsKey?: { signupUrl: string; format: string };
  attribution?: { text: string; url: string; rule: string };
  terms: string;
  /** spacing between requests, and a cap per run where the provider asks for few calls */
  rateLimit: { minIntervalMs: number; maxPerRun?: number; note: string };
  /** 'verified' = a real response recorded for its fixture; 'unverified' = fixture written from the published docs */
  fixture: 'verified' | 'unverified';
  /** an endpoint the provider uses but does not document for third parties */
  undocumented?: boolean;
  search(query: ApiQuery, ctx: ApiCtx): Promise<ApiResult>;
};

export const MAX_TITLES = 3;

/** An HTTP answer an adapter can't use; the message never holds a key (URLs are redacted). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
}
