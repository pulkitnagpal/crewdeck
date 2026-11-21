// ADR-0008: the portals page API, exactly as the UI builds against it (src/jobs/portals/api-stub.ts is the contract):
// GET /api/jobs/portals, connectPortal, disconnectPortal, togglePortal, testPortal, the `portals` refresh topic, and the
// Today panel's sign-in line. The browser work is replaced (no child process, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobsServer, wait } from './api-helpers.ts';
import { createJobsApi } from '../../src/jobs/api.ts';
import { loadPortals } from '../../src/jobs/portals/catalog.ts';
import { updatePortal } from '../../src/jobs/portals/state.ts';
import { createPortalsStub, stubPortal } from '../../src/jobs/portals/api-stub.ts';
import { isJobsTaskLink, parseTaskPrompt } from '../../src/session-link.ts';

const KEYS = ['id', 'name', 'countries', 'fields', 'state', 'enabled', 'risk', 'signup_url', 'login_url', 'verified'];

/** A server in profile mode (Crewdeck's own browser; jobs.portals_mode: profile), the engine's work replaced. */
function server(o: { connect?: (id: string, signup: boolean) => Promise<unknown>; mode?: 'pane' | 'profile'; api?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  return jobsServer('example', {
    api: {
      portals: {
        connect: o.connect ?? (async (id, signup) => { calls.push(`connect ${id}${signup ? ' signup' : ''}`); }),
        disconnect: async (id) => { calls.push(`disconnect ${id}`); },
        test: async (id) => { calls.push(`test ${id}`); return { found: 2, by: { json: 1, jsonld: 0, links: 1 }, sample: [{ title: 'Data Analyst', company: 'Ember Logistics', url: 'https://www.naukri.com/job-listings-data-analyst-ember-201126500777' }] }; },
      },
      ...(o.api ?? {}),
    },
  }).then((s) => {
    // jobs.portals_mode in the temp config.yaml (the API re-reads it), and in the running config.
    appendFileSync(join(s.w.home, 'config.yaml'), `  portals_mode: ${o.mode ?? 'profile'}\n`);
    s.c.jobs.portals_mode = o.mode ?? 'profile';
    return { ...s, calls };
  });
}

test('GET /api/jobs/portals: every catalog portal with the agreed fields, the same shape as the UI\'s stub', async () => {
  const s = await server();
  try {
    const r = await s.get('portals', { 'sec-fetch-site': 'same-origin' });
    assert.equal(r.status, 200);
    assert.equal(r.json.portals.length, loadPortals().portals.length);
    const stub = createPortalsStub([stubPortal('naukri')]).view().portals[0];
    for (const p of r.json.portals) {
      for (const k of KEYS) assert.ok(k in p, `${p.id}.${k}`);
      for (const k of Object.keys(p)) assert.ok(k in stub || ['paused_until', 'last_scan', 'last_found'].includes(k), `${k} is in the contract`);
      assert.equal(p.state, 'not_connected');
      assert.equal(p.enabled, false);
    }
    assert.equal((await s.get('portals', { 'sec-fetch-site': 'cross-site' })).status, 403, 'never read by another site');
    // State, pause and last scan come from <jobs.home>/state/portals.json.
    updatePortal(s.w.jobsHome, 'naukri', () => ({ connected: true, last_scan: '2026-11-21T08:00:00.000Z', last_found: 14, pause: { until: new Date(Date.now() + 3_600_000).toISOString(), level: 1, reason: 'x' } }));
    const n = (await s.get('portals')).json.portals.find((p: any) => p.id === 'naukri');
    assert.equal(n.state, 'paused');
    assert.equal(n.last_found, 14);
    assert.ok(n.paused_until);
  } finally { await s.close(); }
});

test('connectPortal opens the window asynchronously ({ok, opened}), one at a time, and emits `portals` when it is done', async () => {
  let finish!: () => void;
  const s = await server({ connect: () => new Promise<void>((r) => { finish = r; }) });
  const got: string[] = [];
  const req = httpGet({ host: '127.0.0.1', port: s.port, path: '/api/jobs/events', headers: { host: `localhost:${s.port}`, 'sec-fetch-site': 'same-origin' } }, (res) => res.on('data', (d) => got.push(String(d))));
  try {
    await wait(100);
    const r = await s.action('connectPortal', { id: 'naukri', signup: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, opened: true });
    assert.equal((await s.action('connectPortal', { id: 'instahyre' })).status, 409, 'one sign-in window at a time');
    assert.equal((await s.action('connectPortal', { id: 'nope' })).status, 400);
    assert.equal((await s.action('connectPortal', { id: 'naukri' }, { 'content-type': 'application/json' })).status, 403, 'page actions are same-origin only');
    for (let i = 0; i < 40 && !/"portals"/.test(got.join('')); i++) await wait(50);
    assert.match(got.join(''), /"portals"/);
    finish();
    await wait(50);
    assert.equal((await s.action('connectPortal', { id: 'instahyre' })).status, 200, 'free again once the window closed');
  } finally { req.destroy(); await s.close(); }
});

test('togglePortal writes jobs/sources.md with a Changes line (connected portals only); disconnectPortal and testPortal go through the engine', async () => {
  const s = await server();
  try {
    const off = await s.action('togglePortal', { id: 'naukri', on: true });
    assert.equal(off.status, 400);
    assert.match(off.json.error ?? off.body, /Connect Naukri first/);
    updatePortal(s.w.jobsHome, 'naukri', () => ({ connected: true }));
    const on = await s.action('togglePortal', { id: 'naukri', on: true });
    assert.equal(on.status, 200);
    assert.equal(on.json.ok, true);
    assert.equal(on.json.enabled, true);
    const note = readFileSync(join(s.w.vault, 'jobs', 'sources.md'), 'utf8');
    assert.match(note, /portal: naukri/);
    assert.match(note, /: added the portal Naukri/);
    assert.equal((await s.get('portals')).json.portals[0].id, 'naukri', 'the person\'s portals first');
    assert.equal((await s.get('portals')).json.portals[0].enabled, true);
    assert.equal((await s.action('togglePortal', { id: 'naukri', on: 'yes' })).status, 400);
    await s.action('togglePortal', { id: 'naukri', on: false });
    assert.match(readFileSync(join(s.w.vault, 'jobs', 'sources.md'), 'utf8'), /switched off Naukri/);

    const t = await s.action('testPortal', { id: 'naukri' });
    assert.equal(t.status, 200);
    assert.deepEqual(t.json, { found: 2, by: { json: 1, jsonld: 0, links: 1 }, sample: [{ title: 'Data Analyst', company: 'Ember Logistics', url: 'https://www.naukri.com/job-listings-data-analyst-ember-201126500777' }] });
    assert.equal((await s.action('testPortal', { id: 'instahyre' })).status, 400, 'not connected');
    const d = await s.action('disconnectPortal', { id: 'naukri' });
    assert.deepEqual(d.json, { ok: true });
    assert.deepEqual(s.calls, ['test naukri', 'disconnect naukri']);
  } finally { await s.close(); }
});

test('the Today glance lists portals that need a sign-in; the panel\'s Sign in goes to connectPortal', async () => {
  const s = await server();
  const api = createJobsApi(s.c, s.q, { configPath: join(s.w.home, 'config.yaml'), pollMs: 50, browser: () => null, portals: { connect: async () => {} } });
  try {
    assert.deepEqual(api.glance().portals_sign_in, []);
    updatePortal(s.w.jobsHome, 'wellfound', () => ({ connected: true, needs_sign_in: true }));
    assert.deepEqual(api.glance().portals_sign_in, [{ id: 'wellfound', name: 'Wellfound' }]);
    assert.deepEqual(await api.panelAction({ op: 'connectPortal', id: 'wellfound' }), { ok: true, opened: true });
    await assert.rejects(api.panelAction({ op: 'nope' }), /op is find, apply or connectPortal/);
  } finally { api.close(); await s.close(); }
});

// ---- pane mode (the default): Claude signs in and scans in Claude desktop's browser pane, in a Jobs chat ----

test('pane mode: GET portals says so; Connect queues a `connect` request and opens a Jobs chat in front naming it; no browser window', async () => {
  const opened: string[] = [];
  const s = await server({ mode: 'pane', api: { platform: 'darwin', autoOpenChat: true, openLink: async (l: string) => { opened.push(l); } } });
  try {
    assert.equal((await s.get('portals')).json.mode, 'pane');
    const r = await s.action('connectPortal', { id: 'naukri', signup: true });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.mode, 'pane');
    assert.equal(r.json.opened, true);
    const req = s.q.get(r.json.request)!;
    assert.equal(req.kind, 'connect');
    assert.equal(req.ref, 'naukri');
    assert.deepEqual(req.payload, { portal: 'naukri', signup: true });
    assert.deepEqual(opened.map((l) => decodeURIComponent(/&q=(.*)$/.exec(l)![1]!)), [`Crewdeck: connect portal naukri (request ${r.json.request})`]);
    assert.ok(isJobsTaskLink(opened[0]!));
    assert.deepEqual(parseTaskPrompt(`Crewdeck: connect portal naukri (request ${r.json.request})`), { kind: 'connect', portal: 'naukri', request: r.json.request });
    // Clicked again while it waits: the same request, no second chat; another portal is its own request.
    const again = await s.action('connectPortal', { id: 'naukri', signup: true });
    assert.equal(again.json.request, r.json.request);
    assert.equal(opened.length, 1);
    assert.notEqual((await s.action('connectPortal', { id: 'instahyre' })).json.request, r.json.request, 'pane mode has no one-window limit');
    assert.equal((await s.action('connectPortal', { id: 'nope' })).status, 400);
    assert.deepEqual(s.calls, [], 'Crewdeck\'s own browser never opens in pane mode');
  } finally { await s.close(); }
});

