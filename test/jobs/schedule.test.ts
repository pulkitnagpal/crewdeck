// Scheduled fetching (design §2.4 step 1): the interval, the timer that never overlaps, Refresh sources from the page,
// and "N new roles since <time>" on the Jobs page. The child run is replaced by a fake; nothing is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvery, writeSourcesState } from '../../src/jobs/sources.ts';
import { createSourceScheduler } from '../../src/jobs/schedule.ts';
import { normaliseJobs } from '../../src/config.ts';
import { jobsServer, wait } from './api-helpers.ts';
import { role } from './helpers.ts';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { SourcesStrip, sourcesLine } from '../../web/jobs/screens/topbar.js';

test('fetch_every: 30m, 12h, 1d; nothing more often than 30 minutes; the config refuses the same', () => {
  assert.equal(parseEvery('30m'), 1_800_000);
  assert.equal(parseEvery('12h'), 43_200_000);
  assert.equal(parseEvery('1d'), 86_400_000);
  for (const bad of ['10m', '0h', '12', 'h', '1w', '-1h', '']) assert.throws(() => parseEvery(bad), bad);
  assert.equal(normaliseJobs({}).fetch_every, '12h');
  assert.throws(() => normaliseJobs({ fetch_every: '5m' }), /at least 30m/);
});

function fakeRun() {
  let calls = 0, release: (() => void) | null = null;
  const run = () => { calls++; return new Promise<{ code: number }>((r) => { release = () => r({ code: 0 }); }); };
  return { run, calls: () => calls, finish: () => { release?.(); release = null; } };
}

test('scheduler: first run soon when overdue, then one interval after each finish; never two at once', async () => {
  const f = fakeRun();
  const s = createSourceScheduler({ everyMs: 60_000, run: f.run, lastFinished: () => null, ready: () => true, firstDelayMs: 20 });
  try {
    assert.ok(s.status().next_at);
    await wait(60);
    assert.equal(f.calls(), 1);
    assert.equal(s.status().running, true);
    assert.deepEqual(s.refresh(), { started: false, already: true }, 'no overlap');
    assert.equal(f.calls(), 1);
    f.finish();
    await s.idle();
    await wait(5);
    const st = s.status();
    assert.equal(st.running, false);
    assert.equal(st.last_exit?.code, 0);
    assert.ok(Date.parse(st.next_at!) - Date.now() > 50_000, 'next run one interval later');
    assert.deepEqual(s.refresh(), { started: true }, 'Refresh sources runs now');
    assert.equal(f.calls(), 2);
    f.finish();
    await s.idle();
  } finally { s.stop(); }
});

test('scheduler: a recent run waits for its interval; nothing to fetch skips the tick; a failed run is recorded', async () => {
  const f = fakeRun();
  const recent = createSourceScheduler({ everyMs: 3_600_000, run: f.run, lastFinished: () => new Date(Date.now() - 600_000).toISOString(), ready: () => true, firstDelayMs: 10 });
  const at = Date.parse(recent.status().next_at!);
  assert.ok(at - Date.now() > 2_900_000 && at - Date.now() <= 3_000_000);
  recent.stop();
  const notReady = createSourceScheduler({ everyMs: 60_000, run: f.run, lastFinished: () => null, ready: () => false, firstDelayMs: 10 });
  await wait(40);
  assert.equal(f.calls(), 0);
  assert.ok(Date.parse(notReady.status().next_at!) > Date.now() + 50_000);
  notReady.stop();
  const failing = createSourceScheduler({ everyMs: 60_000, run: () => Promise.reject(new Error('boom')), lastFinished: () => null, ready: () => true, firstDelayMs: 1 });
  await wait(30);
  await failing.idle();
  assert.equal(failing.status().last_exit?.error, 'boom');
  failing.stop();
});

