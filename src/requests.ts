// Requests from the Crewdeck page to Claude sessions, one queue per lane.
// A lane is "project:<name>" for a project, else "cockpit". A session's bridge mod claims its lane's
// requests (new → picked) and closes each one (done / failed); unfinished ones go back to new.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { HOME, type Config } from './config.ts';

export type Request = {
  id: number; lane: string; text: string; status: 'new' | 'picked' | 'done' | 'failed';
  by?: string; result?: string; tries: number; created: string; updated: string;
};

const LANE = /^(cockpit|project:[a-z0-9][a-z0-9-]{0,39})$/;
const now = () => new Date().toISOString();
export const MAX_OPEN_PER_LANE = 20;
export const MAX_ADDS_PER_MINUTE = 30;
const KEEP_CLOSED = 500;
const KEEP_CLOSED_DAYS = 30;
const isOpen = (r: Request) => r.status === 'new' || r.status === 'picked';

export class Requests {
  private items: Request[] = [];
  private file: string;
  private adds = new Map<string, number[]>(); // lane → times of recent adds (rate limit)
  constructor(file = join(HOME, 'requests.json')) {
    this.file = file;
    if (existsSync(file)) { try { this.items = JSON.parse(readFileSync(file, 'utf8')); } catch { this.items = []; } }
  }
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
  }
  list(limit = 30) { return this.items.slice(-limit).reverse(); }

  add(lane: string, text: string): Request {
    if (!LANE.test(lane)) throw new Error(`bad lane "${lane}"`);
    const t = String(text ?? '').trim().slice(0, 2000);
    if (!t) throw new Error('empty request');
    if (this.items.filter((r) => r.lane === lane && isOpen(r)).length >= MAX_OPEN_PER_LANE) throw new Error(`too many open requests for ${lane}: let Claude finish some first`);
    const recent = (this.adds.get(lane) ?? []).filter((x) => Date.now() - x < 60_000);
    if (recent.length >= MAX_ADDS_PER_MINUTE) throw new Error('too many requests in a minute: slow down');
    this.adds.set(lane, [...recent, Date.now()]);
    const r: Request = { id: Math.max(0, ...this.items.map((x) => x.id)) + 1, lane, text: t, status: 'new', tries: 0, created: now(), updated: now() };
    this.items.push(r); this.save();
    return r;
  }
  /** Atomically hand a lane's new requests to one session. */
  claim(lane: string, by: string): Request[] {
    const out = this.items.filter((r) => r.lane === lane && r.status === 'new');
    for (const r of out) { r.status = 'picked'; r.by = by; r.updated = now(); }
    if (out.length) this.save();
    return out;
  }
  finish(id: number, result: string, failed = false): Request {
    const r = this.items.find((x) => x.id === id);
    if (!r || (r.status !== 'new' && r.status !== 'picked')) throw new Error(`request ${id} is not open`);
    r.status = failed ? 'failed' : 'done'; r.result = String(result ?? '').slice(0, 1000); r.updated = now();
    this.save();
    return r;
  }
  /** Put back what a session took but didn't close; after 3 tries it fails instead of looping. */
  requeue(ids: number[], by: string): number[] {
    const back: number[] = [];
    for (const r of this.items) {
      if (!ids.includes(r.id) || r.status !== 'picked' || r.by !== by) continue;
      r.tries += 1; r.updated = now(); r.by = undefined;
      if (r.tries >= 3) { r.status = 'failed'; r.result = 'Delivered 3 times without being finished: ask Claude about it in the chat.'; }
      else { r.status = 'new'; back.push(r.id); }
    }
    this.save();
    return back;
  }
}

/** Which lane a Claude session works in, from its folder: inside a project (or its worktrees) → that project. */
export function laneFor(c: Config, cwd: string): string {
  const dir = resolve(cwd);
  const p = c.projects.find((x) => dir === x.path || dir.startsWith(x.path + sep));
  return p ? `project:${p.name}` : 'cockpit';
}
