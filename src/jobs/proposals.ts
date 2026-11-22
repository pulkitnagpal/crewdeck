// Proposals (Jobs v2 §8.7, §11, P3 "Tell Crewdeck"): what intake suggests changing in the person's notes. Claude never
// writes the notes from what someone said or pasted; it writes one proposal (`crewdeck jobs propose --file <f>`), and each
// item is applied only when the person approves it, through the same validated writers the page and the CLI use
// (setFields with a dated Changes line, changeSources, remember, a link request).
//
// The one exception: the person's own direct words (origin "person", the item's evidence found word for word in the tell
// request they typed) apply at once for the low-risk kinds (add a target, add a place, add a link, watch a company). They
// still show as an applied proposal the person can undo. Anything quoted or fetched always waits for a click.
//
// ADR-0008 §9 ("from tomorrow…"): any item may carry `effective_from` (YYYY-MM-DD). Approving (or auto-applying) it before
// that day stores it as `scheduled`; applyDue applies it on the first server start or sources run on or after the day.
// Undo before then cancels it.
//
// `portal_add` (a job site the person named, or one a post linked to): a site Crewdeck already knows becomes a
// `portal_toggle` (a catalog portal) or a `source_add` (a catalog board, an employer's ATS page) when it is stored;
// otherwise approving it adds a `teach: true` entry to <jobs.home>/portals/readers.yaml (Claude teaches its reader on
// first connect). It is never applied on its own, whatever the origin, and Undo removes the entry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Ctx, nowIso, todayOf } from './ctx.ts';
import type { Db } from './db.ts';
import { NOTES, readNote } from './notes.ts';
import { setFields } from './edit.ts';
import { changeSources } from './sources-note.ts';
import { remember } from './kb/ops.ts';
import { ISO2, PAY_PERIODS, PORTAL_ID, WORKPLACES, sourceItems } from './schema.ts';
import { place, placeName } from './places.ts';
import { FAMILIES, loadCatalog } from './catalog.ts';
import { hostIn } from './portals/catalog.ts';
import { addPortal, effectivePortals, idFromUrl, removeAddedPortal } from './portals/readers.ts';

