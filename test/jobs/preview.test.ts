// The search preview (design §24.6, D27, P9d exit check): the owner's case as a fictional fixture (1,480 postings: the
// old phrase gate passed 1; after accepting the suggested variants ≥ 100 pass with the same place drops), read-only
// (the tracker and the notes are byte-for-byte unchanged), overlays validated like pref set, the pool cap and budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notesOf } from '../../src/jobs/ctx.ts';
import { compileRules } from '../../src/jobs/rules.ts';
import { normalise } from '../../src/jobs/schema.ts';
import { tx, upsertRole } from '../../src/jobs/db.ts';
import { POOL_MAX, evaluate, previewLines, previewPool, runPreview, searchFileChanges, trackerDrops } from '../../src/jobs/preview.ts';
import { ENGINEERING, OLD_GATE, ownerRoles, seedOwner } from './owner-fixture.ts';
import { jobs, textFile, world } from './helpers.ts';
import { jobsServer } from './api-helpers.ts';

const segs = (path: string) => path.replace(/\[(\d+)\]/g, '.$1').split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : x));

test('the owner-shaped pool: 1,480 postings, 281 engineering titles, as the old gate saw them', () => {
  const roles = ownerRoles();
  assert.equal(roles.length, 1480);
  assert.equal(roles.filter((r) => r.kind === 'engineering').length, 281);
  assert.equal(ENGINEERING.reduce((a, [, n]) => a + n, 0), 281);
  const w = world('example');
  seedOwner(w.ctx, w.vault);
  const before = runPreview(w.ctx, { changes: searchFileChanges(OLD_GATE) });
  assert.equal(before.pool, 1480);
  assert.equal(before.sources, 9);
  assert.equal(before.pass, 1, 'the old phrase gate passes exactly one');
  const by = Object.fromEntries(before.drops.map((d) => [d.rule, d.n]));
  assert.equal(by.title_gate, 1375);
  assert.equal(by.other_only, 92);
  assert.equal(before.drops.reduce((a, d) => a + d.n, 0) + before.pass, 1480, 'every posting is a pass or one first reason');
});

test('the owner\'s case: the saved notes pass more, the variants fix passes ≥ 100, every place drop stays', () => {
  const w = world('example');
  seedOwner(w.ctx, w.vault);
  const saved = runPreview(w.ctx);
  assert.ok(saved.pass > 1, `word matching alone: ${saved.pass}`);
  assert.deepEqual(saved.near[0].items.slice(0, 2).map((x) => x.label).sort(), ['Full Stack Engineer', 'Software Engineer']);
  assert.equal(saved.near[0].head, 'engineer');
  const fix = saved.suggestions.find((s) => s.kind === 'variants')!;
  assert.ok(fix, 'a variants fix is offered');
  assert.match(fix.label, /^Add 5 title variants: \d+ more pass$/);
  assert.deepEqual(fix.pref.map((p) => p.path), ['roles.titles']);
  assert.deepEqual(Object.keys(fix.change), ['roles.titles'], 'the page fills the same field');
  assert.ok(saved.broad !== null && saved.broad > 0);

  // Accept it: what the user would save.
  const after = runPreview(w.ctx, { changes: fix.pref.map((p) => ({ segs: segs(p.path), value: p.value })) });
  assert.ok(after.pass >= 100, `after the variants: ${after.pass}`);
  assert.equal(after.was, saved.pass);
  assert.equal(after.pass, saved.pass + fix.more!, 'the fix\'s own count is exact');

  // The same place drops: every posting the old gate dropped for its place is still dropped for its place.
  const notes = notesOf(w.ctx);
  const { rows } = previewPool(w.ctx, 14);
  const tracker = trackerDrops(w.ctx, rows);
  const rules = (over: any) => compileRules({ search: { ...notes.search, data: normalise.search({ ...(notes.search.raw as any), ...over, roles: { ...(notes.search.raw as any).roles, ...(over.roles ?? {}) } }) }, memory: notes.memory });
  const old = evaluate(rows, rules(OLD_GATE), tracker);
  const now = evaluate(rows, rules({ roles: { titles: fix.pref[0].value } }), tracker);
  const placeBefore = rows.filter((_, i) => old[i][0]?.group === 'place');
  assert.equal(placeBefore.length, 92);
  for (const r of placeBefore) assert.ok(now[rows.indexOf(r)].some((d) => d.group === 'place'), `${r.title} kept its place drop`);
  // And nothing limited to another place passes.
  const limited = new Set(ownerRoles().map((x, i) => (x.limited ? `https://jobs.example.com/owner/${i}` : '')).filter(Boolean));
  const urls = new Map((w.ctx.db.prepare('select id, url from roles').all() as any[]).map((r) => [r.id, r.url]));
  assert.ok(rows.every((r, i) => now[i].length || !limited.has(urls.get(r.id))));
});

