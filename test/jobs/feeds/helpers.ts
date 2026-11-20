// Fixture network for the feed tests: a FeedFetch that answers from a URL → response map and records every request.
// Nothing here touches a real site.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedFetch, FeedRequest, FeedResponse } from '../../../src/jobs/feeds/types.ts';
import type { Clock } from '../../../src/jobs/feeds/http.ts';

export const FIX = join(import.meta.dirname, '..', '..', 'fixtures', 'jobs', 'feeds');
export const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8');

export type Route = Partial<FeedResponse> | ((req: FeedRequest, n: number) => Partial<FeedResponse>);

/** A fake network: exact URL (or URL without query) → response; anything else is a 404. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: FeedRequest[] = [];
  const counts = new Map<string, number>();
  const f: FeedFetch = async (req) => {
    calls.push(req);
    const r = routes[req.url] ?? routes[req.url.split('?')[0]];
    const n = (counts.get(req.url) ?? 0) + 1;
    counts.set(req.url, n);
    if (!r) return { status: 404, url: req.url, headers: {}, body: 'not found' };
    const o = typeof r === 'function' ? r(req, n) : r;
    return { status: o.status ?? 200, url: req.url, headers: o.headers ?? {}, body: o.body ?? '' };
  };
  return { fetch: f, calls };
}

/** A clock whose sleep advances time at once and records each sleep. */
export function fakeClock(start = Date.parse('2026-11-20T08:00:00Z')) {
  let t = start;
  const sleeps: number[] = [];
  const clock: Clock = { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } };
  return { clock, sleeps, advance: (ms: number) => { t += ms; }, get now() { return t; } };
}
