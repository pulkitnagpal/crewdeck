// Pane mode (ADR-0008, "Pane mode"): Claude scans the person's signed-in portals in Claude desktop's browser pane during
// Find, in the person's own session. Crewdeck's side is plain code with no browser:
//   plan   the pages to open this run, within every limit of the profile engine (searches × pages, pages a day,
//          min_hours, pauses, the company-country verdict), with the jittered wait before each; reading it counts nothing;
//   ingest the in-page script's answer for one page: validated strictly, its signals applied exactly as a profile scan
//          applies a stop (a pause of 6, 24, then 72 h; a sign-in wall marks the portal needs_sign_in), its jobs stored
//          through the same path as a scan (storePostings). This is the only write;
//   mark   Claude records that the person signed in (connected) or is signed out, after running the script on the
//          portal's page: in pane mode that is what "connect" means.
// Page content is data: nothing in the answer is ever run, and every field is a bounded string.
import { type Ctx, notesOf, todayOf } from '../ctx.ts';
import { lookupPlace } from '../places.ts';
import { portalVerdict } from './allow.ts';
import { type Portal, canScan, delayMs, hostIn } from './catalog.ts';
import { effectivePortals } from './readers.ts';
import { type Posting, canonicalJobUrl, postedAt, workplaceOf } from './extract.ts';
import { PAGE_JOBS, type PageOutput, type PaneJob } from './page-script.ts';
import { type PortalProfile, portalProfile, portalQueries, searchUrl } from './queries.ts';
import { EMPTY_ANOMALY, type StopKind, portalItems, storePostings } from './scan.ts';
import { type PortalState, nextPause, readPortalsState, updatePortal } from './state.ts';

export type PortalsMode = 'pane' | 'profile';
/** `titles`: what that page's search covers (`query` is them joined as the portal reads them). */
export type PlanPage = { portal: string; url: string; query: string; titles: string[]; delay_ms: number };
export type PortalPlan = { mode: PortalsMode; pages: PlanPage[]; skipped: { portal: string; name: string; why: string }[] };

/** Pages ingested within this long of the last one belong to the same scan (their counts add up). */
export const SCAN_WINDOW_MS = 60 * 60_000;
/** The largest script answer ingest reads (the script aims under 12 KB). */
export const INGEST_MAX_BYTES = 128 * 1024;

/**
 * The pages to open this run, in the person's portal order. `only`: one portal, as a test (one search, one page; its
 * switch and min_hours don't matter; pauses, sign-in and the daily cap still do). `ids`: only these portals (the
 * person's choice in the Find sheet); a listed id that is switched off is reported as skipped, an unknown one is an error.
 */
