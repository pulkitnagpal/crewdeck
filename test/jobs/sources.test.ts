// The provider sandbox and `crewdeck jobs source` (design D7, §15): the real runner in a real `node --permission` child,
// against a fictional provider tree and a local server. Misbehaving providers try to read, write, spawn and import their
// way out; the parent refuses bad jobs. Nothing here reaches a real site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Plan, cleanJob, cleanEntry, readSourcesState, runProviders, runSources, runnerArgs, sourcePlan, spawnRunner } from '../../src/jobs/sources.ts';
import { normalizeJob } from '../../src/jobs/provider-runner.ts';
import { loadManifest } from '../../src/jobs/providers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { jobs, world } from './helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { CARD, DETAIL } from './linkedin-fixtures.ts';
import { installedFixture } from './provider-helpers.ts';

const plan = (entries: { name: string; entry: Record<string, unknown>; kind?: 'ats' | 'board' }[]): Plan => ({
  entries: entries.map((e, i) => ({ i, name: e.name, list: e.kind === 'ats' ? 'watchlist' : 'boards', kind: e.kind ?? 'board', entry: { name: e.name, ...e.entry } })),
  ids: [...new Set(entries.map((e) => e.entry.provider).filter((p): p is string => typeof p === 'string'))].sort(),
  skipped: [],
});

async function runOne(p: Plan, o: { dir: string; manifest: any; entryTimeoutMs?: number }) {
  const lines: any[] = [];
  const r = await spawnRunner(p, (l) => lines.push(l), o);
  return { ...r, lines, jobs: lines.filter((l) => l.t === 'job'), entries: lines.filter((l) => l.t === 'entry') };
}

test('runner flags: permission model, read grants for the providers and the runner only, no write/process/worker grants', () => {
  const a = runnerArgs('/p/dir', '/r/provider-runner.ts');
  assert.deepEqual(a.slice(0, 3), ['--permission', '--allow-fs-read=/p/dir', '--allow-fs-read=/r/provider-runner.ts']);
  assert.equal(a.includes('--allow-net'), process.allowedNodeEnvironmentFlags.has('--allow-net'));
  assert.ok(a.includes('--disallow-code-generation-from-strings'));
  for (const f of a) assert.doesNotMatch(f, /allow-(fs-write|child-process|worker|addons|wasi|inspector)/);
  assert.deepEqual(a.slice(-2), ['/r/provider-runner.ts', '/p/dir']);
});

test('sandbox: a provider can\'t read or write outside its folder, start a process, read the environment, or import unlisted code', async () => {
  const { dir, manifest } = installedFixture();
  const secretDir = mkdtempSync(join(tmpdir(), 'cd-secret-'));
  const secret = join(secretDir, 'notes.md');
  writeFileSync(secret, 'private');
  const r = await runOne(plan([
    { name: 'Reader', entry: { provider: 'evil-read', target: secret } },
    { name: 'Spawner', entry: { provider: 'evil-spawn' } },
    { name: 'Importer', entry: { provider: 'evil-import' } },
  ]), { dir, manifest });
  assert.equal(r.done, true, r.stderr);
  const title = (p: string) => r.jobs.find((j) => j.provider === p)?.job.title;
  assert.equal(title('evil-read'), 'read ERR_ACCESS_DENIED / write ERR_ACCESS_DENIED');
  assert.equal(existsSync(`${secret}.evil`), false);
  assert.match(title('evil-spawn'), /^spawn refused: provider sandbox: node:child_process is not allowed \/ binding refused \/ env keys 0$/);
  assert.equal(title('evil-import'), 'unlisted refused / package refused');
});

test('sandbox: a file changed after install never runs (every hash is checked before anything is imported)', async () => {
  const { dir, manifest } = installedFixture();
  const f = join(dir, 'providers', 'fixture-board.mjs');
  chmodSync(f, 0o600);
  writeFileSync(f, readFileSync(f, 'utf8').replace('data.jobs', 'data.jobs.concat([{ title: "injected", url: "https://jobs.example.com/x" }])'));
  const r = await runOne(plan([{ name: 'Board', entry: { provider: 'fixture-board', api: 'http://127.0.0.1:9/' } }]), { dir, manifest });
  const fatal = r.lines.find((l) => l.t === 'fatal');
  assert.match(fatal?.error ?? '', /providers\/fixture-board\.mjs: sha256 mismatch/);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.code, 3);
});

