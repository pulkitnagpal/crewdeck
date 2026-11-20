// Employers (design D24, P9b): a careers page resolved to its provider by the detectors in the sandbox and a one-page
// test fetch, written to jobs/sources.md at once; Claude's help through a `source` request when it can't be read. The
// careers pages are fictional hosts shaped like Workday, Greenhouse and NEOGOV, served by a local server through
// netguard's test hosts: nothing here reaches a real site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { world, textFile, REPO } from './helpers.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { resolveSource } from '../../src/jobs/resolve.ts';
import { sandboxSupport } from '../../src/jobs/sources.ts';
import { changeSources } from '../../src/jobs/sources-note.ts';
import { installedFixture } from './provider-helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { jobsServer, TOKEN } from './api-helpers.ts';

const support = sandboxSupport();
const sandbox = { skip: support.ok ? false : support.why };
const WD = 'example-health.wd1.myworkdayjobs.example.test', GH = 'job-boards.greenhouse.example.test', NG = 'www.governmentjobs.example.test', OTHER = 'careers.example.test';
const net = { testHosts: testHosts(WD, GH, NG, OTHER) };

/** The fictional careers sites: Workday-shaped (34 open roles, 20 a page), Greenhouse-shaped (7), NEOGOV-shaped (23, 10 a page). */
async function careersSites(o: { workdayDown?: boolean } = {}) {
  return serve((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    const send = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (u.pathname === '/wday/cxs/example-health/External/jobs' && req.method === 'POST') {
      if (o.workdayDown) { res.writeHead(500).end('down'); return; }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const { offset } = JSON.parse(body);
        send({ total: 34, jobPostings: Array.from({ length: Math.min(20, 34 - offset) }, (_, i) => ({ title: `Registered Nurse ${offset + i}`, externalPath: `/job/Columbus/RN_${offset + i}`, locationsText: 'Columbus, OH' })) });
      });
      return;
    }
    if (u.pathname === '/v1/boards/example-labs/jobs') return send({ jobs: Array.from({ length: 7 }, (_, i) => ({ title: `Analyst ${i}`, absolute_url: `https://${GH}/example-labs/jobs/${i}`, location: { name: 'Remote' } })) });
    if (u.pathname === '/careers/example-county/jobs.json') {
      const page = Number(u.searchParams.get('page'));
      return send({ agency: 'Example County', more: page < 3, jobs: Array.from({ length: page < 3 ? 10 : 3 }, (_, i) => ({ title: `Public Health Nurse ${page}-${i}`, url: `https://${NG}/careers/example-county/jobs/${page}${i}`, location: 'Example County, OH' })) });
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<p>Careers at Example Stores: visit a store</p>');
  });
}

function addPage(w: ReturnType<typeof world>, name: string, url: string, kind: 'careers_url' | 'url' = 'careers_url') {
  return changeSources(w.ctx, { op: 'add', source: { name, [kind]: url, employer: kind === 'careers_url' } }).key;
}
const item = (w: ReturnType<typeof world>, key: string) => notesOf(w.ctx).sources.data.items.find((x) => x.key === key)!;

test('Workday-, Greenhouse- and NEOGOV-shaped careers pages resolve with counts; the note names the provider at once', sandbox, async () => {
  const srv = await careersSites();
  try {
    const w = world('us-nurse');
    const { dir, manifest } = installedFixture();
    const o = { dir, manifest, net };
    const wd = addPage(w, 'Example Health', `${srv.base(WD)}/External`);
    const gh = addPage(w, 'Example Labs', `${srv.base(GH)}/example-labs`);
    const ng = addPage(w, 'Example County', `${srv.base(NG)}/careers/example-county`);
    const a = await resolveSource(w.ctx, wd, o);
    assert.deepEqual([a.ok, a.provider, a.jobs], [true, 'workday', 20], 'one page of the 34');
    assert.equal(a.line, 'resolved Example Health: Workday, 20 roles on a one-page test');
    const b = await resolveSource(w.ctx, gh, o);
    assert.deepEqual([b.ok, b.provider, b.jobs], [true, 'greenhouse', 7]);
    const c = await resolveSource(w.ctx, ng, o);
    assert.deepEqual([c.ok, c.provider, c.jobs], [true, 'neogov', 10], 'one page of the agency\'s 23');
    assert.equal(item(w, wd).provider, 'workday');
    assert.equal(item(w, ng).fetch, 'auto');
    assert.match(readFileSync(join(w.vault, 'jobs', 'sources.md'), 'utf8'), /- \d{4}-\d{2}-\d{2}: resolved Example County: GovernmentJobs \/ SchoolJobs \(NEOGOV\), 10 roles on a one-page test\n/);
    assert.equal((w.ctx.db.prepare('select count(*) n from roles').get() as any).n, 0, 'a test fetch stores nothing');
    // Only the fixture hosts were asked; the three page-1 requests and nothing more.
    assert.deepEqual(srv.hits.filter((h) => !h.startsWith('/v1/') && !h.startsWith('/wday/')), ['/careers/example-county/jobs.json?page=1']);
  } finally { await srv.close(); }
});

