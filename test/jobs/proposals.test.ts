// Tell Crewdeck (P3): proposals apply only through the existing writers, quoted or fetched material never applies on its
// own, the person's own words apply at once only for low-risk kinds (and can be undone), the CLI takes files only, the
// page actions are the page's own, and the Tell box and Proposals card render.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { Proposals, TellArea, TELL_PLACEHOLDER, isJobLink } from '../../web/jobs/screens/tell.js';
import { Today } from '../../web/jobs/screens/today.js';
import { type ApplyEnv, ProposalError, addProposal, approve, checkProposal, getProposal, proposalView, reject, undo } from '../../src/jobs/proposals.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { NOTES } from '../../src/jobs/notes.ts';
import { jobs, textFile, world } from './helpers.ts';
import { jobsServer, wait } from './api-helpers.ts';

const env = (w: ReturnType<typeof world>) => {
  const links: string[] = [];
  const cancelled: number[] = [];
  const e: ApplyEnv = { ctx: w.ctx, queueLink: (url) => { links.push(url); return 40 + links.length; }, cancelLink: (id) => { cancelled.push(id); return true; } };
  return { e, links, cancelled };
};
const search = (w: ReturnType<typeof world>) => notesOf(w.ctx).search.data;
const changes = (w: ReturnType<typeof world>) => readFileSync(join(w.vault, NOTES.search), 'utf8').split('## Changes')[1] ?? '';

test('proposals: each kind applies through its writer, with a dated Changes line quoting the person', () => {
  const w = world('example');
  const { e, links } = env(w);
  const said = 'I also want product manager roles, and I could move to Berlin';
  const p = addProposal(e, checkProposal({
    origin: 'person', summary: 'PM roles and Berlin',
    items: [
      { kind: 'target_add', payload: { name: 'Product manager', titles: ['product manager', 'product owner'], families: ['product-project'] }, reason: 'You want PM roles', evidence: 'I also want product manager roles' },
      { kind: 'place', payload: { field: 'relocate_to', value: 'Berlin' }, reason: 'You could move', evidence: 'I could move to Berlin' },
      { kind: 'work_mode', payload: { workplace: ['remote'] }, reason: 'Remote only' },
      { kind: 'pay', payload: { floor: 5000 }, reason: 'Higher floor' },
      { kind: 'exclude', payload: { field: 'industries', value: 'tobacco' }, reason: 'No tobacco' },
      { kind: 'exclude', payload: { field: 'title_words', value: 'sales' }, reason: 'No sales' },
      { kind: 'profile_fact', payload: { text: 'Led a team of five designers' }, reason: 'A fact', evidence: 'I led a team of five' },
      { kind: 'answer', payload: { key: 'notice_period', text: 'One month' }, reason: 'Notice', evidence: 'my notice is one month' },
      { kind: 'watch_company', payload: { name: 'Example Health', careers_url: 'https://careers.example.org/jobs' }, reason: 'Watch it' },
      { kind: 'source_add', payload: { url: 'https://jobs.example.net/board' }, reason: 'A board' },
      { kind: 'add_link', payload: { url: 'https://jobs.example.com/123' }, reason: 'A posting' },
      { kind: 'target_remove', payload: { name: 'Product design' }, reason: 'Stop design roles' },
    ],
  }), { told: said });
  // Auto: the target and the place (their words, found in what they told); the link and the company had no evidence.
  assert.deepEqual(p.items.map((i) => i.status), ['approved', 'approved', ...Array(10).fill('pending')]);
  assert.ok(search(w).roles.targets.some((t) => t.name === 'Product manager' && t.titles.includes('product owner')));
  assert.ok(search(w).places.relocate_to.includes('Berlin'));
  assert.match(changes(w), /roles\.targets: .*Product manager .*"I also want product manager roles"/);
  const r = approve(e, p.id, undefined, { where: 'on the Jobs page' });
  assert.deepEqual(r.failed, []);
  assert.equal(r.applied, 10);
  const s = search(w);
  assert.deepEqual(s.workplace, ['remote']);
  assert.equal(s.pay.floor, 5000);
  assert.ok(s.exclude.industries.includes('tobacco'));
  assert.ok(s.roles.exclude_title_words.includes('sales'));
  assert.ok(!s.roles.targets.some((t) => t.name === 'Product design'), 'target removed');
  assert.ok(s.roles.targets.some((t) => t.name === 'Product manager'), 'the other target kept');
  assert.match(changes(w), /workplace: remote, hybrid → remote\. "\(approved on the Jobs page: Remote only\)"/);
  const mem = notesOf(w.ctx).memory.data.items;
  assert.ok(mem.some((m) => m.kind === 'fact' && m.text === 'Led a team of five designers' && m.quote === 'I led a team of five'));
  assert.ok(mem.some((m) => m.kind === 'answer' && m.key === 'notice_period'));
  const src = notesOf(w.ctx).sources.data.items;
  assert.ok(src.some((x) => x.careers_url === 'https://careers.example.org/jobs' && x.employer));
  assert.ok(src.some((x) => x.url === 'https://jobs.example.net/board'));
  assert.deepEqual(links, ['https://jobs.example.com/123']);
  const done = getProposal(w.ctx.db, p.id);
  assert.equal(done.status, 'done');
  // Removing a source by key.
  const key = src.find((x) => x.url === 'https://jobs.example.net/board')!.key;
  const q = addProposal(e, checkProposal({ origin: 'person', summary: 'drop it', items: [{ kind: 'source_remove', payload: { key }, reason: 'Drop it' }] }));
  approve(e, q.id, 1, { quote: 'yes drop that board' });
  assert.ok(!notesOf(w.ctx).sources.data.items.some((x) => x.key === key));
});

