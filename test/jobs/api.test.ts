import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { splitNote } from '../../src/jobs/notes.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { addEvent, dbFile, getRole } from '../../src/jobs/db.ts';
import { markApplied } from '../../src/jobs/pipeline/apply.ts';
import { currentAnswers } from '../../src/jobs/kb/ops.ts';
import { resumePath } from '../../src/jobs/views.ts';
import { jobsServer, preparedRole, wait, TOKEN } from './api-helpers.ts';
import { role } from './helpers.ts';

const ACTIONS = ['setup', 'find', 'addLink', 'approve', 'retryApply', 'improve', 'editAnswer', 'answer', 'firstTimeChoice', 'notInterested', 'markApplied', 'select', 'prefs', 'feature', 'reveal', 'refreshSources'];

test('jobs off: no Jobs page, no Jobs API, and the workspace is not a lane', async () => {
  const s = await jobsServer('example', { enabled: false });
  try {
    assert.equal((await s.call('GET', '/jobs/')).status, 404);
    assert.equal((await s.get('state')).status, 404);
    assert.equal(JSON.parse((await s.call('GET', '/api/state')).body).jobs, null);
    assert.equal((await s.claim()).json.lane, 'cockpit');
  } finally { await s.close(); }
});

test('every Jobs action is the page\'s own: exact Origin, same-origin fetch, JSON; never an agent token', async () => {
  const s = await jobsServer();
  try {
    for (const name of ACTIONS) {
      const no = (h: Record<string, string>, why: string) => s.action(name, {}, h).then((r) => assert.equal(r.status, 403, `${name}: ${why}`));
      await no({ 'content-type': 'application/json' }, 'no Origin');
      await no({ ...s.page(), origin: 'http://localhost:4747' }, 'another local app');
      await no({ ...s.page(), origin: 'https://evil.example' }, 'another site');
      await no({ ...s.page(), 'sec-fetch-site': 'cross-site' }, 'cross-site fetch');
      await no({ ...s.page(), 'content-type': 'text/plain' }, 'a form post');
      await no(s.agent(), 'an agent token is not the page');
    }
    assert.equal((await s.action('nope')).status, 404);
    assert.equal((await s.action('constructor')).status, 404, 'no prototype names');
    assert.equal((await s.call('PUT', '/api/jobs/state', s.page())).status, 405);
  } finally { await s.close(); }
});

