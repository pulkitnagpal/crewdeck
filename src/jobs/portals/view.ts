// What the Jobs page and `crewdeck jobs portals list` show for the signed-in portals (ADR-0008), and the switch that
// writes the person's choice to jobs/sources.md. The page API's shapes are the contract in api-stub.ts.
import type { Ctx } from '../ctx.ts';
import { changeSources } from '../sources-note.ts';
import { type Portal, canScan } from './catalog.ts';
import { effectivePortals } from './readers.ts';
import { portalItems } from './scan.ts';
import { type PortalStatus, portalStatus, readPortalsState } from './state.ts';

export type PortalView = {
  id: string; name: string; countries: string[]; fields: string[]; state: PortalStatus;
  /** Scanned in sources runs: connected and its jobs/sources.md row switched on. */ enabled: boolean;
  paused_until?: string; last_scan?: string; last_found?: number; risk: string; signup_url: string; login_url: string; verified: boolean;
  /** No reader yet (a `teach: true` entry): Claude sets one up on first connect. */ needs_reader: boolean;
  kind?: string; access?: string; importance?: number; reader?: boolean; added?: boolean;
};
export type PortalTestView = { found: number; by: { json: number; jsonld: number; links: number }; sample: { title: string; company: string; url: string }[]; stopped?: string };

/** `mode` (jobs.portals_mode): pane = Claude scans in its browser pane during Find, and Connect opens a Jobs chat. */
export function portalsView(ctx: Ctx, cat: Portal[] = effectivePortals(ctx.home).portals, mode: 'pane' | 'profile' = 'pane'): { mode: 'pane' | 'profile'; portals: PortalView[] } {
  const st = readPortalsState(ctx.home).portals;
  let items: ReturnType<typeof portalItems> = [];
  try { items = portalItems(ctx); } catch { /* broken notes: nothing switched on */ }
  const now = ctx.clock();
  // The person's portals first, in their order, then the rest of the catalog.
  const order = new Map(items.map((it, i) => [it.id, i]));
  const sorted = [...cat].sort((a, b) => (order.get(a.id) ?? 1e6) - (order.get(b.id) ?? 1e6));
  return {
    mode,
    portals: sorted.map((p) => {
      const s = st[p.id];
      const state = portalStatus(s, now);
      const on = items.some((it) => it.id === p.id && it.enabled);
      return {
        id: p.id, name: p.name, countries: p.countries, fields: p.fields, state, enabled: on && state !== 'not_connected',
        ...(state === 'paused' && s?.pause ? { paused_until: s.pause.until } : {}),
        ...(s?.last_scan ? { last_scan: s.last_scan } : {}), ...(typeof s?.last_found === 'number' ? { last_found: s.last_found } : {}),
        risk: p.risk, signup_url: p.signup_url, login_url: p.login_url, verified: p.verified, needs_reader: !canScan(p),
        ...(p.kind ? { kind: p.kind } : {}), ...(p.access ? { access: p.access } : {}), ...(p.importance !== undefined ? { importance: p.importance } : {}),
        ...(p.reader ? { reader: true } : {}), ...(p.added ? { added: true } : {}),
      };
    }),
  };
}

/** Connected portals that need the person to sign in again (the Today panel's line). */
export function portalsNeedingSignIn(ctx: Ctx): { id: string; name: string }[] {
  return portalsView(ctx).portals.filter((p) => p.state === 'needs_sign_in').map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Switch a portal's scanning on or off: its `portal: <id>` row in jobs/sources.md (added at the end when switched on
 * the first time), through the same validated writer as every other source, so the note gets a Changes line.
 */
export function togglePortal(ctx: Ctx, portal: Portal, on: boolean): { changed: boolean; key?: string; line?: string } {
  const st = readPortalsState(ctx.home).portals[portal.id];
  if (on && !st?.connected) throw new Error(`Connect ${portal.name} first (crewdeck jobs portals connect ${portal.id})`);
  const row = portalItems(ctx).find((it) => it.id === portal.id);
  if (!row) {
    if (!on) return { changed: false };
    const r = changeSources(ctx, { op: 'add', source: { portal: portal.id, name: portal.name } });
    return { changed: r.changed, key: r.key, line: r.line };
  }
  const r = changeSources(ctx, { op: on ? 'enable' : 'disable', key: row.key });
  return { changed: r.changed, key: row.key, line: r.line };
}

/** A scan run as the page's Test answer. */
export function testView(r: { found: number; by: PortalTestView['by']; sample?: { title: string; company: string; url: string }[]; stopped?: string; why?: string; ran: boolean }): PortalTestView {
  return { found: r.found, by: r.by, sample: (r.sample ?? []).map(({ title, company, url }) => ({ title, company, url })), ...(r.stopped || (!r.ran && r.why) ? { stopped: r.stopped ?? r.why } : {}) };
}
