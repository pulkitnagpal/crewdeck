// Requests from the Crewdeck page to Claude sessions, one queue per lane.
// A lane is "jobs" for the jobs workspace, "project:<name>" for a project, else "cockpit". A session's bridge mod claims
// its lane's requests (new → picked) and closes each one (done / failed); unfinished ones go back to new.
//
// Two shapes share the queue: plain text from the Ask box (cockpit and project lanes), and typed requests (kind, ref,
// payload) that only the Jobs page's own actions create, after checking them (design D4, D16).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { HOME, type Config } from './config.ts';

export const JOB_KINDS = ['setup', 'find', 'link', 'apply', 'improve'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type Progress = { at: string; text: string };

export type Request = {
  id: number; lane: string; text: string; status: 'new' | 'picked' | 'done' | 'failed';
  by?: string; result?: string; tries: number; created: string; updated: string;
  kind?: JobKind; ref?: string; payload?: Record<string, unknown>; progress?: Progress[];
};
export type Typed = { kind: JobKind; ref?: string; payload?: Record<string, unknown> };

const LANE = /^(cockpit|jobs|project:[a-z0-9][a-z0-9-]{0,39})$/;
const REF = /^[A-Za-z0-9_-]{1,64}$/;
const now = () => new Date().toISOString();
export const MAX_OPEN_PER_LANE = 20;
export const MAX_ADDS_PER_MINUTE = 30;
export const MAX_PROGRESS = 50;
export const SEEN_MS = 10_000;
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
  private seen = new Map<string, { at: number; by: string }>(); // lane → last claim (presence)
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
    const t = String(text ?? '').trim().slice(0, 2000);
    if (!t) throw new RequestError('empty request');
    if (this.items.filter((r) => r.lane === lane && isOpen(r)).length >= MAX_OPEN_PER_LANE) throw new RequestError(`too many open requests for ${lane}: let Claude finish some first`);
    const recent = (this.adds.get(lane) ?? []).filter((x) => Date.now() - x < 60_000);
    if (recent.length >= MAX_ADDS_PER_MINUTE) throw new RequestError('too many requests in a minute: slow down');
    this.adds.set(lane, [...recent, Date.now()]);
    const r: Request = { id: Math.max(0, ...this.items.map((x) => x.id)) + 1, lane, text: t, status: 'new', tries: 0, created: now(), updated: now() };
    if (typed) Object.assign(r, { kind: typed.kind, ...(typed.ref !== undefined ? { ref: typed.ref } : {}), payload: typed.payload ?? {} });
    this.items.push(r); this.save();
    return r;
  }
  /** A session of this lane is alive (its bridge claimed, or Claude reported progress). */
  markSeen(lane: string, by = 'session') { this.seen.set(lane, { at: Date.now(), by }); }
  /** Is a Claude session working this lane: seen in the last 10 s, or holding one of its requests (busy sessions don't claim). */
  presence(lane: string) {
    const s = this.seen.get(lane);
    const working = this.items.some((r) => r.lane === lane && r.status === 'picked');
    return { connected: working || (!!s && Date.now() - s.at < SEEN_MS), seen: s ? new Date(s.at).toISOString() : null };
  }
  /** Atomically hand a lane's new requests to one session. */
  claim(lane: string, by: string): Request[] {
    this.markSeen(lane, by);
    const out = this.items.filter((r) => r.lane === lane && r.status === 'new');
    for (const r of out) { r.status = 'picked'; r.by = by; r.updated = now(); }
    if (out.length) this.save();
    return out;
  }
  finish(id: number, result: string, failed = false): Request {
    const r = this.items.find((x) => x.id === id);
    if (!r || !isOpen(r)) throw new RequestError(`request ${id} is not open`);
    r.status = failed ? 'failed' : 'done'; r.result = String(result ?? '').slice(0, 1000); r.updated = now();
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
    r.updated = now();
    this.markSeen(r.lane, r.by ?? 'session');
    this.save();
    return r;
  }
  /** Put back what a session took but didn't close; after 3 tries it fails instead of looping. */
  requeue(ids: number[], by: string): number[] {
    const back: number[] = [];
    for (const r of this.items) {
      if (!ids.includes(r.id) || r.status !== 'picked' || r.by !== by) continue;
      r.tries += 1; r.updated = now(); r.by = undefined;
      if (r.tries >= 3) { r.status = 'failed'; r.result = 'Delivered 3 times without being finished: ask Claude about it in the chat.'; r.payload = undefined; }
      else { r.status = 'new'; back.push(r.id); }
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
  const dir = resolve(cwd);
  const ws = c.jobs?.enabled ? c.jobs.workspace : '';
  if (ws && (dir === ws || dir.startsWith(ws + sep))) return 'jobs';
  const p = c.projects.find((x) => dir === x.path || dir.startsWith(x.path + sep));
  return p ? `project:${p.name}` : 'cockpit';
}
