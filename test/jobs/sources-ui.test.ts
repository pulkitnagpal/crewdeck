// The Sources screen in a real headless Chromium (design §24.3, D41, P9e): reordering with the keyboard only, the note
// the page writes byte for byte the CLI's for the same changes, LinkedIn's row opening the native confirm, and the
// accessibility baseline (no text under 14 px, AA contrast) in light and dark. Skipped without a Chromium-based browser.
// CREWDECK_SHOTS=<dir> also saves full-page screenshots of the screen in both themes there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Browser, Page } from 'playwright-core';
import { findBrowser } from '../../src/jobs/browser.ts';
import { jobsServer } from './api-helpers.ts';
import { REPO, world } from './helpers.ts';

const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;

let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
const asked: string[] = [];
before(async () => {
  if (!found) return;
  s = await jobsServer('berlin-analyst', { api: { confirm: async (_t, text) => { asked.push(text); return 'yes'; } } });
  s.c.appearance = 'auto';
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

async function open(scheme: 'light' | 'dark' = 'light', width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
  await page.goto(`http://localhost:${s.port}/jobs/#sources`);
  await page.locator('.srow').first().waitFor({ timeout: 15_000 });
  return page;
}
const order = (page: Page) => page.locator('.srow h3').allTextContents();
const label = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');

test('keyboard only: Tab to Move up, Enter twice, Space on a switch; the page writes the same note bytes as the CLI', { skip: noBrowser, timeout: 90_000 }, async () => {
  const page = await open();
  assert.deepEqual(await order(page), ['Arbeitnow', 'Berlin Startup Jobs', 'Example GmbH']);
  let tabs = 0;
  while ((await label(page)) !== 'Move Example GmbH up' && tabs++ < 120) await page.keyboard.press('Tab');
  assert.equal(await label(page), 'Move Example GmbH up', 'reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.srow h3')[1]?.textContent === 'Example GmbH');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Move Example GmbH up');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.srow h3')?.textContent === 'Example GmbH');
  // At the top, Move up is disabled: focus moved to Move down, still on the same row.
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Move Example GmbH down');
  assert.deepEqual(await order(page), ['Example GmbH', 'Arbeitnow', 'Berlin Startup Jobs']);
  assert.match(await page.locator('.srcs > .sr[role="status"]').textContent() ?? '', /Example GmbH moved to position 1 of 3/);
  // The switch of the next row: Tab until it, then Space.
  tabs = 0;
  while ((await label(page)) !== 'Fetch Arbeitnow' && tabs++ < 20) await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[aria-label="Fetch Arbeitnow"]')?.getAttribute('aria-checked') === 'false');
  // The same changes through the CLI on a twin of the same person.
  const twin = world('berlin-analyst');
  twin.ctx.db.close();
  for (const args of [['move', 'example-gmbh', 'up'], ['move', 'example-gmbh', 'up'], ['disable', 'arbeitnow']]) {
    const r = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', 'sources', ...args], { env: { ...process.env, CREWDECK_HOME: twin.home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(readFileSync(join(s.w.vault, 'jobs', 'sources.md'), 'utf8'), readFileSync(join(twin.vault, 'jobs', 'sources.md'), 'utf8'));
  await page.close();
});

