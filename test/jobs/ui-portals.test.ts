// The Portals section of Sources (ADR-0008), against the page API stub (src/jobs/portals/api-stub.ts) until the engine
// lands: each state rendered in Node (Not connected, Connected · last scan · found, Sign in again, Paused until), the
// person's portals first and the rest under More portals; then in a real headless Chromium from a fictional person's
// shell server, with only the portals calls answered by the stub: the risk said once at a first Connect with a confirm,
// Sign up as the alternative, Sign in again going straight, Test showing what it found, the switch, and the section at
// phone width (no overlaps, nothing outside the window) and in light and dark (14 px, AA). Skipped without a browser.
// CREWDECK_SHOTS=<dir> saves pictures of the section.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact-render-to-string';
import type { Browser, Page } from 'playwright-core';
import { html } from '../../web/jobs/lib.js';
import { PORTAL_RISK, Portals, effectiveState, fits, paneLine, portalLine, splitPortals, testLine } from '../../web/jobs/screens/portals.js';
import { STUB_RISK, createPortalsStub, stubPortal, type PortalView } from '../../src/jobs/portals/api-stub.ts';
import { findBrowser } from '../../src/jobs/browser.ts';
import { jobsServer } from './api-helpers.ts';
import { audit } from './ui-audit.ts';

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const MINE = { countries: ['de'], within: { de: ['europe', 'world'] }, fields: ['data'] };

function fixture(): PortalView[] {
  return [
    stubPortal('naukri', { name: 'Naukri', countries: ['in'], fields: ['any'] }),
    stubPortal('stepstone', { name: 'StepStone', countries: ['de', 'at'], fields: ['any'], state: 'connected', enabled: true, last_scan: hoursAgo(2), last_found: 34 }),
    stubPortal('example-jobs', { name: 'Example Jobs', countries: ['de'], fields: ['data'], state: 'needs_sign_in', enabled: true }),
    stubPortal('sample-board', { name: 'Sample Board', countries: ['europe'], fields: [], state: 'paused', enabled: true, paused_until: inHours(3), last_scan: hoursAgo(1), last_found: 0 }),
    stubPortal('demo-careers', { name: 'Demo Careers', countries: ['de'], fields: ['data'], verified: false }),
    stubPortal('nurse-portal', { name: 'Nurse Portal', countries: ['de'], fields: ['nursing'] }),
  ];
}

test('the stub keeps the engine\'s contract: list, connect, toggle, test, disconnect', () => {
  const s = createPortalsStub(fixture());
  const v = s.answer('GET', '/api/jobs/portals', null)!.json as any;
  assert.deepEqual(Object.keys(v.portals[0]).sort(), ['countries', 'enabled', 'fields', 'id', 'login_url', 'name', 'needs_reader', 'risk', 'signup_url', 'state', 'verified'].sort());
  assert.deepEqual(s.answer('POST', '/api/jobs/action/connectPortal', { id: 'naukri', signup: true })!.json, { ok: true, opened: true });
  assert.equal(s.answer('POST', '/api/jobs/action/togglePortal', { id: 'naukri', on: true })!.status, 400, 'not connected: no switch');
  assert.deepEqual(s.answer('POST', '/api/jobs/action/togglePortal', { id: 'stepstone', on: false })!.json, { ok: true, enabled: false });
  const t = s.answer('POST', '/api/jobs/action/testPortal', { id: 'stepstone' })!.json as any;
  assert.deepEqual(Object.keys(t).sort(), ['by', 'found', 'sample']);
  s.answer('POST', '/api/jobs/action/disconnectPortal', { id: 'stepstone' });
  assert.equal(s.portals.find((p) => p.id === 'stepstone')!.state, 'not_connected');
  assert.equal(s.answer('POST', '/api/jobs/action/sources', {}), null, 'other actions are not the stub\'s');
  assert.equal(STUB_RISK, PORTAL_RISK, 'the same risk words as the page');
});

test('each state in plain words: Not connected, Connected · last scan · found, Sign in again, Paused until', () => {
  const [naukri, step, ex, paused] = fixture();
  assert.deepEqual(portalLine(naukri, NOW), { chip: 'Not connected', kind: '', text: '' });
  assert.deepEqual(portalLine(step, NOW), { chip: 'Connected', kind: 'ok', text: 'last scan 2 h ago · 34 found' });
  assert.deepEqual(portalLine({ ...step, last_scan: undefined, last_found: undefined }, NOW), { chip: 'Connected', kind: 'ok', text: 'not scanned yet' });
  assert.deepEqual(portalLine({ ...step, enabled: false }, NOW).text, 'last scan 2 h ago · 34 found · off');
  assert.deepEqual(portalLine(ex, NOW), { chip: 'Sign in again', kind: 'warn', text: '' });
  assert.match(portalLine(paused, NOW).chip, /^Paused until \d{1,2}[:.]\d{2}/);
  // A pause that has run out reads as connected.
  assert.equal(effectiveState({ ...paused, paused_until: hoursAgo(1) }, NOW), 'connected');
  assert.equal(testLine({ found: 12, by: { json: 8, jsonld: 0, links: 4 } }), '12 jobs found (8 from the page\'s data, 4 from links)');
  assert.equal(testLine({ found: 0, by: { json: 0, jsonld: 0, links: 0 } }), '0 jobs found');
});