test('an unknown page ends fetch: none with the reason; set-url to the real jobs page and resolve again reads it', sandbox, async () => {
  const srv = await careersSites();
  try {
    const w = world('us-nurse');
    const { dir, manifest } = installedFixture();
    const key = addPage(w, 'Example Stores', `${srv.base(OTHER)}/careers`);
    const r = await resolveSource(w.ctx, key, { dir, manifest, net });
    assert.equal(r.ok, false);
    assert.equal(r.why, 'no provider reads this page: paste its postings, or ask Claude to find its jobs page');
    assert.deepEqual([item(w, key).fetch, item(w, key).why], ['none', r.why]);
    assert.match(readFileSync(join(w.vault, 'jobs', 'sources.md'), 'utf8'), /Example Stores isn't readable by Crewdeck: no provider reads this page/);
    // Claude found the real jobs page (a Greenhouse board): the address is replaced, then resolved.
    changeSources(w.ctx, { op: 'set', key, fields: { careers_url: `${srv.base(GH)}/example-labs`, url: null, provider: null, fetch: null, why: null }, line: 'new jobs page' });
    const again = await resolveSource(w.ctx, key, { dir, manifest, net });
    assert.deepEqual([again.ok, again.provider, item(w, key).fetch, item(w, key).why], [true, 'greenhouse', 'auto', undefined]);
  } finally { await srv.close(); }
});

test('a web address that a provider reads becomes a careers page; a provider error is recorded; hosts outside netguard\'s list are never reached', sandbox, async () => {
  const srv = await careersSites({ workdayDown: true });
  try {
    const w = world('us-nurse');
    const { dir, manifest } = installedFixture();
    const k = addPage(w, 'Example Labs board', `${srv.base(GH)}/example-labs`, 'url');
    assert.equal(item(w, k).fetch, 'none', 'not fetched until resolved');
    const r = await resolveSource(w.ctx, k, { dir, manifest, net });
    assert.equal(r.ok, true);
    assert.deepEqual([item(w, k).url, item(w, k).careers_url, item(w, k).fetch], [undefined, `${srv.base(GH)}/example-labs`, 'auto']);
    const down = addPage(w, 'Example Health', `${srv.base(WD)}/External`);
    const d = await resolveSource(w.ctx, down, { dir, manifest, net });
    assert.equal(d.ok, false);
    assert.match(d.why!, /^Workday couldn't read it \(workday \(fixture\): HTTP 500\): paste its postings/);
    // A Workday-shaped host the test hosts don't map: netguard resolves it for real and refuses or fails; the local
    // server never sees it.
    const before = srv.hits.length;
    const far = addPage(w, 'Elsewhere', `http://elsewhere.wd1.myworkdayjobs.example.test:${srv.port}/External`);
    const e = await resolveSource(w.ctx, far, { dir, manifest, net });
    assert.equal(e.ok, false);
    assert.equal(srv.hits.length, before);
  } finally { await srv.close(); }
});

test('resolve refuses what it can\'t try, and changes nothing then', async () => {
  const w = world('berlin-analyst');
  const before = readFileSync(join(w.vault, 'jobs', 'sources.md'), 'utf8');
  await assert.rejects(resolveSource(w.ctx, 'arbeitnow'), support.ok ? /is a board \(arbeitnow\), not a careers page/ : /Node 25 or newer|is a board/);
  await assert.rejects(resolveSource(w.ctx, 'nope'), /no source with key nope/);
  await assert.rejects(resolveSource(w.ctx, 'Bad Key'), /lowercase/);
  if (!support.ok) await assert.rejects(resolveSource(w.ctx, 'example-gmbh'), /need Node 25 or newer/);
  else await assert.rejects(resolveSource(w.ctx, 'example-gmbh'), /providers are not installed/);
  assert.equal(readFileSync(join(w.vault, 'jobs', 'sources.md'), 'utf8'), before);
});

// ---- the source request, set-url, and the page's sources action ----

let s: Awaited<ReturnType<typeof jobsServer>>;
before(async () => {
  s = await jobsServer('berlin-analyst');
  appendFileSync(join(s.w.home, 'config.yaml'), `port: ${s.port}\n`);
  writeFileSync(join(s.w.home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
});
after(() => s.close());

const crewdeck = (args: string[]): Promise<{ code: number | null; out: string; err: string }> => new Promise((ok) => {
  const p = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', ...args], { cwd: s.workspace, env: { ...process.env, CREWDECK_HOME: s.w.home } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => ok({ code, out, err }));
  p.stdin.end();
});

test('the source request: queued from the page for a careers page only, with the source as context; set-url --request takes the key from it', async () => {
  const id = (await s.action('findJobsPage', { key: 'example-gmbh' })).json.request;
  assert.ok(id);
  assert.equal(s.q.get(id)!.kind, 'source');
  assert.equal(s.q.get(id)!.text, 'Find a jobs page');
  const shown = JSON.parse((await crewdeck(['request', 'show', String(id)])).out);
  assert.deepEqual(shown.payload, { key: 'example-gmbh' });
  assert.equal(shown.context.source.name, 'Example GmbH');
  assert.equal((await s.action('findJobsPage', { key: 'arbeitnow' })).status, 400, 'a board has no page to look up');
  assert.equal((await s.action('findJobsPage', { key: 'nope' })).status, 404);
  assert.equal((await s.action('findJobsPage', { key: '../x' })).status, 400);
  assert.equal((await s.action('findJobsPage', { key: 'example-gmbh' }, { 'content-type': 'application/json' })).status, 403, 'page-only');
  const url = textFile(s.w.root, 'url.txt', 'https://jobs.example.com/example-gmbh/open-roles\n');
  const r = await crewdeck(['sources', 'set-url', '--request', String(id), '--url-file', url]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Example GmbH now reads https:\/\/jobs\.example\.com\/example-gmbh\/open-roles\. Next: crewdeck jobs sources resolve example-gmbh/);
  const note = readFileSync(join(s.w.vault, 'jobs', 'sources.md'), 'utf8');
  assert.match(note, /key: example-gmbh, name: Example GmbH, careers_url: "https:\/\/jobs\.example\.com\/example-gmbh\/open-roles"/);
  assert.match(note, new RegExp(`new jobs page for Example GmbH \\(request ${id}\\)`));
  // Wrong kind, plain set-url, and refusals.
  const find = (await s.action('find', { count: 2 })).json.request;
  assert.match((await crewdeck(['sources', 'set-url', '--request', String(find), '--url-file', url])).err, /kind find: set-url --request works source requests/);
  assert.match((await crewdeck(['sources', 'set-url', 'arbeitnow', '--url-file', url])).err, /not an employer or web-address source/);
  assert.equal((await crewdeck(['sources', 'set-url', 'example-gmbh', '--url-file', textFile(s.w.root, 'u2.txt', 'https://jobs.example.com/gmbh')])).code, 0);
  assert.match((await crewdeck(['sources', 'set-url', 'example-gmbh', '--url-file', textFile(s.w.root, 'u3.txt', 'https://www.linkedin.com/company/x')])).err, /LinkedIn has its own row/);
});

test('the page\'s sources action writes the same bytes as the CLI for the same change, and never touches the LinkedIn switch', async () => {
  const b = world('berlin-analyst');
  b.ctx.db.close();
  // The page action on the server's vault vs. the CLI on a copy: compare the notes after the same operations.
  const ops: [Record<string, unknown>, string[]][] = [
    [{ op: 'add', provider: 'remotive', at: 1 }, ['add', '--provider', 'remotive', '--at', '1']],
    [{ op: 'move', key: 'example-gmbh', to: 1 }, ['move', 'example-gmbh', '--to', '1']],
    [{ op: 'disable', key: 'arbeitnow' }, ['disable', 'arbeitnow']],
    [{ op: 'add', linkedin: true, at: 2 }, ['add', '--linkedin', '--at', '2']],
    [{ op: 'remove', key: 'berlin-startup-jobs' }, ['remove', 'berlin-startup-jobs']],
  ];
  const fresh = await jobsServer('berlin-analyst');
  try {
    const cli = (args: string[]): Promise<number | null> => new Promise((ok) => {
      const p = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', 'sources', ...args], { env: { ...process.env, CREWDECK_HOME: b.home } });
      p.on('close', ok);
    });
    for (const [page, args] of ops) {
      const r = await fresh.action('sources', page);
      assert.equal(r.status, 200, r.body);
      assert.equal(await cli(args), 0);
    }
    assert.equal(readFileSync(join(fresh.w.vault, 'jobs', 'sources.md'), 'utf8'), readFileSync(join(b.vault, 'jobs', 'sources.md'), 'utf8'));
    assert.equal((await fresh.action('sources', { op: 'disable', key: 'linkedin' })).status, 400);
    assert.equal((await fresh.action('sources', { op: 'add', provider: 'vdab' })).status, 400);
    assert.equal((await fresh.action('sources', { op: 'add', careers_url: 'javascript:alert(1)', name: 'X' })).status, 400);
    assert.equal((await fresh.action('sources', { op: 'add', careers_url: 'https://jobs.example.com/x' })).status, 400, 'a page needs its name');
    assert.equal((await fresh.action('sources', { op: 'set_url', key: 'example-gmbh', url: 'https://jobs.example.com/new' })).status, 200);
    assert.equal((await fresh.action('sources', { op: 'explode' })).status, 400);
    assert.equal((await fresh.action('sources', { op: 'remove', key: 'remotive' }, { 'content-type': 'application/json' })).status, 403, 'page-only');
    assert.equal(fresh.w.ctx.features.linkedin_search, false);
  } finally { fresh.close(); }
});