test('proposals: quoted and fetched material never apply on their own; fetched can\'t carry facts or answers', () => {
  const w = world('example');
  const { e, links } = env(w);
  const told = 'Example Health is hiring remote designers https://jobs.example.com/9';
  for (const origin of ['quoted', 'fetched'] as const) {
    const p = addProposal(e, checkProposal({
      origin, summary: 'From a post',
      items: [
        { kind: 'add_link', payload: { url: 'https://jobs.example.com/9' }, reason: 'In the post', evidence: 'https://jobs.example.com/9' },
        { kind: 'watch_company', payload: { name: 'Example Health', careers_url: 'https://careers.example.org/' }, reason: 'Hiring', evidence: 'Example Health is hiring' },
        { kind: 'target_add', payload: { name: 'UX', titles: ['ux designer'] }, reason: 'x', evidence: 'remote designers' },
      ],
    }), { told });
    assert.ok(p.items.every((i) => i.status === 'pending' && !i.auto), `${origin}: nothing applied`);
  }
  assert.deepEqual(links, []);
  assert.equal(search(w).roles.targets.length, 1);
  assert.throws(() => checkProposal({ origin: 'fetched', summary: 's', items: [{ kind: 'profile_fact', payload: { text: 'x' }, reason: 'r' }] }), /never from a fetched page/);
  assert.throws(() => checkProposal({ origin: 'fetched', summary: 's', items: [{ kind: 'answer', payload: { key: 'k', text: 'x' }, reason: 'r' }] }), /never from a fetched page/);
});

