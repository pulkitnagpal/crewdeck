import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/jobs/db.ts';
import { companyId } from '../../src/jobs/db.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { bm25Scores, ensureFts, fts5Available, ftsPhrase, ftsQuery, ftsReady, ftsStatus, profileTerms, rebuildFts, textQuery } from '../../src/jobs/search/fts.ts';
import { engineerWorld, role } from './search-helpers.ts';

test('FTS5 exists in this node:sqlite, and a fresh tracker has roles_fts and role_vectors', () => {
  const db = openDb(':memory:');
  assert.equal(fts5Available(db), true, 'node:sqlite here is built with FTS5');
  assert.equal(ftsReady(db), true);
  assert.ok(db.prepare(`select 1 from sqlite_master where name='role_vectors'`).get());
  assert.equal(ensureFts(db), true, 'idempotent');
});

test('triggers keep roles_fts in step: insert, title and description updates, company rename, delete', () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'Example Labs', title: 'Platform Engineer', description: 'We run Kubernetes clusters.' });
  const ids = (q: string) => [...bm25Scores(w.ctx, ftsQuery([q]))].map(([id]) => id);
  assert.deepEqual(ids('kubernetes'), [a]);
  assert.deepEqual(ids('platform engineer'), [a]);
  w.ctx.db.prepare('update roles set description=? where id=?').run('Android apps in Kotlin.', a);
  assert.deepEqual(ids('kubernetes'), [], 'old description gone');
  assert.deepEqual(ids('kotlin'), [a]);
  w.ctx.db.prepare('update roles set title=? where id=?').run('Mobile Engineer', a);
  assert.deepEqual(ids('platform engineer'), []);
  assert.deepEqual(ids('mobile engineer'), [a]);
  // the company name is searched too, and a rename follows
  assert.deepEqual(ids('example labs'), [a]);
  w.ctx.db.prepare('update companies set name=? where id=?').run('Renamed Works', companyId(w.ctx.db, 'Example Labs'));
  assert.deepEqual(ids('example labs'), []);
  assert.deepEqual(ids('renamed works'), [a]);
  w.ctx.db.prepare('delete from roles where id=?').run(a);
  assert.deepEqual(ids('renamed works'), []);
  assert.equal(ftsStatus(w.ctx.db).indexed, 0);
});

test('an existing tracker gets the index on its next open (backfill), and reindex repairs drift', () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'Backfill Co', title: 'Backend Engineer', description: 'Go services' });
  // As if made before this version: no index, no triggers.
  for (const t of ['roles_fts_ai', 'roles_fts_ad', 'roles_fts_au', 'roles_fts_cu']) w.ctx.db.exec(`drop trigger ${t}`);
  w.ctx.db.exec('drop table roles_fts');
  assert.equal(ftsReady(w.ctx.db), false);
  assert.deepEqual([...bm25Scores(w.ctx, ftsQuery(['go services']))], [], 'no index: no scores, no error');
  assert.equal(ensureFts(w.ctx.db), true);
  assert.deepEqual([...bm25Scores(w.ctx, ftsQuery(['go services']))].map(([id]) => id), [a], 'backfilled');
  w.ctx.db.exec('delete from roles_fts'); // drift
  assert.equal(ftsStatus(w.ctx.db).indexed, 0);
  assert.deepEqual(rebuildFts(w.ctx.db), { available: true, rows: 1 });
});

test('bm25Scores: positive, restricted to ids, a title hit beats a description hit, no match means absent', () => {
  const w = engineerWorld();
  const t = role(w.ctx, { company: 'A Co', title: 'Kubernetes Engineer', description: 'We hire.' });
  const d = role(w.ctx, { company: 'B Co', title: 'Engineer', description: 'We use Kubernetes.' });
  const n = role(w.ctx, { company: 'C Co', title: 'Designer', description: 'Figma.' });
  const all = bm25Scores(w.ctx, ftsQuery(['kubernetes']));
  assert.ok(all.get(t)! > all.get(d)! && all.get(d)! > 0);
  assert.ok(!all.has(n));
  assert.deepEqual([...bm25Scores(w.ctx, ftsQuery(['kubernetes']), [d])].map(([id]) => id), [d]);
  assert.equal(bm25Scores(w.ctx, '').size, 0);
});

test('queries are escaped: FTS5 syntax in a profile term or a typed query never reaches the parser', () => {
  assert.equal(ftsPhrase('Backend Engineer (m/f/d)'), '"backend engineer m f d"');
  assert.equal(ftsPhrase('"; drop table roles; --'), '"drop table roles"');
  assert.equal(ftsPhrase('NEAR(a b, 5)'), '"near a b 5"');
  assert.equal(ftsPhrase('*'), '');
  assert.equal(ftsPhrase('c'), '', 'one letter says nothing');
  assert.equal(ftsPhrase('Zürich'), '"zurich"');
  assert.equal(ftsQuery(['Go', 'go', 'Kubernetes', '', '***']), '"go" OR "kubernetes"');
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'X Co', title: 'Backend Engineer', description: 'AND OR NOT NEAR "quoted" col:umn *' });
  for (const q of ['AND OR NOT', 'NEAR(', '"unbalanced', 'title:backend', '-backend', 'backend*', "'; drop table roles; --", '()']) {
    assert.doesNotThrow(() => bm25Scores(w.ctx, textQuery(q)), q);
  }
  assert.ok(bm25Scores(w.ctx, textQuery('backend "engineer')).has(a));
  assert.ok(w.ctx.db.prepare('select count(*) n from roles').get());
});

test('the profile query: target titles, their synonyms, then skills; de-duplicated and capped at 40', () => {
  const w = engineerWorld();
  const terms = profileTerms(notesOf(w.ctx));
  assert.deepEqual(terms.slice(0, 3), ['backend engineer', 'platform engineer', 'ai engineer']);
  assert.ok(terms.includes('backend developer') && terms.indexOf('backend developer') < terms.indexOf('Go'), 'synonyms come before skills');
  for (const k of ['Go', 'Python', 'Kubernetes', 'distributed systems']) assert.ok(terms.includes(k), k);
  assert.equal(new Set(terms.map((x) => x.toLowerCase())).size, terms.length);
  assert.ok(terms.length <= 40);
  const many = { ...notesOf(w.ctx) } as any;
  many.career = { ...many.career, data: { ...many.career.data, skills: Array.from({ length: 80 }, (_, i) => `skill${i}x`) } };
  const capped = profileTerms(many);
  assert.equal(capped.length, 40);
  assert.deepEqual(capped.slice(0, 3), ['backend engineer', 'platform engineer', 'ai engineer'], 'the cap cuts the tail, not the titles');
  assert.ok(ftsQuery(capped).split(' OR ').length <= 40);
});
