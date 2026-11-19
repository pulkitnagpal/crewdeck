// Request-scoped commands: the page's data reaches Claude's commands by request id from the running server, never
// through the shell (design D11).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentAnswers } from '../../src/jobs/kb/ops.ts';
import { jobsServer, preparedRole, TOKEN } from './api-helpers.ts';
import { role, textFile, REPO } from './helpers.ts';
import { spawn } from 'node:child_process';

let s: Awaited<ReturnType<typeof jobsServer>>;
before(async () => {
  s = await jobsServer();
  // The CLI finds the server and its token through CREWDECK_HOME, like Claude's session does.
  appendFileSync(join(s.w.home, 'config.yaml'), `port: ${s.port}\n`);
  writeFileSync(join(s.w.home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
});
after(() => s.close());

// Asynchronous: the server runs in this process, so a blocking spawn would never let it answer.
const crewdeck = (args: string[], input = ''): Promise<{ code: number | null; out: string; err: string }> => new Promise((ok) => {
  const p = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), ...args], { cwd: s.workspace, env: { ...process.env, CREWDECK_HOME: s.w.home } });
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => ok({ code, out, err }));
  p.stdin.end(input);
});
const jobs = (_home: string, args: string[], input = '') => crewdeck(['jobs', ...args], input);

test('request show and progress: by id, text only from a file or stdin', async () => {
  const id = (await s.action('addLink', { url: 'https://jobs.example.com/roles/7' })).json.request;
  const shown = await jobs(s.w.home, ['request', 'show', String(id)]);
  assert.equal(shown.code, 0, shown.err);
  assert.equal(JSON.parse(shown.out).payload.url, 'https://jobs.example.com/roles/7');
  assert.equal((await crewdeck(['progress', String(id), '--text-file', textFile(s.w.root, 'p.txt', 'Reading the posting\n')])).code, 0);
  assert.equal((await crewdeck(['progress', String(id), '--text', '-'], 'Second line')).code, 0);
  assert.deepEqual(s.q.get(id)!.progress!.map((p) => p.text), ['Reading the posting', 'Second line']);
  const inline = await crewdeck(['progress', String(id), '--text', 'inline words']);
  assert.notEqual(inline.code, 0);
  assert.match(inline.err, /file .* or stdin/);
  assert.match((await crewdeck(['request', 'show', String(id)])).out, /roles\/7/);
});

test('link --request: the address comes from the page\'s request (and still goes through the SSRF guard)', async () => {
  const id = (await s.action('addLink', { url: 'http://127.0.0.1:9/posting' })).json.request;
  const r = await jobs(s.w.home, ['link', '--request', String(id)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /could not be read|blocked|not allowed/i);
  const role = preparedRole(s.w, 'Example Labs');
  const apply = (await s.action('approve', { role })).json.request;
  assert.match((await jobs(s.w.home, ['link', '--request', String(apply)])).err, /kind apply: this command works link requests/);
  await s.call('POST', `/api/requests/${id}/done`, s.agent(), { cwd: s.workspace, result: 'could not read it' });
  assert.match((await jobs(s.w.home, ['link', '--request', String(id)])).err, /already done/);
  assert.match((await jobs(s.w.home, ['link', '--request', 'x'])).err, /request id/);
});

test('fill-plan --request: the apply request names the role', async () => {
  const role = preparedRole(s.w, 'Sample Studio');
  const id = (await s.action('approve', { role })).json.request;
  const fields = textFile(s.w.root, 'fields.json', JSON.stringify([{ label: 'First name', type: 'text' }, { label: 'Submit application', type: 'submit' }]));
  const r = await jobs(s.w.home, ['fill-plan', '--request', String(id), '--fields-file', fields]);
  assert.equal(r.code, 0, r.err);
  const plan = JSON.parse(r.out);
  assert.equal(plan.role, role);
  assert.deepEqual(plan.items.map((i: any) => i.action), ['fill', 'skip']);
  assert.equal(plan.items[0].value, 'Sam');
});

test('answer --request: an Ask Claude rewrite passes the citation check, with the page\'s instruction', async () => {
  const role = preparedRole(s.w, 'Demo Health');
  const f = currentAnswers(s.w.ctx.db, role).find((a) => a.label === 'First name')!;
  const id = (await s.action('improve', { role, field_id: f.field_id, instruction: 'use my preferred name' })).json.request;
  const claims = textFile(s.w.root, 'claims.json', JSON.stringify([{ text: 'Sam', about: 'me', fact_ids: ['profile:first_name'] }]));
  const r = await jobs(s.w.home, ['answer', '--request', String(id), '--text-file', textFile(s.w.root, 'a.txt', 'Sam'), '--claims-file', claims]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).ok, true);
  const bad = await jobs(s.w.home, ['answer', '--request', String(id), '--text-file', textFile(s.w.root, 'b.txt', 'Sam, who led 40 teams'), '--claims-file', claims]);
  assert.equal(bad.code, 1);
});