export function planPortals(ctx: Ctx, o: { mode?: PortalsMode; only?: string; ids?: string[]; portals?: Portal[]; profile?: PortalProfile; rnd?: () => number } = {}): PortalPlan {
  const mode = o.mode ?? 'pane';
  const out: PortalPlan = { mode, pages: [], skipped: [] };
  if (mode !== 'pane') return { ...out, skipped: [{ portal: '*', name: 'Portals', why: 'profile mode: Crewdeck scans portals itself in every sources run' }] };
  const cat = o.portals ?? effectivePortals(ctx.home).portals;
  const byId = new Map(cat.map((p) => [p.id, p]));
  const state = readPortalsState(ctx.home).portals;
  const on = portalItems(ctx).filter((it) => it.enabled).map((it) => it.id);
  if (o.only && o.ids) throw new Error('give --portal (one test page) or --portals (a choice), not both');
  for (const id of o.ids ?? []) if (!byId.has(id)) throw new Error(`no portal "${id}" (crewdeck jobs portals list shows them)`);
  const ids = o.only ? [o.only] : o.ids ? [...new Set(o.ids)] : on;
  const prefs = notesOf(ctx).search.data.companies?.countries;
  const profile = o.profile ?? portalProfile(ctx);
  const now = ctx.clock();
  const today = todayOf(ctx);
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) { if (o.only) throw new Error(`no portal "${id}" (crewdeck jobs portals list shows them)`); continue; }
    const st: PortalState = state[id] ?? {};
    const skip = (why: string) => out.skipped.push({ portal: id, name: p.name, why });
    if (o.ids && !on.includes(id)) { skip('switched off (Jobs page → Sources → Portals)'); continue; }
    if (!canScan(p)) { skip(`needs a reader: Claude sets it up on first connect (crewdeck jobs portals teach ${id})`); continue; }
    if (!st.connected) { skip(`not connected (sign in: Jobs page → Sources → Portals → Connect)`); continue; }
    if (st.needs_sign_in) { skip(`${p.name} needs you to sign in again: Jobs page → Sources → Portals → Sign in`); continue; }
    if (st.pause && Date.parse(st.pause.until) > now.getTime()) { skip(`paused until ${st.pause.until} (${st.pause.reason})`); continue; }
    if (!o.only && st.last_scan && now.getTime() - Date.parse(st.last_scan) < p.limits.min_hours * 3_600_000) { skip(`scanned at ${st.last_scan}; at most one scan every ${p.limits.min_hours} h`); continue; }
    const left = p.limits.pages_per_day - (st.day?.date === today ? st.day.pages : 0);
    if (left <= 0) { skip(`${p.limits.pages_per_day} pages read today already (the daily limit)`); continue; }
    const verdict = portalVerdict(p.countries, prefs, profile.countries);
    if (!verdict.allowed) { skip(`skipped: ${verdict.why}`); continue; }
    const queries = portalQueries(profile, p, { max: o.only ? 1 : undefined, rotation: st.rotation ?? 0 });
    if (!queries.length) { skip(`${p.name} covers none of the places in your search, or your search has no titles`); continue; }
    let n = 0;
    outer: for (const q of queries) {
      for (let page = 0; page < (o.only ? 1 : p.limits.pages_per_search); page++) {
        if (n >= left) break outer;
        const url = page === 0 ? q.url : searchUrl(p, q, page);
        if (!url) break;
        // The first page of a portal opens at once; every later one after the portal's jittered delay.
        out.pages.push({ portal: id, url, query: q.keywords, titles: q.titles, delay_ms: n === 0 ? 0 : delayMs(p.limits, o.rnd) });
        n++;
      }
    }
  }
  return out;
}

// ---- the script's answer, read strictly ----

const KEYS = new Set(['url', 'signals', 'jobs']);
const SIGNALS = ['sign_in_wall', 'challenge', 'empty'] as const;
const JOB_FIELDS: Record<string, number> = { url: 500, title: 200, company: 120, location: 120, posted_at: 40, workplace: 10, company_country: 60, description: 400, apply_kind: 20 };
const WORKPLACES = new Set(['remote', 'hybrid', 'onsite']);
const plainStr = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** The script's answer for this portal, or why it isn't one. Unknown keys, wrong types, sizes over the caps and a job
 * address off the portal's hosts are refused (the answer passed through Claude: it is checked like any page text). */
export function parsePageOutput(raw: unknown, portal: Portal): { out: PageOutput; dropped: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the answer is not an object { url, signals, jobs }');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KEYS.has(k)) throw new Error(`unknown key "${k.slice(0, 40)}" in the answer`);
  if (typeof r.url !== 'string' || !r.url || r.url.length > 2000) throw new Error('url: the page address (a string)');
  const s = r.signals as Record<string, unknown>;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('signals: { sign_in_wall, challenge, empty }');
  for (const k of Object.keys(s)) if (!(SIGNALS as readonly string[]).includes(k)) throw new Error(`unknown signal "${k.slice(0, 40)}"`);
  for (const k of SIGNALS) if (typeof s[k] !== 'boolean') throw new Error(`signals.${k}: true or false`);
  if (!Array.isArray(r.jobs)) throw new Error('jobs: a list');
  if (r.jobs.length > PAGE_JOBS) throw new Error(`jobs: at most ${PAGE_JOBS}`);
  const jobs: PaneJob[] = [];
  let dropped = 0;
  r.jobs.forEach((j: unknown, i: number) => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`jobs[${i}]: an object`);
    const x = j as Record<string, unknown>;
    for (const [k, v] of Object.entries(x)) {
      if (!Object.hasOwn(JOB_FIELDS, k)) throw new Error(`jobs[${i}]: unknown field "${k.slice(0, 40)}"`);
      if (typeof v !== 'string') throw new Error(`jobs[${i}].${k}: a string`);
      if (v.length > JOB_FIELDS[k]) throw new Error(`jobs[${i}].${k}: at most ${JOB_FIELDS[k]} characters`);
    }
    if (typeof x.url !== 'string' || typeof x.title !== 'string') throw new Error(`jobs[${i}]: url and title are needed`);
    let host: string;
    try { const u = new URL(x.url); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(); host = u.hostname; } catch { throw new Error(`jobs[${i}].url: an absolute web address`); }
    if (!hostIn(host, portal.hosts)) throw new Error(`jobs[${i}].url: ${host} is not one of ${portal.name}'s hosts`);
    if (x.workplace !== undefined && !WORKPLACES.has(x.workplace as string)) throw new Error(`jobs[${i}].workplace: remote, hybrid or onsite`);
    if (x.apply_kind !== undefined && x.apply_kind !== 'linkedin_easy') throw new Error(`jobs[${i}].apply_kind: linkedin_easy`);
    const url = canonicalJobUrl(x.url, x.url, portal);
    const title = plainStr(x.title as string);
    if (!url || !title) { dropped++; return; }
    jobs.push({
      url, title, company: plainStr(String(x.company ?? '')), location: plainStr(String(x.location ?? '')),
      ...(x.posted_at ? { posted_at: plainStr(x.posted_at as string) } : {}), ...(x.workplace ? { workplace: x.workplace as PaneJob['workplace'] } : {}),
      ...(x.company_country ? { company_country: plainStr(x.company_country as string) } : {}),
      ...(x.description ? { description: plainStr(x.description as string) } : {}), ...(x.apply_kind ? { apply_kind: 'linkedin_easy' as const } : {}),
    });
  });
  return { out: { url: r.url, signals: { sign_in_wall: s.sign_in_wall as boolean, challenge: s.challenge as boolean, empty: s.empty as boolean }, jobs }, dropped };
}