test('the person\'s portals first (connected ones, then the ones that fit country and field); the rest under More portals', () => {
  assert.equal(fits(stubPortal('a', { countries: ['europe'], fields: ['any'] }), MINE), true, 'a region holding the country');
  assert.equal(fits(stubPortal('a', { countries: ['in'], fields: ['any'] }), MINE), false);
  assert.equal(fits(stubPortal('a', { countries: ['de'], fields: ['nursing'] }), MINE), false);
  assert.equal(fits(stubPortal('a', { countries: ['in'] }), { countries: [], within: {}, fields: [] }), true, 'before setup everything fits');
  const { yours, rest } = splitPortals(fixture(), MINE, NOW);
  assert.deepEqual(yours.map((p) => p.id), ['example-jobs', 'stepstone', 'sample-board', 'demo-careers']);
  assert.deepEqual(rest.map((p) => p.id), ['naukri', 'nurse-portal']);
  // A connected portal outside the person's countries still shows with theirs.
  const moved = fixture().map((p) => (p.id === 'naukri' ? { ...p, state: 'connected' as const } : p));
  assert.ok(splitPortals(moved, MINE, NOW).yours.some((p) => p.id === 'naukri'));
});

test('the section rendered (Your accounts): who it is and how it stands; In Find for a connected one, Sign in, or Connect; the risk only once Connect is pressed', () => {
  const out = render(html`<${Portals} portals=${fixture()} mine=${MINE} countryNames=${['Germany']} />`);
  const t = text(out);
  assert.match(t, /Your accounts · 1 to sign in again/);
  assert.match(t, /Sites you sign in to\. Crewdeck reads them, slowly, with your account\./);
  assert.match(t, /StepStone Signed in · last scan 2 h ago · 34 found/);
  assert.match(t, /In Find/);
  assert.match(t, /Example Jobs Signed out: sign in again/);
  assert.match(t, /Sample Board Paused until/);
  assert.match(t, /Demo Careers .*Connect/);
  assert.match(t, /More sites for Germany \(2\)/);
  assert.match(t, /Sites may not allow automation\. Crewdeck stops at the first check and asks you\./);
  assert.ok(!out.includes('role="alertdialog"'), 'no confirm (and so no risk note up front) until Connect is pressed');
  const rows = out.split('<li class="prow').slice(1);
  assert.equal(rows.length, 6);
  const row = (id: string) => rows.find((r) => r.includes(`data-portal="${id}"`))!;
  // Connected and paused: the In Find switch (Test and Disconnect wait under Details). Sign in again and Connect: one button.
  for (const id of ['stepstone', 'sample-board']) assert.equal((row(id).match(/role="switch"/g) ?? []).length, 1, id);
  for (const id of ['example-jobs', 'demo-careers', 'naukri']) assert.equal((row(id).match(/role="switch"/g) ?? []).length, 0, id);
  assert.match(out, /aria-label="In Find: StepStone"/);
  assert.match(out, /aria-label="Connect Demo Careers"/);
  assert.match(out, /aria-label="Sign in to Example Jobs again"/);
  assert.match(out, /aria-label="Test StepStone"/);
  assert.match(out, /aria-label="Test Sample Board" disabled/, 'no test while paused');
  assert.equal(render(html`<${Portals} portals=${null} mine=${MINE} />`), '', 'nothing (no section at all) on a Crewdeck without portals');
  assert.equal(render(html`<${Portals} portals=${[]} mine=${MINE} />`), '');
});

