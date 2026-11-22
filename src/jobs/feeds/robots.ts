// robots.txt for feed hosts: fetched at most once a week per host (cached in memory and, through `store`, in
// jobs.db), and a feed URL is skipped when the rules for our agent ("crewdeck") or for `*` disallow its path.
// A 4xx robots.txt means no rules (RFC 9309 §2.3.1.3); a 5xx or network failure means "don't fetch for now" and is
// retried after an hour.
import { errText } from './http.ts';
import type { FeedFetch } from './types.ts';

export const ROBOTS_TTL_MS = 7 * 86_400_000;
const RETRY_MS = 3_600_000;
export const ROBOTS_AGENT = 'crewdeck';

type Rule = { allow: boolean; path: string };
export type RobotsRules = { agents: Map<string, Rule[]> };
export type RobotsEntry = { host: string; status: number; body: string; fetchedAt: number };
export type RobotsStore = { get(host: string): RobotsEntry | undefined; set(e: RobotsEntry): void };

/** Parse robots.txt into rule groups by user-agent token (lower case). */
export function parseRobots(txt: string): RobotsRules {
  const agents = new Map<string, Rule[]>();
  let current: string[] = [], inRules = false;
  for (const raw of String(txt ?? '').slice(0, 500_000).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (inRules) { current = []; inRules = false; }
      const a = val.toLowerCase();
      current.push(a);
      if (!agents.has(a)) agents.set(a, []);
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!val && key === 'disallow') continue; // "Disallow:" (empty) allows everything
      for (const a of current) agents.get(a)!.push({ allow: key === 'allow', path: val });
    } else inRules = inRules || current.length > 0;
  }
  return { agents };
}

function matches(pattern: string, path: string): number {
  // `*` any run, `$` end; returns the pattern's length on a match (longest match wins), else -1.
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path) ? pattern.length : -1;
}

function allowedBy(rules: Rule[] | undefined, path: string): boolean {
  if (!rules) return true;
  let best = -1, allow = true;
  for (const r of rules) {
    const n = matches(r.path, path);
    if (n > best || (n === best && n >= 0 && r.allow)) { best = n; allow = r.allow; }
  }
  return allow;
}

/** May our agent fetch `pathAndQuery`? No when the group for our token, or the `*` group, disallows it. */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string, agent = ROBOTS_AGENT): boolean {
  const ours = [...rules.agents.keys()].find((a) => a !== '*' && a !== '' && (agent.includes(a) || a.includes(agent)));
  if (ours && !allowedBy(rules.agents.get(ours), pathAndQuery)) return false;
  return allowedBy(rules.agents.get('*'), pathAndQuery);
}

/** A robots cache over a FeedFetch (pass the polite one: robots.txt counts against the host's pace). */
export class Robots {
  private mem = new Map<string, RobotsEntry>();
  private fetch: FeedFetch;
  private o: { store?: RobotsStore; now?: () => number; ttlMs?: number };
  constructor(fetch: FeedFetch, o: { store?: RobotsStore; now?: () => number; ttlMs?: number } = {}) { this.fetch = fetch; this.o = o; }

  private fresh(e: RobotsEntry | undefined, now: number): e is RobotsEntry {
    if (!e) return false;
    const ttl = e.status >= 500 || e.status === 0 ? RETRY_MS : this.o.ttlMs ?? ROBOTS_TTL_MS;
    return now - e.fetchedAt < ttl;
  }

  async entry(origin: string, signal?: AbortSignal): Promise<RobotsEntry> {
    const now = (this.o.now ?? Date.now)();
    const host = new URL(origin).host.toLowerCase();
    let e: RobotsEntry | undefined = this.mem.get(host);
    if (!this.fresh(e, now)) e = this.o.store?.get(host);
    if (this.fresh(e, now)) { this.mem.set(host, e); return e; }
    let next: RobotsEntry;
    try {
      const r = await this.fetch({ url: `${new URL(origin).origin}/robots.txt`, headers: { accept: 'text/plain, */*;q=0.5' } }, signal);
      next = { host, status: r.status, body: r.status >= 200 && r.status < 300 ? r.body.slice(0, 500_000) : '', fetchedAt: now };
    } catch (err) {
      next = { host, status: 0, body: errText(err), fetchedAt: now };
    }
    this.mem.set(host, next);
    this.o.store?.set(next);
    return next;
  }

  /** { ok } for the URL, with a reason when it is skipped. */
  async check(url: string, signal?: AbortSignal): Promise<{ ok: boolean; reason?: string }> {
    const u = new URL(url);
    const e = await this.entry(u.origin, signal);
    if (e.status === 0 || e.status >= 500) return { ok: false, reason: `robots.txt for ${u.host} could not be read (${e.status || e.body}): skipped for now` };
    if (e.status >= 400) return { ok: true };
    return robotsAllows(parseRobots(e.body), u.pathname + u.search) ? { ok: true } : { ok: false, reason: `robots.txt for ${u.host} disallows ${u.pathname}` };
  }
}