test('C9/C2: pick --role --request takes "Add it anyway" from the link request\'s payload, never from a flag', async () => {
  const url = 'https://jobs.example.com/careers/c9-analyst';
  const busy = role(s.w.ctx, { company: 'Example Forge', title: 'Data Lead' }, 'picked');
  const chosen = role(s.w.ctx, { company: 'Example Forge', title: 'Product Designer', url, source: 'pasted' });
  const statusOf = (id: string) => (s.w.ctx.db.prepare('select status from roles where id=?').get(id) as any).status;
  // Without the user's override: warnings, exit 2, nothing picked.
  const plain = (await s.action('addLink', { url })).json.request;
  const r1 = await jobs(s.w.home, ['pick', '--role', chosen, '--request', String(plain)]);
  assert.equal(r1.code, 2, r1.err);
  assert.match(JSON.parse(r1.out).warnings.join(), /already has "Data Lead" in progress/);
  assert.equal(statusOf(chosen), 'new');
  // A flag can't force it, with or without a request.
  for (const args of [['pick', '--role', chosen, '--force'], ['pick', '--role', chosen, '--request', String(plain), '--force']]) {
    const r = await jobs(s.w.home, args);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--force is not taken from the command line/);
  }
  assert.match((await jobs(s.w.home, ['link', '--url-file', textFile(s.w.root, 'u.txt', url), '--force'])).err, /--force is not taken from the command line/);
  // The page's "Add it anyway" request carries force: it picks this role, and only the role whose link it carries.
  const forced = (await s.action('addLink', { url, force: true })).json.request;
  const other = role(s.w.ctx, { company: 'Example Forge', title: 'Analyst', source: 'pasted' });
  const wrong = await jobs(s.w.home, ['pick', '--role', other, '--request', String(forced)]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, /not the posting of request/);
  assert.equal(statusOf(other), 'new');
  const r2 = await jobs(s.w.home, ['pick', '--role', chosen, '--request', String(forced)]);
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.equal(JSON.parse(r2.out).picked, true);
  assert.equal(statusOf(chosen), 'picked');
  assert.match((s.w.ctx.db.prepare('select status_reason from roles where id=?').get(chosen) as any).status_reason, /chosen by the user despite/);
  assert.equal(statusOf(busy), 'picked');
});

test('P8: the CLI reads the running server as a local tool (requests, doctor), not as a browser', async () => {
  // Node's fetch sends Sec-Fetch-Mode: cors, which the server's reads refuse as a browser without Sec-Fetch-Site (W8).
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/requests`, { headers: { host: `localhost:${s.port}` } })).status, 403);
  const id = (await s.action('addLink', { url: 'https://jobs.example.com/roles/p8' })).json.request;
  const list = await crewdeck(['requests']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, new RegExp(`^${id}\\tnew\\tjobs\\tlink`, 'm'));
  // doctor reads the Jobs state the same way (it said "Crewdeck isn't running" while it was).
  const cfg = join(s.w.home, 'config.yaml'), before = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, before.replace(/^jobs:\n/m, `jobs:\n  enabled: true\n  workspace: ${s.workspace}\n`));
  try {
    const doc = await crewdeck(['doctor']);
    assert.doesNotMatch(doc.out, /isn't running/);
    assert.match(doc.out, /no Claude session works Jobs/);
    await s.claim();
    assert.match((await crewdeck(['doctor'])).out, /a Claude session works the jobs lane/);
  } finally { writeFileSync(cfg, before); }
});
