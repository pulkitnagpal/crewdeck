// Full descriptions for every rule-passing posting (jobs v2 P1b; design §2.2, §14 P1). After the prefilter, every role
// still waiting to be judged whose description is missing (< 200 characters) or was cut by a provider (exactly 4,000
// characters: career-ops' DESCRIPTION_CAP) gets its posting read again, through netguard, in rank order:
//   - a board's own detail API where it has one (Himalayas: its documented public posting API; the HTML page answers 403);
//   - otherwise the posting page, read as schema.org JobPosting JSON-LD (then meta tags), structured fields included.
// Gentle and bounded: one request at a time per host with a short pace, up to 2 retries with jittered backoff on 5xx and
// timeouts, a host that answers 403 or 429 is left alone for the rest of the run, and each role is tried at most once
// a day (roles.detail_status / detail_at). LinkedIn's roles are read by its own paced client, never here.
import { type Ctx, notesOf, nowIso } from '../ctx.ts';
import { addEvent, setStatus } from '../db.ts';
import { hostOf, isLinkedinHost, isXHost } from '../fields.ts';
import { type NetOptions, NetError, guardedFetch } from '../net/netguard.ts';
import type { Posting } from '../link.ts';
import { DESC_CAP, plainText } from '../text.ts';
import { zoneOf } from '../time.ts';
import { rankRoles } from './rank.ts';

export { DESC_CAP };
/** The cap the pinned providers apply (career-ops providers/_html-to-text.mjs): a text exactly this long was cut. */
export const OLD_CAP = 4000;
/** Fewer plain characters than this is not a description a judge can use. */
export const FULL_MIN = 200;
export const RETRY_AFTER_MS = 86_400_000;
export const HIMALAYAS_API = 'https://himalayas.app/jobs/api';

/** Missing, too short to judge, or cut at the providers' 4,000 characters. */
export function needsDescription(desc: string | null | undefined): boolean {
  const t = String(desc ?? '');
  return t.length === OLD_CAP || plainText(t).length < FULL_MIN;
}

/** A full description (what the sources state counts per source; its SQL twin is in sources.ts keyStates). */
export const isFull = (desc: string | null | undefined) => !needsDescription(desc);

// ---- Himalayas (https://himalayas.app/docs/remote-jobs-api) ----

const TRACKING = /^utm_[a-z_]+$/;
/** The posting API path for a Himalayas posting link (companies/<company>/jobs/<slug>), or null. */
export function himalayasPath(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'himalayas.app' || u.port || u.username || u.password) return null;
  const m = /^\/companies\/([a-z0-9][a-z0-9-]{0,255})\/jobs\/([a-z0-9][a-z0-9-]{0,255})\/?$/.exec(u.pathname);
  if (!m || [...u.searchParams.keys()].some((k) => !TRACKING.test(k))) return null;
  return `companies/${m[1]}/jobs/${m[2]}`;
}

const PERIOD: Record<string, string> = { annual: 'year', yearly: 'year', year: 'year', monthly: 'month', month: 'month', weekly: 'week', daily: 'day', hourly: 'hour', hour: 'hour' };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const epochIso = (v: unknown) => {
  const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : NaN;
  return Number.isFinite(n) ? new Date(n).toISOString() : undefined;
};

/** One posting from the Himalayas API's `{ job }` answer (shape checked; every string treated as data). */
export function readHimalayasJob(body: any): Posting | null {
  const j = body && typeof body === 'object' ? body.job : null;
  if (!j || typeof j !== 'object' || typeof j.description !== 'string') return null;
  const s = (v: unknown, max = 300) => (typeof v === 'string' ? plainText(v).slice(0, max) : '');
  const where = Array.isArray(j.locationRestrictions) ? j.locationRestrictions.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => s(x, 100)).slice(0, 60) : [];
  const min = num(j.minSalary), max = num(j.maxSalary), cur = s(j.currency, 10), per = PERIOD[String(j.salaryPeriod ?? '').toLowerCase()];
  const range = min && max && min !== max ? `${min}–${max}` : String(min ?? max ?? '');
  return {
    title: s(j.title) || undefined, company: s(j.companyName) || undefined,
    description: plainText(j.description) || undefined,
    location: where.length ? `Remote (${where.join(', ')})` : 'Remote (worldwide)',
    workplace: 'remote', remote_countries: where.length ? where : ['Worldwide'],
    employment_type: s(j.employmentType, 100) || undefined,
    pay_text: range ? `${cur ? `${cur} ` : ''}${range}${per ? ` per ${per}` : ''}` : undefined,
    posted_at: epochIso(j.pubDate), valid_through: epochIso(j.expiryDate),
  };
}