export const PROPOSAL_KINDS = ['target_add', 'target_remove', 'place', 'work_mode', 'pay', 'profile_fact', 'answer', 'watch_company', 'add_link', 'source_add', 'source_remove', 'exclude', 'company_countries', 'portal_toggle', 'portal_add'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const ORIGINS = ['person', 'quoted', 'fetched'] as const;
export type Origin = (typeof ORIGINS)[number];
/** Kinds the person's own direct words may apply at once (still listed, and undoable). */
export const AUTO_KINDS: ReadonlySet<ProposalKind> = new Set(['target_add', 'place', 'add_link', 'watch_company', 'company_countries', 'portal_toggle']);
/** Kinds never taken from fetched material (design §8.7: nothing writes profile answers from fetched text). */
const PERSONAL_KINDS: ReadonlySet<ProposalKind> = new Set(['profile_fact', 'answer']);
export const PLACE_FIELDS = ['onsite', 'remote_from', 'relocate_to', 'authorized_in'] as const;
export const EXCLUDE_FIELDS = ['companies', 'industries', 'title_words'] as const;
export const MAX_ITEMS = 20;
export const MAX_SUMMARY = 300;

export type ItemStatus = 'pending' | 'scheduled' | 'approved' | 'rejected';
export type ProposalItem = {
  kind: ProposalKind; payload: Record<string, any>; reason: string; evidence?: string;
  /** The day it takes effect (YYYY-MM-DD, the person's time zone): before it, an approved item waits as `scheduled`. */ effective_from?: string;
  status: ItemStatus;
  /** A scheduled item: how it was approved, so it applies later exactly as it would have then. */ wait?: { quote?: string; where?: string; auto?: boolean };
  /** Applied at once from the person's own words. */ auto?: boolean;
  /** What applying it did, for the line shown and for undo (a source key, a request id). */ done?: string; undo?: Record<string, unknown>;
  /** When it was approved, rejected or undone. */ decided?: string; undone?: boolean;
  /** Approving it failed: the writer's message (the item stays pending). */ error?: string;
};
export type Proposal = { id: number; created: string; updated: string; origin: Origin; summary: string; request: number | null; status: 'pending' | 'done'; items: ProposalItem[] };
export type ProposalInput = { origin: Origin; summary: string; request?: number; items: Pick<ProposalItem, 'kind' | 'payload' | 'reason' | 'evidence' | 'effective_from'>[] };

/** How an approved item reaches the world outside the notes (the server queues a link request; tests record it). */
export type ApplyEnv = {
  ctx: Ctx;
  /** Queue a pasted-link request for a posting; returns the request id. */
  queueLink: (url: string) => number;
  /** Cancel an open link request (undo of an add_link); false when it already ran. */
  cancelLink?: (id: number) => boolean;
};

export class ProposalError extends Error {}
const bad = (m: string): never => { throw new ProposalError(m); };

// ---- validation (the only shape intake may write) ----

const text = (v: unknown, max: number, what: string, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') return required ? bad(`${what} is required`) : undefined;
  if (typeof v !== 'string') return bad(`${what} must be text`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t && required) return bad(`${what} is empty`);
  if (t.length > max) return bad(`${what} is longer than ${max} characters`);
  return t || undefined;
};
const words = (v: unknown, max: number, what: string, required = false): string[] => {
  if (v === undefined || v === null) return required ? bad(`${what} is required`) : [];
  if (!Array.isArray(v) || v.length > max) return bad(`${what} must be a list of at most ${max}`);
  const out = [...new Set(v.map((x, i) => text(x, 120, `${what}[${i}]`)!))];
  if (required && !out.length) return bad(`${what} is empty`);
  return out;
};
const webUrl = (v: unknown, what: string): string => {
  const t = text(v, 2000, what)!;
  let u: URL;
  try { u = new URL(t); } catch { return bad(`${what} is not a web address`); }
  if (!/^https?:$/.test(u.protocol) || /\s/.test(t)) return bad(`${what} must be an http(s) address`);
  return u.href;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => ((list as readonly unknown[]).includes(v) ? v as T : bad(`${what} must be one of ${list.join(', ')}`));
const onlyKeys = (p: Record<string, unknown>, keys: string[], what: string) => {
  for (const k of Object.keys(p)) if (!keys.includes(k)) bad(`${what}: unknown field "${k}" (use ${keys.join(', ')})`);
};

/** One item's payload, checked and normalised for its kind. */
export function checkPayload(kind: ProposalKind, raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${kind}: payload must be a map`);
  const p = raw as Record<string, unknown>;
  const w = `${kind}.payload`;
  switch (kind) {
    case 'target_add': {
      onlyKeys(p, ['name', 'titles', 'families', 'skills'], w);
      const families = words(p.families, 10, `${w}.families`);
      const known = FAMILIES();
      for (const f of families) if (!known.includes(f)) bad(`${w}.families: "${f}" is not a field Crewdeck knows (${known.slice(0, 6).join(', ')}, …)`);
      return { name: text(p.name, 120, `${w}.name`), titles: words(p.titles, 30, `${w}.titles`, true), families, skills: words(p.skills, 30, `${w}.skills`) };
    }
    case 'target_remove': onlyKeys(p, ['name'], w); return { name: text(p.name, 120, `${w}.name`) };
    case 'place': onlyKeys(p, ['field', 'value'], w); return { field: oneOf(p.field, PLACE_FIELDS, `${w}.field`), value: text(p.value, 200, `${w}.value`) };
    case 'work_mode': {
      onlyKeys(p, ['workplace'], w);
      const list = words(p.workplace, 3, `${w}.workplace`, true);
      for (const x of list) oneOf(x, WORKPLACES, `${w}.workplace`);
      return { workplace: list };
    }
    case 'pay': {
      onlyKeys(p, ['floor', 'currency', 'period'], w);
      const out: Record<string, unknown> = {};
      if (p.floor !== undefined) { if (typeof p.floor !== 'number' || !Number.isFinite(p.floor) || p.floor < 0) bad(`${w}.floor must be a number`); out.floor = p.floor; }
      if (p.currency !== undefined) { if (typeof p.currency !== 'string' || !/^[A-Z]{3}$/.test(p.currency)) bad(`${w}.currency is a 3-letter code (USD, EUR…)`); out.currency = p.currency; }
      if (p.period !== undefined) out.period = oneOf(p.period, PAY_PERIODS, `${w}.period`);
      if (!Object.keys(out).length) bad(`${w}: give floor, currency or period`);
      return out;
    }
    case 'profile_fact': case 'answer': {
      onlyKeys(p, ['text', 'key'], w);
      const key = p.key === undefined ? undefined : (typeof p.key === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(p.key) ? p.key : bad(`${w}.key is lowercase words joined by _`));
      if (kind === 'answer' && !key) bad(`${w}.key names the question it answers (e.g. notice_period)`);
      return { text: text(p.text, 2000, `${w}.text`), ...(key ? { key } : {}) };
    }
    case 'watch_company': onlyKeys(p, ['name', 'careers_url'], w); return { name: text(p.name, 120, `${w}.name`), careers_url: webUrl(p.careers_url, `${w}.careers_url`) };
    case 'add_link': onlyKeys(p, ['url'], w); return { url: webUrl(p.url, `${w}.url`) };
    case 'source_add': {
      onlyKeys(p, ['provider', 'careers_url', 'url', 'name'], w);
      const out: Record<string, unknown> = {};
      if (p.provider !== undefined) out.provider = typeof p.provider === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(p.provider) ? p.provider : bad(`${w}.provider is a catalog id`);
      if (p.careers_url !== undefined) out.careers_url = webUrl(p.careers_url, `${w}.careers_url`);
      if (p.url !== undefined) out.url = webUrl(p.url, `${w}.url`);
      if (['provider', 'careers_url', 'url'].filter((k) => out[k]).length !== 1) bad(`${w}: give one of provider, careers_url or url`);
      const name = text(p.name, 120, `${w}.name`, false);
      return name ? { ...out, name } : out;
    }
    case 'source_remove': onlyKeys(p, ['key'], w); return { key: typeof p.key === 'string' && /^[a-z0-9][a-z0-9-]{0,60}$/.test(p.key) ? p.key : bad(`${w}.key is a source key (crewdeck jobs sources list)`) };
    case 'exclude': onlyKeys(p, ['field', 'value'], w); return { field: oneOf(p.field, EXCLUDE_FIELDS, `${w}.field`), value: text(p.value, 200, `${w}.value`) };
    case 'company_countries': {
      // The whole list for each side given (like work_mode); an empty list clears that side.
      onlyKeys(p, ['only', 'exclude'], w);
      const out: Record<string, string[]> = {};
      for (const side of ['only', 'exclude'] as const) {
        if (p[side] === undefined) continue;
        if (!Array.isArray(p[side]) || (p[side] as unknown[]).length > 50) bad(`${w}.${side} must be a list of at most 50 country codes`);
        out[side] = [...new Set((p[side] as unknown[]).map((c, i) => {
          const code = typeof c === 'string' ? c.trim().toLowerCase() : '';
          if (!ISO2.test(code) || place(code)?.kind !== 'country') bad(`${w}.${side}[${i}]: ${JSON.stringify(c)} is not a two-letter country code (in, us, de …)`);
          return code;
        }))];
      }
      if (!Object.keys(out).length) bad(`${w}: give only, exclude or both (lists of country codes)`);
      const both = (out.only ?? []).filter((c) => (out.exclude ?? []).includes(c));
      if (both.length) bad(`${w}: ${both.join(', ')} is in both only and exclude`);
      return out;
    }
    case 'portal_add': {
      onlyKeys(p, ['name', 'url', 'countries', 'fields'], w);
      const url = webUrl(p.url, `${w}.url`);
      const countries = words(p.countries, 12, `${w}.countries`).map((c) => c.toLowerCase());
      for (const c of countries) if (c !== 'world' && (!ISO2.test(c) || place(c)?.kind !== 'country')) bad(`${w}.countries: "${c}" is not a two-letter country code (in, us …) or world`);
      const fields = words(p.fields, 10, `${w}.fields`);
      const known = FAMILIES();
      for (const f of fields) if (f !== 'any' && !known.includes(f)) bad(`${w}.fields: "${f}" is not a field Crewdeck knows (${known.slice(0, 6).join(', ')}, …)`);
      return { name: text(p.name, 80, `${w}.name`), url, ...(countries.length ? { countries } : {}), ...(fields.length ? { fields } : {}) };
    }
    case 'portal_toggle': {
      onlyKeys(p, ['portal', 'on'], w);
      const portal = typeof p.portal === 'string' && PORTAL_ID.test(p.portal) ? p.portal : bad(`${w}.portal is a portal id (lowercase letters, digits and -)`);
      if (typeof p.on !== 'boolean') bad(`${w}.on is true (switch it on) or false (switch it off)`);
      return { portal, on: p.on };
    }
  }
  return bad(`unknown kind ${kind}`);
}

/** A proposal file as intake writes it: checked whole, or refused with the first problem. */
export function checkProposal(raw: unknown): ProposalInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('a proposal is a JSON object { origin, summary, items: [...] }');
  const p = raw as Record<string, any>;
  onlyKeys(p, ['origin', 'summary', 'request', 'items'], 'proposal');
  const origin = oneOf(p.origin, ORIGINS, 'origin');
  let summary = text(p.summary, 5000, 'summary')!;
  if (summary.length > MAX_SUMMARY) summary = `${summary.slice(0, MAX_SUMMARY - 1)}…`;
  const request = p.request === undefined || p.request === null ? undefined : (Number.isInteger(p.request) && p.request > 0 ? p.request as number : bad('request is a request id (a number)'));
  if (!Array.isArray(p.items) || !p.items.length) bad('items: give at least one item');
  if (p.items.length > MAX_ITEMS) bad(`items: at most ${MAX_ITEMS}`);
  const items = p.items.map((it: any, i: number) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) bad(`items[${i}] must be a map`);
    onlyKeys(it, ['kind', 'payload', 'reason', 'evidence', 'effective_from'], `items[${i}]`);
    const kind = oneOf(it.kind, PROPOSAL_KINDS, `items[${i}].kind`);
    if (origin === 'fetched' && PERSONAL_KINDS.has(kind)) bad(`items[${i}]: a ${kind} comes only from the person's own words or their own file, never from a fetched page`);
    const evidence = text(it.evidence, 500, `items[${i}].evidence`, false);
    const from = it.effective_from;
    if (from !== undefined && !isDay(from)) bad(`items[${i}].effective_from is a date, YYYY-MM-DD (e.g. 2026-11-22)`);
    return { kind, payload: checkPayload(kind, it.payload), reason: text(it.reason, 300, `items[${i}].reason`)!, ...(evidence ? { evidence } : {}), ...(from ? { effective_from: from as string } : {}) };
  });
  return { origin, summary, ...(request ? { request } : {}), items };
}

