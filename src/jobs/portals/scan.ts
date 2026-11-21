// Scanning signed-in portals (ADR-0008 §3–4): plain code, no tokens, inside a sources run, one portal at a time. A
// portal is scanned when the person connected it and switched its `portal: <id>` item on in jobs/sources.md. Its
// searches (queries.ts) load in Crewdeck's profile within the catalog's limits: searches × pages per run, jittered
// delays, one scan per min_hours, pages_per_day. The first challenge, sign-in wall, 429/999 or a sudden empty result
// stops the portal and pauses it 6 h, 24 h, then 72 h; a sign-in wall also marks it needs_sign_in. Crewdeck never tries
// to get past a check: the person reconnects. Roles go through upsertRole with source_key portal:<id>.
import { type Ctx, notesOf, nowIso, todayOf } from '../ctx.ts';
import { addEvent, upsertRole } from '../db.ts';
import { cleanJob } from '../sources.ts';
import { portalVerdict } from './allow.ts';
import { type Portal, delayMs, hostIn, loadPortals } from './catalog.ts';
import { type Extracted, type Found, type Layer, type Posting, extractPostings } from './extract.ts';
import type { Launch, Loaded } from './profile.ts';
import { type PortalQuery, type PortalProfile, portalProfile, portalQueries, searchUrl } from './queries.ts';
import { type PortalState, nextPause, readPortalsState, updatePortal } from './state.ts';