test('pane mode: the section says Claude scans during Find in its browser pane; the stub answers Connect and Test with a queued Jobs chat', () => {
  const t = text(render(html`<${Portals} portals=${fixture()} mode="pane" mine=${MINE} />`));
  assert.match(t, /Sites you sign in to\. Claude reads them, slowly, only when you Find\./);
  assert.match(t, /import that site's cookies from your own browser with the pane's ⋮ menu/);
  assert.match(t, /Sign in with Google may not work inside the pane/);
  assert.doesNotMatch(t, /Crewdeck's own browser/);
  assert.equal(paneLine({ ok: true, request: 3, opened: true, mode: 'pane' }), 'A Jobs chat opened: sign in there');
  assert.equal(paneLine({ ok: true, request: 3, mode: 'pane' }), 'Sent to your Jobs chat: sign in there');
  assert.equal(paneLine({ ok: true, request: 3, opened: true, mode: 'pane' }, 'test'), 'A Jobs chat opened: Claude tests it there');
  assert.equal(paneLine({ ok: true, opened: true }), '', 'profile mode has its own words');
  const stub = createPortalsStub(fixture(), { mode: 'pane' });
  assert.equal((stub.answer('GET', '/api/jobs/portals', null)!.json as any).mode, 'pane');
  assert.deepEqual(stub.answer('POST', '/api/jobs/action/connectPortal', { id: 'naukri' })!.json, { ok: true, request: 1, status: 'new', opened: true, mode: 'pane' });
  assert.deepEqual(stub.answer('POST', '/api/jobs/action/testPortal', { id: 'stepstone' })!.json, { ok: true, request: 2, status: 'new', opened: true, mode: 'pane' });
});

// ---- in a real browser ----
const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;
let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
before(async () => {
  if (!found) return;
  s = await jobsServer('berlin-analyst');
  s.c.appearance = 'auto';
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

async function open(stub: ReturnType<typeof createPortalsStub>, o: { width?: number; height?: number; scheme?: 'light' | 'dark' } = {}) {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1280, height: o.height ?? 900 }, colorScheme: o.scheme ?? 'light' });
  await page.route('**/*', async (r) => {
    const u = new URL(r.request().url());
    if (u.port !== String(s.port)) return r.abort();
    const a = stub.answer(r.request().method(), u.pathname, r.request().postDataJSON?.() ?? null);
    if (!a) return r.continue();
    return r.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.json) });
  });
  await page.goto(`http://localhost:${s.port}/jobs/#sources`);
  await page.locator('.prow').first().waitFor({ timeout: 15_000 });
  return page;
}