/** A real calendar day written YYYY-MM-DD. */
const isDay = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// ---- the store ----

const row = (r: any): Proposal => ({ id: Number(r.id), created: r.created, updated: r.updated, origin: r.origin, summary: r.summary, request: r.request_id ?? null, status: r.status, items: JSON.parse(r.items_json) });

export function getProposal(db: Db, id: number): Proposal {
  const r = db.prepare('select * from proposals where id = ?').get(id);
  if (!r) throw new ProposalError(`no proposal ${id}`);
  return row(r);
}

/** Open proposals (an item still pending), then those decided in the last `days` days, newest first. */
export function listProposals(db: Db, o: { days?: number; limit?: number; now?: Date } = {}): Proposal[] {
  const since = new Date((o.now ?? new Date()).getTime() - (o.days ?? 7) * 86400_000).toISOString();
  return (db.prepare(`select * from proposals where status = 'pending' or updated >= ? order by id desc limit ?`).all(since, o.limit ?? 50) as any[]).map(row);
}

function save(db: Db, p: Proposal, at: string) {
  // A scheduled item keeps its proposal open (listed with "Starts <date>") until it applies or is undone.
  const status = p.items.some((i) => i.status === 'pending' || i.status === 'scheduled') ? 'pending' : 'done';
  db.prepare('update proposals set items_json = ?, status = ?, updated = ? where id = ?').run(JSON.stringify(p.items), status, at, p.id);
  p.status = status; p.updated = at;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Store a checked proposal. `told` is the text of the tell request it answers (the person's own words, read by the
 * server from the request): a low-risk item of origin "person" whose evidence is found in it word for word applies now.
 */
export function addProposal(env: ApplyEnv, input: ProposalInput, o: { told?: string } = {}): Proposal {
  const at = nowIso(env.ctx);
  const items: ProposalItem[] = input.items.map((i) => ({ ...(i.kind === 'portal_add' ? routePortalAdd(env.ctx, i) : i), status: 'pending' }));
  const id = Number(env.ctx.db.prepare(`insert into proposals(created, updated, origin, summary, request_id, items_json, status) values (?, ?, ?, ?, ?, ?, 'pending')`)
    .run(at, at, input.origin, input.summary, input.request ?? null, JSON.stringify(items)).lastInsertRowid);
  const p = getProposal(env.ctx.db, id);
  const told = o.told ? norm(o.told) : '';
  const today = todayOf(env.ctx);
  p.items.forEach((it, i) => {
    if (input.origin !== 'person' || !AUTO_KINDS.has(it.kind) || !told || !it.evidence || !told.includes(norm(it.evidence))) return;
    if (later(it, today)) return schedule(env, it, { auto: true });
    try { applyAt(env, p, i, { auto: true }); } catch (e: any) { it.error = String(e?.message ?? e).slice(0, 300); }
  });
  save(env.ctx.db, p, nowIso(env.ctx));
  return p;
}

/** Item numbers as the person sees them (1-based); none = every pending item. */
function pick(p: Proposal, n: number | undefined, want: (i: ProposalItem) => boolean): number[] {
  if (n === undefined) return p.items.flatMap((it, i) => (want(it) ? [i] : []));
  if (!Number.isInteger(n) || n < 1 || n > p.items.length) throw new ProposalError(`proposal ${p.id} has items 1 to ${p.items.length}`);
  return [n - 1];
}

/**
 * Approve one item (or every pending one): each goes through its writer; one that fails stays pending with the reason,
 * the others still apply. `quote` is the person's own words for the Changes line (the CLI asks for them).
 */
export function approve(env: ApplyEnv, id: number, n?: number, o: { quote?: string; where?: string } = {}): { proposal: Proposal; applied: number; failed: string[] } {
  const p = getProposal(env.ctx.db, id);
  const idx = pick(p, n, (it) => it.status === 'pending');
  let applied = 0;
  const failed: string[] = [];
  const today = todayOf(env.ctx);
  for (const i of idx) {
    const it = p.items[i];
    if (it.status !== 'pending') throw new ProposalError(`item ${i + 1} is already ${it.status}`);
    // Approved for a later day: it waits (and counts as approved for the caller).
    if (later(it, today)) { schedule(env, it, o); applied++; continue; }
    try { applyAt(env, p, i, o); applied++; } catch (e: any) { it.error = String(e?.message ?? e).slice(0, 300); failed.push(`item ${i + 1}: ${it.error}`); }
  }
  save(env.ctx.db, p, nowIso(env.ctx));
  return { proposal: p, applied, failed };
}

export function reject(env: ApplyEnv, id: number, n?: number): Proposal {
  const p = getProposal(env.ctx.db, id);
  for (const i of pick(p, n, (it) => it.status === 'pending')) {
    if (p.items[i].status !== 'pending') throw new ProposalError(`item ${i + 1} is already ${p.items[i].status}`);
    Object.assign(p.items[i], { status: 'rejected', decided: nowIso(env.ctx), error: undefined });
  }
  save(env.ctx.db, p, nowIso(env.ctx));
  return p;
}

/** An item approved for a day still to come. */
const later = (it: ProposalItem, today: string) => !!it.effective_from && it.effective_from > today;
function schedule(env: ApplyEnv, it: ProposalItem, o: { quote?: string; where?: string; auto?: boolean }) {
  const wait = Object.fromEntries(Object.entries({ quote: o.quote?.trim() || undefined, where: o.where, auto: o.auto || undefined }).filter(([, v]) => v !== undefined));
  Object.assign(it, { status: 'scheduled', decided: nowIso(env.ctx), wait, error: undefined, done: `starts ${it.effective_from}`, ...(o.auto ? { auto: true } : {}) });
}

/**
 * Apply every scheduled item whose day has come (effective_from on or before `today`, the person's day): called on the
 * server's start and at each sources run. One that fails stays scheduled with the reason and is tried again next time.
 */
export function applyDue(env: ApplyEnv, today: string = todayOf(env.ctx)): { applied: number; failed: string[] } {
  let applied = 0;
  const failed: string[] = [];
  const rows = env.ctx.db.prepare(`select id from proposals where status = 'pending' and items_json like '%"scheduled"%' order by id`).all() as any[];
  for (const r of rows) {
    const p = getProposal(env.ctx.db, Number(r.id));
    let touched = false;
    p.items.forEach((it, i) => {
      if (it.status !== 'scheduled' || !it.effective_from || it.effective_from > today) return;
      touched = true;
      const o = it.wait ?? {};
      try {
        applyAt(env, p, i, { ...o, where: o.where ?? `on ${it.effective_from}, as approved` });
        delete it.wait;
        applied++;
      } catch (e: any) {
        it.error = String(e?.message ?? e).slice(0, 300);
        failed.push(`proposal ${p.id} item ${i + 1}: ${it.error}`);
      }
    });
    if (touched) save(env.ctx.db, p, nowIso(env.ctx));
  }
  return { applied, failed };
}

/**
 * Undo an item Crewdeck applied at once from the person's words (its target, place, watched company, link, company
 * countries or portal switch), or cancel any item still waiting for its day.
 */
export function undo(env: ApplyEnv, id: number, n: number): Proposal {
  const p = getProposal(env.ctx.db, id);
  const [i] = pick(p, n, () => false);
  const it = p.items[i];
  if (it.status === 'scheduled') {
    Object.assign(it, { status: 'rejected', undone: true, decided: nowIso(env.ctx), done: `cancelled before ${it.effective_from}`, error: undefined });
    delete it.wait;
    save(env.ctx.db, p, nowIso(env.ctx));
    return p;
  }
  // An added portal can always be taken back (it only made an entry in the person's readers file).
  if (it.status !== 'approved' || it.undone || (!it.auto && it.kind !== 'portal_add')) throw new ProposalError(`item ${n} was not applied by Crewdeck on its own: change it in Preferences or Sources`);
  const because = `undone on the Jobs page: ${it.done ?? it.kind}`;
  const u = it.undo ?? {};
  if (it.kind === 'target_add' && u.target) removeTarget(env.ctx, String(u.target), because);
  else if (it.kind === 'place' && u.field) removeFromList(env.ctx, ['places', String(u.field)], String(u.value), because);
  else if (it.kind === 'watch_company' && u.key) changeSources(env.ctx, { op: 'remove', key: String(u.key) });
  else if (it.kind === 'add_link' && u.request && !(env.cancelLink?.(Number(u.request)) ?? false)) throw new ProposalError('Claude already added that link: skip the role on Today instead');
  else if (it.kind === 'company_countries' && u.before) {
    const before = u.before as Record<string, string[] | null>;
    setFields(searchFile(env.ctx), 'search', Object.entries(before).map(([k, v]) => ({ segs: ['companies', 'countries', k], raw: JSON.stringify(v ?? []) })), { because, today: todayOf(env.ctx) });
  } else if (it.kind === 'portal_add' && u.portal) {
    removeAddedPortal(env.ctx.home, String(u.portal));
    const row = sourceItems(readNote(join(env.ctx.vault, NOTES.sources)).doc.toJS() ?? {}).items.find((x) => x.portal === u.portal);
    if (row) changeSources(env.ctx, { op: 'remove', key: row.key });
  } else if (it.kind === 'portal_toggle' && u.key) {
    if (u.added) changeSources(env.ctx, { op: 'remove', key: String(u.key) });
    else changeSources(env.ctx, { op: u.was === false ? 'disable' : 'enable', key: String(u.key) });
  }
  Object.assign(it, { status: 'rejected', undone: true, decided: nowIso(env.ctx) });
  save(env.ctx.db, p, nowIso(env.ctx));
  return p;
}

// ---- applying one item through the existing writers ----

const searchFile = (ctx: Ctx) => join(ctx.vault, NOTES.search);
const rawSearch = (ctx: Ctx): any => readNote(searchFile(ctx)).doc.toJS() ?? {};
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const TARGET_KEYS = ['name', 'titles', 'families', 'skills'];

/** The words the Changes line quotes: the person's own (evidence of their statement, or their yes), else where it was approved. */
function becauseFor(p: Proposal, it: ProposalItem, o: { quote?: string; where?: string; auto?: boolean }): string {
  if (o.quote?.trim()) return o.quote.trim().slice(0, 1000);
  if (p.origin === 'person' && it.evidence) return it.evidence;
  const from = p.origin === 'person' ? '' : ` from ${p.origin === 'quoted' ? 'quoted' : 'fetched'} material`;
  return `(approved ${o.where ?? 'on the Jobs page'}${from}: ${it.reason})`.slice(0, 1000);
}

function targetsNow(ctx: Ctx): { at: number; t: Record<string, unknown> }[] {
  const raw = rawSearch(ctx)?.roles?.targets;
  return Array.isArray(raw) ? raw.flatMap((t: unknown, at: number) => (t && typeof t === 'object' && !Array.isArray(t) ? [{ at, t: t as Record<string, unknown> }] : [])) : [];
}
const targetName = (t: Record<string, unknown>) => String(t.name ?? strList(t.titles)[0] ?? '');
const shape = (t: Record<string, unknown>) => {
  const families = strList(t.families), skills = strList(t.skills);
  return { ...(t.name ? { name: String(t.name) } : {}), titles: strList(t.titles), ...(families.length ? { families } : {}), ...(skills.length ? { skills } : {}) };
};

function writeTargets(ctx: Ctx, list: { at: number | null; t: Record<string, unknown> }[], because: string) {
  setFields(searchFile(ctx), 'search', [{ segs: ['roles', 'targets'], raw: JSON.stringify(list.map((x) => shape(x.t))), keep: list.map((x) => x.at), owns: TARGET_KEYS }], { because, today: todayOf(ctx) });
}
function removeTarget(ctx: Ctx, name: string, because: string): boolean {
  const now = targetsNow(ctx);
  const left = now.filter((x) => norm(targetName(x.t)) !== norm(name));
  if (left.length === now.length) return false;
  if (!left.length) {
    setFields(searchFile(ctx), 'search', [{ segs: ['roles', 'targets'], raw: '[]' }], { because, today: todayOf(ctx) });
    return true;
  }
  writeTargets(ctx, left, because);
  return true;
}
function addToList(ctx: Ctx, segs: string[], value: string, because: string): boolean {
  const now = strList(segs.reduce((x: any, k) => x?.[k], rawSearch(ctx)));
  if (now.some((x) => norm(x) === norm(value))) return false;
  setFields(searchFile(ctx), 'search', [{ segs, raw: JSON.stringify([...now, value]) }], { because, today: todayOf(ctx) });
  return true;
}
function removeFromList(ctx: Ctx, segs: string[], value: string, because: string): boolean {
  const now = strList(segs.reduce((x: any, k) => x?.[k], rawSearch(ctx)));
  const left = now.filter((x) => norm(x) !== norm(value));
  if (left.length === now.length) return false;
  setFields(searchFile(ctx), 'search', [{ segs, raw: JSON.stringify(left) }], { because, today: todayOf(ctx) });
  return true;
}

/** Apply item i of p through its writer; marks it approved with what was done. Throws (item untouched) on failure. */
function applyAt(env: ApplyEnv, p: Proposal, i: number, o: { quote?: string; where?: string; auto?: boolean }) {
  const { ctx } = env;
  const it = p.items[i];
  const pl = it.payload;
  const because = becauseFor(p, it, o);
  let done = '';
  let undoInfo: Record<string, unknown> | undefined;
  switch (it.kind) {
    case 'target_add': {
      const now = targetsNow(ctx);
      if (now.some((x) => norm(targetName(x.t)) === norm(pl.name))) { done = `${pl.name} is already a target`; break; }
      writeTargets(ctx, [...now, { at: null, t: pl }], because);
      done = `added the target ${pl.name}`; undoInfo = { target: pl.name };
      break;
    }
    case 'target_remove':
      done = removeTarget(ctx, pl.name, because) ? `removed the target ${pl.name}` : `${pl.name} was not a target`;
      break;
    case 'place':
      done = addToList(ctx, ['places', pl.field], pl.value, because) ? `added ${pl.value} to places.${pl.field}` : `${pl.value} was already in places.${pl.field}`;
      undoInfo = done.startsWith('added') ? { field: pl.field, value: pl.value } : undefined;
      break;
    case 'work_mode':
      setFields(searchFile(ctx), 'search', [{ segs: ['workplace'], raw: JSON.stringify(pl.workplace) }], { because, today: todayOf(ctx) });
      done = `workplace: ${pl.workplace.join(', ')}`;
      break;
    case 'pay':
      setFields(searchFile(ctx), 'search', Object.entries(pl).map(([k, v]) => ({ segs: ['pay', k], raw: String(v) })), { because, today: todayOf(ctx) });
      done = `pay: ${Object.entries(pl).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      break;
    case 'profile_fact': case 'answer': {
      const quote = o.quote?.trim() || it.evidence || because;
      const r = remember(ctx, { kind: it.kind === 'answer' ? 'answer' : 'fact', text: pl.text, quote, ...(pl.key ? { key: pl.key } : {}) });
      done = r.existing ? `already remembered as ${r.item.id}` : `remembered as ${r.item.id}`;
      break;
    }
    case 'watch_company': {
      const r = changeSources(ctx, { op: 'add', source: { name: pl.name, careers_url: pl.careers_url, employer: true } });
      done = `watching ${pl.name} (source ${r.key})`; undoInfo = { key: r.key };
      break;
    }
    case 'add_link': {
      const req = env.queueLink(pl.url);
      done = `link sent to Claude (request ${req})`; undoInfo = { request: req };
      break;
    }
    case 'source_add': {
      const r = changeSources(ctx, { op: 'add', source: { ...pl } });
      done = `added the source ${r.key}`;
      break;
    }
    case 'source_remove':
      changeSources(ctx, { op: 'remove', key: pl.key });
      done = `removed the source ${pl.key}`;
      break;
    case 'exclude': {
      const segs = pl.field === 'title_words' ? ['roles', 'exclude_title_words'] : ['exclude', pl.field];
      done = addToList(ctx, segs, pl.value, because) ? `now excluded: ${pl.value}` : `${pl.value} was already excluded`;
      break;
    }
    case 'company_countries': {
      const now = rawSearch(ctx)?.companies?.countries ?? {};
      const sides = Object.keys(pl) as ('only' | 'exclude')[];
      const before = Object.fromEntries(sides.map((k) => [k, strList(now[k])]));
      setFields(searchFile(ctx), 'search', sides.map((k) => ({ segs: ['companies', 'countries', k], raw: JSON.stringify(pl[k]) })), { because, today: todayOf(ctx) });
      done = countriesLine(pl);
      undoInfo = { before };
      break;
    }
    case 'portal_add': {
      const u = new URL(pl.url);
      const cat = effectivePortals(ctx.home);
      let id = idFromUrl(pl.url);
      for (let i = 2; cat.byId.has(id) && i < 50; i++) id = `${idFromUrl(pl.url).slice(0, 27)}-${i}`;
      const p = addPortal(ctx.home, { id, name: pl.name, home_url: `https://${u.host}${u.pathname === '/' ? '/' : u.pathname}`, countries: pl.countries ?? [], fields: pl.fields ?? [] }, cat);
      done = `added the job site ${p.name} (${p.id}): connect it on Sources → Portals, and Claude sets up its reader`;
      undoInfo = { portal: p.id };
      break;
    }
    case 'portal_toggle': {
      const row = sourceItems(readNote(join(ctx.vault, NOTES.sources)).doc.toJS() ?? {}).items.find((x) => x.portal === pl.portal);
      if (row) {
        if (row.enabled !== pl.on) changeSources(ctx, { op: pl.on ? 'enable' : 'disable', key: row.key });
        done = row.enabled === pl.on ? `the portal ${row.name} was already ${pl.on ? 'on' : 'off'}` : `switched ${pl.on ? 'on' : 'off'} the portal ${row.name}`;
        undoInfo = row.enabled === pl.on ? undefined : { key: row.key, was: row.enabled };
      } else {
        const r = changeSources(ctx, { op: 'add', source: { portal: pl.portal, name: portalName(pl.portal), ...(pl.on ? {} : { enabled: false }) } });
        done = `${pl.on ? 'added' : 'added, switched off,'} the portal ${portalName(pl.portal)} (source ${r.key})`;
        undoInfo = { key: r.key, added: true };
      }
      break;
    }
  }
  Object.assign(it, { status: 'approved', decided: nowIso(ctx), done, error: undefined, ...(o.auto ? { auto: true } : {}), ...(undoInfo ? { undo: undoInfo } : {}) });
}