test('runner end to end: a board and a careers page from a local server; timeouts, errors and console noise stay per entry', async () => {
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/board') res.end(JSON.stringify({ jobs: [
      { title: 'Senior Data Analyst', url: 'https://jobs.example.com/board/1', company: 'Example Co', location: 'Berlin', description: '<p>SQL and dbt</p>', postedAt: Date.parse('2026-11-18T08:00:00Z'), salary: { min: 60000, max: 70000, currency: 'EUR', period: 'year' } },
      { title: 'Old Analyst', url: 'https://jobs.example.com/board/old', company: 'Example Co', postedAt: Date.parse('2025-01-01T00:00:00Z') },
    ] }));
    else if (req.url === '/careers.json') res.end(JSON.stringify([{ name: 'BI Analyst', link: 'https://ats.example.test/jobs/7', city: 'Berlin', posted: '2026-11-17T10:00:00Z' }]));
    else res.writeHead(404).end();
  });
  try {
    const { dir, manifest } = installedFixture();
    const r = await runOne(plan([
      { name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base()}/board` } },
      { name: 'Example GmbH', kind: 'ats', entry: { careers_url: 'https://ats.example.test/example', api: srv.base() } },
      { name: 'Slow board', entry: { provider: 'slow' } },
      { name: 'Down board', entry: { provider: 'broken' } },
      { name: 'Chatty board', entry: { provider: 'noisy' } },
    ]), { dir, manifest, entryTimeoutMs: 1500 });
    assert.equal(r.done, true, r.stderr);
    assert.equal(r.bad, 0, 'a provider\'s console output never reaches the protocol');
    assert.match(r.stderr, /"title":"forged"/, 'it went to stderr instead');
    const e = (i: number) => r.entries.find((x) => x.i === i);
    assert.equal(e(0).ok, true);
    assert.equal(e(1).provider, 'fixture-ats', 'the careers page was routed by detect()');
    assert.match(e(2).error, /timed out after 2 s|timed out after 1 s/);
    assert.equal(e(3).error, 'the board is down');
    const board = r.jobs.filter((j) => j.i === 0).map((j) => j.job);
    assert.deepEqual(board.map((j) => j.title), ['Senior Data Analyst', 'Old Analyst'], 'no --since cutoff here');
    assert.equal(board[0].pay_text, 'EUR 60000-70000 per year');
    assert.equal(board[0].posted_at, '2026-11-18T08:00:00.000Z');
  } finally { await srv.close(); }
});

test('jobs source: providers → validation → tracker (ats/board labels, refusals counted) → prefilter → state file', async () => {
  const srv = await serve((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/board') res.end(JSON.stringify({ jobs: [
      { title: 'Senior Data Analyst', url: 'https://jobs.example.com/board/1', company: 'Example Co', location: 'Berlin, Germany', description: 'SQL, dbt and Looker in Berlin.', postedAt: Date.now() - 86_400_000 },
      { title: 'Sales Manager', url: 'https://jobs.example.com/board/2', company: 'Example Co', location: 'Berlin, Germany' },
    ] }));
    else res.end(JSON.stringify([{ name: 'BI Analyst', link: 'https://ats.example.test/jobs/7', city: 'Berlin, Germany', posted: new Date().toISOString() }]));
  });
  const w = world('berlin-analyst', { now: new Date().toISOString() });
  try {
    const { dir, manifest } = installedFixture();
    const s = await runSources(w.ctx, {
      dir, manifest, details: 0, entryTimeoutMs: 1500,
      plan: plan([
        { name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base()}/board` } },
        { name: 'Example GmbH', kind: 'ats', entry: { careers_url: 'https://ats.example.test/example', api: srv.base() } },
        { name: 'Chatty board', entry: { provider: 'noisy' } },
      ]),
    });
    const p = s.providers as any;
    assert.equal(p.ran, true);
    assert.equal(p.fetched, 4);
    assert.equal(p.new, 4);
    assert.equal(p.refused, 3, 'javascript: URL, X link and a 400-character title');
    const rows = w.ctx.db.prepare('select r.title, r.source, r.status, c.name company from roles r join companies c on c.id=r.company_id order by r.title').all() as any[];
    assert.deepEqual(rows.map((r) => [r.title, r.source]), [['BI Analyst', 'ats'], ['Data Analyst', 'board'], ['Sales Manager', 'board'], ['Senior Data Analyst', 'board']]);
    assert.equal(rows.find((r) => r.title === 'BI Analyst').company, 'Example GmbH', 'a careers page names its company');
    assert.equal(rows.find((r) => r.title === 'Sales Manager').status, 'prefiltered_out', 'the user\'s rules ran after sourcing');
    assert.equal(s.linkedin?.ran, false);
    const st = readSourcesState(w.ctx.home)!;
    assert.equal(st.new, 4);
    assert.ok(st.finished);
    // Running again finds nothing new.
    const again = await runSources(w.ctx, { dir, manifest, details: 0, plan: plan([{ name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base()}/board` } }]) });
    assert.equal(again.new, 0);
  } finally { await srv.close(); }
});

test('jobs source without installed providers says so and still runs the rules', async () => {
  const w = world('berlin-analyst');
  const s = await runSources(w.ctx, { details: 0 });
  assert.equal((s.providers as any).ran, false);
  assert.match((s.providers as any).why, /not installed: crewdeck jobs providers install/);
  assert.ok(s.prefilter);
});

test('the plan: enabled entries only, known providers only, careers pages labelled ats, only plain values handed over', () => {
  const w = world('berlin-analyst');
  const notes = notesOf(w.ctx);
  const p = sourcePlan(notes, loadManifest());
  assert.deepEqual(p.entries.map((e) => [e.name, e.kind]), [['Arbeitnow', 'board'], ['Berlin Startup Jobs', 'ats'], ['Example GmbH', 'ats']]);
  assert.deepEqual(p.ids, ['arbeitnow', 'sitemap']);
  const fake = { sources: { data: { boards: [{ name: 'Off', provider: 'remotive', enabled: false }, { name: 'Gone', provider: 'vdab' }, { name: 'Nothing' }], watchlist: [] } } } as any;
  const q = sourcePlan(fake, loadManifest());
  assert.deepEqual(q.entries, []);
  assert.deepEqual(q.skipped.map((s) => s.name), ['Gone', 'Nothing']);
  assert.deepEqual(cleanEntry({ name: 'X', provider: 'p', parser: 'rm -rf', fn: (() => 1) as any, deep: { a: { b: 1 } }, opts: { keywords: ['a', 'b'], n: 2 }, list: ['a'] } as any),
    { name: 'X', provider: 'p', deep: {}, opts: { keywords: ['a', 'b'], n: 2 }, list: ['a'] });
});

test('cleanJob: typed, bounded, http(s) only, X never, LinkedIn only when pasted links are on, dates sane', () => {
  const at = new Date('2026-11-19T10:00:00Z');
  const ok = (j: any, f = false) => cleanJob(j, { features: { linkedin_links: f }, at });
  assert.equal(ok({ title: 'A', url: 'ftp://x.example.com/a' }).ok, false);
  assert.equal(ok({ title: 'A', url: 'https://user:pw@example.com/a' }).ok, false);
  assert.equal(ok({ title: 'A', url: 'https://twitter.com/a' }).ok, false);
  assert.equal(ok({ title: 'A', url: 'https://www.linkedin.com/jobs/view/1234567890' }).ok, false);
  assert.equal(ok({ title: 'A', url: 'https://www.linkedin.com/jobs/view/1234567890' }, true).ok, true);
  assert.equal(ok({ title: '', url: 'https://jobs.example.com/a' }).ok, false);
  assert.equal(ok({ title: 7, url: 'https://jobs.example.com/a' }).ok, false);
  const r = ok({ title: ' Analyst\u0000 ', url: 'https://jobs.example.com/a#frag', company: 'C'.repeat(500), posted_at: '2030-01-01T00:00:00Z', pay_text: 5 }) as any;
  assert.equal(r.role.title, 'Analyst');
  assert.equal(r.role.url, 'https://jobs.example.com/a');
  assert.equal(r.role.company.length, 200);
  assert.equal(r.role.posted_at, null, 'a date in the future is dropped');
  assert.equal(r.role.pay_text, null);
  assert.equal((ok({ title: 'A', url: 'https://jobs.example.com/a' }) as any).role.company, 'Unknown');
});

test('normalizeJob: the Hacker News "Company | Role | Place" split, pay text and dates', () => {
  const hn = normalizeJob({ title: 'Example Labs | Data Analyst | Berlin | €70k', url: 'https://news.example.com/item?id=1', company: 'Hacker News', location: '' }, 'hackernews');
  assert.deepEqual([hn.company, hn.title, hn.location], ['Example Labs', 'Data Analyst', 'Berlin | €70k']);
  const hn2 = normalizeJob({ title: 'Hiring', url: 'https://news.example.com/item?id=2', company: 'Hacker News', description: 'no pipes here' }, 'hackernews');
  assert.equal(hn2.company, '');
  const b = normalizeJob({ title: 'Analyst', url: 'https://jobs.example.com/1', location: 'Berlin', workplaceType: 'hybrid', salary: { min: 50, currency: 'USD', period: 'hour' }, postedAt: Date.parse('2026-11-01T00:00:00Z') }, 'board');
  assert.equal(b.location, 'Berlin · hybrid');
  assert.equal(b.pay_text, 'USD 50 per hour');
  assert.equal(b.posted_at, '2026-11-01T00:00:00.000Z');
  assert.equal(normalizeJob({ title: 'X', url: 'u', postedAt: 'yesterday' }, 'b').posted_at, undefined);
});

test('runProviders reports a runner that dies early', async () => {
  const w = world('berlin-analyst');
  const { dir, manifest } = installedFixture();
  const broken = { ...manifest, files: { ...manifest.files, 'providers/missing.mjs': '0'.repeat(64) } };
  const r = await runProviders(w.ctx, plan([{ name: 'Board', entry: { provider: 'fixture-board', api: 'http://127.0.0.1:9/' } }]), { dir, manifest: broken });
  assert.match(r.error ?? '', /providers\/missing\.mjs: ENOENT/);
  assert.equal(r.entries[0].ok, false);
});

test('fitness: the runner imports node: built-ins only (one read grant is enough) and the parent spawns it with an empty environment', () => {
  const runner = readFileSync(new URL('../../src/jobs/provider-runner.ts', import.meta.url), 'utf8');
  const specs = [...runner.matchAll(/^import [^;]*? from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
  const parent = readFileSync(new URL('../../src/jobs/sources.ts', import.meta.url), 'utf8');
  assert.match(parent, /spawn\(process\.execPath, runnerArgs\(dir, runner\), \{ env: \{\}/);
});

test('jobs source: LinkedIn guest search runs after the boards only when the user switched it on', async () => {
  let n = 0;
  const li = await serve((req, res) => {
    n++;
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname.endsWith('/seeMoreJobPostings/search')) { res.writeHead(200, { 'content-type': 'text/html' }).end(u.searchParams.get('start') === '0' ? CARD('4000000071', 'Senior Data Analyst', 'Example Co') : ''); return; }
    if (u.pathname.endsWith('/jobPosting/4000000071')) { res.writeHead(200, { 'content-type': 'text/html' }).end(DETAIL({ company: 'Example Co' })); return; }
    res.writeHead(404).end();
  });
  try {
    const linkedin = { base: `${li.base('li.example.test')}/jobs-guest/jobs/api`, net: { testHosts: testHosts('li.example.test') }, sleep: async () => {} };
    const off = world('berlin-analyst');
    const a = await runSources(off.ctx, { details: 0, linkedin });
    assert.deepEqual([a.linkedin?.ran, a.linkedin?.why], [false, 'LinkedIn search is off']);
    assert.equal(n, 0, 'nothing sent to LinkedIn');
    const on = world('berlin-analyst', { features: { linkedin_search: true } });
    const b = await runSources(on.ctx, { details: 0, linkedin });
    assert.equal(b.linkedin?.ran, true);
    assert.equal(b.linkedin?.stored, 1);
    assert.equal(b.new, 1);
    assert.equal((on.ctx.db.prepare("select source from roles").get() as any).source, 'linkedin');
  } finally { await li.close(); }
});

test('CLI: jobs source without providers prints what ran and what did not', () => {
  const w = world('berlin-analyst');
  w.ctx.db.close();
  const r = jobs(w.home, ['source', '--since', '7']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /boards: not run \(job-board providers are not installed: crewdeck jobs providers install/);
  assert.match(r.out, /LinkedIn: not run \(LinkedIn search is off\)/);
  assert.match(r.out, /after your rules: 0 waiting to be judged, 0 dropped/);
  assert.match(jobs(w.home, ['source', '--since', '0']).err, /--since must be from 1 to 90/);
});