test('pane mode: the request\'s context names the portal; Test and the panel\'s Sign in queue connect requests; Disconnect only forgets', async () => {
  const s = await server({ mode: 'pane' });
  const api = createJobsApi(s.c, s.q, { configPath: join(s.w.home, 'config.yaml'), pollMs: 50, browser: () => null });
  try {
    assert.equal((await s.action('testPortal', { id: 'naukri' })).status, 400, 'not connected');
    updatePortal(s.w.jobsHome, 'naukri', () => ({ connected: true, last_scan: '2026-11-21T08:00:00.000Z' }));
    const t = await s.action('testPortal', { id: 'naukri' });
    assert.equal(t.status, 200, t.body);
    assert.equal(t.json.mode, 'pane');
    const req = s.q.get(t.json.request)!;
    assert.deepEqual([req.kind, req.ref, req.payload], ['connect', 'naukri', { portal: 'naukri', test: true }]);
    const ctx = api.contextFor(req) as any;
    assert.equal(ctx.mode, 'pane');
    assert.equal(ctx.portal.id, 'naukri');
    assert.equal(ctx.portal.state, 'connected');
    assert.equal(ctx.portal.login_url, loadPortals().byId.get('naukri')!.login_url);
    assert.deepEqual(ctx.portal.hosts, loadPortals().byId.get('naukri')!.hosts);
    updatePortal(s.w.jobsHome, 'wellfound', () => ({ connected: true, needs_sign_in: true }));
    const done = await api.panelAction({ op: 'connectPortal', id: 'wellfound' }) as any;
    assert.equal(done.mode, 'pane');
    assert.equal(s.q.get(done.request)!.kind, 'connect');
    const d = await s.action('disconnectPortal', { id: 'naukri' });
    assert.deepEqual(d.json, { ok: true });
    assert.equal((await s.get('portals')).json.portals.find((p: any) => p.id === 'naukri').state, 'not_connected');
    assert.deepEqual(s.calls, []);
  } finally { api.close(); await s.close(); }
});
