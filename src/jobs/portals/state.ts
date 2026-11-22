// Each portal's connection state (ADR-0008 §7): signed in or not, the last scan, a pause after a stop, the pages read
// today. Machine state in <jobs.home>/state/portals.json (0600), never in the person's notes.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome } from '../../config.ts';

export type Pause = { until: string; level: number; reason: string };
export type PortalState = {
  connected?: boolean; connected_at?: string;
  /** A scan met a sign-in wall: the person signs in again (connect). */ needs_sign_in?: boolean;
  last_scan?: string; last_found?: number; last_new?: number; last_error?: string;
  pause?: Pause;
  /** Finished scans (counted per scan, not per page): moves which title variants the next search uses (ADR-0008, Search coverage). */ rotation?: number;
  /** The title groups the last scan searched, one list per search. */ last_titles?: string[][];
  /** Pages loaded on `date` (the person's day), for pages_per_day. */ day?: { date: string; pages: number };
};
export type PortalsState = { portals: Record<string, PortalState> };
export type PortalStatus = 'not_connected' | 'connected' | 'needs_sign_in' | 'paused';

export const portalsStateFile = (home: string) => join(home, 'state', 'portals.json');

export function readPortalsState(home: string): PortalsState {
  try {
    const j = JSON.parse(readFileSync(portalsStateFile(home), 'utf8'));
    return { portals: j && typeof j.portals === 'object' && !Array.isArray(j.portals) ? j.portals : {} };
  } catch { return { portals: {} }; }
}

export function writePortalsState(home: string, s: PortalsState) {
  ensureHome(join(home, 'state'));
  const f = portalsStateFile(home), tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, f);
}

/** Change one portal's state (read, change, write: the CLI and the server never write at the same instant for one portal). */
export function updatePortal(home: string, id: string, fn: (p: PortalState) => PortalState | void): PortalState {
  const s = readPortalsState(home);
  const cur = { ...(s.portals[id] ?? {}) };
  const next = fn(cur) ?? cur;
  s.portals[id] = next;
  writePortalsState(home, s);
  return next;
}

/** What the page shows: a sign-in wall first (the person must act), then a pause, then connected. */
export function portalStatus(p: PortalState | undefined, now: Date): PortalStatus {
  if (!p?.connected) return 'not_connected';
  if (p.needs_sign_in) return 'needs_sign_in';
  if (p.pause && Date.parse(p.pause.until) > now.getTime()) return 'paused';
  return 'connected';
}

/** Hours a portal pauses after 1, 2, 3+ stops in a row (ADR-0008 §4). */
export const PAUSE_HOURS = [6, 24, 72];

/** The next pause after a stop: the level goes up from the last one (a clean scan resets it). */
export function nextPause(prev: Pause | undefined, reason: string, now: Date): Pause {
  const level = Math.min((prev?.level ?? 0) + 1, PAUSE_HOURS.length);
  return { until: new Date(now.getTime() + PAUSE_HOURS[level - 1] * 3_600_000).toISOString(), level, reason: reason.slice(0, 300) };
}
