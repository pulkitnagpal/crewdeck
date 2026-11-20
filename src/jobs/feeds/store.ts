// Where feed results live in jobs.db. The roles table has no columns for structured place, remoteness or pay, so
// every normalised posting is kept whole in `postings_ats` and mapped onto a role (postingToRole) for the existing
// pipeline (prefilter, judging, picking). The tables are additive and created on first use with
// `create table if not exists` — no user_version bump, so this cannot collide with the v5 migration being written
// elsewhere; fold them into that migration when it lands.
import { createHash } from 'node:crypto';
import { type Db, type RoleInput, addEvent, tx, upsertRole } from '../db.ts';
import { placeName } from '../places.ts';
import type { RobotsEntry, RobotsStore } from './robots.ts';
import type { Board, Pay, Posting } from './types.ts';
import { boardKey } from './types.ts';

const ready = new WeakSet<Db>();
/** Create the feed tables if missing (a plain literal: the SQL guard test checks every exec). */
export function ensureFeedTables(db: Db) {
  if (ready.has(db)) return;
  db.exec(`
create table if not exists postings_ats (
  id text primary key, ats text not null, board text not null, ats_job_id text not null, company text not null, title text not null,
  url text not null, apply_url text, description_text text not null default '', description_html text,
  locations_json text not null default '[]', workplace text not null default 'unknown', remote_countries_json text not null default '[]',
  countries_json text not null default '[]', employment_type text, pay_json text, posted_at text, updated_at text, closes_at text,
  department text, raw_json text, content_hash text not null, role_id text, first_seen text not null, last_seen text not null,
  changed_at text, closed_at text, unique (board, ats_job_id));
create index if not exists postings_ats_board on postings_ats(board, closed_at);
create index if not exists postings_ats_seen on postings_ats(last_seen);
create table if not exists feed_boards (
  key text primary key, ats text not null, slug text not null, host text, site text, company text, etag text,
  last_status text, last_error text, last_ok text, fetched_at text, postings integer not null default 0);
create table if not exists feed_hosts (host text primary key, robots_status integer, robots_body text, robots_at integer);
`);
  ready.add(db);
}

export const postingId = (p: Pick<Posting, 'ats' | 'board' | 'atsJobId'>) => createHash('sha1').update(`${p.ats}\n${p.board}\n${p.atsJobId}`).digest('hex').slice(0, 16);

/** What counts as a change: what a person or the judge would read (not raw fields, not last-seen). */
export function contentHash(p: Posting): string {
  const c = [p.title, p.url, p.applyUrl, p.descriptionText, p.locations, p.workplace, p.remoteCountries, p.countries, p.employmentType, p.pay ?? null, p.postedAt, p.updatedAt, p.closesAt ?? '', p.department ?? '', p.company];
  return createHash('sha1').update(JSON.stringify(c)).digest('hex');
}

export function boardState(db: Db, b: Board): { etag?: string; known: Set<string> } {
  ensureFeedTables(db);
  const key = boardKey(b);
  const row = db.prepare('select etag from feed_boards where key = ?').get(key) as any;
  const known = new Set((db.prepare('select ats_job_id from postings_ats where board = ? and closed_at is null').all(key) as any[]).map((r) => String(r.ats_job_id)));
  return { etag: row?.etag ?? undefined, known };
}

export function saveBoardState(db: Db, b: Board, s: { etag?: string; status: string; error?: string; ok: boolean; at: string; postings?: number }) {
  ensureFeedTables(db);
  db.prepare(`insert into feed_boards(key, ats, slug, host, site, company, etag, last_status, last_error, last_ok, fetched_at, postings)
      values (?,?,?,?,?,?,?,?,?,?,?,coalesce(?, 0))
      on conflict(key) do update set etag=coalesce(excluded.etag, feed_boards.etag), last_status=excluded.last_status, last_error=excluded.last_error,
        last_ok=coalesce(excluded.last_ok, feed_boards.last_ok), fetched_at=excluded.fetched_at, postings=coalesce(?, feed_boards.postings),
        host=excluded.host, site=excluded.site, company=coalesce(excluded.company, feed_boards.company)`)
    .run(boardKey(b), b.ats, b.slug, b.host ?? null, b.site ?? null, b.company ?? null, s.etag ?? null, s.status, s.error ?? null, s.ok ? s.at : null, s.at, s.postings ?? null, s.postings ?? null);
}

const PERIOD_WORD = { year: 'a year', month: 'a month', week: 'a week', day: 'a day', hour: 'an hour' } as const;
export function payText(p?: Pay): string | null {
  if (!p) return null;
  const n = (x: number | null) => (x === null ? '' : x.toLocaleString('en-US'));
  const range = p.min !== null && p.max !== null && p.min !== p.max ? `${n(p.min)}–${n(p.max)}` : n(p.min ?? p.max);
  return [p.currency, range, p.period ? PERIOD_WORD[p.period] : ''].filter(Boolean).join(' ');
}

const countryNames = (cs: string[]) => cs.map((c) => (c === '*' ? 'anywhere' : placeName(c.toLowerCase()))).join(', ');

/** The role row for a posting: the existing pipeline's view (location text carries remoteness and its scope). */
export function postingToRole(p: Posting): RoleInput {
  const head = p.workplace === 'remote'
    ? (p.remoteCountries[0] === '*' ? 'Remote (anywhere)' : p.remoteCountries.length && p.remoteCountries.length <= 12 ? `Remote (${countryNames(p.remoteCountries)})` : 'Remote')
    : p.workplace === 'hybrid' ? 'Hybrid' : p.workplace === 'onsite' ? 'On-site' : '';
  const location = [head, p.locations.join('; ')].filter(Boolean).join(' · ').slice(0, 300);
  return {
    url: p.url, title: p.title.slice(0, 300), company: p.company.slice(0, 200), location, description: p.descriptionText.slice(0, 200_000),
    source: 'board', source_key: `ats:${p.board}`, pay_text: payText(p.pay), posted_at: p.postedAt || null,
    apply_url: p.applyUrl || null, apply_kind: 'external', employment_type: p.employmentType || null,
  };
}

