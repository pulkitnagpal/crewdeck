// Requests from the Crewdeck page to Claude sessions, one queue per lane.
// A lane is "jobs" for the jobs workspace, "project:<name>" for a project, else "cockpit". A session's bridge mod claims
// its lane's requests (new → picked) and closes each one (done / failed); unfinished ones go back to new.
//
// Two shapes share the queue: plain text from the Ask box (cockpit and project lanes), and typed requests (kind, ref,
// payload) that only the Jobs page's own actions create, after checking them (design D4, D16).
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { HOME, type Config } from './config.ts';

// tell (P3): what the person told Crewdeck (the Tell box, the panel, `crewdeck jobs tell`): intake turns it into a proposal.
// prepare (P4): one pick Find didn't prepare ahead, on the person's Prepare click.
export const JOB_KINDS = ['setup', 'find', 'link', 'apply', 'improve', 'source', 'tell', 'prepare'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type Progress = { at: string; text: string };

export type Request = {
  id: number; lane: string; text: string; status: 'new' | 'picked' | 'done' | 'failed';
  by?: string; result?: string; tries: number; created: string; updated: string;
  kind?: JobKind; ref?: string; payload?: Record<string, unknown>; progress?: Progress[];
  /** When Claude took it up (read it with `request show` or posted progress): from then on it is that session's work. */
  taken?: string;
  /**
   * Held back from claims until Crewdeck finishes something first (`fetching`: a Find waits for fresh postings), or kept
   * for the Jobs chat Crewdeck opened for it (`chat`: only a claim that names it takes it, ADR-0004).
   */
  hold?: string;
};
export type Typed = { kind: JobKind; ref?: string; payload?: Record<string, unknown> };

const LANE = /^(cockpit|jobs|project:[a-z0-9][a-z0-9-]{0,39})$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const now = () => new Date().toISOString();
/** Open requests per lane and kind (plain text counts as its own kind): a pile of links never blocks an Apply. */
export const MAX_OPEN_PER_LANE = 20;
export const MAX_ADDS_PER_MINUTE = 30;
export const MAX_PROGRESS = 50;
export const SEEN_MS = 10_000;
/** A picked request with no word from Claude (claim, progress) for this long goes back to the queue (a crashed session). */
export const LEASE_MS = 15 * 60_000;
const KEEP_CLOSED = 500;
const KEEP_CLOSED_DAYS = 30;
/** A queue rule the caller broke (bad lane, empty, limits, a closed request): the caller's to fix, so a 400. */
export class RequestError extends Error {}

export const isOpen = (r: Request) => r.status === 'new' || r.status === 'picked';

/** JSON with sorted keys, so the same payload in another key order is the same request. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** What the page and the bridge may see of a request: payload keys, never the payload's values. */
export function publicView(r: Request) {
  const { payload, ...rest } = r;
  return { ...rest, keys: payload ? Object.keys(payload) : undefined };
}

export class Requests {
  private items: Request[] = [];
  private file: string;
  private adds = new Map<string, number[]>(); // lane → times of recent adds (rate limit)
  private seen = new Map<string, { at: number; by: string; idle: boolean }>(); // lane → last claim (presence)
  private heard = new Map<number, number>(); // picked request → when its session was last heard from (the lease; memory only)
  private listeners = new Set<() => void>();
  constructor(file = join(HOME, 'requests.json')) {
    this.file = file;
    if (existsSync(file)) { try { this.items = JSON.parse(readFileSync(file, 'utf8')); } catch { this.items = []; } }
  }
  /** Called after every change that was saved (the Jobs page's live refresh listens). */
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Open requests are never dropped; closed ones are kept for 30 days, at most 500 of them. */
  private save() {
    const cutoff = new Date(Date.now() - KEEP_CLOSED_DAYS * 86400_000).toISOString();
    const closed = this.items.filter((r) => !isOpen(r) && r.updated >= cutoff).slice(-KEEP_CLOSED);
    const keep = new Set([...this.items.filter(isOpen), ...closed]);
    this.items = this.items.filter((r) => keep.has(r));
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file); // atomic: a crash never leaves half a file
    for (const fn of this.listeners) { try { fn(); } catch { /* a listener never breaks the queue */ } }
  }

  list(limit = 30) { return this.items.slice(-limit).reverse(); }
  get(id: number): Request | undefined { return this.items.find((x) => x.id === id); }
  /** Requests of a lane (newest first), optionally only one kind. */
  ofLane(lane: string, kind?: JobKind): Request[] { return this.items.filter((r) => r.lane === lane && (!kind || r.kind === kind)).reverse(); }
  /** The newest request of a kind for a ref (open or closed). */
  latest(lane: string, kind: JobKind, ref: string): Request | undefined { return this.ofLane(lane, kind).find((r) => r.ref === ref); }

  /**
   * Queue a request. Plain text (the Ask box) for cockpit and project lanes; the jobs lane takes only typed requests,
   * which the Jobs API creates after checking them. The same open typed request returns the existing one.
   */
  add(lane: string, text: string, typed?: Typed): Request {
    if (!LANE.test(lane)) throw new RequestError(`bad lane "${lane}"`);
    if (lane === 'jobs' && !typed) throw new RequestError('the jobs lane takes only requests made by the Jobs page\'s own buttons');
    if (typed) {
      if (!(JOB_KINDS as readonly string[]).includes(typed.kind)) throw new RequestError(`unknown request kind "${typed.kind}"`);
      if (typed.ref !== undefined && !REF.test(typed.ref)) throw new RequestError('bad request ref');
      if (typed.payload !== undefined && (typeof typed.payload !== 'object' || Array.isArray(typed.payload) || typed.payload === null)) throw new RequestError('a payload is a map of values');
      if (canonical(typed.payload ?? {}).length > 4000) throw new RequestError('request payload too large');
      const key = canonical(typed.payload ?? {});
      const same = this.items.find((r) => isOpen(r) && r.lane === lane && r.kind === typed.kind && (r.ref ?? '') === (typed.ref ?? '') && canonical(r.payload ?? {}) === key);
      if (same) return same;
    }
    this.expire();
    const t = String(text ?? '').trim().slice(0, 2000);
    if (!t) throw new RequestError('empty request');
    const kind = typed?.kind;
    if (this.items.filter((r) => r.lane === lane && r.kind === kind && isOpen(r)).length >= MAX_OPEN_PER_LANE) throw new RequestError(`too many open ${kind ?? 'requests'} requests for ${lane}: let Claude finish some first`);
    const rate = `${lane}\u0000${kind ?? ''}`;
    const recent = (this.adds.get(rate) ?? []).filter((x) => Date.now() - x < 60_000);
    if (recent.length >= MAX_ADDS_PER_MINUTE) throw new RequestError('too many requests in a minute: slow down');
    this.adds.set(rate, [...recent, Date.now()]);
    const r: Request = { id: Math.max(0, ...this.items.map((x) => x.id)) + 1, lane, text: t, status: 'new', tries: 0, created: now(), updated: now() };
    if (typed) Object.assign(r, { kind: typed.kind, ...(typed.ref !== undefined ? { ref: typed.ref } : {}), payload: typed.payload ?? {} });
    this.items.push(r); this.save();
    return r;
  }
  /** A session of this lane is alive: its bridge claimed (a busy session's bridge claims without taking anything). */
  markSeen(lane: string, by = 'session', idle = false) { this.seen.set(lane, { at: Date.now(), by, idle }); }
  /**
   * Is a Claude session working this lane: a claim in the last 10 s. A picked request alone doesn't say so: the session
   * that took it may have crashed (the lease puts it back).
   */
  presence(lane: string) {
    const s = this.seen.get(lane);
    const connected = !!s && Date.now() - s.at < SEEN_MS;
    // idle: its last claim could take work (a busy session's heartbeat can't).
    return { connected, idle: connected && !!s?.idle, seen: s ? new Date(s.at).toISOString() : null };
  }
  /**
   * Atomically hand a lane's new requests to one session; `take: false` is a busy session's heartbeat (presence only).
   * The session's own picked requests count as heard from, so a long piece of work keeps its lease.
   * `want`: the request a Jobs chat was opened for (its first prompt names it): taken first, even while busy, and even
   * when it is kept for that chat (`hold: 'chat'`); never one held for a fetch.
   */
  claim(lane: string, by: string, take = true, want: number[] = []): Request[] {
    this.markSeen(lane, by, take);
    this.expire();
    for (const r of this.items) if (r.lane === lane && r.status === 'picked' && r.by === by) this.heard.set(r.id, Date.now());
    const wanted = this.items.filter((r) => r.lane === lane && r.status === 'new' && want.includes(r.id) && (!r.hold || r.hold === 'chat'));
    const rest = take ? this.items.filter((r) => r.lane === lane && r.status === 'new' && !r.hold && !wanted.includes(r)) : [];
    const out = [...wanted, ...rest];
    for (const r of out) { r.status = 'picked'; r.by = by; r.updated = now(); r.taken = undefined; r.hold = undefined; this.heard.set(r.id, Date.now()); }
    if (out.length) this.save();
    return out;
  }
  /** Hold a new request back from claims (Crewdeck does something first), or let it go (`undefined`). */
  setHold(id: number, hold: string | undefined) {
    const r = this.items.find((x) => x.id === id);
    if (!r || r.status !== 'new' || r.hold === hold) return;
    r.hold = hold; r.updated = now();
    this.save();
  }
  /**
   * Leases: a picked request whose session hasn't been heard from (claim, progress) for 15 min goes back to the queue
   * (tries + 1; failed after 3, like requeue). Called on every claim and add, and by the Jobs page's timer.
   */
  expire(at = Date.now()): number[] {
    const back: number[] = [];
    for (const r of this.items) {
      if (r.status !== 'picked') continue;
      const last = Math.max(this.heard.get(r.id) ?? 0, Date.parse(r.updated));
      if (at - last < LEASE_MS) continue;
      this.putBack(r, 'Claude stopped answering 3 times (the session closed or crashed): open a session and try again.');
      back.push(r.id);
    }
    if (back.length) this.save();
    return back;
  }
  private putBack(r: Request, failText: string) {
    r.tries += 1; r.updated = now(); r.by = undefined; r.taken = undefined; this.heard.delete(r.id);
    if (r.tries >= 3) { r.status = 'failed'; r.result = failText; r.payload = undefined; }
    else r.status = 'new';
  }
  /** The user stopped it on the page: closed as failed, whatever state it was in. */
  cancel(id: number, lane: string): Request {
    const r = this.items.find((x) => x.id === id);
    if (!r || r.lane !== lane || !isOpen(r)) throw new RequestError(`request ${id} is not open`);
    r.status = 'failed'; r.result = 'Cancelled on the page'; r.updated = now(); r.by = undefined; r.payload = undefined; this.heard.delete(id);
    this.save();
    return r;
  }
  finish(id: number, result: string, failed = false): Request {
    const r = this.items.find((x) => x.id === id);
    if (!r || !isOpen(r)) throw new RequestError(`request ${id} is not open`);
    r.status = failed ? 'failed' : 'done'; r.result = String(result ?? '').slice(0, 1000); r.updated = now(); this.heard.delete(id);
    if (r.payload) r.payload = undefined; // the page's data has done its job (design §9)
    this.save();
    return r;
  }
  /** A line of what Claude is doing, shown on the page (the last 50 per request). */
  progress(id: number, text: string): Request {
    const r = this.items.find((x) => x.id === id);
    if (!r || !isOpen(r)) throw new RequestError(`request ${id} is not open`);
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) throw new RequestError('empty progress line');
    r.progress = [...(r.progress ?? []), { at: now(), text: t }].slice(-MAX_PROGRESS);
    r.updated = now(); // progress renews the lease (updated); presence comes only from claims
    if (r.status === 'picked' && !r.taken) r.taken = now();
    this.save();
    return r;
  }
  /** Claude read a picked request (`request show`): it has taken it up, so a turn ending no longer puts it back. */
  take(id: number): void {
    const r = this.items.find((x) => x.id === id);
    if (!r || r.status !== 'picked' || r.taken) return;
    r.taken = now(); this.heard.set(id, Date.now()); this.save();
  }
  /**
   * Put back what a session was given but didn't take up (a turn interrupted before Claude read it); after 3 tries it
   * fails instead of looping. A request Claude took up (`request show`, progress) stays with its session across turns:
   * an interview or an apply waits for the person's answers. If that session goes away, the lease puts it back.
   */
  requeue(ids: number[], by: string): number[] {
    const back: number[] = [];
    for (const r of this.items) {
      if (!ids.includes(r.id) || r.status !== 'picked' || r.by !== by) continue;
      if (r.taken) { this.heard.set(r.id, Date.now()); continue; }
      this.putBack(r, 'Delivered 3 times without being finished: ask Claude about it in the chat.');
      if (r.status === 'new') back.push(r.id);
    }
    this.save();
    return back;
  }
  /**
   * Close open jobs requests whose role is already applied or skipped (the user submitted on the site, or skipped it):
   * nothing is left to do for them. `statusOf(ref)` is the role's status.
   */
  reconcile(statusOf: (ref: string) => string | undefined): number[] {
    const closed: number[] = [];
    for (const r of this.items) {
      if (r.lane !== 'jobs' || !isOpen(r) || !r.ref) continue;
      const s = statusOf(r.ref);
      if (s !== 'applied' && s !== 'skipped') continue;
      r.status = 'done'; r.result = `Nothing to do: this role is already ${s}`; r.updated = now(); r.payload = undefined;
      closed.push(r.id);
    }
    if (closed.length) this.save();
    return closed;
  }
}

/**
 * Which lane a Claude session works in, from its folder: inside the jobs workspace → jobs (checked first, so a workspace
 * inside a project still works Jobs); inside a project (or its worktrees) → that project; else cockpit.
 */
export function laneFor(c: Config, cwd: string): string {
  // Compared as given and with links resolved (macOS /var is /private/var; a process's cwd is always the real path).
  const dirs = [resolve(cwd), real(cwd)];
  const inside = (root: string) => [root, real(root)].some((r) => dirs.some((d) => d === r || d.startsWith(r + sep)));
  const ws = c.jobs?.enabled ? c.jobs.workspace : '';
  if (ws && inside(ws)) return 'jobs';
  const p = c.projects.find((x) => inside(x.path));
  return p ? `project:${p.name}` : 'cockpit';
}
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
