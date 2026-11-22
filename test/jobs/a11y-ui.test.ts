// D41 for the whole Jobs page (design §24.13, P9i), in a real headless Chromium, light and dark: the top bar, Today
// (the queue, a role with a first-time question, the apply panel, "Why so few?" and the Not interested dialog),
// Applications, What Claude knows (every tab), Settings (with its confirm open) and the setup card a new user sees.
// Sources and Preferences have their own checks in sources-ui.test.ts. On every screen: no text under 14 px, AA
// contrast (4.5:1) for every text, every control labelled, none taken out of the Tab order, and a Tab walk that reaches
// the screen's controls. Skipped without a Chromium-based browser. CREWDECK_SHOTS=<dir> saves a screenshot of each.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { findBrowser } from '../../src/jobs/browser.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { budgetedCandidates, recordJudged } from '../../src/jobs/pipeline/rank.ts';
import { judge, pick } from '../../src/jobs/pipeline/pick.ts';
import { remember } from '../../src/jobs/kb/ops.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';
import { role } from './helpers.ts';
import { seedOwner } from './owner-fixture.ts';
import { audit, tabWalk, unlabelled, unreachable } from './ui-audit.ts';

const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;

let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
let picked = '';
before(async () => {
  if (!found) return;
  s = await jobsServer('example');
  s.c.appearance = 'auto';
  // A Find that picked fewer than asked (the "Why so few?" card), a role with a first-time question, an applied role,
  // and something remembered: every part of every screen has something in it.
  seedOwner(s.w.ctx, s.w.vault);
  runPrefilter(s.w.ctx);
  const b = budgetedCandidates(s.w.ctx, { budget: 40, batch: 10, need: 5, start: true });
  judge(s.w.ctx, b.batch.map((c, i) => ({ role: c.id, eligible: i === 0 ? 'yes' : 'no', score: i === 0 ? 80 : 0, evidence: 'from the posting', reason: i === 0 ? undefined : 'requires US work authorisation' })) as any);
  recordJudged(s.w.ctx, b.batch.map((c) => c.id));
  pick(s.w.ctx, 5);
  const r = (await s.action('find', { count: 5 })).json;
  s.q.finish(r.request, '1 picked');
  picked = preparedRole(s.w, 'Example Studio', { firstTime: true });
  role(s.w.ctx, { company: 'Sample Applied Co', title: 'Backend Engineer' }, 'applied');
  remember(s.w.ctx, { kind: 'preference', text: 'Prefers teams with on-call rotations under one week', quote: 'one week on call at most' } as any);
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

async function open(hash: string, scheme: 'light' | 'dark', ready: string, port = s.port) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  await page.goto(`http://localhost:${port}/jobs/#${hash}`);
  await page.locator(ready).first().waitFor({ timeout: 15_000 });
  return page;
}

/** The D41 checks on the whole page (the top bar included), with a screenshot when asked. */
async function d41(page: Page, name: string) {
  const items = await audit(page, '.app');
  assert.ok(items.length > 10, `${name}: ${items.length} texts`);
  assert.deepEqual(items.filter((x) => x.size < 14), [], `${name}: nothing under 14 px`);
  assert.deepEqual(items.filter((x) => x.ratio < 4.5), [], `${name}: AA (4.5:1) for every text`);
  assert.deepEqual(await unlabelled(page, '.app'), [], `${name}: every control labelled`);
  assert.deepEqual(await unreachable(page, '.app'), [], `${name}: nothing taken out of the Tab order`);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); }
  return items.length;
}

const SCREENS: { name: string; hash: string; ready: string; then?: (p: Page) => Promise<void> }[] = [
  { name: 'today', hash: 'today', ready: '.why' },
  { name: 'today-role', hash: 'today', ready: '.qitem', then: async (p) => { await p.locator('.qitem', { hasText: 'Example Studio' }).click(); await p.locator('.side').waitFor(); } },
  { name: 'today-not-interested', hash: 'today', ready: '.qitem', then: async (p) => { await p.locator('.qitem', { hasText: 'Example Studio' }).click(); await p.getByRole('button', { name: 'Not interested' }).click(); await p.getByText('Not interested in Example Studio?').waitFor(); } },
  { name: 'applications', hash: 'applications', ready: 'table' },
  { name: 'explore', hash: 'explore', ready: '.xrow' },
  { name: 'explore-saved', hash: 'explore', ready: '.xrow', then: async (p) => { await p.locator('.xrow .iconbtn[aria-pressed="false"]').first().click(); await p.locator('.xsaved button.primary').waitFor(); await p.locator('.fchip', { hasText: 'Saved' }).click(); } },
  { name: 'sources', hash: 'sources', ready: '.fgroup', then: async (p) => { for (const g of await p.locator('.fgroup > summary').all()) await g.click(); await p.getByRole('button', { name: 'Browse catalog' }).click(); await p.locator('.clist').first().waitFor(); } },
  { name: 'find-sheet', hash: 'today', ready: '.find', then: async (p) => { await p.locator('.top .find').click(); await p.getByRole('dialog').waitFor(); } },
  { name: 'more-menu', hash: 'today', ready: '.morebtn', then: async (p) => { await p.locator('.morebtn').click(); await p.locator('.menu').waitFor(); } },
  ...['profile', 'career', 'search', 'memory', 'answers'].map((tab) => ({ name: `knowledge-${tab}`, hash: 'knowledge', ready: '.kb, .tabs', then: async (p: Page) => { await p.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).click(); await p.waitForTimeout(300); } })),
  { name: 'settings', hash: 'settings', ready: '.switch' },
  { name: 'settings-confirm', hash: 'settings', ready: '.switch', then: async (p) => { await p.locator('.switch').first().click(); await p.getByRole('alertdialog').waitFor(); } },
];