/** One line per item, for the CLI and the panel. */
export function itemLine(it: ProposalItem): string {
  const p = it.payload;
  const what: Record<ProposalKind, () => string> = {
    target_add: () => `Add the target ${p.name} (${p.titles.slice(0, 4).join(', ')})`,
    target_remove: () => `Stop looking for ${p.name}`,
    place: () => `${({ onsite: 'Work on site in', remote_from: 'Work remotely from', relocate_to: 'Move to', authorized_in: 'Allowed to work in' } as Record<string, string>)[p.field]} ${p.value}`,
    work_mode: () => `Work: ${p.workplace.join(', ')}`,
    pay: () => `Pay: ${[p.floor !== undefined ? `at least ${p.floor}` : '', p.currency ?? '', p.period ? `per ${p.period}` : ''].filter(Boolean).join(' ')}`,
    profile_fact: () => `Remember: ${p.text}`,
    answer: () => `Answer ${p.key.replace(/_/g, ' ')}: ${p.text}`,
    watch_company: () => `Watch ${p.name}'s jobs page`,
    add_link: () => `Consider this job: ${p.url}`,
    source_add: () => `Add the source ${p.name ?? p.provider ?? p.careers_url ?? p.url}`,
    source_remove: () => `Remove the source ${p.key}`,
    exclude: () => `Exclude ${({ companies: 'the company', industries: 'the industry', title_words: 'titles with' } as Record<string, string>)[p.field]} ${p.value}`,
    company_countries: () => countriesLine(p),
    portal_toggle: () => `Switch ${p.on ? 'on' : 'off'} the portal ${portalName(p.portal)}`,
    portal_add: () => `Add the job site ${p.name} (${hostName(p.url)})`,
  };
  return what[it.kind]();
}

