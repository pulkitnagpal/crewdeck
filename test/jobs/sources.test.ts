// The provider sandbox and `crewdeck jobs source` (design D7, §15): the real runner in a real `node --permission` child,
// against a fictional provider tree and a local server. Misbehaving providers try to read, write, spawn, import, connect
// and forge their way out; the parent refuses bad jobs. Nothing here reaches a real site.
//
// The sandbox needs Node ≥ 25 (its permission model denies the network, E1). On Node 22/24 the tests that spawn it are
// skipped with that reason, and the refusal itself is asserted instead; the parent's fetch bridge is tested everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type Plan, FETCH_CAPS, answerFetch, cleanJob, cleanEntry, readSourcesState, runProviders, runSources, runnerArgs, sandboxSupport, sourcePlan, spawnRunner } from '../../src/jobs/sources.ts';
import { type FetchAsk, normalizeJob } from '../../src/jobs/provider-runner.ts';
import { loadManifest } from '../../src/jobs/providers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { sourceItems } from '../../src/jobs/schema.ts';
import { jobs, world } from './helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { CARD, DETAIL } from './linkedin-fixtures.ts';
import { installedFixture } from './provider-helpers.ts';

const plan = (entries: { name: string; entry: Record<string, unknown>; kind?: 'ats' | 'board' }[]): Plan => ({
  entries: entries.map((e, i) => ({ i, key: `k${i}`, name: e.name, kind: e.kind ?? 'board', entry: { name: e.name, ...e.entry } })),
  ids: [...new Set(entries.map((e) => e.entry.provider).filter((p): p is string => typeof p === 'string'))].sort(),
  skipped: [],
});

const support = sandboxSupport();
/** Tests that spawn the sandbox: skipped on Node < 25, where sourcing refuses (asserted below). */
const sandbox = { skip: support.ok ? false : support.why };
const BOARD = 'board.example.test';
const net = { testHosts: testHosts(BOARD) };

async function runOne(p: Plan, o: { dir: string; manifest: any; entryTimeoutMs?: number; net?: any }) {
  const lines: any[] = [];
  const r = await spawnRunner(p, (l) => lines.push(l), { net, ...o });
  return { ...r, lines, jobs: lines.filter((l) => l.t === 'job'), entries: lines.filter((l) => l.t === 'entry') };
}

test('runner flags: permission model, read grants for the providers and the runner only, no network/write/process/worker grants', () => {
  const a = runnerArgs('/p/dir', '/r/provider-runner.ts');
  assert.deepEqual(a.slice(0, 3), ['--permission', '--allow-fs-read=/p/dir', '--allow-fs-read=/r/provider-runner.ts']);
  assert.ok(a.includes('--disallow-code-generation-from-strings'));
  for (const f of a) assert.doesNotMatch(f, /allow-(net|fs-write|child-process|worker|addons|wasi|inspector)/);
  assert.deepEqual(a.slice(-2), ['/r/provider-runner.ts', '/p/dir']);
});

test('E1: sourcing needs Node 25+ (the permission model denies the network from 25 on); older Node refuses with a clear message', () => {
  const old = sandboxSupport('24.11.1', new Set());
  assert.equal(old.ok, false);
  assert.match((old as any).why, /need Node 25 or newer \(this is Node 24\.11\.1\).*off the network.*pasted links, Prepare and Apply work/);
  assert.equal(sandboxSupport('22.18.0', new Set()).ok, false);
  assert.equal(sandboxSupport('25.0.0', new Set()).ok, false, 'no --allow-net flag: the model does not gate the network');
  assert.equal(sandboxSupport('25.9.0', new Set(['--allow-net'])).ok, true);
  assert.equal(support.ok, Number(process.versions.node.split('.')[0]) >= 25, 'this Node');
});