for (const scheme of ['light', 'dark'] as const) {
  test(`D41 on every Jobs screen in ${scheme}: text ≥ 14 px, AA contrast, labelled controls, nothing out of the Tab order`, { skip: noBrowser, timeout: 180_000 }, async () => {
    const counts: string[] = [];
    for (const sc of SCREENS) {
      const page = await open(sc.hash, scheme, sc.ready);
      await sc.then?.(page);
      counts.push(`${sc.name} ${await d41(page, `${sc.name}-${scheme}`)}`);
      await page.close();
    }
    assert.equal(counts.length, SCREENS.length);
  });
}

test('the keyboard reaches every screen\'s controls: the top bar\'s tabs, Find, the Tell box that takes links; a role\'s Apply box and its first-time answer', { skip: noBrowser, timeout: 120_000 }, async () => {
  const page = await open('today', 'light', '.qitem');
  await page.locator('.qitem', { hasText: 'Example Studio' }).click();
  await page.locator('.side').waitFor();
  const walk = await tabWalk(page);
  for (const name of ['For you', 'Explore', 'Applied', 'Sources', 'More', 'Find jobs', 'Tell Crewdeck']) assert.ok(walk.some((w) => w.startsWith(name)), `Tab reaches ${name}: ${walk.join(' | ')}`);
  assert.ok(walk.some((w) => /Example Studio/.test(w)), 'the queue');
  assert.ok(walk.some((w) => /^Yes$/.test(w)), 'the first-time question\'s options');
  // Enter on More opens its menu (What Claude knows, Preferences, Settings stay reachable); Enter on Settings switches screens.
  await page.mouse.click(1, 1);
  for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).startsWith('More'); i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('.menu').waitFor();
  for (let i = 0; i < 5 && (await page.evaluate(() => document.activeElement?.textContent)) !== 'Settings'; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.locator('.switch').first().waitFor();
  // A switch takes Space; the confirm's buttons are next in the Tab order.
  for (let i = 0; i < 40 && (await page.evaluate(() => document.activeElement?.getAttribute('role'))) !== 'switch'; i++) await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.getByRole('alertdialog').waitFor();
  const next = await tabWalk(page);
  assert.ok(next.includes('Yes, switch it on'), next.join(' | '));
  await page.close();
  assert.ok(picked);
});

test('the setup card and the top bar for a new user (no sources yet), light and dark', { skip: noBrowser, timeout: 60_000 }, async () => {
  const fresh = await jobsServer('template');
  fresh.c.appearance = 'auto';
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await open('today', scheme, '.setup', fresh.port);
      // The header is only the tabs, More and Find jobs: the "No sources yet / Open Sources" strip moved out. The Sources tab
      // is still one click away and the setup card on For you is what tells a new user what to do.
      const top = await page.locator('.top').textContent() ?? '';
      assert.match(top, /Sources/, 'the Sources tab');
      assert.doesNotMatch(top, /No sources yet|Job boards not set up|Open Sources|Refresh sources|Paste a job link/);
      assert.equal(await page.locator('.top .sources, .top .addlink, .top .topsub').count(), 0, 'no second row for an idle new user');
      assert.match(await page.locator('.setup').textContent() ?? '', /Set up with Claude/);
      await d41(page, `setup-${scheme}`);
      // Sent with no Claude session connected: the card says what to do, and the request can be cancelled.
      await page.getByRole('button', { name: 'Set up with Claude' }).click();
      await page.getByText('Waiting for a Claude session').waitFor();
      assert.match(await page.locator('.setup').textContent() ?? '', /No Claude session is connected yet/);
      await d41(page, `setup-waiting-${scheme}`);
      await page.locator('.setup').getByRole('button', { name: 'Cancel' }).click();
      await page.getByRole('button', { name: 'Set up with Claude' }).and(page.locator(':not([disabled])')).waitFor();
      assert.doesNotMatch(await page.locator('.setup').textContent() ?? '', /Setup stopped/, 'a cancel is not a failure');
      await page.close();
    }
  } finally { await fresh.close(); }
});
