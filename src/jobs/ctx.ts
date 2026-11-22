// What every Jobs operation works with: the tracker, the user's vault (notes), jobs.home (machine state), the risky
// switches and a clock (tests move it across midnights).
import { join } from 'node:path';
import { type Config, FEATURE_DEFAULTS, type JobsFeatures } from '../config.ts';
import { type Db, openJobsDb } from './db.ts';
import { type JobNotes, NOTES, loadJobNotes } from './notes.ts';
import { dayBounds, dayIn, zoneOf } from './time.ts';

export type Ctx = { db: Db; vault: string; home: string; features: JobsFeatures; clock: () => Date };

export function makeCtx(o: { db: Db; vault: string; home: string; features?: Partial<JobsFeatures>; clock?: () => Date }): Ctx {
  return { db: o.db, vault: o.vault, home: o.home, features: { ...FEATURE_DEFAULTS, ...(o.features ?? {}) }, clock: o.clock ?? (() => new Date()) };
}

/** The CLI's context: the user's config, their tracker (8 s busy timeout) or the server's (250 ms). */
export function openCtx(c: Config, opts: { server?: boolean } = {}): Ctx {
  return makeCtx({ db: openJobsDb(c.jobs.home, opts), vault: c.vault, home: c.jobs.home, features: c.jobs.features });
}

/** The five notes, validated (broken ones fall back to their last valid version). */
export const notesOf = (ctx: Ctx): JobNotes => loadJobNotes(ctx.vault, ctx.home);
export const memoryFile = (ctx: Ctx) => join(ctx.vault, NOTES.memory);
export const tzOf = (ctx: Ctx, notes?: Pick<JobNotes, 'search'>) => zoneOf((notes ?? notesOf(ctx)).search.data.schedule.timezone);
export const nowIso = (ctx: Ctx) => ctx.clock().toISOString();
/** Today in the user's time zone. */
export const todayOf = (ctx: Ctx, notes?: Pick<JobNotes, 'search'>) => dayIn(tzOf(ctx, notes), ctx.clock());
export const todayBounds = (ctx: Ctx, notes?: Pick<JobNotes, 'search'>) => dayBounds(tzOf(ctx, notes), todayOf(ctx, notes));