// ---- one role ----

type Outcome =
  | { kind: 'found'; p: Posting }
  | { kind: 'closed'; reason: string }
  | { kind: 'http'; status: number }
  | { kind: 'error'; message: string; retry: boolean };

export type DetailOptions = {
  net?: NetOptions; limit?: number; concurrency?: number; retries?: number; paceMs?: number; backoffMs?: number;
  timeoutMs?: number; deadlineMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number;
  /** Test seam: where Himalayas' posting API lives. */ himalayasApi?: string;
};

async function readOne(url: string, at: Date, o: DetailOptions): Promise<Outcome> {
  const hp = himalayasPath(url);
  if (hp) {
    const r = await guardedFetch(`${(o.himalayasApi ?? HIMALAYAS_API).replace(/\/+$/, '')}/${hp}`, { ...o.net, timeoutMs: o.timeoutMs ?? 15_000, redirect: 'manual', headers: { accept: 'application/json' } });
    // The API's 410 is its documented "expired"; its 404 only means no record at that path.
    if (r.status === 410) return { kind: 'closed', reason: 'Himalayas says the posting expired' };
    if (r.status !== 200) return { kind: 'http', status: r.status };
    let body: any;
    try { body = JSON.parse(r.body); } catch { return { kind: 'error', message: 'Himalayas answered something that is not JSON', retry: false }; }
    const p = readHimalayasJob(body);
    if (!p) return { kind: 'error', message: 'Himalayas answered without a posting', retry: false };
    if (p.valid_through && Date.parse(p.valid_through) < at.getTime()) return { kind: 'closed', reason: `the posting expired on ${p.valid_through.slice(0, 10)}` };
    return { kind: 'found', p };
  }
  const page = await guardedFetch(url, { ...o.net, timeoutMs: o.timeoutMs ?? 15_000 });
  if (page.status === 404 || page.status === 410) return { kind: 'closed', reason: `the posting page answered HTTP ${page.status}` };
  if (page.status < 200 || page.status > 299) return { kind: 'http', status: page.status };
  const { readPostingPage } = await import('../link.ts');
  const p = readPostingPage(page.body, at);
  if (p.closed) return { kind: 'closed', reason: `the posting is closed: ${p.closed_reason}` };
  return { kind: 'found', p };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRY_CODES = new Set(['timeout', 'network']);

/** One role with up to `retries` retries (5xx, timeouts, dropped connections), each after a jittered backoff. */
async function withRetries(url: string, at: Date, o: DetailOptions, stats: { retried: number }): Promise<Outcome> {
  const retries = Math.max(0, Math.min(o.retries ?? 2, 2));
  const wait = o.sleep ?? sleep, rnd = o.random ?? Math.random, base = o.backoffMs ?? 1000;
  for (let n = 0; ; n++) {
    let out: Outcome;
    try { out = await readOne(url, at, o); }
    catch (e: any) { out = { kind: 'error', message: String(e?.message ?? e).slice(0, 200), retry: e instanceof NetError ? RETRY_CODES.has(e.code) : false }; }
    const again = out.kind === 'error' ? out.retry : out.kind === 'http' && out.status >= 500;
    if (!again || n >= retries) return out;
    stats.retried++;
    await wait(base * 2 ** n + Math.floor(rnd() * base));
  }
}

export type DetailsResult = { tried: number; found: number; closed: number; errors: number; retried: number; deferred: number; backed_off: string[] };

/**
 * Read the posting of every rule-passing role that needs a description (rank order, at most `limit` per run), and store
 * the full text with what the page says in structure (workplace, remote countries, employment type, pay, closing date).
 */
export async function fetchDetails(ctx: Ctx, o: DetailOptions = {}): Promise<DetailsResult> {
  const out: DetailsResult = { tried: 0, found: 0, closed: 0, errors: 0, retried: 0, deferred: 0, backed_off: [] };
  const limit = o.limit ?? 1000;
  if (limit <= 0) return out;
  const at = ctx.clock();
  const since = new Date(at.getTime() - RETRY_AFTER_MS).toISOString();
  const last = ctx.db.prepare('select detail_at from roles where id=?');
  const todo = rankRoles(ctx).filter((r) => {
    if (!needsDescription(r.description)) return false;
    const h = hostOf(r.url);
    if (!h || isLinkedinHost(h) || isXHost(h)) return false;
    const d = (last.get(r.id) as any)?.detail_at;
    return !d || d < since;
  }).slice(0, limit);
  if (!todo.length) return out;

  // One queue per host, in rank order; hosts are worked in parallel, each host's roles one at a time.
  const byHost = new Map<string, typeof todo>();
  for (const r of todo) { const h = hostOf(r.url); byHost.set(h, [...(byHost.get(h) ?? []), r]); }
  const hosts = [...byHost.keys()];
  const blocked = new Set<string>();
  const deadline = Date.now() + (o.deadlineMs ?? 10 * 60_000);
  const wait = o.sleep ?? sleep, pace = o.paceMs ?? 250;
  const save = ctx.db.prepare(`update roles set description=?, pay_text=coalesce(pay_text, ?), posted_at=coalesce(posted_at, ?),
      location=coalesce(nullif(location, ''), ?), employment_type=coalesce(employment_type, ?), workplace=coalesce(?, workplace),
      remote_countries=coalesce(?, remote_countries), valid_through=coalesce(?, valid_through), detail_status=?, detail_at=?, updated_at=? where id=?`);
  const mark = ctx.db.prepare('update roles set detail_status=?, detail_at=? where id=?');

  const one = async (r: (typeof todo)[number]) => {
    const now = nowIso(ctx);
    out.tried++;
    const res = await withRetries(r.url, at, o, out);
    if (res.kind === 'closed') {
      mark.run('closed', now, r.id);
      setStatus(ctx.db, r.id, 'expired', res.reason, now);
      out.closed++;
      return;
    }
    if (res.kind === 'http' || res.kind === 'error') {
      const status = res.kind === 'http' ? `http_${res.status}` : 'error';
      mark.run(status, now, r.id);
      addEvent(ctx.db, r.id, 'details', res.kind === 'http' ? `HTTP ${res.status}` : `not read: ${res.message}`, now);
      out.errors++;
      // The host said no (forbidden, or slow down): nothing more is asked of it in this run.
      if (res.kind === 'http' && (res.status === 403 || res.status === 429)) blocked.add(hostOf(r.url));
      return;
    }
    const p = res.p;
    const text = (p.description ?? '').slice(0, DESC_CAP);
    const longer = text.length > String(r.description ?? '').length;
    const full = longer && !needsDescription(text);
    save.run(longer ? text : r.description ?? '', p.pay_text ?? null, p.posted_at ?? null, p.location ?? null, p.employment_type ?? null, p.workplace ?? null,
      p.remote_countries?.length ? JSON.stringify(p.remote_countries) : null, p.valid_through ?? null, full ? 'ok' : 'none', now, now, r.id);
    addEvent(ctx.db, r.id, 'details', full ? 'description read from the posting' : 'no fuller description on the posting', now);
    if (full) out.found++;
  };

  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const h = hosts[next++];
      const list = byHost.get(h)!;
      for (let i = 0; i < list.length; i++) {
        if (blocked.has(h) || Date.now() > deadline) { out.deferred += list.length - i; break; }
        if (i > 0 && pace > 0) await wait(pace);
        await one(list[i]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 4, 8)) }, worker));
  out.backed_off = [...blocked].sort();
  return out;
}

/** "14:05" in the user's zone (jobs/search.md schedule.timezone, else this machine's). */
export function localClock(ctx: Ctx, iso: string): string {
  let tz: string | undefined;
  try { tz = (notesOf(ctx).search.data as any).schedule?.timezone; } catch {}
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: zoneOf(tz), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
