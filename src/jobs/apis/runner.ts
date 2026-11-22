// Runs a plan of API searches: providers in parallel (different hosts), each provider's requests one at a time with its
// documented spacing; every request through netguard with a 20 s deadline (design §8.1), 2 retries on 5xx and network
// errors, back-off on 429 (Retry-After when given). A provider without its key is "needs key", never an error; one
// provider failing never stops another (§4.2 availability). Every log line and error is redacted.
import { type FetchOptions, type Fetched, NetError, guardedFetch } from '../net/netguard.ts';
import { redact } from './keys.ts';
import { covers, provider as lookup } from './registry.ts';
import { type ApiFetch, type ApiPosting, type ApiQuery, type KeyReader, type Provider } from './types.ts';

export const API_TIMEOUT_MS = 20_000;
export const API_MAX_BYTES = 10_000_000;
export const RETRIES = 2;
const MAX_BACKOFF_MS = 60_000;

export type Transport = (url: string, opts: FetchOptions) => Promise<Fetched>;
export type PlanEntry = { provider: string; query: ApiQuery };
export type RunOptions = {
  keys: KeyReader & { secrets?(): string[] };
  /** guardedFetch unless a test injects one */
  transport?: Transport;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** test seams */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  providers?: (id: string) => Provider | undefined;
};
export type ProviderStatus = 'ok' | 'partial' | 'error' | 'needs_key' | 'skipped';
export type ProviderStats = {
  provider: string; name: string; status: ProviderStatus;
  searches: number; requests: number; retries: number; rateLimited: number; postings: number; bytes: number; ms: number;
  errors: string[]; note?: string;
};
export type EntryResult = { provider: string; query: ApiQuery; postings: number; next?: number; errors: string[]; status: ProviderStatus };
export type RunResult = { postings: ApiPosting[]; stats: ProviderStats[]; entries: EntryResult[] };

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Retry-After in ms (seconds or an HTTP date), else undefined. */
export function retryAfterMs(v: unknown, now = Date.now()): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(String(s));
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

class BudgetError extends Error { name = 'BudgetError'; }