test('proposals: the person\'s words auto-apply only for low-risk kinds whose evidence is in what they told; undo works', () => {
  const w = world('example');
  const { e, links, cancelled } = env(w);
  const told = 'Watch Example Health. Remote only now. Here is a job https://jobs.example.com/77 and I can work from Canada';
  const p = addProposal(e, checkProposal({
    origin: 'person', summary: 's',
    items: [
      { kind: 'watch_company', payload: { name: 'Example Health', careers_url: 'https://careers.example.org/' }, reason: 'r', evidence: 'Watch Example Health' },
      { kind: 'work_mode', payload: { workplace: ['remote'] }, reason: 'r', evidence: 'Remote only now' },
      { kind: 'add_link', payload: { url: 'https://jobs.example.com/77' }, reason: 'r', evidence: 'https://jobs.example.com/77' },
      { kind: 'place', payload: { field: 'remote_from', value: 'Canada' }, reason: 'r', evidence: 'I can work from Mexico' },
    ],
  }), { told });
  assert.deepEqual(p.items.map((i) => i.status), ['approved', 'pending', 'approved', 'pending'], 'work_mode is not low-risk; the place\'s evidence is not their words');
  assert.deepEqual(search(w).workplace, ['remote', 'hybrid']);
  assert.deepEqual(links, ['https://jobs.example.com/77']);
  // Without the request's text nothing applies at once.
  const q = addProposal(e, checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'place', payload: { field: 'onsite', value: 'Porto' }, reason: 'r', evidence: 'Porto' }] }));
  assert.equal(q.items[0].status, 'pending');
  // Undo: the company leaves the sources, the link request is cancelled.
  assert.ok(notesOf(w.ctx).sources.data.items.some((x) => x.name === 'Example Health'));
  undo(e, p.id, 1);
  assert.ok(!notesOf(w.ctx).sources.data.items.some((x) => x.name === 'Example Health'));
  undo(e, p.id, 3);
  assert.deepEqual(cancelled, [41]);
  assert.equal(getProposal(w.ctx.db, p.id).items[0].undone, true);
  assert.throws(() => undo(e, p.id, 2), ProposalError, 'only what Crewdeck applied on its own');
  // Undo a target added at once.
  const t = addProposal(e, checkProposal({ origin: 'person', summary: 's', items: [{ kind: 'target_add', payload: { name: 'Nurse', titles: ['registered nurse'], families: ['healthcare'] }, reason: 'r', evidence: 'nurse' }] }), { told: 'I am a nurse' });
  assert.ok(search(w).roles.targets.some((x) => x.name === 'Nurse'));
  undo(e, t.id, 1);
  assert.ok(!search(w).roles.targets.some((x) => x.name === 'Nurse'));
  assert.ok(search(w).roles.targets.some((x) => x.name === 'Product design'), 'other targets kept');
  // Reject one; a writer that refuses leaves the item pending with the reason.
  const r = addProposal(e, checkProposal({ origin: 'quoted', summary: 's', items: [
    { kind: 'source_remove', payload: { key: 'no-such-source' }, reason: 'r' }, { kind: 'exclude', payload: { field: 'companies', value: 'Example Bank' }, reason: 'r' }] }));
  const a = approve(e, r.id);
  assert.equal(a.applied, 1);
  assert.match(a.failed[0], /item 1: no source with key/);
  assert.equal(getProposal(w.ctx.db, r.id).items[0].status, 'pending');
  reject(e, r.id, 1);
  assert.equal(getProposal(w.ctx.db, r.id).status, 'done');
  assert.throws(() => reject(e, r.id, 1), /already rejected/);
});

test('proposals: the file is checked whole (kinds, payload fields, families, origin, size)', () => {
  const ok = { origin: 'person', summary: 'x'.repeat(400), items: [{ kind: 'add_link', payload: { url: 'https://jobs.example.com/1' }, reason: 'r' }] };
  assert.equal(checkProposal(ok).summary.length, 300);
  for (const [bad, re] of [
    [{ ...ok, origin: 'someone' }, /origin must be one of/],
    [{ ...ok, items: [] }, /at least one item/],
    [{ ...ok, items: [{ kind: 'run_command', payload: {}, reason: 'r' }] }, /kind must be one of/],
    [{ ...ok, items: [{ kind: 'add_link', payload: { url: 'javascript:alert(1)' }, reason: 'r' }] }, /http\(s\)/],
    [{ ...ok, items: [{ kind: 'add_link', payload: { url: 'https://x.example', extra: 1 }, reason: 'r' }] }, /unknown field "extra"/],
    [{ ...ok, items: [{ kind: 'target_add', payload: { name: 'X', titles: ['x'], families: ['astrology'] }, reason: 'r' }] }, /not a field Crewdeck knows/],
    [{ ...ok, items: [{ kind: 'pay', payload: {}, reason: 'r' }] }, /give floor, currency or period/],
    [{ ...ok, items: [{ kind: 'add_link', payload: { url: 'https://x.example' } }] }, /reason is required/],
    [{ ...ok, items: Array(21).fill(ok.items[0]) }, /at most 20/],
    [{ ...ok, approve: true }, /unknown field "approve"/],
  ] as const) assert.throws(() => checkProposal(bad), re as RegExp);
});

