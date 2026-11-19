// LinkedIn's public guest pages (plain HTTP through netguard, no account, no browser), only when the user switched the
// feature on (design §12): `linkedin_links` for a pasted posting, `linkedin_search` for search. Gentle by construction:
// one request per 2.5 s, a request cap per run, and the whole run stops at the first 429, 999 or redirect (LinkedIn's
// "slow down" and sign-in wall). Applying happens in the user's own signed-in browser pane, never here.
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { addEvent, upsertRole } from './db.ts';
import { cleanHost } from './fields.ts';
import { type FetchOptions, type NetOptions, guardedFetch } from './net/netguard.ts';
import type { JobNotes } from './notes.ts';
import { compileRules, prefilter } from './rules.ts';
import { searchTerms } from './titles.ts';
import { after, plainText } from './text.ts';

export const LINKEDIN_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api';
export const PACE_MS = 2500;
export const MAX_REQUESTS = 60;

export type ApplyKind = 'easy' | 'external' | 'unknown';
export type Card = { id: string; title: string; company: string; location: string; posted_at?: string };
export type Detail = { id: string; title: string; company: string; location: string; description: string; apply_kind: ApplyKind; closed: boolean; posted_at?: string };

/** The numeric job id from any LinkedIn job link: /jobs/view/<id>, /jobs/view/<slug>-<id>, ?currentJobId=<id>, /comm/jobs/view/<id>. */
export function linkedinJobId(input: string): string | null {
  let u: URL;
  try { u = new URL(String(input ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)linkedin\.com$/.test(cleanHost(u.hostname))) return null;
  const cur = u.searchParams.get('currentJobId');
  if (cur && /^\d{6,}$/.test(cur)) return cur;
  return /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/.exec(u.pathname)?.[1] ?? null;
}

export const canonicalJobUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}`;

const text = (h: string) => plainText(h ?? '');

export function parseSearch(html: string): Card[] {
  const out: Card[] = [];
  // Linear scans only (E6): each card is the text between two `<li` tags, fields are found with indexOf.
  const page = String(html ?? '');
  const starts: number[] = [];
  for (const m of page.matchAll(/<li\b/g)) starts.push(m.index!);
  for (let k = 0; k < starts.length; k++) {
    const gt = page.indexOf('>', starts[k]);
    if (gt < 0) break;
    const li = page.slice(gt + 1, k + 1 < starts.length ? starts[k + 1] : page.length);
    const id = /urn:li:jobPosting:(\d+)/.exec(li)?.[1];
    const title = after(li, 'base-search-card__title', 'h3');
    if (!id || !title) continue;
    const company = after(li, 'base-search-card__subtitle', 'h4') ?? '';
    const location = after(li, 'job-search-card__location', 'span') ?? '';
    const d = li.indexOf('job-search-card__listdate');
    const posted = d < 0 ? undefined : /^[^>]{0,300}?datetime="(\d{4}-\d{2}-\d{2})"/.exec(li.slice(d, d + 400))?.[1];
    out.push({ id, title: text(title), company: text(company), location: text(location), posted_at: posted ? `${posted}T00:00:00.000Z` : undefined });
  }
  return out;
}

/** Closed postings say so in the top card. */
export const isClosed = (html: string) => /no longer accepting applications/i.test(html);

export function parseDetail(id: string, html: string): Detail | null {
  html = String(html ?? '');
  const title = after(html, 'topcard__title', 'h[12]');
  if (!title) return null;
  const company = after(html, 'topcard__org-name-link', 'a') ?? after(html, 'topcard__flavor"', 'span') ?? '';
  const location = after(html, 'topcard__flavor topcard__flavor--bullet', 'span') ?? '';
  const desc = after(html, 'show-more-less-html__markup', 'div') ?? '';
  // The apply button carries its kind in the tracking name; off-site links sit behind the sign-in modal.
  const apply_kind: ApplyKind = /apply-link-onsite/.test(html) ? 'easy' : /apply-link-offsite/.test(html) ? 'external' : 'unknown';
  const description = desc.replace(/<br\s*\/?>|<\/(li|p|ul|ol|h\d)>/gi, '\n').replace(/<[^<>]+>/g, ' ').split('\n').map((l) => text(l)).filter(Boolean).join('\n');
  return { id, title: text(title), company: text(company), location: text(location), description, apply_kind, closed: isClosed(html) };
}

export class LinkedinStop extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'LinkedinStop'; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type ClientOptions = { base?: string; net?: NetOptions; paceMs?: number; maxRequests?: number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number };

/** One run's connection to the guest pages: paced, capped, and stopped for good at the first refusal. */
export class LinkedinClient {
  base: string; net: NetOptions; pace: number; cap: number; wait: (ms: number) => Promise<void>; timeoutMs?: number;
  requests = 0; last = 0; stopped: string | null = null;
  constructor(o: ClientOptions = {}) {
    this.base = (o.base ?? LINKEDIN_BASE).replace(/\/+$/, '');
    this.net = o.net ?? {};
    this.pace = o.paceMs ?? PACE_MS;
    this.cap = Math.min(o.maxRequests ?? 30, MAX_REQUESTS);
    this.wait = o.sleep ?? sleep;
    this.timeoutMs = o.timeoutMs;
  }

  /** GET a guest page; '' for 404. Throws LinkedinStop at a refusal or the cap. */
  async get(path: string): Promise<string> {
    if (this.stopped) throw new LinkedinStop(0, this.stopped);
    if (this.requests >= this.cap) throw new LinkedinStop(0, `request cap reached (${this.cap} per run)`);
    const wait = this.last ? this.pace - (Date.now() - this.last) : 0;
    if (wait > 0) await this.wait(wait);
    this.requests++;
    this.last = Date.now();
    const o: FetchOptions = { ...this.net, redirect: 'manual', timeoutMs: this.timeoutMs };
    const r = await guardedFetch(`${this.base}/${path}`, o);
    this.last = Date.now();
    if (r.status === 429 || r.status === 999 || (r.status >= 300 && r.status < 400)) {
      this.stopped = `LinkedIn asked to slow down or sign in (HTTP ${r.status}): stopped for this run`;
      throw new LinkedinStop(r.status, this.stopped);
    }
    if (r.status === 404 || r.status === 410) return '';
    if (r.status < 200 || r.status > 299) {
      this.stopped = `LinkedIn answered HTTP ${r.status}: stopped for this run`;
      throw new LinkedinStop(r.status, this.stopped);
    }
    return r.body;
  }
}

/** One posting from its guest page, or null when LinkedIn doesn't show it (removed, or behind sign-in). */
export async function fetchDetail(client: LinkedinClient, id: string): Promise<Detail | null> {
  if (!/^\d{6,}$/.test(id)) throw new Error('not a LinkedIn job id');
  const html = await client.get(`jobPosting/${id}`);
  return html ? parseDetail(id, html) : null;
}

const WT: Record<string, string> = { onsite: '1', remote: '2', hybrid: '3' };

/** What to search for, from the notes: titles × places, workplace and age filters. */
export function searchPlan(notes: Pick<JobNotes, 'search'>, days = 7) {
  const s = notes.search.data;
  // Each target's first three titles (not every variant, design D22), then roles.titles: the matcher's own list.
  const terms = searchTerms(s);
  const raw = [...s.places.onsite, ...s.places.remote_from].map((p) => p.trim()).filter(Boolean);
  const places = [...new Set(raw.map((p) => (/^(worldwide|anywhere|global)$/i.test(p) ? 'Worldwide' : p)))];
  const wt = [...new Set(s.workplace.map((w) => WT[w]).filter(Boolean))].sort().join(',');
  const tpr = days <= 1 ? 'r86400' : days <= 7 ? 'r604800' : 'r2592000';
  return { terms, places: places.length ? places : ['Worldwide'], f_WT: wt, f_TPR: tpr };
}

export type SearchResult = { cards: number; stored: number; skipped: number; known: number; requests: number; stopped?: string; errors: string[]; roles: string[] };

/** Store one posting read from LinkedIn (a search hit or a pasted link) with its apply kind. */
export function storeLinkedinRole(ctx: Ctx, d: Detail, source: 'linkedin' | 'pasted') {
  const at = nowIso(ctx);
  const res = upsertRole(ctx.db, { url: canonicalJobUrl(d.id), title: d.title.slice(0, 300), company: d.company.slice(0, 200) || 'Unknown', location: d.location.slice(0, 300), description: d.description.slice(0, 200_000), source, posted_at: d.posted_at ?? null, apply_kind: d.apply_kind, source_key: source === 'linkedin' ? 'linkedin' : null });
  if (res.isNew) addEvent(ctx.db, res.id, 'added', `from ${source} (${d.apply_kind === 'easy' ? 'Easy Apply' : d.apply_kind === 'external' ? 'applies on the company site' : 'apply type unknown'})`, at);
  return res;
}

/**
 * Guest search (needs `linkedin_search`): cards for every term × place, checked against the user's rules from the
 * card alone, then details for the survivors (at most `maxDetails`). Stops for the run at the first refusal.
 */
export async function searchLinkedin(ctx: Ctx, o: ClientOptions & { days?: number; pages?: number; maxDetails?: number } = {}): Promise<SearchResult> {
  if (!ctx.features.linkedin_search) throw new Error('LinkedIn search is off: only the user can switch it on (Jobs → Settings, or crewdeck jobs features linkedin_search on in their own terminal)');
  const notes = notesOf(ctx);
  const plan = searchPlan(notes, o.days ?? 7);
  if (!plan.terms.length) throw new Error('jobs/search.md has no job titles to search for (roles.titles or roles.targets)');
  const client = new LinkedinClient(o);
  const compiled = compileRules(notes);
  const res: SearchResult = { cards: 0, stored: 0, skipped: 0, known: 0, requests: 0, errors: [], roles: [] };
  const seen = new Map<string, Card>();
  try {
    outer: for (const place of plan.places) for (const term of plan.terms) for (let p = 0; p < (o.pages ?? 1); p++) {
      if (client.requests >= client.cap) break outer;
      const q = new URLSearchParams({ keywords: term, location: place, f_TPR: plan.f_TPR, start: String(p * 25) });
      if (plan.f_WT) q.set('f_WT', plan.f_WT);
      const cards = parseSearch(await client.get(`seeMoreJobPostings/search?${q}`));
      for (const c of cards) if (!seen.has(c.id)) seen.set(c.id, c);
      if (cards.length < 10) break;
    }
  } catch (e: any) {
    if (!(e instanceof LinkedinStop)) res.errors.push(e.message); else res.stopped = e.message;
  }
  res.cards = seen.size;
  let details = 0;
  for (const c of seen.values()) {
    if (res.stopped) break;
    if (ctx.db.prepare('select 1 from roles where url=?').get(canonicalJobUrl(c.id))) { res.known++; continue; }
    // The card alone often settles it (title, company, location): no detail request for what the rules drop.
    if (!prefilter({ title: c.title, company: c.company, location: c.location }, compiled).keep) { res.skipped++; continue; }
    if (details >= (o.maxDetails ?? 40) || client.requests >= client.cap) break;
    details++;
    try {
      const d = await fetchDetail(client, c.id);
      if (!d || d.closed) { res.skipped++; continue; }
      res.roles.push(storeLinkedinRole(ctx, { ...d, posted_at: c.posted_at }, 'linkedin').id);
      res.stored++;
    } catch (e: any) {
      if (e instanceof LinkedinStop) res.stopped = e.message; else { res.errors.push(e.message); break; }
    }
  }
  res.requests = client.requests;
  return res;
}