test('LinkedIn\'s row: placed like any source, switched on only through the confirm and the native dialog', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open();
  await page.getByRole('button', { name: 'Place LinkedIn in your list' }).first().click();
  await page.locator('.srow[data-key="linkedin"]').waitFor();
  assert.equal(await page.locator('[aria-label="Fetch LinkedIn"]').count(), 0, 'no note switch for LinkedIn');
  await page.getByRole('button', { name: 'Switch on…' }).click();
  const dialog = page.getByRole('alertdialog');
  assert.match(await dialog.textContent() ?? '', /Switch on LinkedIn search\?.*terms/);
  assert.equal(asked.length, 0, 'nothing asked before the second click');
  await dialog.getByRole('button', { name: 'Yes, switch it on' }).click();
  await page.locator('.srow[data-key="linkedin"] .chip.ok', { hasText: 'On' }).waitFor();
  assert.equal(asked.length, 1, 'the native dialog was asked once');
  assert.match(asked[0], /LinkedIn/);
  assert.match(readFileSync(join(s.w.home, 'config.yaml'), 'utf8'), /linkedin_search: true/);
  assert.match(readFileSync(join(s.w.vault, 'jobs', 'sources.md'), 'utf8'), /\n {2}- \{ key: linkedin, name: LinkedIn, linkedin: search, added: [\d-]+ \}\n/, 'never a note flag');
  // Off again (no confirm needed to narrow).
  await page.getByRole('button', { name: 'Switch LinkedIn search off' }).click();
  await page.locator('.srow[data-key="linkedin"] .chip', { hasText: 'Off' }).waitFor();
  assert.equal(asked.length, 1);
  await page.close();
});

/** Every visible text in the screen: its computed size and its contrast with the first opaque background behind it. */
async function audit(page: Page, root = '.srcs') {
  return page.evaluate((root) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c.slice(0, 3); }
      return [255, 255, 255];
    };
    const out: { text: string; size: number; ratio: number }[] = [];
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      const t = n.textContent!.trim();
      if (!t || el.closest('.sr, option, button:disabled, [disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      const a = lum(rgb(cs.color)), b = lum(bg(el));
      out.push({ text: t.slice(0, 40), size: parseFloat(cs.fontSize), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
    }
    return out;
  }, root);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`D41 in ${scheme}: no text under 14 px, AA contrast for every text, labelled controls`, { skip: noBrowser, timeout: 60_000 }, async () => {
    const page = await open(scheme);
    // A failed fetch, an unreadable page and an open confirm, so every state's colours are checked.
    await page.getByRole('button', { name: 'Remove Berlin Startup Jobs' }).click();
    const items = await audit(page);
    assert.ok(items.length > 100, `${items.length} texts`);
    const small = items.filter((x) => x.size < 14);
    assert.deepEqual(small, [], 'nothing under 14 px');
    const low = items.filter((x) => x.ratio < 4.5);
    assert.deepEqual(low, [], 'AA (4.5:1) for every text');
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('.srcs button, .srcs input, .srcs select')]
      .filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim() || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label'))).length);
    assert.equal(unlabelled, 0);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.getByRole('button', { name: 'Cancel' }).click();
      // The page scrolls inside .content: let it grow for a full-page picture.
      await page.evaluate(() => { for (const e of [document.documentElement, document.body, document.getElementById('root'), document.querySelector('.app')] as HTMLElement[]) e.style.height = 'auto'; (document.querySelector('.content') as HTMLElement).style.overflow = 'visible'; });
      await page.screenshot({ path: join(SHOTS, `sources-${scheme}.png`), fullPage: true });
      const narrow = await open(scheme, 820);
      await narrow.screenshot({ path: join(SHOTS, `sources-${scheme}-pane.png`), fullPage: false });
      await narrow.close();
    }
    await page.close();
  });
}

test('the setup card a new user sees first: no text under 14 px and AA contrast, light and dark; it says no resume is fine', { skip: noBrowser, timeout: 60_000 }, async () => {
  const fresh = await jobsServer('template');
  fresh.c.appearance = 'auto';
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
      await page.goto(`http://localhost:${fresh.port}/jobs/`);
      await page.locator('.setup').waitFor({ timeout: 15_000 });
      const text = await page.locator('.setup').textContent() ?? '';
      assert.match(text, /no resume is fine too/);
      assert.match(text, /If no job board covers your field where you live, it says so/);
      await page.getByRole('button', { name: 'I\'ll edit the files' }).click();
      const items = await audit(page, '.setup');
      assert.deepEqual(items.filter((x) => x.size < 14), [], 'nothing under 14 px');
      assert.deepEqual(items.filter((x) => x.ratio < 4.5), [], 'AA contrast');
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `setup-${scheme}.png`), fullPage: false });
      await page.close();
    }
  } finally { await fresh.close(); }
});