test('the text output: counts, reasons, near misses, examples, sources and fixes as --value-file commands', () => {
  const w = world('example');
  seedOwner(w.ctx, w.vault);
  const t = previewLines(runPreview(w.ctx)).join('\n');
  assert.match(t, /^1,480 postings from 9 sources \(last 14 days\)/);
  assert.match(t, /Dropped, by first reason: title 1,\d{3} · only for other places 9\d/);
  assert.match(t, /Only one thing stops them: title/);
  assert.match(t, /Near misses on title: engineer → /);
  assert.match(t, /By source: .*LinkedIn 16\d → \d+/);
  assert.match(t, /crewdeck jobs pref set roles.titles --value-file <f> --because-file <f>/);
  assert.doesNotMatch(t, /pref set \S+ '\[/, 'posting text never goes on a command line');
});

/** Every byte the preview could have written: the tracker, every note, Jobs' state files. */
function snapshot(w: ReturnType<typeof world>) {
  const h = createHash('sha256');
  const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; }) : []);
  for (const f of [join(w.jobsHome, 'jobs.db'), join(w.jobsHome, 'jobs.db-wal'), ...files(join(w.vault, 'me')), ...files(join(w.vault, 'jobs')), ...files(join(w.jobsHome, 'state'))].sort()) {
    if (existsSync(f)) h.update(f).update(readFileSync(f));
  }
  h.update(JSON.stringify(w.ctx.db.prepare('select id, status, status_reason, pay_status, pay_min, eligibility, updated_at from roles order by id').all()));
  h.update(JSON.stringify(w.ctx.db.prepare('select count(*) n from events').get()));
  return h.digest('hex');
}

test('read-only: a preview (in process, CLI and page) never writes the tracker, the notes or state', async () => {
  const s = await jobsServer('example');
  try {
    const w = s.w;
    seedOwner(w.ctx, w.vault);
    notesOf(w.ctx); // the last-valid copies exist before the first snapshot, as on any machine that ran Jobs
    const before = snapshot(w);
    runPreview(w.ctx);
    runPreview(w.ctx, { changes: [{ segs: ['roles', 'match'], value: 'broad' }] });
    assert.equal(snapshot(w), before, 'in process');
    const f = textFile(w.root, 'change.yaml', 'roles:\n  titles: [backend engineer, ai engineer, software engineer]\n');
    const cli = jobs(w.home, ['preview', '--search-file', f, '--json']);
    assert.equal(cli.code, 0, cli.err);
    assert.ok(JSON.parse(cli.out).pass > 1);
    assert.equal(snapshot(w), before, 'the CLI');
    const page = await s.call('POST', '/api/jobs/preview', s.page(), { search: { 'roles.titles': ['backend engineer', 'ai engineer', 'full stack engineer'] } });
    assert.equal(page.status, 200, page.body);
    assert.equal(page.json.ok, true);
    assert.ok(page.json.pass > page.json.was);
    assert.equal(snapshot(w), before, 'the page');
    assert.match(readFileSync(join(w.vault, 'jobs', 'search.md'), 'utf8'), /titles: \[backend engineer, ai engineer\]/);
  } finally { await s.close(); }
});

