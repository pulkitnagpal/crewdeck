// ADR-0008: scanning with a fake launcher (no real browser): limits, delays, pauses, sign-in walls, challenges, the
// empty-result anomaly, storing roles, the sources run's portal step, and connect/disconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { world } from './helpers.ts';
import { scanPortal, scanPortals } from '../../src/jobs/portals/scan.ts';
import { PAUSE_HOURS, portalsStateFile, readPortalsState, updatePortal } from '../../src/jobs/portals/state.ts';
import { connectPortal, disconnectPortal } from '../../src/jobs/portals/connect.ts';
import { ensureProfile, profileDir } from '../../src/jobs/portals/profile.ts';
import { portalsView, togglePortal } from '../../src/jobs/portals/view.ts';
import { runSources } from '../../src/jobs/sources.ts';
import { INDIA_PROFILE, cardsPage, fakeLaunch, fixture, fixturePortal } from './portal-helpers.ts';

const connect = (home: string, id = 'fixture') => updatePortal(home, id, (p) => ({ ...p, connected: true, connected_at: '2026-11-01T00:00:00Z' }));
const opts = (f: ReturnType<typeof fakeLaunch>, sleeps: number[] = []) => ({ launch: f.launch, profile: INDIA_PROFILE, sleep: async (ms: number) => { sleeps.push(ms); }, rnd: () => 0.5 });

test('a scan: the portal\'s searches within its limits, jittered delays between page loads, roles stored as portal:<id>', async () => {
  const w = world();
  connect(w.jobsHome);
  const p = fixturePortal();
  const f = fakeLaunch((url) => ({ html: url.includes('page=2') ? cardsPage(2, 'p') : cardsPage(3, url.includes('remote') || url.includes('wfh') ? 'r' : url.includes('bi-analyst') ? 'b' : 'd') }));
  const sleeps: number[] = [];
  const r = await scanPortal(w.ctx, p, opts(f, sleeps));
  assert.equal(r.ran, true);
  // 3 searches × up to 2 pages, at most pages_per_day.
  assert.equal(f.gotos.length, 6);
  assert.deepEqual(f.gotos.slice(0, 2), ['https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7', 'https://www.portal.test/jobs/data-analyst-jobs-in-bangalore?days=7&page=2']);
  assert.deepEqual(sleeps, [10000, 10000, 10000, 10000, 10000], 'a delay before every load but the first');
  assert.deepEqual(f.launches, [{ headless: true }]);
  assert.equal(f.closes, 1);
  assert.equal(r.found, 3 + 2 + 3 + 3);
  assert.deepEqual(r.by, { json: 0, jsonld: 0, links: r.found });
  assert.equal(r.new, r.found);
  const rows = w.ctx.db.prepare(`select source, source_key, title from roles`).all() as any[];
  assert.equal(rows.length, r.found);
  assert.ok(rows.every((x) => x.source === 'portal' && x.source_key === 'portal:fixture'));
  const st = readPortalsState(w.jobsHome).portals.fixture;
  assert.equal(st.last_found, r.found);
  assert.deepEqual(st.day, { date: '2026-11-19', pages: 6 });
  assert.equal(statSync(portalsStateFile(w.jobsHome)).mode & 0o777, 0o600);
});

test('limits: one scan per min_hours; pages_per_day across scans', async () => {
  const w = world();
  connect(w.jobsHome);
  const p = fixturePortal({ limits: { searches_per_run: 3, pages_per_search: 2, delay_ms: 10000, min_hours: 6, pages_per_day: 4 } });
  const f = fakeLaunch(() => ({ html: cardsPage(2) }));
  const a = await scanPortal(w.ctx, p, opts(f));
  assert.equal(a.pages, 4, 'stopped at the daily cap');
  const b = await scanPortal(w.ctx, p, opts(f));
  assert.equal(b.ran, false);
  assert.match(b.why!, /at most one scan every 6 h/);
  w.at('2026-11-19T17:00:00Z');
  const c = await scanPortal(w.ctx, p, opts(f));
  assert.match(c.why!, /4 pages read today already/);
  w.at('2026-11-20T17:00:00Z');
  const d = await scanPortal(w.ctx, p, opts(f));
  assert.equal(d.ran, true);
  assert.equal(f.launches.length, 2, 'no browser opened when a limit says no');
});

