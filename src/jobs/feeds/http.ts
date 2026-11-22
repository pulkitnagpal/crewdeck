// Feed fetching: netguard underneath (SSRF rules, redirects checked, body capped), an honest User-Agent, and
// politeness around it — one request at a time per host, ≥ 1 s apart plus jitter, 15 s timeout, 2 retries on 5xx or
// timeout, and a per-host back-off on 429 (ADR-0002).
import { type NetOptions, NetError, guardedFetch } from '../net/netguard.ts';
import type { FeedFetch, FeedRequest, FeedResponse } from './types.ts';

export const FEED_USER_AGENT = 'Crewdeck/0.8 (+https://github.com/pulkitnagpal/crewdeck)';
export const FEED_TIMEOUT_MS = 15_000;
/** Whole boards with full descriptions are large (a big Ashby board is ~15 MB). */
export const FEED_MAX_BYTES = 40_000_000;

/** Time, injectable: tests drive pacing with a fake clock. */
export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return reject(new NetError('timeout', 'stopped'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new NetError('timeout', 'stopped')); };
    signal?.addEventListener('abort', stop, { once: true });
  }),
};

/** The plain guarded fetch for feeds (no pacing). */
export function guardFeedFetch(net: NetOptions = {}, o: { timeoutMs?: number; maxBytes?: number } = {}): FeedFetch {
  return async (req: FeedRequest, signal?: AbortSignal): Promise<FeedResponse> => {
    if (signal?.aborted) throw new NetError('timeout', 'stopped');
    const run = guardedFetch(req.url, {
      ...net, method: req.method ?? 'GET', body: req.body !== undefined ? Buffer.from(req.body) : undefined,
      timeoutMs: o.timeoutMs ?? FEED_TIMEOUT_MS, maxBytes: o.maxBytes ?? FEED_MAX_BYTES,
      headers: { 'user-agent': FEED_USER_AGENT, accept: 'application/json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5', ...req.headers },
    });
    const r = signal
      ? await Promise.race([run, new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new NetError('timeout', 'stopped')), { once: true }))])
      : await run;
    return { status: r.status, url: r.url, headers: r.headers as FeedResponse['headers'], body: r.body };
  };
}

export type PoliteOptions = {
  clock?: Clock;
  /** minimum gap between two requests to one host (default 1000 ms) */
  minIntervalMs?: number;
  /** extra random gap, 0..jitterMs (default 250 ms) */
  jitterMs?: number;
  /** retries on 5xx, timeouts and network errors (default 2) */
  retries?: number;
  /** first back-off after a 429 without Retry-After (default 30 s, doubling, ≤ 10 min) */
  backoffMs?: number;
  random?: () => number;
};

type HostState = { tail: Promise<unknown>; nextAt: number; strikes: number };

export const header = (h: FeedResponse['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v ?? undefined;
};

/** Seconds or an HTTP date in Retry-After → milliseconds from now. */
export function retryAfterMs(v: string | undefined, now: number): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * Wrap a FeedFetch with per-host politeness. Requests to one host run one after another; different hosts run in
 * parallel. Returns the last response after retries (a 5xx or 429 the caller then reports), or throws the last
 * network error.
 */
export function politeFetch(inner: FeedFetch, o: PoliteOptions = {}): FeedFetch & { hosts: Map<string, HostState> } {
  const clock = o.clock ?? realClock, gap = o.minIntervalMs ?? 1000, jitter = o.jitterMs ?? 250, retries = o.retries ?? 2;
  const base = o.backoffMs ?? 30_000, rnd = o.random ?? Math.random;
  const hosts = new Map<string, HostState>();

  const one = async (h: HostState, req: FeedRequest, signal?: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      const wait = h.nextAt - clock.now();
      if (wait > 0) await clock.sleep(wait, signal);
      h.nextAt = clock.now() + gap + Math.floor(rnd() * jitter);
      let res: FeedResponse | undefined, err: unknown;
      try { res = await inner(req, signal); } catch (e) { err = e; }
      if (signal?.aborted) throw err ?? new NetError('timeout', 'stopped');
      if (res && res.status === 429) {
        h.strikes++;
        const ra = retryAfterMs(header(res.headers, 'retry-after'), clock.now());
        const back = Math.min(ra ?? base * 2 ** (h.strikes - 1), 600_000);
        h.nextAt = Math.max(h.nextAt, clock.now() + back);
        if (attempt < retries) continue;
        return res;
      }
      if (res && res.status < 500) { h.strikes = 0; return res; }
      const retryable = res ? res.status >= 500 : err instanceof NetError && (err.code === 'timeout' || err.code === 'network');
      if (!retryable || attempt >= retries) { if (res) return res; throw err; }
      // exponential pause before the retry, on top of the normal gap
      h.nextAt = Math.max(h.nextAt, clock.now() + gap * 2 ** attempt);
    }
  };

  const f = (async (req: FeedRequest, signal?: AbortSignal) => {
    let host: string;
    try { host = new URL(req.url).host.toLowerCase(); } catch { throw new NetError('scheme', 'not a web address'); }
    let h = hosts.get(host);
    if (!h) { h = { tail: Promise.resolve(), nextAt: 0, strikes: 0 }; hosts.set(host, h); }
    const state = h;
    const run = state.tail.then(() => one(state, req, signal), () => one(state, req, signal));
    state.tail = run.catch(() => undefined);
    return run;
  }) as FeedFetch & { hosts: Map<string, HostState> };
  f.hosts = hosts;
  return f;
}

/** A feed error as one short line. */
export const errText = (e: unknown) => (e instanceof NetError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e));