test('E1: on this Node (< 25) a run refuses before spawning anything, and says why', { skip: support.ok ? 'this Node runs the sandbox (the refusal is for Node < 25)' : false }, async () => {
  const { dir, manifest } = installedFixture();
  await assert.rejects(spawnRunner(plan([{ name: 'Board', entry: { provider: 'fixture-board', api: 'https://board.example.test/' } }]), () => {}, { dir, manifest }), /need Node 25 or newer/);
  const w = world('berlin-analyst');
  const s = await runSources(w.ctx, { dir, manifest, details: 0, plan: plan([{ name: 'Board', entry: { provider: 'fixture-board', api: 'https://board.example.test/' } }]) });
  assert.deepEqual([(s.providers as any).ran, (s.providers as any).why], [false, (support as any).why]);
  assert.ok(s.prefilter, 'the rules still ran');
});

test('sandbox: a provider can\'t read or write outside its folder, start a process, read the environment, or import unlisted code', sandbox, async () => {
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

test('sandbox: a file changed after install never runs (every hash is checked before anything is imported)', sandbox, async () => {
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

test('runner end to end: a board and a careers page from a local server; timeouts, errors and console noise stay per entry', sandbox, async () => {
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
      { name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base(BOARD)}/board` } },
      { name: 'Example GmbH', kind: 'ats', entry: { careers_url: 'https://ats.example.test/example', api: srv.base(BOARD) } },
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

test('jobs source: providers → validation → tracker (ats/board labels, refusals counted) → prefilter → state file', sandbox, async () => {
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
      dir, manifest, details: 0, entryTimeoutMs: 1500, net,
      plan: plan([
        { name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base(BOARD)}/board` } },
        { name: 'Example GmbH', kind: 'ats', entry: { careers_url: 'https://ats.example.test/example', api: srv.base(BOARD) } },
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
    const again = await runSources(w.ctx, { dir, manifest, details: 0, net, plan: plan([{ name: 'Board', entry: { provider: 'fixture-board', api: `${srv.base(BOARD)}/board` } }]) });
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
  const fake = { sources: { data: sourceItems({ boards: [{ name: 'Off', provider: 'remotive', enabled: false }, { name: 'Gone', provider: 'vdab' }, { name: 'Nothing' }], watchlist: [] }) } } as any;
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

test('runProviders reports a runner that dies early', sandbox, async () => {
  const w = world('berlin-analyst');
  const { dir, manifest } = installedFixture();
  const broken = { ...manifest, files: { ...manifest.files, 'providers/missing.mjs': '0'.repeat(64) } };
  const r = await runProviders(w.ctx, plan([{ name: 'Board', entry: { provider: 'fixture-board', api: 'http://127.0.0.1:9/' } }]), { dir, manifest: broken });
  assert.match(r.error ?? '', /providers\/missing\.mjs: ENOENT/);
  assert.equal(r.entries[0].ok, false);
});

test('E1: no network in the sandbox (TCP, DNS, Unix sockets, node:http, loopback through the bridge); fetch to a public host goes through netguard in the parent', sandbox, async () => {
  const { createServer } = await import('node:net');
  const sockDir = mkdtempSync(join(tmpdir(), 'cd-sock-'));
  const sock = join(sockDir, 's');
  const unix = createServer((c) => c.end('secret'));
  await new Promise<void>((ok) => unix.listen(sock, ok));
  const bodies: any[] = [];
  const srv = await serve((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { bodies.push({ method: req.method, url: req.url, type: req.headers['content-type'], board: req.headers['x-board'], body: b }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ echo: JSON.parse(b || '{}').q ?? null })); });
  });
  try {
    const { dir, manifest } = installedFixture();
    const r = await runOne(plan([{ name: 'Net', entry: { provider: 'evil-net', port: srv.port, socket: sock, api: `${srv.base(BOARD)}/search` } }]), { dir, manifest });
    assert.equal(r.done, true, r.stderr);
    const title = r.jobs[0]?.job.title ?? '';
    assert.match(title, /^tcp ERR_ACCESS_DENIED \/ dns ERR_ACCESS_DENIED \/ unix ERR_ACCESS_DENIED \/ http ERR_ACCESS_DENIED \/ loopback blocked \/ public 200 analyst$/, title);
    assert.deepEqual(bodies, [{ method: 'POST', url: '/search', type: 'application/json', board: 'evil', body: '{"q":"analyst"}' }], 'only the public fetch arrived, made by the parent');
    assert.equal(r.fetches, 2, 'the loopback fetch was asked for and refused by netguard');
  } finally { await srv.close(); unix.close(); }
});

test('E2: getBuiltinModule, module.registerHooks, vm, child_process, workers and WebAssembly are refused inside the sandbox', sandbox, async () => {
  const { dir, manifest } = installedFixture();
  const r = await runOne(plan([{ name: 'Escape', entry: { provider: 'evil-escape' } }]), { dir, manifest });
  assert.equal(r.done, true, r.stderr);
  assert.equal(r.jobs[0]?.job.title, 'vm refused / hooks refused / spawn refused / worker refused / replace refused / assign refused / wasm refused / wasmModule refused / wasmInstantiate refused / import refused / fs ran');
});

test('E9: forged protocol lines on stdout, the console or the private channel itself (no nonce) are never stored', sandbox, async () => {
  const w = world('berlin-analyst');
  const { dir, manifest } = installedFixture();
  const lines: any[] = [];
  const out = await spawnRunner(plan([{ name: 'Forge', entry: { provider: 'evil-forge', target: 0 } }]), (l) => lines.push(l), { dir, manifest, net });
  assert.equal(out.done, true, out.stderr);
  assert.deepEqual(lines.filter((l) => l.t === 'job').map((l) => l.job.title), ['Honest Analyst']);
  assert.ok(out.bad >= 2, `lines without the nonce were counted and dropped (${out.bad})`);
  assert.match(out.stderr, /"title":"stdout"/, 'stdout is only a log');
  const r = await runProviders(w.ctx, plan([{ name: 'Forge', entry: { provider: 'evil-forge', target: 0 } }]), { dir, manifest, net });
  assert.equal(r.fetched, 1);
  assert.deepEqual((w.ctx.db.prepare('select title from roles').all() as any[]).map((x) => x.title), ['Honest Analyst']);
});

test('E1: the parent\'s fetch for providers: netguard on every request and redirect, POST bodies, redirect modes, methods and budgets', async () => {
  const srv = await serve((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.url === '/hop') { res.writeHead(302, { location: '/ok' }).end(); return; }
      if (req.url === '/local') { res.writeHead(302, { location: `http://127.0.0.1:${srv.port}/ok` }).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'x-seen': `${req.method} ${b}`, 'set-cookie': ['a=1', 'b=2'] }).end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const base = srv.base(BOARD);
    const budget = { requests: 0, bytes: 0 };
    const ask = (o: Partial<FetchAsk>) => answerFetch({ t: 'fetch', id: 1, url: `${base}/ok`, method: 'GET', headers: [], body: null, redirect: 'follow', ...o }, { net, budget });
    const ok = await ask({ method: 'POST', body: Buffer.from('{"q":1}').toString('base64'), headers: [['content-type', 'application/json'], ['host', 'evil.example'], ['x-bad', 'a\r\nb']] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.headers!.filter(([k]) => k === 'x-seen' || k === 'set-cookie').sort(), [['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['x-seen', 'POST {"q":1}']]);
    assert.equal(Buffer.from(ok.body!, 'base64').toString(), '{"ok":true}');
    assert.deepEqual((await ask({ url: `${base}/hop` })).redirected, true);
    assert.deepEqual([(await ask({ url: `${base}/hop`, redirect: 'error' })).code], ['redirect'], 'career-ops asks for redirect: error');
    assert.equal((await ask({ url: `${base}/hop`, redirect: 'manual' })).status, 302);
    assert.equal((await ask({ url: `${base}/local` })).code, 'blocked', 'a redirect to loopback is refused');
    assert.equal((await ask({ url: `http://127.0.0.1:${srv.port}/ok` })).code, 'blocked');
    assert.equal((await ask({ url: 'file:///etc/passwd' })).code, 'scheme');
    assert.equal((await ask({ method: 'DELETE' })).code, 'method');
    const small = { ...FETCH_CAPS, requests: 1 };
    const b2 = { requests: 0, bytes: 0 };
    assert.equal((await answerFetch({ t: 'fetch', id: 2, url: `${base}/ok`, method: 'GET', headers: [], body: null, redirect: 'follow' }, { net, budget: b2, caps: small })).status, 200);
    assert.equal((await answerFetch({ t: 'fetch', id: 3, url: `${base}/ok`, method: 'GET', headers: [], body: null, redirect: 'follow' }, { net, budget: b2, caps: small })).code, 'budget');
  } finally { await srv.close(); }
});

test('fitness: the runner imports node: built-ins only (one read grant is enough) and the parent spawns it with an empty environment', () => {
  const runner = readFileSync(new URL('../../src/jobs/provider-runner.ts', import.meta.url), 'utf8');
  const specs = [...runner.matchAll(/^import [^;]*? from '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  assert.deepEqual(specs.filter((s) => !s.startsWith('node:')), []);
  const parent = readFileSync(new URL('../../src/jobs/sources.ts', import.meta.url), 'utf8');
  assert.match(parent, /spawn\(process\.execPath, runnerArgs\(dir, runner\), \{ env: \{\}, stdio: \['pipe', 'pipe', 'pipe', 'pipe', 'pipe'\] \}\)/);
  assert.match(runner, /lockDownRuntime\(\);\n\n  \/\/ 4\. The providers/, 'locked down right before the first provider import');
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

test('jobs source: after a LinkedIn stop, LinkedIn is paused 1 h, 4 h, 12 h, then 24 h (stops in a row), shown in its status; a clean run clears it; description coverage per source', async () => {
  let refuse = true, n = 0;
  const li = await serve((req, res) => {
    n++;
    if (refuse) { res.writeHead(429).end(); return; }
    const u = new URL(req.url ?? '', 'http://x');
    if (u.pathname.endsWith('/seeMoreJobPostings/search')) { res.writeHead(200, { 'content-type': 'text/html' }).end(u.searchParams.get('start') === '0' ? CARD('4000000081', 'Senior Data Analyst', 'Example Co') : ''); return; }
    if (u.pathname.endsWith('/jobPosting/4000000081')) { res.writeHead(200, { 'content-type': 'text/html' }).end(DETAIL({ company: 'Example Co' })); return; }
    res.writeHead(404).end();
  });
  try {
    const linkedin = { base: `${li.base('li.example.test')}/jobs-guest/jobs/api`, net: { testHosts: testHosts('li.example.test') }, sleep: async () => {} };
    const w = world('berlin-analyst', { features: { linkedin_search: true } });
    const run = () => runSources(w.ctx, { details: 0, linkedin });
    const hhmm = /LinkedIn paused until \d\d:\d\d/;
    const a = await run();
    assert.match(a.linkedin?.stopped ?? '', /HTTP 429.*LinkedIn paused until \d\d:\d\d$/);
    assert.deepEqual([a.linkedin_pause?.level, a.linkedin_pause?.until], [1, '2026-11-19T11:00:00.000Z']);
    assert.equal(a.by_key?.linkedin?.paused_until, '2026-11-19T11:00:00.000Z');
    // Within the hour: not run, nothing sent, and the source's status says until when.
    const sent = n;
    const b = await run();
    assert.equal(b.linkedin?.ran, false);
    assert.match(b.linkedin?.why ?? '', hhmm);
    assert.match(b.by_key?.linkedin?.why ?? '', hhmm);
    assert.equal(n, sent);
    // Each stop in a row pauses longer: 4 h, 12 h, 24 h, 24 h.
    const hours: number[] = [];
    for (const at of ['2026-11-19T11:01:00Z', '2026-11-19T15:02:00Z', '2026-11-20T03:03:00Z', '2026-11-21T03:04:00Z']) {
      w.at(at);
      const r = await run();
      hours.push(Math.round((Date.parse(r.linkedin_pause!.until) - Date.parse(at)) / 3_600_000));
    }
    assert.deepEqual(hours, [4, 12, 24, 24]);
    // A clean run clears the pause; the role is counted in LinkedIn's description coverage (the fixture's text is short).
    refuse = false;
    w.at('2026-11-22T04:00:00Z');
    const c = await run();
    assert.equal(c.linkedin?.ran, true);
    assert.equal(c.linkedin_pause, undefined);
    assert.equal(c.by_key?.linkedin?.paused_until, undefined);
    assert.deepEqual(c.by_key?.linkedin?.descriptions, { full: 0, total: 1 });
    assert.equal(readSourcesState(w.ctx.home)?.linkedin_pause, undefined);
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