test('a challenge stops the portal at once and pauses it 6 h, then 24 h, then 72 h; a clean scan resets the level', async () => {
  const w = world();
  connect(w.jobsHome);
  const p = fixturePortal();
  const f = fakeLaunch(() => ({ status: 200, html: fixture('challenge.html') }));
  const levels: number[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await scanPortal(w.ctx, p, opts(f));
    assert.equal(r.stop_kind, 'challenge');
    assert.equal(r.pages, 1, 'nothing more after a check');
    const st = readPortalsState(w.jobsHome).portals.fixture;
    levels.push((Date.parse(st.pause!.until) - w.ctx.clock().getTime()) / 3_600_000);
    // Paused: nothing is opened until the pause ends.
    const during = await scanPortal(w.ctx, p, opts(f));
    assert.equal(during.ran, false);
    assert.match(during.why!, /paused until/);
    w.at(new Date(Date.parse(st.pause!.until) + 60_000).toISOString());
  }
  assert.deepEqual(levels, [6, 24, 72, 72]);
  assert.deepEqual(PAUSE_HOURS, [6, 24, 72]);
  assert.equal(portalsView(w.ctx, [p]).portals[0].state, 'connected', 'the pause is over');
  const ok = fakeLaunch(() => ({ html: cardsPage(1) }));
  await scanPortal(w.ctx, p, opts(ok));
  assert.equal(readPortalsState(w.jobsHome).portals.fixture.pause, undefined);
});

test('a sign-in wall marks needs_sign_in (and pauses); a missing sign-in cookie does without loading a page; 429 and 999 pause', async () => {
  const w = world();
  connect(w.jobsHome);
  const p = fixturePortal();
  const wall = fakeLaunch(() => ({ url: 'https://www.portal.test/login?next=%2Fjobs', html: '<form>Sign in</form>' }));
  const r = await scanPortal(w.ctx, p, opts(wall));
  assert.equal(r.stop_kind, 'sign_in');
  assert.equal(r.needs_sign_in, true);
  assert.equal(portalsView(w.ctx, [p]).portals[0].state, 'needs_sign_in');
  const later = await scanPortal(w.ctx, p, opts(wall));
  assert.equal(later.ran, false);

  const w2 = world();
  connect(w2.jobsHome);
  const noCookie = fakeLaunch(() => ({ html: cardsPage(3) }), { cookies: [] });
  const r2 = await scanPortal(w2.ctx, p, opts(noCookie));
  assert.equal(r2.stop_kind, 'sign_in');
  assert.deepEqual(noCookie.gotos, []);

  for (const status of [429, 999]) {
    const w3 = world();
    connect(w3.jobsHome);
    const r3 = await scanPortal(w3.ctx, p, opts(fakeLaunch(() => ({ status, html: '' }))));
    assert.equal(r3.stop_kind, 'rate');
    assert.ok(r3.paused_until);
  }
});

test('an empty result where the last scan found many pauses the portal; an error ends the run without a pause', async () => {
  const w = world();
  connect(w.jobsHome);
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, last_found: 25 }));
  const p = fixturePortal();
  const r = await scanPortal(w.ctx, p, opts(fakeLaunch(() => ({ html: '<html><body>No jobs</body></html>' }))));
  assert.equal(r.stop_kind, 'empty');
  assert.ok(r.paused_until);

  const w2 = world();
  connect(w2.jobsHome);
  const e = await scanPortal(w2.ctx, p, opts(fakeLaunch(() => ({ throws: 'net::ERR_TIMED_OUT' }))));
  assert.equal(e.stop_kind, 'error');
  assert.equal(e.paused_until, undefined);
  assert.equal(readPortalsState(w2.jobsHome).portals.fixture.pause, undefined);
});