test('CLI: propose, proposals and tell take text and JSON only from files', () => {
  const w = world('example');
  const run = (args: string[], input = '') => jobs(w.home, args, input);
  let r = run(['propose', '--file', '-'], '{}');
  assert.notEqual(r.code, 0); assert.match(r.err, /not stdin/);
  r = run(['propose', '{"origin":"person"}']);
  assert.notEqual(r.code, 0); assert.match(r.err, /usage: crewdeck jobs propose/);
  r = run(['propose', '--file', textFile(w.root, 'p.json', 'not json')]);
  assert.match(r.err, /not valid JSON/);
  r = run(['propose', '--file', textFile(w.root, 'p.json', JSON.stringify({ origin: 'person', summary: 's', items: [{ kind: 'nope', payload: {}, reason: 'r' }] }))]);
  assert.match(r.err, /kind must be one of/, 'checked before anything reaches Crewdeck');
  r = run(['propose', '--file', '/etc/hosts']);
  assert.notEqual(r.code, 0, 'a file outside Jobs\' folders is refused');
  r = run(['tell', 'now PM roles']);
  assert.match(r.err, /usage: crewdeck jobs tell/);
  r = run(['tell', '--text-file', '-'], 'x');
  assert.match(r.err, /not stdin/);
  r = run(['proposals', 'approve', '3']);
  assert.match(r.err, /needs the person's own yes/);
  r = run(['proposals', 'delete', '3']);
  assert.match(r.err, /usage: crewdeck jobs proposals/);
});

// ---- the server ----

let s: Awaited<ReturnType<typeof jobsServer>>;
after(() => s?.close());

test('server: tell queues a tell request (page action, same-origin only) and returns the Jobs chat link', async () => {
  const opened: string[] = [];
  s = await jobsServer('example', { api: { autoOpenChat: true, platform: 'darwin', openLink: async (l) => { opened.push(l); } } });
  const r = await s.action('tell', { text: 'now PM roles please' });
  assert.equal(r.status, 200, r.body);
  const req = s.q.get(r.json.request)!;
  assert.equal(req.kind, 'tell');
  assert.deepEqual(req.payload, { text: 'now PM roles please' });
  assert.match(r.json.link, /^claude:\/\/code\/new\?folder=.*&q=Crewdeck%3A%20handle%20tell%20request%20\d+$/);
  assert.equal(r.json.opened_chat, true);
  assert.match(decodeURIComponent(opened[0]), /Crewdeck: handle tell request \d+/);
  // The page's own only: another origin, no Fetch Metadata, a form post, the token alone.
  for (const h of [{ ...s.page(), origin: 'http://evil.example' }, { ...s.page(), 'sec-fetch-site': 'cross-site' }, { ...s.page(), 'content-type': 'text/plain' }, s.agent()]) {
    assert.equal((await s.action('tell', { text: 'x' }, h)).status, 403);
    assert.equal((await s.action('approveProposal', { id: 1 }, h)).status, 403);
    assert.equal((await s.action('rejectProposal', { id: 1 }, h)).status, 403);
  }
  assert.equal((await s.action('tell', { text: '   ' })).status, 400);
  assert.equal((await s.action('tell', { text: 'x'.repeat(3001) })).status, 400);
  // The agent endpoint takes the token (the panel, `crewdeck jobs tell`).
  assert.equal((await s.call('POST', '/api/tell', { 'content-type': 'application/json' }, { text: 'x' })).status, 401);
  assert.equal((await s.call('POST', '/api/tell', s.page(), { text: 'x' })).status, 401);
  const t = await s.call('POST', '/api/tell', s.agent(), { text: 'a link https://jobs.example.com/5' });
  assert.equal(s.q.get(t.json.request)!.kind, 'tell');
});

test('server: proposals through the agent endpoint and the page; auto-apply checks the tell request; SSE topic', async () => {
  const told = 'Watch Example Health please';
  const tr = (await s.action('tell', { text: told })).json.request;
  // The live stream, to see the topic.
  const topics: string[] = [];
  const sse = request({ host: '127.0.0.1', port: s.port, path: '/api/jobs/events', headers: { host: `localhost:${s.port}`, ...s.agent() } }, (res) => { res.setEncoding('utf8'); res.on('data', (d: string) => topics.push(d)); });
  sse.end();
  await wait(100);
  const proposal = { origin: 'person', summary: 'Watch a company', request: tr, items: [
    { kind: 'watch_company', payload: { name: 'Example Health', careers_url: 'https://careers.example.org/' }, reason: 'You asked', evidence: 'Watch Example Health' },
    { kind: 'pay', payload: { floor: 6000 }, reason: 'Pay' }] };
  assert.equal((await s.call('POST', '/api/proposals', s.page(), { op: 'propose', proposal })).status, 401, 'token only');
  assert.equal((await s.call('POST', '/api/proposals', s.agent(), { op: 'propose', proposal, cwd: s.w.root })).status, 403, 'from the jobs workspace only');
  const p = (await s.call('POST', '/api/proposals', s.agent(), { op: 'propose', proposal, cwd: s.workspace })).json;
  assert.deepEqual(p.items.map((i: any) => i.status), ['approved', 'pending']);
  assert.equal(p.items[0].can_undo, true);
  // A request that isn't an open tell request is refused.
  const bad = await s.call('POST', '/api/proposals', s.agent(), { op: 'propose', proposal: { ...proposal, request: 9999 }, cwd: s.workspace });
  assert.equal(bad.status, 400);
  const list = (await s.get('proposals')).json;
  assert.equal(list.count, 1);
  assert.equal((await s.get('today')).json.proposals.count, 1, 'Today carries the card\'s data');
  assert.equal((await s.call('POST', '/api/today', s.agent(), {})).json.jobs.proposals, 1, 'the panel\'s glance counts them');
  const ok = await s.action('approveProposal', { id: p.id, item: 2 });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(notesOf(s.w.ctx).search.data.pay.floor, 6000);
  assert.equal((await s.action('approveProposal', { id: p.id, item: 2 })).status, 400, 'already approved');
  assert.equal((await s.action('undoProposal', { id: p.id, item: 1 })).status, 200);
  assert.ok(!notesOf(s.w.ctx).sources.data.items.some((x) => x.name === 'Example Health'));
  // The panel: list and reject with the token.
  const p2 = (await s.call('POST', '/api/proposals', s.agent(), { op: 'propose', proposal: { origin: 'fetched', summary: 'From a page', items: [{ kind: 'add_link', payload: { url: 'https://jobs.example.com/8' }, reason: 'r' }] } })).json;
  assert.equal((await s.call('POST', '/api/proposals', s.agent(), { op: 'list' })).json.pending.length, 1);
  assert.equal((await s.call('POST', '/api/proposals', s.agent(), { op: 'reject', id: p2.id })).json.status, 'done');
  assert.equal((await s.call('POST', '/api/proposals', s.agent(), { op: 'explode' })).status, 400);
  await wait(300);
  sse.destroy();
  assert.ok(topics.join('').includes('"proposals"'), 'the live stream names the proposals topic');
});

// ---- the page ----

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('UI: the one input routes a single job URL to Add link, and posts or other text to Tell', () => {
  for (const u of ['https://jobs.example.com/5', 'http://careers.example.org/roles/senior-analyst?id=7', 'https://boards.greenhouse.io/atlan/jobs/123', 'https://www.linkedin.com/jobs/view/3912345678']) assert.equal(isJobLink(u), true, u);
  for (const u of ['https://www.linkedin.com/posts/someone_hiring-activity-123', 'https://linkedin.com/feed/update/urn:li:activity:1', 'https://x.com/someone/status/123', 'https://twitter.com/someone/status/123', 'https://lnkd.in/abc123', 'now PM roles', 'a link https://jobs.example.com/5', 'https://jobs.example.com/5 and this one', 'jobs.example.com/5', '']) assert.equal(isJobLink(u), false, u);
});

test('UI: the Tell box sits at the top of Today; the Proposals card lists pending items with Approve / Reject / Approve all', async () => {
  const state = (await s.get('state')).json;
  const d = (await s.get('today')).json;
  const out = render(html`<${Today} data=${d} state=${state} />`);
  assert.ok(out.indexOf('tell Crewdeck anything') >= 0 && out.indexOf('tell Crewdeck anything') < out.indexOf('Nothing to review'), 'the box is first');
  assert.match(out, /<input[^>]*aria-label="Tell Crewdeck"/);
  assert.match(out, /<button type="submit"[^>]*disabled[^>]*>Send<\/button>/, 'Send waits for text');
  assert.equal(TELL_PLACEHOLDER, 'Paste a job link, or tell Crewdeck anything: a LinkedIn post, \'now PM roles\'…');
  assert.equal((out.match(/<input/g) ?? []).length, 1, 'the one input on For you takes links too');
  // A card with two pending items and one applied at once.
  const w = world('example');
  const { e } = env(w);
  const p = addProposal(e, checkProposal({ origin: 'quoted', summary: 'From a LinkedIn post', items: [
    { kind: 'watch_company', payload: { name: 'Example Health', careers_url: 'https://careers.example.org/' }, reason: 'Hiring remote', evidence: 'Example Health is hiring' },
    { kind: 'exclude', payload: { field: 'companies', value: 'Example Bank' }, reason: 'Not for you' }] }));
  const q = addProposal(e, checkProposal({ origin: 'person', summary: 'A place', items: [{ kind: 'place', payload: { field: 'onsite', value: 'Porto' }, reason: 'r', evidence: 'Porto' }] }), { told: 'Porto is fine' });
  const data = { pending: [proposalView(p)], recent: [proposalView(getProposal(w.ctx.db, q.id))] };
  const card = render(html`<${Proposals} data=${data} />`);
  const t = text(card);
  assert.match(t, /Proposals 2/);
  assert.match(t, /Watch Example Health's jobs page/);
  assert.match(t, /Exclude the company Example Bank/);
  assert.match(t, /From a LinkedIn post · from what you pasted/);
  assert.match(card, /aria-label="Approve: Watch Example Health&#39;s jobs page"|aria-label="Approve: Watch Example Health's jobs page"/);
  assert.match(card, /aria-label="Reject: Exclude the company Example Bank"/);
  assert.match(t, /Approve all/);
  assert.match(card, /<details class="more"><summary>Applied from your words: 1 change<\/summary>/, 'what applied at once is one quiet line, with Undo inside');
  assert.match(t, /added Porto to places\.onsite Undo/);
  assert.match(card, /<summary>Where this comes from<\/summary>/);
  assert.equal(render(html`<${Proposals} data=${{ pending: [], recent: [] }} />`), '', 'nothing when nothing waits');
  // In the queue layout too.
  const area = render(html`<${TellArea} proposals=${data} />`);
  assert.ok(area.indexOf('class="tell"') < area.indexOf('class="card proposals"'));
});
