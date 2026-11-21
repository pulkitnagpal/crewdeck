// Tracker schema, versioned by PRAGMA user_version (design D9). v1 is generic: pay in the user's own currency and
// period, no social columns nobody uses. Each step runs in BEGIN IMMEDIATE and re-checks the version inside the
// transaction, so two processes opening a fresh database never both apply it.
import type { DatabaseSync } from 'node:sqlite';

const V1 = `
create table companies (
  id integer primary key, name text not null, key text not null unique, domain text, cooldown_until text, note text);
create table roles (
  id text primary key, company_id integer not null references companies(id), title text not null, url text not null unique,
  apply_url text, apply_kind text, location text not null default '', description text not null default '', source text not null,
  pay_text text, pay_min real, pay_max real, pay_currency text, pay_period text, pay_status text,
  status text not null default 'new'
    check (status in ('new','bench','picked','prepared','applied','skipped','expired','judged_out','prefiltered_out')),
  status_reason text, eligibility text check (eligibility in ('yes','no','unclear')), evidence text, score integer,
  posted_at text, first_seen text not null, updated_at text not null, picked_on text);
create index roles_status on roles(status);
create index roles_company on roles(company_id);
create index roles_picked_on on roles(picked_on);
create table contacts (
  id integer primary key, company_id integer references companies(id), name text not null, title text, email text,
  email_verified integer not null default 0, linkedin_url text, source text not null default '', created_at text not null);
create table messages (
  id integer primary key, role_id text not null references roles(id), contact_id integer references contacts(id),
  channel text not null check (channel in ('email','linkedin')), body text not null, gmail_draft_id text,
  status text not null default 'draft' check (status in ('draft','sent')), created_at text not null, sent_at text);
create index messages_role on messages(role_id);
create table events (id integer primary key, role_id text, kind text not null, detail text not null default '', at text not null);
create index events_role_kind on events(role_id, kind);
create index events_kind_at on events(kind, at);
create table questions (
  id integer primary key, role_id text not null references roles(id), text text not null, answer text,
  asked_at text not null, answered_at text);

create table kb_questions (
  id integer primary key, canonical_key text not null unique,
  kind text not null check (kind in ('contact','logistics','numeric','choice','narrative','sensitive')), text text not null);
create table question_wordings (
  id integer primary key, question_id integer not null references kb_questions(id), text text not null, company text,
  unique (question_id, text, company));
create virtual table question_fts using fts5(text, content='question_wordings', content_rowid='id', tokenize='porter');
create trigger question_wordings_ai after insert on question_wordings begin
  insert into question_fts(rowid, text) values (new.id, new.text); end;
create trigger question_wordings_ad after delete on question_wordings begin
  insert into question_fts(question_fts, rowid, text) values ('delete', old.id, old.text); end;
create trigger question_wordings_au after update on question_wordings begin
  insert into question_fts(question_fts, rowid, text) values ('delete', old.id, old.text);
  insert into question_fts(rowid, text) values (new.id, new.text); end;
create table form_fields (
  id integer primary key, role_id text not null references roles(id), ord integer not null, section text, label text not null,
  kind text, required integer not null default 0, options_json text, char_limit integer,
  question_id integer references kb_questions(id), unique (role_id, label));
create table answers (
  id integer primary key, role_id text not null references roles(id), form_field_id integer not null references form_fields(id),
  question_id integer references kb_questions(id), company text, text text, fact_ids_json text not null default '[]',
  status text not null check (status in ('first_time','drafted','approved')), reason text, version integer not null default 1,
  created_at text not null);
create index answers_field on answers(form_field_id, version);
create index answers_question on answers(question_id, status);
create table corrections (
  id integer primary key, answer_id integer references answers(id), instruction text, before text, after text, at text not null);
create table undo_log (
  id integer primary key, kind text not null check (kind in ('answer','memory')), ref text not null,
  created_answers_json text not null default '[]', at text not null);
PRAGMA user_version = 1;
`;

// v2 (design D20, P9a): which of the user's sources a role came from (its key in jobs/sources.md), and what a provider
// says about it beyond the text: the posting's language, its visa or eligibility line and a structured employment type.
const V2 = `
alter table roles add column source_key text;
alter table roles add column language text;
alter table roles add column visa_text text;
alter table roles add column employment_type text;
create index roles_source_key on roles(source_key);
PRAGMA user_version = 2;
`;