/** A location the gazetteer or the workplace words recognise; card text that isn't one (skills, salary) is dropped. */
export function placeLike(loc: string): boolean {
  if (!loc) return false;
  if (/^(remote|hybrid|work from home|on-?site)\b/i.test(loc)) return true;
  return loc.split(/[,(·|/;]| - /).map((x) => x.replace(/\)$/, '').trim()).filter(Boolean).slice(0, 6).some((x) => (lookupPlace(x) ?? []).length > 0);
}

/** A pane job as a posting for storePostings: dates read, the workplace from the place words, the country as ISO. */
export function toPosting(j: PaneJob, now: Date): Posting {
  const posted = /^\d{9,13}$/.test(j.posted_at ?? '') ? postedAt(Number(j.posted_at), now) : postedAt(j.posted_at, now);
  const location = placeLike(j.location) ? j.location : '';
  const wp = j.workplace ?? workplaceOf(j.location);
  return { url: j.url, title: j.title, company: j.company, location, ...(posted ? { posted_at: posted } : {}), ...(wp ? { workplace: wp } : {}), ...(j.company_country ? { company_country: j.company_country } : {}),
    ...(j.description ? { description: j.description } : {}), ...(j.apply_kind ? { apply_kind: j.apply_kind } : {}) };
}

export type IngestResult = {
  portal: string; found: number; stored: number; new: number; dropped: number;
  stopped?: string; stop_kind?: StopKind | 'paused' | 'limit' | 'not_connected'; paused_until?: string; needs_sign_in?: boolean;
  /** --test: the first few found (nothing is stored). */ sample?: { title: string; company: string; url: string }[];
};

/**
 * One page's answer into the tracker and the portal's state. `pageUrl`: where the pane really is (the page's own `url`
 * otherwise). `test`: nothing stored and last_scan untouched (a connect check), the page still counts for the day.
 */