test('a company\'s country shown by the portal is stored on the role (company_country)', async () => {
  const w = world();
  connect(w.jobsHome);
  await scanPortal(w.ctx, fixturePortal(), opts(fakeLaunch(() => ({ html: fixture('jsonld-search.html') }))));
  const rows = w.ctx.db.prepare(`select c.name company, r.company_country from roles r join companies c on c.id=r.company_id order by c.name`).all() as any[];
  assert.deepEqual(rows.map((r) => [r.company, r.company_country]), [['Ember Logistics', 'in'], ['Saffron Retail', null]]);
});

test('test mode: one query, one page, nothing stored, min_hours ignored, the daily cap still counted', async () => {
  const w = world();
  connect(w.jobsHome);
  const p = fixturePortal();
  updatePortal(w.jobsHome, 'fixture', (s) => ({ ...s, last_scan: w.ctx.clock().toISOString() }));
  const f = fakeLaunch(() => ({ html: fixture('cards-search.html') }));
  const r = await scanPortal(w.ctx, p, { ...opts(f), test: true });
  assert.equal(f.gotos.length, 1);
  assert.equal(r.found, 2);
  assert.equal(r.sample?.[0].by, 'links');
  assert.equal((w.ctx.db.prepare('select count(*) n from roles').get() as any).n, 0);
  assert.equal(readPortalsState(w.jobsHome).portals.fixture.day?.pages, 1);
});