test('the page\'s preview: same-origin only, the Preferences checks, field errors instead of a preview', async () => {
  const s = await jobsServer('example');
  try {
    assert.equal((await s.call('POST', '/api/jobs/preview', { 'content-type': 'application/json' }, {})).status, 403, 'no Origin');
    assert.equal((await s.call('POST', '/api/jobs/preview', s.agent(), {})).status, 403, 'the agent token is not the page');
    assert.equal((await s.call('POST', '/api/jobs/preview', { ...s.page(), origin: 'https://evil.example.com' }, {})).status, 403);
    assert.equal((await s.call('GET', '/api/jobs/preview', {})).status, 404, 'POST only');
    const bad = await s.call('POST', '/api/jobs/preview', s.page(), { search: { 'roles.match': 'fuzzy' } });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.issues[0].path, 'roles.match');
    assert.equal((await s.call('POST', '/api/jobs/preview', s.page(), { search: { 'pay.secret': 1 } })).status, 400);
    assert.equal((await s.call('POST', '/api/jobs/preview', s.page(), { days: 400 })).status, 400);
    const empty = await s.call('POST', '/api/jobs/preview', s.page(), {});
    assert.equal(empty.json.pool, 0);
  } finally { await s.close(); }
});

test('the CLI: an empty pool says to fetch first; a bad search file is refused with the field', () => {
  const w = world('example');
  const empty = jobs(w.home, ['preview']);
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /No postings in the last 14 days to preview\. Fetch first: crewdeck jobs source/);
  const bad = jobs(w.home, ['preview', '--search-file', textFile(w.root, 'bad.yaml', 'roles: { level: wizard }\n')]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /roles\.level/);
  assert.equal(jobs(w.home, ['preview', '--source', '../x']).code, 1);
  assert.equal(jobs(w.home, ['preview', '--days', '0']).code, 1);
});

test('the pool: the 5,000 newest of the last N days, never applied roles; suggestions stay within the time budget', () => {
  const w = world('example');
  seedOwner(w.ctx, w.vault);
  const para = 'We are a distributed team building tools for finance teams; you will design APIs and own services end to end. ';
  tx(w.ctx.db, () => { for (let i = 0; i < 3600; i++) upsertRole(w.ctx.db, { url: `https://jobs.example.com/more/${i}`, title: i % 3 ? 'Software Engineer' : 'Account Manager', company: `Example Extra ${i % 300}`, location: 'Remote - India', description: para.repeat(20), source: 'board', source_key: 'remotive' }); });
  const applied = (w.ctx.db.prepare('select id from roles limit 1').get() as any).id;
  w.ctx.db.prepare(`update roles set status='applied' where id=?`).run(applied);
  const p = runPreview(w.ctx);
  assert.equal(p.pool, POOL_MAX);
  assert.ok(p.capped);
  assert.ok(!previewPool(w.ctx, 14).rows.some((r) => r.id === applied));
  assert.ok(p.ms < 5000, `${p.ms} ms`);
  const tiny = runPreview(w.ctx, { budgetMs: 0 });
  assert.equal(tiny.partial, true);
  assert.equal(tiny.pass, p.pass, 'the counts never depend on the budget, only the suggestions do');
  assert.equal(runPreview(w.ctx, { source: 'linkedin' }).pool, 165);
});

test('a --search-file merges maps and replaces lists, like pref set', () => {
  assert.deepEqual(searchFileChanges({ roles: { titles: ['a'], match: 'broad' }, pay: { fx: { USD: 83 } } }).map((c: any) => [c.segs.join('.'), c.value]), [
    ['roles.titles', ['a']], ['roles.match', 'broad'], ['pay.fx', { USD: 83 }],
  ]);
  assert.throws(() => searchFileChanges(['a']), /YAML map/);
  const w = world('example');
  writeFileSync(join(w.vault, 'jobs', 'search.md'), readFileSync(join(w.vault, 'jobs', 'search.md'), 'utf8'));
  assert.throws(() => runPreview(w.ctx, { changes: searchFileChanges({ roles: { match: 'fuzzy' } }) }), /roles\.match/);
});
