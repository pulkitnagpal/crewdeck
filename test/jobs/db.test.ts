import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dbFile, openDb, openJobsDb, roleId, setStatus, tx, upsertRole } from '../../src/jobs/db.ts';
import { SCHEMA_VERSION, migrate } from '../../src/jobs/migrations.ts';
import { tempSetup } from './helpers.ts';

const tables = (db: any) => (db.prepare(`select name from sqlite_master where type='table'`).all() as any[]).map((r) => r.name);

test('v1 creates the tracker and knowledge-base tables, and the FTS index follows question wordings', () => {
  const db = openDb(':memory:');
  for (const t of ['companies', 'roles', 'contacts', 'messages', 'events', 'questions', 'kb_questions', 'question_wordings', 'question_fts', 'form_fields', 'answers', 'corrections', 'undo_log']) assert.ok(tables(db).includes(t), t);
  const cols = (t: string) => (db.prepare('select name from pragma_table_info(?)').all(t) as any[]).map((c) => c.name);
  for (const c of ['pay_min', 'pay_max', 'pay_currency', 'pay_period', 'pay_text', 'pay_status', 'apply_url', 'apply_kind', 'eligibility', 'evidence', 'score', 'picked_on']) assert.ok(cols('roles').includes(c), c);
  assert.ok(!cols('roles').some((c) => /inr/.test(c)), 'no currency-specific columns');
  assert.ok(!cols('contacts').includes('x_url'));
  assert.ok(cols('companies').includes('key') && cols('companies').includes('cooldown_until'));
  db.prepare(`insert into kb_questions(canonical_key, kind, text) values ('sql_level','choice','Experience with SQL')`).run();
  db.prepare(`insert into question_wordings(question_id, text, company) values (1, 'Experience with SQL', 'Example Labs')`).run();
  assert.equal(db.prepare(`select rowid from question_fts where question_fts match 'sql'`).all().length, 1);
  assert.throws(() => db.prepare(`insert into messages(role_id, channel, body, created_at) values ('x','x','b','t')`).run(), /CHECK|FOREIGN/);
});

test('migrations are idempotent, versioned, and refuse a database from a newer Crewdeck', () => {
  const s = tempSetup();
  const a = openJobsDb(s.jobsHome);
  assert.equal(Number((a.prepare('PRAGMA user_version').get() as any).user_version), SCHEMA_VERSION);
  upsertRole(a, { url: 'https://jobs.example.com/1', title: 'Data Analyst', company: 'Example Labs', source: 'board' });
  const b = openJobsDb(s.jobsHome); // a second process opening the same file
  assert.equal(migrate(b), SCHEMA_VERSION);
  assert.equal((b.prepare('select count(*) n from roles').get() as any).n, 1, 'reopening keeps the data');
  a.close(); b.close();
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const raw = new DatabaseSync(dbFile(s.jobsHome));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openJobsDb(s.jobsHome), /newer than this Crewdeck/);
});

test('jobs.home is 0700, the database files 0600, WAL on, busy timeouts for the CLI and the server', () => {
  const s = tempSetup();
  mkdirSync(s.jobsHome, { mode: 0o755 });
  const db = openJobsDb(s.jobsHome);
  upsertRole(db, { url: 'https://jobs.example.com/2', title: 'Data Analyst', company: 'Example Labs', source: 'board' });
  assert.equal(statSync(s.jobsHome).mode & 0o777, 0o700);
  assert.equal(statSync(join(s.jobsHome, 'jobs.db')).mode & 0o777, 0o600);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal');
  assert.equal(Number((db.prepare('PRAGMA busy_timeout').get() as any).timeout), 8000);
  const server = openJobsDb(s.jobsHome, { server: true });
  assert.equal(Number((server.prepare('PRAGMA busy_timeout').get() as any).timeout), 250);
  for (const f of ['jobs.db-wal', 'jobs.db-shm']) { try { assert.equal(statSync(join(s.jobsHome, f)).mode & 0o777, 0o600, f); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } }
});

test('upserting the same url keeps one row, refreshes text and never resets status; companies merge by key', () => {
  const db = openDb(':memory:');
  const r = { url: 'https://jobs.example.com/x/1', title: 'Data Analyst', company: 'Example Labs GmbH', location: 'Berlin', description: 'first', source: 'board' };
  upsertRole(db, r);
  setStatus(db, roleId(r.url), 'picked');
  const again = upsertRole(db, { ...r, title: 'Data Analyst II', company: 'example labs', description: '' });
  assert.equal(again.isNew, false);
  const rows = db.prepare('select title, status, description from roles').all() as any[];
  assert.deepEqual(rows.map((x) => [x.title, x.status, x.description]), [['Data Analyst II', 'picked', 'first']]);
  upsertRole(db, { ...r, url: 'https://jobs.example.com/x/2', company: 'Example-Labs.com' });
  assert.equal((db.prepare('select count(*) n from companies').get() as any).n, 1);
});

test('tx: one write transaction, nested calls join it, errors roll everything back', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => {
    upsertRole(db, { url: 'https://jobs.example.com/t/1', title: 'A', company: 'Example Labs', source: 'board' });
    tx(db, () => upsertRole(db, { url: 'https://jobs.example.com/t/2', title: 'B', company: 'Example Labs', source: 'board' }));
    throw new Error('boom');
  }), /boom/);
  assert.equal((db.prepare('select count(*) n from roles').get() as any).n, 0);
});