export function ingestPage(ctx: Ctx, portal: Portal, raw: unknown, o: { pageUrl?: string; test?: boolean } = {}): IngestResult {
  const { out, dropped } = parsePageOutput(raw, portal);
  let page: URL;
  try { page = new URL(o.pageUrl ?? out.url); if (page.protocol !== 'https:' && page.protocol !== 'http:') throw new Error(); } catch { throw new Error('--page-url: the address the pane shows (http or https)'); }
  const at = ctx.clock();
  const res: IngestResult = { portal: portal.id, found: out.jobs.length, stored: 0, new: 0, dropped };
  const st: PortalState = readPortalsState(ctx.home).portals[portal.id] ?? {};
  if (!st.connected) return { ...res, stored: 0, stopped: `${portal.name} is not connected (crewdeck jobs portals mark ${portal.id} connected, once the person is signed in)`, stop_kind: 'not_connected' };
  if (st.pause && Date.parse(st.pause.until) > at.getTime()) return { ...res, stopped: `${portal.name} is paused until ${st.pause.until} (${st.pause.reason})`, stop_kind: 'paused', paused_until: st.pause.until };
  if (st.needs_sign_in && !o.test) return { ...res, stopped: `${portal.name} needs you to sign in again: Jobs page → Sources → Portals → Sign in`, stop_kind: 'sign_in', needs_sign_in: true };
  const today = todayOf(ctx);
  const used = st.day?.date === today ? st.day.pages : 0;
  if (used >= portal.limits.pages_per_day) return { ...res, stopped: `${portal.limits.pages_per_day} pages read today already (the daily limit)`, stop_kind: 'limit' };

  const continuing = !!st.last_scan && at.getTime() - Date.parse(st.last_scan) < SCAN_WINDOW_MS;
  // The same order as a profile scan's classifyPage: another host, a sign-in wall, a challenge, then a quiet block.
  let stop: { kind: StopKind; reason: string } | null = null;
  if (!hostIn(page.hostname, portal.hosts)) stop = { kind: 'challenge', reason: `${portal.name} sent the page to ${page.hostname}` };
  else if (out.signals.sign_in_wall || portal.sign_in_wall.some((w) => { try { return new RegExp(w).test(page.pathname); } catch { return false; } })) stop = { kind: 'sign_in', reason: `${portal.name} asked to sign in again` };
  else if (out.signals.challenge) stop = { kind: 'challenge', reason: `${portal.name} showed a check (CAPTCHA or bot shield): Claude doesn't answer those` };
  else if (!o.test && !continuing && out.jobs.length === 0 && (st.last_found ?? 0) >= EMPTY_ANOMALY) stop = { kind: 'empty', reason: `${portal.name} showed no jobs where the last scan found ${st.last_found}: probably blocked quietly` };

  const postings = stop ? [] : out.jobs.map((j) => toPosting(j, at));
  if (!stop && !o.test) Object.assign(res, storePostings(ctx, portal, postings, at));
  if (o.test) res.sample = out.jobs.slice(0, 5).map((j) => ({ title: j.title, company: j.company, url: j.url }));
  // A new scan (not another page of this one, not a test, not a stop) moves the title rotation on: the groups this scan's
  // plan held are remembered, and the next scan starts from the next variants.
  const searched = !o.test && !stop && !continuing && canScan(portal) ? safeQueries(ctx, portal, st.rotation ?? 0) : null;
  const after = updatePortal(ctx.home, portal.id, (p) => {
    p.day = { date: today, pages: used + 1 };
    if (searched) { p.rotation = (p.rotation ?? 0) + 1; p.last_titles = searched.map((q) => q.titles); }
    if (!o.test) {
      p.last_found = (continuing ? p.last_found ?? 0 : 0) + res.found;
      p.last_new = (continuing ? p.last_new ?? 0 : 0) + res.new;
      p.last_scan = at.toISOString();
    }
    if (stop) {
      p.last_error = stop.reason;
      p.pause = nextPause(p.pause, stop.reason, at);
      if (stop.kind === 'sign_in' && p.connected) p.needs_sign_in = true;
    } else if (!o.test || res.found) { delete p.pause; delete p.last_error; delete p.needs_sign_in; }
  });
  if (stop) {
    res.stopped = stop.reason; res.stop_kind = stop.kind;
    if (after.pause) res.paused_until = after.pause.until;
    if (after.needs_sign_in) res.needs_sign_in = true;
  }
  return res;
}

/** The queries of a scan at `rotation` (what its plan held), or none when the notes can't make any now. */
function safeQueries(ctx: Ctx, portal: Portal, rotation: number) {
  try { return portalQueries(portalProfile(ctx), portal, { rotation }); } catch { return null; }
}

/** Claude's record of the person's sign-in in the pane: connected (the pause and the sign-in flag go) or signed out. */
export function markPortal(ctx: Ctx, portal: Portal, how: 'connected' | 'signed-out'): PortalState {
  return updatePortal(ctx.home, portal.id, (p) => {
    if (how === 'connected') {
      const { pause: _p, needs_sign_in: _n, last_error: _e, ...rest } = p;
      return { ...rest, connected: true, connected_at: ctx.clock().toISOString() };
    }
    // Signed out: a connected portal waits for the person to sign in again; one never connected stays as it was.
    if (p.connected) p.needs_sign_in = true;
    return p;
  });
}