export type WriteResult = 'new' | 'changed' | 'same' | 'seen';

/**
 * Upsert one posting (and, unless `roles` is false, its role). A partial posting (Workday, detail not fetched again)
 * only refreshes last_seen. Returns what happened.
 */
export function writePosting(db: Db, p: Posting, at: string, o: { roles?: boolean } = {}): WriteResult {
  ensureFeedTables(db);
  const id = postingId(p);
  return tx(db, () => {
    const prev = db.prepare('select content_hash, role_id, closed_at from postings_ats where id = ?').get(id) as any;
    if (p.partial) {
      if (!prev) return 'seen';
      db.prepare('update postings_ats set last_seen = ?, closed_at = null where id = ?').run(at, id);
      return 'seen';
    }
    const hash = contentHash(p);
    if (prev && prev.content_hash === hash) {
      db.prepare('update postings_ats set last_seen = ?, closed_at = null where id = ?').run(at, id);
      return 'same';
    }
    let roleId: string | null = prev?.role_id ?? null;
    if (o.roles !== false) {
      const r = upsertRole(db, postingToRole(p));
      roleId = r.id;
      if (r.isNew) addEvent(db, r.id, 'added', `from ${p.ats} board ${p.board.split(':')[1]}`, at);
    }
    const J = JSON.stringify;
    db.prepare(`insert into postings_ats(id, ats, board, ats_job_id, company, title, url, apply_url, description_text, description_html, locations_json,
        workplace, remote_countries_json, countries_json, employment_type, pay_json, posted_at, updated_at, closes_at, department, raw_json, content_hash,
        role_id, first_seen, last_seen, changed_at, closed_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,null)
        on conflict(id) do update set company=excluded.company, title=excluded.title, url=excluded.url, apply_url=excluded.apply_url,
          description_text=excluded.description_text, description_html=excluded.description_html, locations_json=excluded.locations_json,
          workplace=excluded.workplace, remote_countries_json=excluded.remote_countries_json, countries_json=excluded.countries_json,
          employment_type=excluded.employment_type, pay_json=excluded.pay_json, posted_at=excluded.posted_at, updated_at=excluded.updated_at,
          closes_at=excluded.closes_at, department=excluded.department, raw_json=excluded.raw_json, content_hash=excluded.content_hash,
          role_id=coalesce(excluded.role_id, postings_ats.role_id), last_seen=excluded.last_seen, changed_at=excluded.changed_at, closed_at=null`)
      .run(id, p.ats, p.board, p.atsJobId, p.company, p.title, p.url, p.applyUrl, p.descriptionText, p.descriptionHtml ?? null, J(p.locations),
        p.workplace, J(p.remoteCountries), J(p.countries), p.employmentType || null, p.pay ? J(p.pay) : null, p.postedAt || null, p.updatedAt || null,
        p.closesAt ?? null, p.department ?? null, J(p.raw ?? {}), hash, roleId, at, at, prev ? at : null);
    return prev ? 'changed' : 'new';
  });
}

/** Postings of a board not seen in a complete fetch at `at`: marked closed. Returns how many. */
export function closeMissing(db: Db, board: string, at: string): number {
  ensureFeedTables(db);
  return Number(db.prepare('update postings_ats set closed_at = ? where board = ? and closed_at is null and last_seen < ?').run(at, board, at).changes);
}

/** A stored posting back as a Posting (for the matcher, previews and tests). */
export function readPosting(db: Db, id: string): Posting | undefined {
  ensureFeedTables(db);
  const r = db.prepare('select * from postings_ats where id = ?').get(id) as any;
  if (!r) return undefined;
  return {
    source: 'ats', ats: r.ats, board: r.board, atsJobId: r.ats_job_id, company: r.company, title: r.title, url: r.url, applyUrl: r.apply_url ?? r.url,
    descriptionText: r.description_text, ...(r.description_html ? { descriptionHtml: r.description_html } : {}), locations: JSON.parse(r.locations_json),
    workplace: r.workplace, remoteCountries: JSON.parse(r.remote_countries_json), countries: JSON.parse(r.countries_json), employmentType: r.employment_type ?? '',
    ...(r.pay_json ? { pay: JSON.parse(r.pay_json) } : {}), postedAt: r.posted_at ?? '', updatedAt: r.updated_at ?? '', ...(r.closes_at ? { closesAt: r.closes_at } : {}),
    ...(r.department ? { department: r.department } : {}), raw: JSON.parse(r.raw_json ?? '{}'),
  };
}

/** robots.txt entries kept in jobs.db (so "once a week per host" holds across runs). */
export function dbRobotsStore(db: Db): RobotsStore {
  ensureFeedTables(db);
  return {
    get(host) {
      const r = db.prepare('select robots_status, robots_body, robots_at from feed_hosts where host = ?').get(host) as any;
      return r && r.robots_at !== null ? { host, status: Number(r.robots_status), body: r.robots_body ?? '', fetchedAt: Number(r.robots_at) } : undefined;
    },
    set(e: RobotsEntry) {
      db.prepare('insert into feed_hosts(host, robots_status, robots_body, robots_at) values (?,?,?,?) on conflict(host) do update set robots_status=excluded.robots_status, robots_body=excluded.robots_body, robots_at=excluded.robots_at')
        .run(e.host, e.status, e.body.slice(0, 500_000), e.fetchedAt);
    },
  };
}