test('scanPortals: only connected portals switched on in jobs/sources.md, in the person\'s order; the switch needs a connection', async () => {
  const w = world();
  const p = fixturePortal();
  const f = fakeLaunch(() => ({ html: cardsPage(2) }));
  const none = await scanPortals(w.ctx, { ...opts(f), portals: [p] });
  assert.match(none.why!, /no portals switched on/);
  assert.throws(() => togglePortal(w.ctx, p, true), /Connect Fixture Portal first/);
  connect(w.jobsHome);
  const on = togglePortal(w.ctx, p, true);
  assert.equal(on.changed, true);
  assert.equal(on.key, 'portal-fixture');
  const view = portalsView(w.ctx, [p]).portals[0];
  assert.equal(view.enabled, true);
  const r = await scanPortals(w.ctx, { ...opts(f), portals: [p] });
  assert.equal(r.ran, true);
  assert.equal(r.portals[0].found, 2);
  // A portal serving none of the places the person works in is skipped (portals/allow.ts), without a browser.
  w.at('2026-11-20T10:00:00Z');
  const launches = f.launches.length;
  const away = await scanPortals(w.ctx, { ...opts(f), portals: [p], profile: { ...INDIA_PROFILE, countries: ['de'], places: ['Berlin'] } });
  assert.match(away.portals[0].why!, /^skipped: it serves in, where you don't look for work/);
  assert.equal(f.launches.length, launches);
  togglePortal(w.ctx, p, false);
  const off = await scanPortals(w.ctx, { ...opts(f), portals: [p] });
  assert.match(off.why!, /no portals switched on/);
});

test('runSources: the portal step runs after the planned sources (CREWDECK_PORTALS=off skips it), and its row gets a by_key line', async () => {
  const w = world();
  const p = fixturePortal();
  connect(w.jobsHome);
  togglePortal(w.ctx, p, true);
  const f = fakeLaunch(() => ({ html: cardsPage(2) }));
  const off = await runSources(w.ctx, { details: 0, plan: { entries: [], ids: [], skipped: [] }, portals: { ...opts(f), portals: [p] } });
  assert.equal(off.portals, undefined, 'the suite sets CREWDECK_PORTALS=off');
  assert.equal(f.launches.length, 0);
  const was = process.env.CREWDECK_PORTALS;
  delete process.env.CREWDECK_PORTALS;
  try {
    const s = await runSources(w.ctx, { details: 0, plan: { entries: [], ids: [], skipped: [] }, portals: { ...opts(f), portals: [p] } });
    assert.ok(s.portals && 'portals' in s.portals);
    assert.equal(s.portals.portals[0].found, 2);
    assert.equal(s.new, 2);
    assert.equal(s.by_key?.['portal-fixture']?.jobs, 2);
    assert.equal(s.by_key?.['portal-fixture']?.ok, true);
  } finally { process.env.CREWDECK_PORTALS = was; }
});

test('connect polls the signed-in check every 3 s and records the connection; a closed window or the deadline does not', async () => {
  const w = world();
  const p = fixturePortal();
  const f = fakeLaunch(() => ({ html: '<form>Sign in</form>' }), { cookies: [] });
  let polls = 0;
  const waits: number[] = [];
  const done = connectPortal(w.jobsHome, p, { launch: f.launch, sleep: async (ms) => { waits.push(ms); if (++polls === 3) f.cookies = [{ name: 'fx_session', domain: '.portal.test' }]; } });
  const r = await done;
  assert.deepEqual(r, { ok: true, outcome: 'connected' });
  assert.deepEqual(f.launches, [{ headless: false, signIn: true }], 'a visible window with the sign-in helpers allowed');
  assert.deepEqual(f.gotos, ['https://www.portal.test/login']);
  assert.deepEqual(waits, [3000, 3000, 3000]);
  assert.equal(f.closes, 1);
  assert.equal(readPortalsState(w.jobsHome).portals.fixture.connected, true);

  // Sign-up opens the sign-up page; the signed-in page path also counts.
  const g = fakeLaunch(() => ({}), { cookies: [] });
  const r2 = connectPortal(w.jobsHome, p, { launch: g.launch, signup: true, sleep: async () => { g.open = [{ url: 'https://www.portal.test/dashboard/feed', has: async () => false }]; } });
  assert.equal((await r2).ok, true);
  assert.deepEqual(g.gotos, ['https://www.portal.test/register']);

  const h = fakeLaunch(() => ({}), { cookies: [] });
  const closed = await connectPortal(w.jobsHome, p, { launch: h.launch, sleep: async () => { h.closedByUser = true; } });
  assert.equal(closed.outcome, 'closed');
  const slow = await connectPortal(w.jobsHome, p, { launch: fakeLaunch(() => ({}), { cookies: [] }).launch, timeoutMs: 0, sleep: async () => {} });
  assert.equal(slow.outcome, 'timeout');
  const broken = await connectPortal(w.jobsHome, p, { launch: fakeLaunch(() => ({}), { fail: 'No Chromium-based browser found' }).launch });
  assert.deepEqual(broken, { ok: false, outcome: 'error', why: 'No Chromium-based browser found' });
});

test('reconnecting clears a pause and needs_sign_in; disconnect clears cookies and state but keeps the day count and the profile', async () => {
  const w = world();
  const p = fixturePortal();
  updatePortal(w.jobsHome, 'fixture', () => ({ connected: true, needs_sign_in: true, pause: { until: '2026-11-25T00:00:00Z', level: 2, reason: 'x' }, day: { date: '2026-11-19', pages: 3 } }));
  const f = fakeLaunch(() => ({}));
  await connectPortal(w.jobsHome, p, { launch: f.launch, sleep: async () => {} });
  const st = readPortalsState(w.jobsHome).portals.fixture;
  assert.equal(st.needs_sign_in, undefined);
  assert.equal(st.pause, undefined);
  ensureProfile(w.jobsHome);
  assert.equal(statSync(profileDir(w.jobsHome)).mode & 0o777, 0o700);
  const d = await disconnectPortal(w.jobsHome, p, { launch: f.launch });
  assert.equal(d.cleared, true);
  assert.equal(f.cleared, 1);
  assert.deepEqual(readPortalsState(w.jobsHome).portals.fixture, { day: { date: '2026-11-19', pages: 3 } });
  assert.ok(statSync(profileDir(w.jobsHome)).isDirectory());
  assert.equal(portalsView(w.ctx, [p]).portals[0].state, 'not_connected');
});