// v3 (D36, P9g): when the user marked a role applied, so a cooldown can be about the same title at a company (scope:
// role) rather than the whole company. Roles applied before v3 take the time of their "applied" status event.
const V3 = `
alter table roles add column applied_at text;
update roles set applied_at = coalesce(
  (select max(e.at) from events e where e.role_id = roles.id and e.kind = 'status' and e.detail like 'applied%'), roles.updated_at)
  where status = 'applied';
PRAGMA user_version = 3;
`;

// v4 (D33, D35, P9h): how the employer takes applications (recorded at Prepare: form, email, document, walk_in, chatbot,
// account_needed) with a note from the posting (where and when to walk in, the address to email), and the language of
// the application form (answers are drafted in it).
const V4 = `
alter table roles add column apply_method text;
alter table roles add column apply_note text;
alter table roles add column form_lang text;
PRAGMA user_version = 4;
`;

// v5 (jobs v2 P1b): what a posting's detail page says beyond its text (schema.org JobPosting or a board's own API):
// remote/hybrid/onsite, the countries a remote role hires from (a JSON list), and the closing date. `detail_status` and
// `detail_at` record the last detail fetch, so a role is tried at most once a day.
const V5 = `
alter table roles add column workplace text;
alter table roles add column remote_countries text;
alter table roles add column valid_through text;
alter table roles add column detail_status text;
alter table roles add column detail_at text;
PRAGMA user_version = 5;
`;

// Additive tables (no user_version step): created if missing on every open, so they never collide with the numbered steps
// other phases add. Each is `create table if not exists` and never alters an existing table.
// proposals (Jobs v2 §8.7, §11, P3): what intake suggests changing in the person's notes, each item approved, rejected
// or (the person's own words, low-risk kinds only) applied at once and undoable. items_json holds the items and their status.
const PROPOSALS = `
create table if not exists proposals (
  id integer primary key, created text not null, origin text not null check (origin in ('person','quoted','fetched')),
  summary text not null default '', request_id integer, items_json text not null default '[]',
  status text not null default 'pending' check (status in ('pending','done')), updated text not null);
create index if not exists proposals_status on proposals(status);
`;
export const ADDITIVE: { name: string; sql: string }[] = [{ name: 'proposals', sql: PROPOSALS }];

// Additive columns (no user_version step, like ADDITIVE): nullable, no default, added when missing on every open, so a
// parallel phase's numbered step never collides with them. Each is checked inside BEGIN IMMEDIATE before the ALTER.
// roles.company_country (ADR-0008 §8): the company's own country (an ISO code) when a feed or a portal said.
export const ADDITIVE_COLUMNS: { table: string; column: string; sql: string }[] = [
  { table: 'roles', column: 'company_country', sql: 'alter table roles add column company_country text' },
];

const hasColumn = (db: DatabaseSync, table: string, column: string) => !!db.prepare('select 1 from pragma_table_info(?) where name = ?').get(table, column);

function addColumns(db: DatabaseSync) {
  for (const step of ADDITIVE_COLUMNS) {
    if (hasColumn(db, step.table, step.column)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!hasColumn(db, step.table, step.column)) db.exec(step.sql);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Every schema step, in order; step N leaves user_version = N. */
export const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: V1 }, { version: 2, sql: V2 }, { version: 3, sql: V3 }, { version: 4, sql: V4 }, { version: 5, sql: V5 }];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as any).user_version);

/** Bring the database up to SCHEMA_VERSION. Safe to call on every open. */
export function migrate(db: DatabaseSync): number {
  const have = version(db);
  if (have > SCHEMA_VERSION) throw new Error(`jobs.db is schema v${have}, newer than this Crewdeck (v${SCHEMA_VERSION}): update Crewdeck`);
  for (const step of MIGRATIONS) {
    if (version(db) >= step.version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have migrated while we waited for the lock.
      if (version(db) < step.version) db.exec(step.sql);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  for (const step of ADDITIVE) db.exec(step.sql);
  addColumns(db);
  return version(db);
}