export type StopKind = 'rate' | 'challenge' | 'sign_in' | 'empty' | 'error';
export type Stop = { kind: StopKind; reason: string };
export type PortalRun = {
  id: string; name: string; ran: boolean; why?: string;
  queries: Omit<PortalQuery, 'url'>[]; urls: string[];
  pages: number; found: number; new: number; stored: number; by: Record<Layer, number>;
  stopped?: string; stop_kind?: StopKind; paused_until?: string; needs_sign_in?: boolean;
  sample?: { title: string; company: string; url: string; by: Layer }[];
  /** Hosts the guard refused while scanning (a page needing another host shows here). */ blocked?: string[];
};
export type PortalsRun = { ran: boolean; why?: string; portals: PortalRun[]; new: number };
export type ScanOptions = {
  launch?: Launch; now?: () => Date; sleep?: (ms: number) => Promise<void>; rnd?: () => number;
  /** Tests: a catalog instead of the shipped one. */ portals?: Portal[];
  /** Tests: the person's search instead of the notes'. */ profile?: PortalProfile;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A scan that finds nothing where the last one found at least this many has probably been blocked quietly. */
export const EMPTY_ANOMALY = 10;

// Markers of a bot check or block page (Cloudflare, DataDome, PerimeterX, reCAPTCHA/hCaptcha walls, LinkedIn's checkpoint).
const CHALLENGE = /captcha-delivery\.com|cf-chl-|\/cdn-cgi\/challenge-platform|id=["']challenge-form|px-captcha|\/checkpoint\/challenge|verify (that )?you are (a )?human|are you a robot|unusual traffic from your|<title>\s*(just a moment|attention required|access denied)/i;

/** Why a loaded page means "stop now", or null. Pure: the scan and its tests share it. */
export function classifyPage(p: Loaded & { html: string }, portal: Portal): Stop | null {
  if (p.status === 429 || p.status === 999) return { kind: 'rate', reason: `${portal.name} asked Crewdeck to slow down (HTTP ${p.status})` };
  let path = '';
  try {
    const u = new URL(p.url);
    path = u.pathname;
    if (!hostIn(u.hostname, portal.hosts)) return { kind: 'challenge', reason: `${portal.name} sent the page to ${u.hostname}` };
  } catch {}
  if (portal.sign_in_wall.some((w) => { try { return new RegExp(w).test(path); } catch { return false; } })) return { kind: 'sign_in', reason: `${portal.name} asked to sign in again` };
  if (CHALLENGE.test(p.html.slice(0, 300_000))) return { kind: 'challenge', reason: `${portal.name} showed a check (CAPTCHA or bot shield): Crewdeck doesn't answer those` };
  if (p.status === 403) return { kind: 'challenge', reason: `${portal.name} refused the page (HTTP 403)` };
  if (p.status >= 500 || p.status === 0) return { kind: 'error', reason: `${portal.name} answered HTTP ${p.status || 'nothing'}` };
  return null;
}

/**
 * Postings into the tracker, the one path for both engines (profile scan, pane ingest): the same checks as every
 * source (cleanJob), then upsertRole with source_key portal:<id> and the company's country when the portal showed it.
 */
export function storePostings(ctx: Ctx, portal: Portal, postings: Posting[], at: Date): { stored: number; new: number } {
  const t = nowIso(ctx);
  let stored = 0, added = 0;
  for (const p of postings) {
    const c = cleanJob({ ...p, description: p.description ?? '', location: p.location || (p.workplace === 'remote' ? 'Remote' : '') }, { features: { linkedin_links: true }, at });
    if (!c.ok) continue;
    const { id, isNew } = upsertRole(ctx.db, { ...c.role, source: 'portal', source_key: `portal:${portal.id}`, company_country: p.company_country ?? null });
    stored++;
    if (isNew) { added++; addEvent(ctx.db, id, 'added', `from ${portal.name} (signed-in portal)`, t); }
  }
  return { stored, new: added };
}

/** The person's portals in their order: `portal: <id>` items in jobs/sources.md, with the on/off switch. */
export function portalItems(ctx: Ctx): { key: string; id: string; enabled: boolean }[] {
  return notesOf(ctx).sources.data.items.filter((it) => it.portal).map((it) => ({ key: it.key, id: it.portal!, enabled: it.enabled }));
}

const empty = (): Record<Layer, number> => ({ json: 0, jsonld: 0, links: 0 });

/**
 * One portal's scan. `test`: one query, one page, nothing stored, min_hours ignored (pauses and the daily cap still
 * count), and a sign-in wall only marks needs_sign_in when the portal was connected.
 */
export async function scanPortal(ctx: Ctx, portal: Portal, o: ScanOptions & { test?: boolean } = {}): Promise<PortalRun> {
  const now = o.now ?? ctx.clock;
  const wait = o.sleep ?? sleep;
  const run: PortalRun = { id: portal.id, name: portal.name, ran: false, queries: [], urls: [], pages: 0, found: 0, new: 0, stored: 0, by: empty() };
  const st: PortalState = readPortalsState(ctx.home).portals[portal.id] ?? {};
  const at = now();
  if (st.pause && Date.parse(st.pause.until) > at.getTime()) return { ...run, why: `paused until ${st.pause.until} (${st.pause.reason})`, paused_until: st.pause.until };
  if (!o.test && st.needs_sign_in) return { ...run, why: `${portal.name} needs you to sign in again (crewdeck jobs portals connect ${portal.id})`, needs_sign_in: true };
  if (!o.test && st.last_scan && at.getTime() - Date.parse(st.last_scan) < portal.limits.min_hours * 3_600_000) {
    return { ...run, why: `scanned at ${st.last_scan}; at most one scan every ${portal.limits.min_hours} h` };
  }
  const today = todayOf(ctx);
  const usedToday = st.day?.date === today ? st.day.pages : 0;
  const left = portal.limits.pages_per_day - usedToday;
  if (left <= 0) return { ...run, why: `${portal.limits.pages_per_day} pages read today already (the daily limit)` };
  const queries = portalQueries(o.profile ?? portalProfile(ctx), portal, { max: o.test ? 1 : undefined });
  run.queries = queries.map(({ url: _u, ...q }) => q);
  if (!queries.length) return { ...run, why: `${portal.name} covers none of the places in your search, or your search has no titles` };
  if (!o.launch) return { ...run, why: 'no browser to scan with' };

  let b;
  try { b = await o.launch(portal, { headless: !portal.headful }); }
  catch (e: any) { return { ...run, why: String(e?.message ?? e).slice(0, 300) }; }
  run.ran = true;
  let stop: Stop | null = null;
  const found: Found[] = [];
  try {
    // A missing sign-in cookie is a sign-in wall without loading a page.
    if (portal.signed_in.cookie && !(await b.cookies()).some((c) => c.name === portal.signed_in.cookie)) stop = { kind: 'sign_in', reason: `${portal.name} isn't signed in in Crewdeck's browser` };
    const page = stop ? null : await b.newPage();
    const pagesPer = o.test ? 1 : portal.limits.pages_per_search;
    outer: for (const q of queries) {
      for (let n = 0; n < pagesPer && page; n++) {
        if (run.pages >= left) break outer;
        const url = n === 0 ? q.url : searchUrl(portal, q, n);
        if (!url) break;
        if (run.pages > 0) await wait(delayMs(portal.limits, o.rnd));
        run.pages++;
        run.urls.push(url);
        let loaded: Loaded, html: string;
        try { loaded = await page.goto(url); html = await page.html(); }
        catch (e: any) { stop = { kind: 'error', reason: `${portal.name}: the page didn't load (${String(e?.message ?? e).split('\n')[0].slice(0, 200)})` }; break outer; }
        stop = classifyPage({ ...loaded, html }, portal);
        if (stop) break outer;
        const x: Extracted = extractPostings({ html, url: loaded.url, captured: page.captured() }, portal, now());
        for (const p of x.postings) if (!found.some((f) => f.url === p.url)) { found.push(p); run.by[p.by]++; }
        if (!x.postings.length) break;
      }
    }
  } finally {
    run.blocked = [...new Set(b.blocked())].slice(0, 20);
    await b.close();
  }
  run.found = found.length;
  if (!stop && !o.test && run.found === 0 && run.pages > 0 && (st.last_found ?? 0) >= EMPTY_ANOMALY) stop = { kind: 'empty', reason: `${portal.name} showed no jobs where the last scan found ${st.last_found}: probably blocked quietly` };
  run.sample = found.slice(0, 5).map((p) => ({ title: p.title, company: p.company, url: p.url, by: p.by }));

  if (!o.test) {
    const r = storePostings(ctx, portal, found, now());
    run.stored = r.stored; run.new = r.new;
  }

  // A real stop pauses the portal; an error (5xx, a page that didn't load) only ends this run.
  const pausing = stop && stop.kind !== 'error' && !(o.test && stop.kind === 'sign_in' && !st.connected);
  updatePortal(ctx.home, portal.id, (p) => {
    p.day = { date: today, pages: usedToday + run.pages };
    if (!o.test) { p.last_scan = at.toISOString(); p.last_found = run.found; p.last_new = run.new; }
    if (stop) {
      p.last_error = stop.reason;
      if (pausing) p.pause = nextPause(p.pause, stop.reason, at);
      if (stop.kind === 'sign_in' && p.connected) p.needs_sign_in = true;
    } else if (!o.test || run.found) { delete p.pause; delete p.last_error; delete p.needs_sign_in; }
  });
  if (stop) {
    run.stopped = stop.reason; run.stop_kind = stop.kind;
    const after = readPortalsState(ctx.home).portals[portal.id];
    if (pausing && after?.pause) run.paused_until = after.pause.until;
    if (after?.needs_sign_in) run.needs_sign_in = true;
  }
  return run;
}

/** Every connected, switched-on portal, one at a time, in the person's order. */
export async function scanPortals(ctx: Ctx, o: ScanOptions = {}): Promise<PortalsRun> {
  const cat = o.portals ?? loadPortals().portals;
  const byId = new Map(cat.map((p) => [p.id, p]));
  const state = readPortalsState(ctx.home);
  const out: PortalsRun = { ran: false, portals: [], new: 0 };
  const items = portalItems(ctx).filter((it) => it.enabled && byId.has(it.id));
  const wanted = items.filter((it) => state.portals[it.id]?.connected);
  if (!items.length) return { ...out, why: 'no portals switched on in jobs/sources.md' };
  if (!wanted.length) return { ...out, why: 'none of your switched-on portals is connected (crewdeck jobs portals connect <id>)' };
  out.ran = true;
  // ADR-0008 §8: a portal serving only places the person doesn't work in, or only countries whose companies they don't
  // want, is skipped (portals/allow.ts, shared with the planner).
  const prefs = notesOf(ctx).search.data.companies?.countries;
  const work = (o.profile ?? portalProfile(ctx)).countries;
  for (const it of wanted) {
    const verdict = portalVerdict(byId.get(it.id)!.countries, prefs, work);
    if (!verdict.allowed) {
      out.portals.push({ id: it.id, name: byId.get(it.id)!.name, ran: false, why: `skipped: ${verdict.why}`, queries: [], urls: [], pages: 0, found: 0, new: 0, stored: 0, by: empty() });
      continue;
    }
    try {
      const r = await scanPortal(ctx, byId.get(it.id)!, o);
      out.portals.push(r);
      out.new += r.new;
    } catch (e: any) {
      out.portals.push({ id: it.id, name: byId.get(it.id)!.name, ran: false, why: String(e?.message ?? e).slice(0, 300), queries: [], urls: [], pages: 0, found: 0, new: 0, stored: 0, by: empty() });
    }
  }
  return out;
}