test('reads: never for another site; the page and the address bar may read', async () => {
  const s = await jobsServer();
  try {
    assert.equal((await s.get('state', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await s.get('state', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await s.get('state', { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await s.get('today', { 'sec-fetch-site': 'none' })).status, 200);
    const st = await s.get('state');
    assert.equal(st.headers['access-control-allow-origin'], undefined);
    assert.equal(st.headers['x-content-type-options'], 'nosniff');
    assert.equal(st.json.setup.needed, false, 'the example person is set up');
    assert.equal(st.json.agent.connected, false);
  } finally { await s.close(); }
});

test('the Jobs page: its files only, Preact and htm from an explicit map, an importmap allowed by hash', async () => {
  const s = await jobsServer();
  try {
    const page = await s.call('GET', '/jobs/');
    assert.equal(page.status, 200);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page.body)![1];
    const { createHash } = await import('node:crypto');
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`));
    assert.equal((await s.call('GET', '/jobs')).status, 301);
    for (const f of ['vendor/preact.mjs', 'vendor/hooks.mjs', 'vendor/htm.mjs', 'app.js', 'jobs.css', 'screens/today.js']) assert.equal((await s.call('GET', `/jobs/${f}`)).status, 200, f);
    for (const f of ['vendor/../../package.json', '..%2F..%2Fpackage.json', 'vendor/preact.js', '%2e%2e/%2e%2e/package.json', 'index.html%00.js']) assert.equal((await s.call('GET', `/jobs/${f}`)).status, 404, f);
    assert.doesNotMatch((await s.call('GET', '/jobs/vendor/preact.mjs')).body, /sourceMappingURL/);
    assert.equal((await s.call('GET', '/jobs/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await s.call('GET', '/api/state')).json.jobs.path, '/jobs/');
  } finally { await s.close(); }
});

test('the jobs lane: only typed requests from the page, deduped, claimed by the workspace session as kind, ref and keys', async () => {
  const s = await jobsServer();
  try {
    assert.equal((await s.call('POST', '/api/requests', s.page(), { lane: 'jobs', text: 'apply to everything' })).status, 400, 'the Ask box can\'t reach jobs');
    for (const [url, why] of [['ftp://jobs.example.com/1', 'not http'], ['https://x.com/someone/status/1', 'X'], ['https://www.linkedin.com/jobs/view/4000000001', 'LinkedIn links off'], ['https://www.linkedin.com/feed/', 'not a posting'], ['https://user:pw@example.com/1', 'credentials'], ['not a url', 'not a url']]) {
      assert.equal((await s.action('addLink', { url })).status, 400, why);
    }
    const a = await s.action('addLink', { url: 'https://jobs.example.com/roles/42#apply' });
    assert.equal(a.status, 200);
    assert.equal((await s.action('addLink', { url: 'https://jobs.example.com/roles/42' })).json.request, a.json.request, 'same open link = same request');
    assert.equal((await s.action('find', { count: 50 })).status, 400);
    const f = await s.action('find', {});
    assert.equal(s.q.get(f.json.request)!.payload!.count, 3, 'daily picks from the notes');
    const setup = await s.action('setup');
    const c = await s.claim();
    assert.equal(c.json.lane, 'jobs');
    assert.equal(c.json.hint, 'Use the jobs-workspace skill.');
    assert.deepEqual(c.json.requests.map((r: any) => r.kind), ['link', 'find', 'setup']);
    assert.deepEqual(c.json.requests[0].keys, ['url']);
    assert.doesNotMatch(c.body, /jobs\.example\.com/, 'no payload value in the claim (it reaches the prompt)');
    assert.equal(c.json.requests[2].id, setup.json.request);
    // Claude reads the payload by id, with the token.
    const show = await s.call('POST', `/api/requests/${a.json.request}/show`, s.agent(), { cwd: s.workspace });
    assert.equal(show.json.payload.url, 'https://jobs.example.com/roles/42');
    assert.equal((await s.call('POST', `/api/requests/${a.json.request}/show`, s.page(), {})).status, 401);
    // The shell's request list shows keys, not values.
    assert.doesNotMatch((await s.call('GET', '/api/requests')).body, /roles\/42/);
    // Progress, then done: the payload is cleared, progress and result stay.
    assert.equal((await s.call('POST', `/api/requests/${a.json.request}/progress`, s.agent(), { cwd: s.workspace, text: 'Reading the posting' })).status, 200);
    assert.equal((await s.call('POST', `/api/requests/${a.json.request}/progress`, s.page(), { text: 'x' })).status, 401);
    await s.call('POST', `/api/requests/${a.json.request}/done`, s.agent(), { cwd: s.workspace, result: 'Added Example Labs' });
    const after = s.q.get(a.json.request)!;
    assert.equal(after.payload, undefined);
    assert.equal(after.progress![0].text, 'Reading the posting');
    assert.equal((await s.call('POST', `/api/requests/${a.json.request}/progress`, s.agent(), { cwd: s.workspace, text: 'late' })).status, 400);
    // A new link after the first closed is a new request.
    assert.notEqual((await s.action('addLink', { url: 'https://jobs.example.com/roles/42' })).json.request, a.json.request);
  } finally { await s.close(); }
});

test('LinkedIn links: accepted (canonical, no tracking) once the user switched them on in Settings', async () => {
  const s = await jobsServer();
  try {
    const url = 'https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4000000002&trk=x';
    assert.equal((await s.action('addLink', { url })).status, 400);
    assert.equal((await s.action('feature', { name: 'linkedin_links', value: true })).status, 200);
    const r = await s.action('addLink', { url });
    assert.equal(r.status, 200);
    assert.equal(s.q.get(r.json.request)!.payload!.url, 'https://www.linkedin.com/jobs/view/4000000002');
  } finally { await s.close(); }
});

test('features: only the page\'s POST changes a switch (config.yaml keeps the rest); caps are enforced', async () => {
  const s = await jobsServer();
  try {
    const cfg = join(s.w.home, 'config.yaml');
    assert.equal((await s.action('feature', { name: 'easy_apply', value: true }, s.agent())).status, 403);
    assert.equal((await s.action('feature', { name: 'nope', value: true })).status, 400);
    assert.equal((await s.action('feature', { name: 'daily_quick_apply', value: 26 })).status, 400);
    assert.equal((await s.action('feature', { name: 'easy_apply', value: 'yes' })).status, 400);
    assert.equal((await s.action('feature', { name: 'easy_apply', value: true })).status, 200);
    assert.equal((await s.action('feature', { name: 'daily_quick_apply', value: 5 })).status, 200);
    const y = parse(readFileSync(cfg, 'utf8'));
    assert.equal(y.jobs.features.easy_apply, true);
    assert.equal(y.jobs.features.daily_quick_apply, 5);
    assert.equal(y.vault, s.w.vault, 'the rest of config.yaml is kept');
    const st = await s.get('settings');
    assert.equal(st.json.features.find((f: any) => f.name === 'easy_apply').on, true);
    assert.match(st.json.features.find((f: any) => f.name === 'easy_apply').risk, /against LinkedIn's terms/);
    assert.equal(st.json.features.find((f: any) => f.name === 'easy_apply').limit.value, 5);
  } finally { await s.close(); }
});

test('apply: only when every required question has an answer; copy mode for LinkedIn with Easy Apply off', async () => {
  const s = await jobsServer();
  try {
    const ready = preparedRole(s.w, 'Example Labs');
    const first = preparedRole(s.w, 'Sample Studio', { firstTime: true });
    const li = preparedRole(s.w, 'Placeholder Bank', { url: 'https://www.linkedin.com/jobs/view/4000000003' });
    assert.equal((await s.action('approve', { role: 'zz' })).status, 400);
    assert.equal((await s.action('approve', { role: 'abcdefabcdef' })).status, 404);
    const no = await s.action('approve', { role: first });
    assert.equal(no.status, 400);
    assert.match(no.json.error, /first-time/);
    const copy = await s.action('approve', { role: li });
    assert.equal(copy.json.mode, 'copy');
    assert.match(copy.json.reason, /Easy Apply filling is off/);
    assert.equal(s.q.ofLane('jobs', 'apply').length, 0, 'copy mode queues nothing');
    const ok = await s.action('approve', { role: ready });
    assert.equal(ok.json.mode, 'fill');
    assert.equal(s.q.get(ok.json.request)!.ref, ready);
    assert.deepEqual(s.q.get(ok.json.request)!.payload, { role: ready });
    const t = await s.get(`today?role=${ready}`);
    assert.equal(t.json.panel.state, 'waiting');
    assert.equal(t.json.queue.find((q: any) => q.id === ready).chip.text, 'Waiting for Claude');
    const c = await s.get(`today?role=${li}`);
    assert.equal(c.json.panel.state, 'copy');
    assert.deepEqual(c.json.detail.copy.map((a: any) => a.label), ['First name', 'Email']);
    // request show adds the role (its address) for Claude.
    const show = await s.call('POST', `/api/requests/${ok.json.request}/show`, s.agent(), { cwd: s.workspace });
    assert.equal(show.json.context.role.company, 'Example Labs');
    assert.match(show.json.context.role.url, /^https:\/\/jobs\.example\.com\//);
  } finally { await s.close(); }
});

test('needs you: the user answers in the panel, it is remembered, and Apply is queued again', async () => {
  const s = await jobsServer();
  try {
    const id = preparedRole(s.w, 'Mock Mobility');
    const r1 = (await s.action('approve', { role: id })).json.request;
    await s.claim();
    await s.call('POST', `/api/requests/${r1}/done`, s.agent(), { cwd: s.workspace, result: 'needs you: What is your earliest start date?' });
    let t = await s.get(`today?role=${id}`);
    assert.equal(t.json.panel.state, 'needs_you');
    assert.equal(t.json.panel.question, 'What is your earliest start date?');
    assert.equal(t.json.queue[0].chip.text, 'Needs you');
    assert.equal((await s.action('answer', { role: id, request: r1 + 100, text: 'x' })).status, 400);
    const a = await s.action('answer', { role: id, request: r1, text: 'From 1 February 2027' });
    assert.equal(a.status, 200);
    assert.ok(a.json.reapplied && a.json.reapplied !== r1);
    t = await s.get(`today?role=${id}`);
    assert.equal(t.json.panel.state, 'waiting');
    assert.ok(currentAnswers(s.w.ctx.db, id).some((f) => f.label === 'What is your earliest start date?' && f.text === 'From 1 February 2027'));
    assert.match(readFileSync(join(s.w.vault, 'jobs', 'memory.md'), 'utf8'), /From 1 February 2027/);
  } finally { await s.close(); }
});

test('first-time questions answered on the page: options and words; edits are the user\'s, improve asks Claude', async () => {
  const s = await jobsServer();
  try {
    const id = preparedRole(s.w, 'Sample Studio', { firstTime: true });
    const q = currentAnswers(s.w.ctx.db, id).find((f) => f.status === 'first_time')!;
    assert.equal((await s.action('firstTimeChoice', { role: id, field_id: q.field_id, option: 'Maybe' })).status, 400);
    assert.equal((await s.action('firstTimeChoice', { role: id, field_id: q.field_id, option: 'Yes' })).status, 200);
    assert.equal(currentAnswers(s.w.ctx.db, id).find((f) => f.field_id === q.field_id)!.text, 'Yes');
    assert.equal((await s.get(`today?role=${id}`)).json.detail.approvable, true);
    const email = currentAnswers(s.w.ctx.db, id).find((f) => f.label === 'Email')!;
    assert.equal((await s.action('editAnswer', { role: id, field_id: email.field_id, text: '' })).status, 400);
    assert.equal((await s.action('editAnswer', { role: id, field_id: 99999, text: 'x' })).status, 400);
    assert.equal((await s.action('editAnswer', { role: id, field_id: email.field_id, text: 'sam.work@example.com' })).status, 200);
    assert.equal((await s.action('improve', { role: id, field_id: email.field_id, instruction: 'x'.repeat(501) })).status, 400);
    const imp = await s.action('improve', { role: id, field_id: email.field_id, instruction: 'shorter' });
    assert.deepEqual(s.q.get(imp.json.request)!.payload, { role: id, field_id: email.field_id, question: email.ref, instruction: 'shorter' });
    assert.deepEqual((await s.get(`today?role=${id}`)).json.asking, [email.field_id]);
    const show = await s.call('POST', `/api/requests/${imp.json.request}/show`, s.agent(), { cwd: s.workspace });
    assert.equal(show.json.context.field.label, 'Email');
  } finally { await s.close(); }
});

test('Mark applied and Not interested close the role\'s open requests; so does a CLI marking it applied (reconcile on DB change)', async () => {
  const s = await jobsServer();
  try {
    const a = preparedRole(s.w, 'Example Labs'), b = preparedRole(s.w, 'Sample Studio'), c = preparedRole(s.w, 'Demo Health');
    const ra = (await s.action('approve', { role: a })).json.request;
    const rb = (await s.action('approve', { role: b })).json.request;
    const rc = (await s.action('approve', { role: c })).json.request;
    const m = await s.action('markApplied', { role: a });
    assert.equal(m.status, 200);
    assert.equal(s.q.get(ra)!.status, 'done');
    assert.match(s.q.get(ra)!.result!, /already applied/);
    assert.equal((await s.get(`today?role=${a}`)).json.panel.state, 'applied');
    assert.equal((await s.action('notInterested', { role: b, reason: '' })).status, 400);
    assert.equal((await s.action('notInterested', { role: b, reason: 'Too much travel for me', titleWords: ['Travel'] })).status, 200);
    assert.equal(s.q.get(rb)!.status, 'done');
    assert.equal(getRole(s.w.ctx.db, b).status, 'skipped');
    assert.ok(notesOf(s.w.ctx).search.data.roles.exclude_title_words.includes('Travel'));
    // Another program (the CLI) marks c applied: the server sees the database change and closes c's request.
    markApplied(s.w.ctx, c);
    for (let i = 0; i < 40 && s.q.get(rc)!.status !== 'done'; i++) await wait(50);
    assert.equal(s.q.get(rc)!.status, 'done');
  } finally { await s.close(); }
});

test('preferences: saved to jobs/search.md with a Changes line; invalid values save nothing and say which field', async () => {
  const s = await jobsServer();
  try {
    const file = join(s.w.vault, 'jobs', 'search.md');
    const before = readFileSync(file, 'utf8');
    const p = await s.get('preferences');
    assert.deepEqual(p.json.values.workplace, ['remote', 'hybrid']);
    assert.equal((await s.action('prefs', { changes: { 'rules.title_gate': ['x'] } })).status, 400, 'only the form\'s fields');
    assert.equal((await s.action('prefs', { changes: { 'pay.floor': 'lots' } })).status, 400);
    const bad = await s.action('prefs', { changes: { workplace: ['remote', 'office'], 'pay.floor': 5000 } });
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.issues[0].path, 'workplace.1');
    assert.equal(readFileSync(file, 'utf8'), before, 'nothing written');
    const ok = await s.action('prefs', { changes: { workplace: ['remote', 'hybrid', 'onsite'], 'places.onsite': ['Lisbon', 'Porto, Portugal'], 'pay.floor': 5000, needs_sponsorship: false, languages: [{ name: 'English', level: 'fluent' }] } });
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.changed.sort(), ['languages', 'pay.floor', 'places.onsite', 'workplace']);
    const text = readFileSync(file, 'utf8');
    const front = parse(splitNote(text).front!);
    assert.deepEqual(front.places.onsite, ['Lisbon', 'Porto, Portugal']);
    assert.equal(front.pay.floor, 5000);
    assert.match(text, /- \d{4}-\d{2}-\d{2}: workplace: remote, hybrid → remote, hybrid, onsite\. "\(set on the Jobs page\)"/);
    assert.match(text, /pay\.floor: 4500 → 5000\. "\(set on the Jobs page\)"/);
    assert.match(text, /# Job search/, 'the body is kept');
  } finally { await s.close(); }
});

test('busy: while a CLI holds the write lock the page gets "busy, retry" instead of a stalled shell', async () => {
  const s = await jobsServer();
  try {
    const id = preparedRole(s.w, 'Example Labs');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const other = new DatabaseSync(dbFile(s.w.jobsHome));
    other.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      const r = await s.action('markApplied', { role: id });
      assert.equal(r.status, 503);
      assert.equal(r.json.error, 'busy, retry');
      assert.ok(Date.now() - t0 < 3000);
      assert.equal((await s.call('GET', '/api/state')).status, 200, 'the shell still answers');
    } finally { other.exec('ROLLBACK'); other.close(); }
    assert.equal((await s.action('markApplied', { role: id })).status, 200);
  } finally { await s.close(); }
});

test('resume: by role id only, inside jobs.home/out, inline PDF with nosniff; Show in Finder only on macOS', async () => {
  const shown: string[] = [];
  const s = await jobsServer('example', { api: { platform: 'darwin', reveal: async (f) => { shown.push(f); } } });
  try {
    const id = preparedRole(s.w, 'Example Labs');
    assert.equal((await s.get(`resume/${id}`)).status, 404, 'not made yet');
    const pdf = resumePath(s.w.ctx, id, notesOf(s.w.ctx));
    mkdirSync(join(s.w.jobsHome, 'out', id), { recursive: true });
    writeFileSync(pdf, '%PDF-1.4 fictional');
    const r = await s.get(`resume/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-disposition'], /^inline; filename="Sam Example Resume\.pdf"/);
    assert.match((await s.get(`resume/${id}?download=1`)).headers['content-disposition'], /^attachment/);
    for (const bad of ['..%2F..%2Fconfig.yaml', '../config.yaml', `${id}x`, 'ABCDEFABCDEF', '%2e%2e']) assert.equal((await s.get(`resume/${bad}`)).status, 404, bad);
    // A link that points outside out/ is refused.
    const other = role(s.w.ctx, { company: 'Sample Studio' }, 'picked');
    mkdirSync(join(s.w.jobsHome, 'out', other), { recursive: true });
    symlinkSync(join(s.w.home, 'config.yaml'), resumePath(s.w.ctx, other, notesOf(s.w.ctx)));
    assert.equal((await s.get(`resume/${other}`)).status, 404);
    const t = await s.get(`today?role=${id}`);
    assert.deepEqual(t.json.detail.resume, { file: 'Sam Example Resume.pdf', url: `/api/jobs/resume/${id}`, note: 'Tailored for this role' });
    assert.doesNotMatch(t.body, new RegExp(s.w.jobsHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no file system path to the page');
    assert.equal((await s.action('reveal', { role: id })).status, 200);
    assert.deepEqual(shown.map((f) => f.endsWith('Sam Example Resume.pdf')), [true]);
    assert.equal((await s.action('reveal', { role: other })).status, 404);
  } finally { await s.close(); }
  const linux = await jobsServer('example', { api: { platform: 'linux', reveal: async () => { throw new Error('never'); } } });
  try {
    const id = preparedRole(linux.w, 'Example Labs');
    assert.equal((await linux.action('reveal', { role: id })).status, 404);
    assert.equal((await linux.get('state')).json.reveal, false);
  } finally { await linux.close(); }
});

function events(port: number) {
  const got: string[] = [];
  const req = httpGet({ host: '127.0.0.1', port, path: '/api/jobs/events', headers: { host: `localhost:${port}`, 'sec-fetch-site': 'same-origin' } }, (res) => res.on('data', (d) => got.push(String(d))));
  return { got, stop: () => req.destroy(), text: () => got.join('') };
}

test('live refresh: an event when another program writes the database, and when a note changes on disk', async () => {
  const s = await jobsServer();
  try {
    const id = preparedRole(s.w, 'Example Labs');
    const e = events(s.port);
    await wait(200);
    addEvent(s.w.ctx.db, id, 'note', 'written by the CLI');
    for (let i = 0; i < 40 && !/"db"/.test(e.text()); i++) await wait(50);
    assert.match(e.text(), /event: refresh\ndata: \{"topics":\[[^\]]*"db"/);
    appendFileSync(join(s.w.vault, 'jobs', 'search.md'), '\nA line the user added in Notes.\n');
    for (let i = 0; i < 60 && !/"notes"/.test(e.text()); i++) await wait(50);
    assert.match(e.text(), /"notes"/);
    await s.action('setup');
    for (let i = 0; i < 40 && !/"queue"/.test(e.text()); i++) await wait(50);
    assert.match(e.text(), /"queue"/);
    e.stop();
    assert.equal((await s.call('GET', '/api/jobs/events', { 'sec-fetch-site': 'cross-site' })).status, 403);
  } finally { await s.close(); }
});

test('state: banners for a broken note and a missing browser; the setup card for a new user', async () => {
  const s = await jobsServer('example', { api: { browser: () => null } });
  try {
    const file = join(s.w.vault, 'jobs', 'search.md');
    await s.get('state'); // read once while valid: that version is kept as the last valid one
    writeFileSync(file, readFileSync(file, 'utf8').replace('floor: 4500', 'floor: lots'));
    const st = (await s.get('state')).json;
    assert.ok(st.banners.some((b: any) => b.kind === 'note' && /pay\.floor/.test(b.text) && b.page === 'jobs/search'));
    assert.ok(st.banners.some((b: any) => b.kind === 'browser'));
    assert.equal(st.setup.needed, false, 'a broken note falls back to its last valid version');
  } finally { await s.close(); }
  const fresh = await jobsServer('template');
  try {
    const st = (await fresh.get('state')).json;
    assert.equal(st.setup.needed, true);
    assert.deepEqual(st.setup.files.map((f: any) => f.file), ['me/profile.md', 'me/career.md', 'jobs/search.md', 'jobs/memory.md', 'jobs/sources.md']);
    assert.equal(st.agent.workspace, fresh.workspace);
    await fresh.action('setup');
    assert.equal((await fresh.get('state')).json.setup.request.status, 'new');
  } finally { await fresh.close(); }
});

// ---- review pass A ----

test('W3/C1: switching on needs a yes in the native dialog; no is unchanged; no dialog gives a one-time code for the terminal', async () => {
  const answers: string[] = [];
  let next: 'yes' | 'no' | 'unavailable' = 'no';
  const s = await jobsServer('example', { api: { confirm: async (_t, text) => { answers.push(text); return next; } } });
  try {
    const cfg = join(s.w.home, 'config.yaml');
    const no = await s.action('feature', { name: 'easy_apply', value: true });
    assert.equal(no.status, 409);
    assert.match(no.json.error, /cancelled/);
    assert.match(answers[0], /Switch on Easy Apply filling\?[\s\S]*LinkedIn's terms/);
    assert.doesNotMatch(readFileSync(cfg, 'utf8'), /easy_apply: true/);

    next = 'unavailable';
    const code = await s.action('feature', { name: 'easy_apply', value: true });
    assert.equal(code.status, 200);
    assert.equal(code.json.ok, false);
    assert.equal(code.json.terminal.command, 'crewdeck jobs features easy_apply on');
    assert.match(code.json.terminal.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.doesNotMatch(readFileSync(cfg, 'utf8'), /easy_apply: true/, 'nothing changes until the terminal');
    const { useCode } = await import('../../src/jobs/confirm.ts');
    assert.equal(useCode(TOKEN, 'easy_apply', true, code.json.terminal.code, join(s.w.home, 'feature-code.json')), true, 'the code the CLI asks for');

    next = 'yes';
    const yes = await s.action('feature', { name: 'easy_apply', value: true });
    assert.equal(yes.status, 200);
    assert.deepEqual(yes.json.also, [{ name: 'daily_quick_apply', value: 5 }], 'C11: on with 0 a day starts at 5');
    const y = parse(readFileSync(cfg, 'utf8'));
    assert.equal(y.jobs.features.easy_apply, true);
    assert.equal(y.jobs.features.daily_quick_apply, 5);

    // Off and lower never ask; higher does.
    const before = answers.length;
    assert.equal((await s.action('feature', { name: 'daily_quick_apply', value: 2 })).status, 200);
    assert.equal((await s.action('feature', { name: 'easy_apply', value: false })).status, 200);
    assert.equal(answers.length, before);
    next = 'no';
    assert.equal((await s.action('feature', { name: 'daily_quick_apply', value: 9 })).status, 409);
    assert.equal(answers.length, before + 1);
    assert.equal((await s.action('feature', { name: '__proto__', value: true })).status, 400, 'W6');
    assert.equal((await s.action('feature', { name: 'toString', value: true })).status, 400, 'W6');
  } finally { await s.close(); }
});

test('W3: one dialog at a time', async () => {
  let release: (v: 'yes') => void = () => {};
  const s = await jobsServer('example', { api: { confirm: () => new Promise((r) => { release = r; }) } });
  try {
    const first = s.action('feature', { name: 'linkedin_links', value: true });
    await wait(50);
    const second = await s.action('feature', { name: 'linkedin_search', value: true });
    assert.equal(second.status, 409);
    assert.match(second.json.error, /already open/);
    release('yes');
    assert.equal((await first).status, 200);
  } finally { await s.close(); }
});

test('C11: Easy Apply on with 0 forms a day says so, not "off"; C12: a switch changed in a terminal is seen without a restart', async () => {
  const s = await jobsServer('example');
  try {
    const id = preparedRole(s.w, 'Example Labs', { url: 'https://www.linkedin.com/jobs/view/4000000003/' });
    const cfg = join(s.w.home, 'config.yaml');
    const { setFeature } = await import('../../src/config.ts');
    setFeature('easy_apply', true, cfg); // the user's terminal, behind the server's back
    await wait(20);
    const t = await s.get(`today?role=${id}`);
    assert.equal(t.json.panel.state, 'copy');
    assert.match(t.json.panel.copyReason, /on, but its forms per day is 0/);
    setFeature('daily_quick_apply', 3, cfg);
    await wait(20);
    assert.equal((await s.get(`today?role=${id}`)).json.panel.state, 'ready', 'seen on the next view');
    assert.equal((await s.get('settings')).json.features.find((f: any) => f.name === 'easy_apply').limit.value, 3);
  } finally { await s.close(); }
});

test('W9: the live stream is for the page (same-origin) or the token; HEAD never holds a slot', async () => {
  const s = await jobsServer('example');
  try {
    assert.equal((await s.call('GET', '/api/jobs/events')).status, 403, 'a local tool without the token');
    assert.equal((await s.call('GET', '/api/jobs/events', { 'sec-fetch-site': 'none' })).status, 403);
    const head = await s.call('HEAD', '/api/jobs/events', { 'sec-fetch-site': 'same-origin' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const e = httpGet({ host: '127.0.0.1', port: s.port, path: '/api/jobs/events', headers: { host: `localhost:${s.port}`, 'x-crewdeck-token': TOKEN } });
    const status = await new Promise<number>((ok) => e.on('response', (r) => ok(r.statusCode!)));
    assert.equal(status, 200);
    e.destroy();
  } finally { await s.close(); }
});

test('C4: Cancel on the panel closes a waiting or stuck request; presence needs a claim', async () => {
  const s = await jobsServer('example');
  try {
    const id = preparedRole(s.w, 'Example Labs');
    const a = await s.action('approve', { role: id });
    await s.claim();
    (s.q as any).seen.clear(); // the session went away
    let t = await s.get(`today?role=${id}`);
    assert.equal(t.json.panel.state, 'filling');
    assert.equal(t.json.panel.connected, false, 'a picked request alone is not a connected session');
    assert.equal((await s.action('cancel', { request: a.json.request }, s.agent())).status, 403, 'the page only');
    assert.equal((await s.action('cancel', { request: 'x' })).status, 400);
    assert.equal((await s.action('cancel', { request: a.json.request })).status, 200);
    t = await s.get(`today?role=${id}`);
    assert.equal(t.json.panel.state, 'stopped');
    assert.equal(t.json.panel.reason, 'Cancelled on the page');
    assert.equal((await s.action('cancel', { request: a.json.request })).status, 400, 'already closed');
  } finally { await s.close(); }
});