test('Jobs page: sources in the state ("N new roles since" the last Find), Refresh sources is the page\'s, never two runs', async () => {
  const f = fakeRun();
  const s = await jobsServer('berlin-analyst', { api: { sources: { run: f.run, ready: () => true, firstDelayMs: 3_600_000 } } });
  try {
    role(s.w.ctx, { company: 'Example One', title: 'Data Analyst' });
    role(s.w.ctx, { company: 'Example Two', title: 'Data Analyst' });
    writeSourcesState(s.w.jobsHome, { started: '2026-11-19T08:00:00.000Z', finished: '2026-11-19T08:01:00.000Z', ok: true, new: 2, providers: { ran: true, fetched: 9, new: 2, refused: 0, skipped: [], entries: [{ name: 'Board', ok: true, jobs: 9, new: 2, refused: 0 }, { name: 'Down', ok: false, jobs: 0, new: 0, refused: 0, error: 'HTTP 500' }] } });
    let st = (await s.get('state')).json.sources;
    assert.equal(st.ready, true);
    assert.equal(st.waiting, 2);
    assert.equal(st.new_since, 2);
    assert.equal(st.since, null);
    assert.deepEqual([st.last.new, st.last.failed, st.last.entries], [2, 1, 2]);
    assert.equal(st.running, false);
    // A Find marks the point "new" counts from.
    await s.action('find', { count: 3 });
    st = (await s.get('state')).json.sources;
    assert.ok(st.since);
    assert.equal(st.new_since, 0);
    const r = await s.action('refreshSources');
    assert.equal(r.status, 200);
    assert.equal(r.json.started, true);
    assert.equal((await s.action('refreshSources')).json.already, true);
    assert.equal(f.calls(), 1);
    assert.equal((await s.get('state')).json.sources.running, true);
    f.finish();
    await wait(20);
    assert.equal((await s.get('state')).json.sources.running, false);
  } finally { await s.close(); }
});

test('Refresh sources is refused when there is nothing to fetch with', async () => {
  const s = await jobsServer('berlin-analyst', { api: { sources: { run: async () => ({ code: 0 }), firstDelayMs: 3_600_000 } } });
  try {
    const r = await s.action('refreshSources');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /crewdeck jobs providers install/);
    assert.equal((await s.get('state')).json.sources.ready, false);
  } finally { await s.close(); }
});

test('the sources line on the page', () => {
  const now = Date.parse('2026-11-19T15:00:00Z');
  assert.equal(sourcesLine({ ready: false })!.text, 'Job boards not set up');
  const l = sourcesLine({ ready: true, running: false, new_since: 12, since: '2026-11-18T09:00:00Z', waiting: 30, last: { finished: '2026-11-19T13:00:00Z', ok: true }, next_at: '2026-11-20T01:00:00Z' }, now)!;
  assert.match(l.text, /^12 new roles since .+ · fetched 2 h ago$/);
  assert.equal(l.refresh, true);
  assert.match(l.title, /30 roles waiting to be judged/);
  assert.equal(sourcesLine({ ready: true, running: true, new_since: 1, waiting: 1 }, now)!.text, 'Fetching roles…');
  assert.equal(sourcesLine({ ready: true, running: false, new_since: 3, waiting: 3, last: null }, now)!.text, '3 new roles waiting · not fetched yet');
  const out = render(html`<${SourcesStrip} sources=${{ ready: true, running: false, new_since: 1, waiting: 1, last: { finished: '2026-11-19T13:00:00Z', ok: false } }} />`);
  assert.match(out, /1 new role waiting · fetched .* \(with errors\)/);
  assert.match(out, />Refresh sources</);
  // A new user before setup: no source switched on, so nothing to refresh; the line points at the Sources tab.
  const none = sourcesLine({ ready: true, running: false, listed: 0, new_since: 0, waiting: 0, last: { finished: '2026-11-19T13:00:00Z', ok: true } }, now)!;
  assert.equal(none.text, 'No sources yet');
  assert.equal(none.refresh, false);
  const bare = render(html`<${SourcesStrip} sources=${{ ready: true, running: false, listed: 0, new_since: 0, waiting: 0, last: null }} />`);
  assert.match(bare, />Open Sources</);
  assert.doesNotMatch(bare, /Refresh sources/);
});

test('the state says how many sources are switched on (none for a new user, so the page says "No sources yet")', async () => {
  for (const [person, listed] of [['template', 0], ['berlin-analyst', 3]] as const) {
    const s = await jobsServer(person, { api: { sources: { run: async () => ({ code: 0 }), firstDelayMs: 3_600_000 } } });
    try { assert.equal((await s.get('state')).json.sources.listed, listed, person); } finally { await s.close(); }
  }
});
