// The server's sourcing timer (design §2.4 step 1): `crewdeck jobs source` every jobs.fetch_every, as a child process,
// never two at once. No Claude: fetching is code. The first run comes shortly after the server starts when the last one is
// older than the interval (or there was none); after that, one interval after each finish. Refresh sources runs it now.
export type SchedulerOptions = {
  everyMs: number;
  /** One run: resolves when the child exits. */
  run: () => Promise<{ code: number | null; error?: string }>;
  /** When the last run finished (from the state file), or null. */
  lastFinished: () => string | null;
  /** Whether there is anything to fetch (providers installed, or LinkedIn search on). */
  ready: () => boolean;
  firstDelayMs?: number;
  now?: () => number;
  onChange?: () => void;
};
export type SchedulerStatus = { running: boolean; started: string | null; next_at: string | null; last_exit: { code: number | null; error?: string; at: string } | null };

export function createSourceScheduler(o: SchedulerOptions) {
  const now = o.now ?? Date.now;
  let running: Promise<void> | null = null;
  let started: string | null = null;
  let nextAt: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastExit: SchedulerStatus['last_exit'] = null;
  let stopped = false;

  const arm = (at: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextAt = at;
    timer = setTimeout(tick, Math.max(0, at - now()));
    timer.unref();
  };
  const tick = () => {
    timer = null;
    if (running) return; // the running one re-arms when it ends
    if (!o.ready()) { arm(now() + o.everyMs); return; }
    start();
  };
  function start() {
    started = new Date(now()).toISOString();
    nextAt = null;
    o.onChange?.();
    running = o.run()
      .then((r) => { lastExit = { ...r, at: new Date(now()).toISOString() }; })
      .catch((e: any) => { lastExit = { code: null, error: String(e?.message ?? e).slice(0, 300), at: new Date(now()).toISOString() }; })
      .finally(() => { running = null; started = null; arm(now() + o.everyMs); o.onChange?.(); });
  }

  // The first run: one interval after the last finish, but not sooner than firstDelay after start.
  const last = Date.parse(o.lastFinished() ?? '');
  arm(Math.max(now() + (o.firstDelayMs ?? 120_000), Number.isFinite(last) ? last + o.everyMs : 0));

  return {
    /** Refresh sources: start now unless a run is going. */
    refresh(): { started: boolean; already?: boolean } {
      if (running) return { started: false, already: true };
      if (timer) clearTimeout(timer);
      timer = null;
      start();
      return { started: true };
    },
    status(): SchedulerStatus {
      return { running: !!running, started, next_at: nextAt ? new Date(nextAt).toISOString() : null, last_exit: lastExit };
    },
    /** For tests and shutdown: wait for the running child. */
    idle: () => running ?? Promise.resolve(),
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
export type SourceScheduler = ReturnType<typeof createSourceScheduler>;
