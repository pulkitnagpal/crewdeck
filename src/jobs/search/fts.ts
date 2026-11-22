// Full-text search over the tracker's roles (hybrid ranking, signal 2): a SQLite FTS5 table `roles_fts(title, company,
// description)` whose rowid is the role's rowid, kept in step by triggers on roles and companies. Additive like the other
// tables (created when missing on every open, backfilled once); if this SQLite has no FTS5 the whole thing is a no-op and
// ranking falls back to the other signals. No Claude, no network, no tokens.
import type { Ctx } from '../ctx.ts';
import type { Db } from '../db.ts';
import type { JobNotes } from '../notes.ts';
import { loadTitleWords } from '../titles.ts';

const TABLE: { sql: string } = { sql: `create virtual table roles_fts using fts5(title, company, description, tokenize='porter unicode61 remove_diacritics 2')` };
const NAME = `coalesce((select name from companies where id=new.company_id), '')`;
// Constant SQL, run as `step.sql` (the SQL guard test allows only literals and migration-style steps).
const TRIGGERS: { sql: string }[] = [
  { sql: `create trigger if not exists roles_fts_ai after insert on roles begin
     insert into roles_fts(rowid, title, company, description) values (new.rowid, new.title, ${NAME}, new.description); end` },
  { sql: `create trigger if not exists roles_fts_ad after delete on roles begin delete from roles_fts where rowid = old.rowid; end` },
  { sql: `create trigger if not exists roles_fts_au after update of title, description, company_id on roles begin
     delete from roles_fts where rowid = old.rowid;
     insert into roles_fts(rowid, title, company, description) values (new.rowid, new.title, ${NAME}, new.description); end` },
  { sql: `create trigger if not exists roles_fts_cu after update of name on companies begin
     delete from roles_fts where rowid in (select rowid from roles where company_id = new.id);
     insert into roles_fts(rowid, title, company, description) select r.rowid, r.title, new.name, r.description from roles r where r.company_id = new.id; end` },
];
const FILL: { sql: string } = { sql: `insert into roles_fts(rowid, title, company, description)
  select r.rowid, r.title, c.name, r.description from roles r join companies c on c.id = r.company_id` };

const exists = (db: Db) => !!db.prepare(`select 1 from sqlite_master where type='table' and name='roles_fts'`).get();

/** Does this SQLite build have FTS5? (Asked of the build itself, not guessed from a version.) */
export function fts5Available(db: Db): boolean {
  try { return Number((db.prepare(`select sqlite_compileoption_used('ENABLE_FTS5') u`).get() as any).u) === 1; }
  catch { return false; }
}

/** Create the table and triggers when missing (backfilling the roles already stored). Never throws: false = not available. */
export function ensureFts(db: Db): boolean {
  try {
    if (!exists(db)) {
      if (!fts5Available(db)) return false;
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!exists(db)) { for (const step of [TABLE, FILL]) db.exec(step.sql); }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    for (const step of TRIGGERS) db.exec(step.sql);
    return true;
  } catch { return false; }
}

/** Is the index there (the table exists)? */
export const ftsReady = (db: Db): boolean => { try { return exists(db); } catch { return false; } };

/** Rebuild the index from the roles (`search reindex`; also repairs drift). */
export function rebuildFts(db: Db): { available: boolean; rows: number } {
  if (!ensureFts(db)) return { available: false, rows: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('delete from roles_fts');
    for (const step of [FILL]) db.exec(step.sql);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { available: true, rows: Number((db.prepare('select count(*) n from roles_fts').get() as any).n) };
}

export function ftsStatus(db: Db): { available: boolean; ready: boolean; indexed: number; roles: number } {
  const roles = Number((db.prepare('select count(*) n from roles').get() as any).n);
  if (!ftsReady(db)) return { available: fts5Available(db), ready: false, indexed: 0, roles };
  return { available: true, ready: true, indexed: Number((db.prepare('select count(*) n from roles_fts').get() as any).n), roles };
}

// ---- queries ----

/** One FTS5 phrase for a text: its letters and digits only (FTS5 syntax characters never get through), quoted. */
export function ftsPhrase(text: string): string {
  const words = (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length && words.join('').length >= 2 ? `"${words.join(' ')}"` : '';
}

/** Terms OR-joined as phrases, de-duplicated, at most `cap` of them. Empty string when nothing usable. */
export function ftsQuery(terms: string[], cap = 40): string {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of terms) {
    const p = ftsPhrase(t);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= cap) break;
  }
  return out.join(' OR ');
}

/** A person's free-text query as OR-ed words (each word its own phrase). */
export const textQuery = (q: string, cap = 40): string => ftsQuery((q ?? '').split(/\s+/).filter((w) => w.length >= 2), cap);

/**
 * The profile's terms in priority order, at most `cap`: the target titles, titles that mean the same job (from
 * data/title-words.yaml), then target and career skills. The cap cuts the tail.
 */
export function profileTerms(notes: Pick<JobNotes, 'search' | 'career'>, cap = 40): string[] {
  const s = notes.search.data, targets = s.roles.targets;
  const titles = [...targets.flatMap((t) => t.titles), ...s.roles.titles];
  const syn: string[] = [];
  try {
    for (const t of titles) {
      const low = ` ${t.toLowerCase()} `;
      for (const g of loadTitleWords().synonyms) for (const ph of g) {
        const w = ph.join(' ');
        if (w && low.includes(` ${w} `)) for (const o of g) if (o !== ph) syn.push(low.trim().replace(w, o.join(' ')));
      }
    }
  } catch { /* the synonym data is a bonus */ }
  const skills = [...targets.flatMap((t) => t.skills), ...notes.career.data.skills];
  const seen = new Set<string>(), out: string[] = [];
  for (const t of [...titles, ...syn, ...skills]) {
    const p = ftsPhrase(t);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * BM25 scores (higher = better, always > 0) of the roles matching `query` (from ftsQuery/textQuery), restricted to `ids`
 * when given. Roles matching nothing are absent. A title hit counts most, then the company, then the description.
 */
export function bm25Scores(ctx: Pick<Ctx, 'db'>, query: string, ids?: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!query || !ftsReady(ctx.db)) return out;
  try {
    const rows = (ids
      ? ctx.db.prepare(`select r.id id, -bm25(roles_fts, 8.0, 2.0, 1.0) s from roles_fts join roles r on r.rowid = roles_fts.rowid
          where roles_fts match ? and r.id in (select value from json_each(?))`).all(query, JSON.stringify(ids))
      : ctx.db.prepare(`select r.id id, -bm25(roles_fts, 8.0, 2.0, 1.0) s from roles_fts join roles r on r.rowid = roles_fts.rowid
          where roles_fts match ?`).all(query)) as any[];
    for (const r of rows) out.set(String(r.id), Math.max(1e-9, Number(r.s)));
  } catch { /* a query FTS5 rejects scores nothing */ }
  return out;
}