export async function runApis(plan: PlanEntry[], o: RunOptions): Promise<RunResult> {
  const transport = o.transport ?? guardedFetch;
  const sleep = o.sleep ?? defaultSleep;
  const now = o.now ?? Date.now;
  const find = o.providers ?? lookup;
  const secrets = () => o.keys.secrets?.() ?? [];
  const log = (line: string) => o.log?.(redact(line, secrets()));
  const clean = (e: unknown) => redact(e instanceof Error ? e.message : String(e), secrets());

  const groups = new Map<string, PlanEntry[]>();
  for (const e of plan) groups.set(e.provider, [...(groups.get(e.provider) ?? []), e]);
  const entries: EntryResult[] = [];
  const postings: ApiPosting[] = [];
  const seen = new Set<string>();

  const runProvider = async (id: string, list: PlanEntry[]): Promise<ProviderStats> => {
    const p = find(id);
    const st: ProviderStats = { provider: id, name: p?.name ?? id, status: 'ok', searches: 0, requests: 0, retries: 0, rateLimited: 0, postings: 0, bytes: 0, ms: 0, errors: [] };
    const t0 = now();
    if (!p) { st.status = 'error'; st.errors.push(`unknown provider "${id}"`); return st; }
    if (p.needsKey && !o.keys.get(id)) {
      st.status = 'needs_key';
      st.note = `needs your own free key: get one at ${p.needsKey.signupUrl}, then run crewdeck jobs keys set ${id}`;
      for (const e of list) entries.push({ provider: id, query: e.query, postings: 0, errors: [], status: 'needs_key' });
      log(`${id}: skipped, no key`);
      return st;
    }

    let last = -Infinity;
    const fetch: ApiFetch = async (req) => {
      for (let attempt = 0; ; attempt++) {
        if (o.signal?.aborted) throw new NetError('timeout', 'the run was stopped');
        if (p.rateLimit.maxPerRun !== undefined && st.requests >= p.rateLimit.maxPerRun) throw new BudgetError(`stopped at ${p.rateLimit.maxPerRun} requests this run (${p.rateLimit.note})`);
        const wait = last + p.rateLimit.minIntervalMs - now();
        if (wait > 0) await sleep(wait, o.signal);
        last = now();
        st.requests++;
        let r: Fetched;
        try {
          r = await transport(req.url, {
            method: req.method ?? 'GET', headers: req.headers, body: req.body === undefined ? undefined : Buffer.from(req.body),
            timeoutMs: o.timeoutMs ?? API_TIMEOUT_MS, maxBytes: API_MAX_BYTES,
          });
        } catch (e: any) {
          const retryable = e instanceof NetError && (e.code === 'network' || e.code === 'timeout') && !o.signal?.aborted;
          log(`${id}: ${req.method ?? 'GET'} ${req.url} failed: ${e?.message ?? e}${retryable && attempt < RETRIES ? ' (retrying)' : ''}`);
          if (retryable && attempt < RETRIES) { st.retries++; await sleep(1000 * 2 ** attempt, o.signal); continue; }
          throw new Error(clean(e));
        }
        st.bytes += r.bytes?.length ?? Buffer.byteLength(r.body);
        log(`${id}: ${req.method ?? 'GET'} ${req.url} → ${r.status}`);
        if (r.status >= 500 && attempt < RETRIES) { st.retries++; await sleep(1000 * 2 ** attempt, o.signal); continue; }
        if (r.status === 429) {
          st.rateLimited++;
          if (attempt < RETRIES) {
            st.retries++;
            const ms = Math.min(MAX_BACKOFF_MS, retryAfterMs(r.headers['retry-after'], now()) ?? 5000 * 2 ** attempt);
            log(`${id}: rate limited, waiting ${Math.round(ms / 1000)} s`);
            await sleep(ms, o.signal);
            last = now();
            continue;
          }
        }
        return { status: r.status, url: r.url, headers: r.headers as Record<string, string | string[] | undefined>, body: r.body };
      }
    };

    for (const e of list) {
      if (o.signal?.aborted) break;
      if (!covers(p, e.query.country)) {
        entries.push({ provider: id, query: e.query, postings: 0, errors: [], status: 'skipped' });
        st.note = `covers ${p.countries.join(', ')} only`;
        continue;
      }
      st.searches++;
      let errs: string[] = [], got: ApiPosting[] = [], next: number | undefined;
      try {
        const r = await p.search(e.query, { keys: o.keys, fetch, signal: o.signal });
        got = r.postings; next = r.next; errs = r.errors.map((x) => redact(x, secrets()));
      } catch (err) {
        errs = [clean(err)];
      }
      for (const x of got) {
        const k = `${x.sourceKey}\u0000${x.sourceJobId}`;
        if (seen.has(k)) continue;
        seen.add(k); postings.push(x); st.postings++;
      }
      st.errors.push(...errs);
      entries.push({ provider: id, query: e.query, postings: got.length, next, errors: errs, status: errs.length ? (got.length ? 'partial' : 'error') : 'ok' });
    }
    st.ms = now() - t0;
    const mine = entries.filter((x) => x.provider === id);
    if (mine.length && mine.every((x) => x.status === 'skipped')) st.status = 'skipped';
    else if (st.errors.length) st.status = st.postings ? 'partial' : 'error';
    return st;
  };

  const stats = await Promise.all([...groups].map(([id, list]) => runProvider(id, list).catch((e) => ({
    provider: id, name: id, status: 'error' as const, searches: 0, requests: 0, retries: 0, rateLimited: 0, postings: 0, bytes: 0, ms: 0, errors: [clean(e)],
  }))));
  return { postings, stats, entries };
}
