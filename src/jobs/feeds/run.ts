// Run company boards: robots check, conditional fetch, normalise, upsert (postings_ats + roles), closed detection,
// per-board stats. Boards run a few at a time; requests to one host are paced by politeFetch whatever the board.
import type { Db } from '../db.ts';
import type { NetOptions } from '../net/netguard.ts';
import { ADAPTERS } from './adapters/index.ts';
import { type Clock, type PoliteOptions, errText, guardFeedFetch, politeFetch, realClock } from './http.ts';
import { Robots } from './robots.ts';
import { boardState, closeMissing, dbRobotsStore, ensureFeedTables, saveBoardState, writePosting } from './store.ts';
import { type Board, type FeedFetch, boardKey } from './types.ts';

export type BoardStats = {
  board: string; ats: string; status: 'ok' | 'not_modified' | 'skipped' | 'failed';
  fetched: number; new: number; changed: number; notModified: boolean; closed: number; errors: string[];
};

export type RunFeedsOptions = {
  db: Db;
  /** the network: default netguard (with `net` test options) wrapped in politeFetch */
  fetch?: FeedFetch;
  net?: NetOptions;
  polite?: PoliteOptions;
  clock?: Clock;
  /** check robots.txt (default true) */
  robots?: boolean;
  /** also upsert roles for the existing pipeline (default true) */
  roles?: boolean;
  /** boards fetched at once (default 4) */
  concurrency?: number;
  signal?: AbortSignal;
  since?: string;
  maxDetails?: number;
  /** progress, one line per board */
  onBoard?: (s: BoardStats) => void;
};

/** Fetch every board and store what changed. Never throws for one board's failure: it is in that board's stats. */
export async function runFeeds(boards: Board[], o: RunFeedsOptions): Promise<BoardStats[]> {
  const { db } = o;
  ensureFeedTables(db);
  const clock = o.clock ?? realClock;
  const fetch = o.fetch ?? politeFetch(guardFeedFetch(o.net), { clock, ...o.polite });
  const robots = o.robots === false ? null : new Robots(fetch, { store: dbRobotsStore(db), now: () => clock.now() });
  const queue = [...new Map(boards.map((b) => [boardKey(b), b])).values()];
  const out: BoardStats[] = [];

  const one = async (b: Board): Promise<BoardStats> => {
    const key = boardKey(b);
    const s: BoardStats = { board: key, ats: b.ats, status: 'ok', fetched: 0, new: 0, changed: 0, notModified: false, closed: 0, errors: [] };
    const adapter = ADAPTERS[b.ats];
    const at = new Date(clock.now()).toISOString();
    if (!adapter) return { ...s, status: 'failed', errors: [`no adapter for ${b.ats}`] };
    try {
      const url = adapter.feedUrl(b);
      if (robots) {
        const r = await robots.check(url, o.signal);
        if (!r.ok) {
          saveBoardState(db, b, { status: 'skipped', error: r.reason, ok: false, at });
          return { ...s, status: 'skipped', errors: [r.reason!] };
        }
      }
      const state = boardState(db, b);
      const res = await adapter.fetchBoard(b, { fetch, etag: state.etag, known: state.known, signal: o.signal, since: o.since, now: clock.now(), maxDetails: o.maxDetails });
      s.errors.push(...res.errors);
      if (res.notModified) {
        s.status = 'not_modified'; s.notModified = true;
        db.prepare('update postings_ats set last_seen = ? where board = ? and closed_at is null').run(at, key);
        saveBoardState(db, b, { etag: res.etag, status: 'not_modified', ok: true, at });
        return s;
      }
      if (!res.postings.length && res.complete === false) {
        s.status = 'failed';
        saveBoardState(db, b, { status: 'failed', error: res.errors.join('; ').slice(0, 500), ok: false, at });
        return s;
      }
      s.fetched = res.postings.length;
      for (const p of res.postings) {
        try {
          const w = writePosting(db, p, at, { roles: o.roles });
          if (w === 'new') s.new++;
          else if (w === 'changed') s.changed++;
        } catch (e) { s.errors.push(`${p.atsJobId}: ${errText(e)}`); }
      }
      // Closed detection only after a complete, unfiltered list.
      if (res.complete !== false && !o.since) s.closed = closeMissing(db, key, at);
      saveBoardState(db, b, { etag: res.etag, status: s.errors.length ? 'partial' : 'ok', error: s.errors.join('; ').slice(0, 500) || undefined, ok: true, at, postings: s.fetched });
      return s;
    } catch (e) {
      s.status = 'failed';
      s.errors.push(errText(e));
      try { saveBoardState(db, b, { status: 'failed', error: errText(e), ok: false, at }); } catch { /* the stats still say it */ }
      return s;
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, queue.length)) }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      if (o.signal?.aborted) break;
      const s = await one(b);
      out.push(s);
      o.onBoard?.(s);
    }
  });
  await Promise.all(workers);
  return out;
}
