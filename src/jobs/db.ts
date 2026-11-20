// The tracker: <jobs.home>/jobs.db (SQLite through node:sqlite, loaded only when Jobs needs it). Several programs share
// the file (CLI commands, the Crewdeck server), so it runs in WAL mode (readers never wait) with a busy timeout: 8 s for
// the CLI, 250 ms for the server, which answers "busy, retry" instead of stalling the shell (design D2, §16).
import { chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureHome } from '../config.ts';
import { companyKey } from './rules.ts';
import { migrate } from './migrations.ts';

export type Db = DatabaseSync;
export type RoleInput = {
  url: string; title: string; company: string; location?: string; description?: string; source: string;
  pay_text?: string | null; posted_at?: string | null; apply_url?: string | null; apply_kind?: string | null;
  /** v2: the source's key in jobs/sources.md, and what its provider said about the posting. */
  source_key?: string | null; language?: string | null; visa_text?: string | null; employment_type?: string | null;
};

export const STATUSES = ['new', 'bench', 'picked', 'prepared', 'applied', 'skipped', 'expired', 'judged_out', 'prefiltered_out'] as const;
export type Status = (typeof STATUSES)[number];

let sqlite: typeof import('node:sqlite') | null = null;
/** node:sqlite, loaded on first use. Node 22 warns that it is experimental: that one warning is not the user's business. */
function load(): typeof import('node:sqlite') {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((w: any, ...rest: any[]) => {
    if (String(w?.message ?? w).includes('SQLite')) return;
    return (emit as any).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = emit; }
  return sqlite!;
}

export const dbFile = (home: string) => join(home, 'jobs.db');

/** Open (and migrate) a tracker database. `server` uses the short busy timeout. */
export function openDb(path: string, opts: { server?: boolean } = {}): Db {
  const db = new (load().DatabaseSync)(path);
  if (opts.server) db.exec('PRAGMA busy_timeout = 250');
  else db.exec('PRAGMA busy_timeout = 8000');
  if (path !== ':memory:') {
    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* a filesystem without WAL keeps the default */ }
  }
  migrate(db);
  if (path !== ':memory:') for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  return db;
}

/**
 * The tracker opened read-only (the preview, D27): no migration, no write, and closing it never checkpoints the WAL, so
 * the database's bytes stay as they were. Null when there is no tracker yet.
 */
export function openJobsDbReadOnly(home: string): Db | null {
  const path = dbFile(home);
  if (!existsSync(path)) return null;
  const db = new (load().DatabaseSync)(path, { readOnly: true } as any);
  db.exec('PRAGMA busy_timeout = 8000');
  return db;
}

/** The user's tracker in jobs.home (0700; the database files 0600). */
export function openJobsDb(home: string, opts: { server?: boolean } = {}): Db {
  ensureHome(home);
  return openDb(dbFile(home), opts);
}

const depth = new WeakMap<Db, number>();
/** Run fn in one write transaction (BEGIN IMMEDIATE takes the write lock up front); nested calls join the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) { depth.set(db, d + 1); try { return fn(); } finally { depth.set(db, d); } }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally { depth.set(db, 0); }
}

export const now = () => new Date().toISOString();
export const roleId = (url: string) => createHash('sha1').update(url).digest('hex').slice(0, 12);
export const ROLE_ID = /^[a-f0-9]{12}$/;

/** The company row for a name: one row per company key ("Example GmbH", "example.com" and "Example" are one). */
export function companyId(db: Db, name: string): number {
  const clean = name.trim().replace(/\s+/g, ' ') || 'Unknown';
  const key = companyKey(clean) || clean.toLowerCase();
  const found = db.prepare('select id from companies where key = ?').get(key) as any;
  if (found) return found.id;
  return Number(db.prepare('insert into companies(name, key) values (?, ?)').run(clean, key).lastInsertRowid);
}

/** Insert or update a role keyed on its url. Never resets status, judging or picks. */
export function upsertRole(db: Db, r: RoleInput): { id: string; isNew: boolean } {
  const id = roleId(r.url);
  return tx(db, () => {
    const exists = !!db.prepare('select 1 from roles where url = ?').get(r.url);
    const cid = companyId(db, r.company);
    const t = now();
    db.prepare(`insert into roles(id, company_id, title, url, apply_url, apply_kind, location, description, source, pay_text, posted_at, first_seen, updated_at, source_key, language, visa_text, employment_type)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        on conflict(url) do update set title=excluded.title, location=coalesce(nullif(excluded.location,''), roles.location),
          description=coalesce(nullif(excluded.description,''), roles.description), pay_text=coalesce(excluded.pay_text, roles.pay_text),
          posted_at=coalesce(excluded.posted_at, roles.posted_at), apply_url=coalesce(roles.apply_url, excluded.apply_url),
          apply_kind=coalesce(excluded.apply_kind, roles.apply_kind), updated_at=excluded.updated_at,
          source_key=coalesce(roles.source_key, excluded.source_key), language=coalesce(excluded.language, roles.language),
          visa_text=coalesce(excluded.visa_text, roles.visa_text), employment_type=coalesce(excluded.employment_type, roles.employment_type)`)
      .run(id, cid, r.title, r.url, r.apply_url ?? null, r.apply_kind ?? null, r.location ?? '', r.description ?? '', r.source, r.pay_text ?? null, r.posted_at ?? null, t, t,
        r.source_key ?? null, r.language ?? null, r.visa_text ?? null, r.employment_type ?? null);
    return { id, isNew: !exists };
  });
}

export function addEvent(db: Db, role: string | null, kind: string, detail = '', at = now()) {
  db.prepare('insert into events(role_id, kind, detail, at) values (?,?,?,?)').run(role, kind, detail, at);
}

export function setStatus(db: Db, id: string, status: Status, reason = '', at = now()) {
  if (!(STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  tx(db, () => {
    const r = db.prepare('update roles set status=?, status_reason=?, updated_at=? where id=?').run(status, reason, at, id);
    if (!r.changes) throw new Error(`no role ${id}`);
    addEvent(db, id, 'status', `${status}${reason ? `: ${reason}` : ''}`, at);
  });
}

/** A role with its company name, or an error naming the id. */
export function getRole(db: Db, id: string): any {
  const r = db.prepare('select r.*, c.name company, c.cooldown_until from roles r join companies c on c.id=r.company_id where r.id=?').get(id);
  if (!r) throw new Error(`no role ${id}`);
  return r;
}