/** "Only companies headquartered outside India" (one line, the person reads it). */
function countriesLine(p: Record<string, any>): string {
  const n = (cs: string[]) => cs.map((c) => placeName(c)).join(', ');
  const parts: string[] = [];
  if (p.only) parts.push(p.only.length ? `only companies headquartered in ${n(p.only)}` : 'companies from any country');
  if (p.exclude) parts.push(p.exclude.length ? `${p.only?.length ? 'never' : 'only'} companies headquartered ${p.only?.length ? 'in' : 'outside'} ${n(p.exclude)}` : 'no country excluded');
  const t = parts.join('; ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const hostName = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

/** ATS hosts: an employer's careers page there is a source (source_add with careers_url), not a portal. */
const ATS_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'keka.com', 'darwinbox.in', 'darwinbox.com', 'zohorecruit.com', 'zohorecruit.in', 'smartrecruiters.com', 'workable.com', 'recruitee.com', 'teamtailor.com', 'personio.de', 'personio.com', 'breezy.hr', 'jobvite.com', 'icims.com', 'freshteam.com'];
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A `portal_add` for a site Crewdeck already knows becomes what it really is: the catalog portal switched on, an
 * employer's ATS page as a source, or a catalog board as a source. Otherwise it stays a portal_add.
 */
export function routePortalAdd(ctx: Ctx, it: ProposalInput['items'][number]): ProposalInput['items'][number] {
  const pl = it.payload;
  let host = '';
  try { host = new URL(pl.url).hostname.toLowerCase(); } catch { return it; }
  const note = (r: string) => `${it.reason} (${r})`.slice(0, 300);
  const portal = effectivePortals(ctx.home).portals.find((p) => hostIn(host, p.hosts));
  if (portal) return { ...it, kind: 'portal_toggle', payload: { portal: portal.id, on: true }, reason: note(`already one of Crewdeck's portals: ${portal.name}`) };
  if (hostIn(host, ATS_HOSTS)) return { ...it, kind: 'source_add', payload: { careers_url: pl.url, name: pl.name }, reason: note('an employer\'s careers page: watched as a source') };
  const label = squash(host.replace(/^(www|jobs|careers)\./, '').split('.')[0] ?? '');
  const board = label.length >= 4 ? loadCatalog().sources.find((c) => c.runnable && !c.retired && !c.blocked && c.needs !== 'careers_url' && c.kind !== 'ats' && (squash(c.id) === label || squash(c.name) === label)) : undefined;
  if (board) return { ...it, kind: 'source_add', payload: { provider: board.id, name: board.name }, reason: note(`a job board Crewdeck reads: ${board.name}`) };
  return it;
}

/** A portal's name from the portals catalog when there is one (ADR-0008 §6), else its id. */
function portalName(id: string): string {
  try {
    const file = join(import.meta.dirname, 'data', 'portals.yaml');
    if (!existsSync(file)) return id;
    const y = parseYaml(readFileSync(file, 'utf8')) as any;
    const list: any[] = Array.isArray(y) ? y : Array.isArray(y?.portals) ? y.portals : [];
    const hit = list.find((x) => x?.id === id);
    return typeof hit?.name === 'string' && hit.name.trim() ? hit.name.trim() : id;
  } catch { return id; }
}

/** What the page and the panel see: every item with its number and line; never more than the proposal holds. */
export function proposalView(p: Proposal) {
  return {
    id: p.id, created: p.created, origin: p.origin, summary: p.summary, status: p.status, request: p.request,
    items: p.items.map((it, i) => ({ n: i + 1, kind: it.kind, line: itemLine(it), reason: it.reason, evidence: it.evidence ?? null, status: it.status,
      auto: !!it.auto, undone: !!it.undone, done: it.done ?? null, error: it.error ?? null,
      // "Starts <date>" while it waits for its day; null once applied, cancelled, or without a date.
      starts: it.status === 'scheduled' || it.status === 'pending' ? it.effective_from ?? null : null,
      can_undo: (it.status === 'approved' && (!!it.auto || it.kind === 'portal_add') && !it.undone) || it.status === 'scheduled' })),
  };
}

/** Every pending item across proposals (the page's badge, the panel's count). */
export const pendingCount = (db: Db) => (db.prepare(`select items_json from proposals where status = 'pending'`).all() as any[])
  .reduce((n, r) => n + (JSON.parse(r.items_json) as ProposalItem[]).filter((i) => i.status === 'pending').length, 0);