test('first Connect: the risk once, quietly, with a confirm; Sign in or Sign up opens the window; Sign in again goes straight', { skip: noBrowser, timeout: 90_000 }, async () => {
  const stub = createPortalsStub(fixture());
  const page = await open(stub);
  // Not shown before Connect.
  assert.equal(await page.getByText(PORTAL_RISK).filter({ visible: true }).count(), 0);
  await page.getByRole('button', { name: 'Connect Demo Careers' }).click();
  const dialog = page.getByRole('alertdialog');
  assert.match(await dialog.textContent() ?? '', /Connect Demo Careers\?.*slow pace.*could limit your account.*never does/);
  assert.equal(stub.calls.length, 0, 'nothing sent before the confirm');
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Waiting for you to sign in, in the Demo Careers window').waitFor();
  assert.deepEqual(stub.calls.at(-1), { name: 'connectPortal', body: { id: 'demo-careers' } });
  // Sign up instead, from the same confirm.
  await page.getByRole('button', { name: 'Connect Demo Careers' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign up' }).click();
  assert.deepEqual(stub.calls.at(-1), { name: 'connectPortal', body: { id: 'demo-careers', signup: true } });
  // Sign in again: no second risk note.
  await page.getByRole('button', { name: 'Sign in to Example Jobs again' }).click();
  await page.getByText('Waiting for you to sign in, in the Example Jobs window').waitFor();
  assert.deepEqual(stub.calls.at(-1), { name: 'connectPortal', body: { id: 'example-jobs' } });
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  // The engine finishes the sign-in: on the next refresh the row is connected with Test.
  stub.set('demo-careers', { state: 'connected', enabled: false });
  await page.reload();
  await page.getByRole('switch', { name: 'In Find: Demo Careers' }).waitFor();
  await page.close();
});

test('pane mode in the page: Connect (after the risk) and Test say a Jobs chat opened; the confirm says where to sign in', { skip: noBrowser, timeout: 90_000 }, async () => {
  const stub = createPortalsStub(fixture(), { mode: 'pane' });
  const page = await open(stub);
  await page.getByRole('button', { name: 'Connect Demo Careers' }).click();
  const dialog = page.getByRole('alertdialog');
  assert.match(await dialog.textContent() ?? '', /could limit your account.*A Jobs chat opens with the site in Claude's browser pane.*Claude never does/);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.prow[data-portal="demo-careers"]').getByText('A Jobs chat opened: sign in there').waitFor();
  assert.deepEqual(stub.calls.at(-1), { name: 'connectPortal', body: { id: 'demo-careers' } });
  await page.locator('.prow[data-portal="stepstone"] summary').click();
  await page.getByRole('button', { name: 'Test StepStone' }).click();
  await page.locator('.prow[data-portal="stepstone"]').getByText('A Jobs chat opened: Claude tests it there').waitFor();
  assert.equal(await page.locator('.psample').count(), 0, 'no result in the row: Claude reports in the chat');
  await page.close();
});

test('Test shows what it found and how; the switch turns scanning on and off', { skip: noBrowser, timeout: 60_000 }, async () => {
  const stub = createPortalsStub(fixture());
  const page = await open(stub);
  await page.locator('.prow[data-portal="stepstone"] summary').click();
  await page.getByRole('button', { name: 'Test StepStone' }).click();
  const row = page.locator('.prow[data-portal="stepstone"]');
  await row.getByText('3 jobs found (2 from the page\'s data, 1 from links)').waitFor();
  assert.deepEqual(await row.locator('.psample li').allTextContents(), ['Backend Engineer · Example Labs', 'Data Analyst · Sample Co']);
  assert.equal(await row.locator('.psample a').first().getAttribute('rel'), 'noopener noreferrer');
  const sw = page.getByRole('switch', { name: 'In Find: StepStone' });
  assert.equal(await sw.getAttribute('aria-checked'), 'true');
  await sw.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="In Find: StepStone"]')?.getAttribute('aria-checked') === 'false');
  assert.deepEqual(stub.calls.at(-1), { name: 'togglePortal', body: { id: 'stepstone', on: false } });
  assert.equal(await page.getByRole('switch', { name: 'In Find: Demo Careers' }).count(), 0, 'connect first: no switch for an account that is not connected');
  // More sites: the rest, one click away.
  assert.equal(await page.locator('.prow[data-portal="naukri"]').isVisible(), false);
  await page.getByText(/^More sites/).click();
  assert.equal(await page.locator('.prow[data-portal="naukri"]').isVisible(), true);
  await page.close();
});

/** Controls in the Portals section that overlap, sit outside the window, or are under 32 px tall at phone width. */
const problems = (page: Page) => page.evaluate(() => {
  const out: string[] = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page overflows ${document.documentElement.scrollWidth} > ${vw}`);
  // Inside a closed <details> nothing shows (newer Chromium still gives such content a box: content-visibility).
  const closed = (e: Element) => !!(e.matches('summary') ? e.parentElement?.parentElement : e)?.closest('details:not([open])');
  const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !closed(e); };
  const cs = [...document.querySelectorAll('.portals button, .portals a, .portals summary')].filter(shown);
  const name = (e: Element) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30);
  for (const e of cs) {
    const r = e.getBoundingClientRect();
    if (r.left < 11 || r.right > vw - 11) out.push(`outside: ${name(e)}`);
    if (e.matches('.btn') && r.height < 31.5) out.push(`under 32 px: ${name(e)}`);
  }
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    if (cs[i].contains(cs[j]) || cs[j].contains(cs[i])) continue;
    const a = cs[i].getBoundingClientRect(), b = cs[j].getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`overlap: ${name(cs[i])} / ${name(cs[j])}`);
  }
  return out;
});

for (const [width, height] of [[360, 640], [390, 844], [820, 700]] as const) {
  test(`Portals at ${width}×${height}: nothing overlaps or leaves the window, with a confirm and a test result open`, { skip: noBrowser, timeout: 60_000 }, async () => {
    const page = await open(createPortalsStub(fixture()), { width, height });
    await page.locator('.prow[data-portal="stepstone"] summary').click();
    await page.getByRole('button', { name: 'Test StepStone' }).click();
    await page.locator('.psample').waitFor();
    await page.getByRole('button', { name: 'Connect Demo Careers' }).click();
    await page.getByText(/^More sites/).click();
    assert.deepEqual(await problems(page), []);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.locator('.portals').screenshot({ path: join(SHOTS, `portals-${width}.png`) }); }
    await page.close();
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Portals in ${scheme}: no text under 14 px, AA contrast, every control labelled`, { skip: noBrowser, timeout: 60_000 }, async () => {
    const page = await open(createPortalsStub(fixture()), { scheme });
    await page.locator('.prow[data-portal="stepstone"] summary').click();
    await page.getByRole('button', { name: 'Test StepStone' }).click();
    await page.locator('.psample').waitFor();
    await page.getByRole('button', { name: 'Connect Demo Careers' }).click();
    const items = await audit(page, '.portals');
    assert.ok(items.length > 20, `${items.length} texts`);
    assert.deepEqual(items.filter((x) => x.size < 14), []);
    assert.deepEqual(items.filter((x) => x.ratio < 4.5), []);
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('.portals button')].filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim())).length);
    assert.equal(unlabelled, 0);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.locator('.portals').screenshot({ path: join(SHOTS, `portals-${scheme}.png`) }); }
    await page.close();
  });
}
