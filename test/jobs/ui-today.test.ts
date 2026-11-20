// Today in Claude desktop's browser pane (about 760–1000 px wide, 700–900 tall), in a real headless Chromium, from the
// shell server of a fictional person: a role selected with Find's "Why so few?" showing and Claude applying. The
// owner's report: the apply panel was cut off with no way to scroll to it, it overlapped the queue, and "Why so few?"
// took half the screen. Here: Apply is reachable by scrolling and nothing covers it, no two controls overlap, the top
// bar is two rows, and "Why so few?" is one line until opened. Also checked inside the shell (the rail narrows the
// frame). CREWDECK_SHOTS=<dir> saves screenshots. Skipped without a Chromium-based browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page, Frame } from 'playwright-core';
import { findBrowser } from '../../src/jobs/browser.ts';
import { runPrefilter } from '../../src/jobs/pipeline/prefilter.ts';
import { budgetedCandidates, recordJudged } from '../../src/jobs/pipeline/rank.ts';
import { judge, pick } from '../../src/jobs/pipeline/pick.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';
import { seedOwner } from './owner-fixture.ts';

const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;
const CLOSED_PORT = 9;

let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
before(async () => {
  if (!found) return;
  s = await jobsServer('example');
  s.c.silverbullet = { ...s.c.silverbullet, port: CLOSED_PORT };
  s.c.projects = s.c.projects.map((p) => ({ ...p, boardPort: CLOSED_PORT }));
  seedOwner(s.w.ctx, s.w.vault);
  runPrefilter(s.w.ctx);
  const b = budgetedCandidates(s.w.ctx, { budget: 40, batch: 10, need: 5, start: true });
  judge(s.w.ctx, b.batch.map((c, i) => ({ role: c.id, eligible: i === 0 ? 'yes' : 'no', score: i === 0 ? 80 : 0, evidence: 'from the posting', reason: i === 0 ? undefined : 'requires US work authorisation' })) as any);
  recordJudged(s.w.ctx, b.batch.map((c) => c.id));
  pick(s.w.ctx, 5);
  const r = (await s.action('find', { count: 5 })).json;
  s.q.finish(r.request, '1 picked');
  preparedRole(s.w, 'Example Studio', { firstTime: true });
  preparedRole(s.w, 'Example Analytics With A Long Company Name');
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

async function newPage(width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('**/*', (r) => (new URL(r.request().url()).port === String(s.port) ? r.continue() : r.abort()));
  return page;
}

const shot = async (page: Page, name: string) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };

/** Select a role and check the page: Why so few? collapsed, Apply reachable and on top, no overlapping controls. */
async function checkToday(f: Frame | Page, label: string, shotPage?: Page) {
  await f.locator('.qitem', { hasText: 'Example Analytics' }).first().click();
  await f.locator('.side').waitFor();
  if (shotPage) await shot(shotPage, `selected-${label}`);
  const why = f.locator('.why');
  if (await why.count()) {
    const open = await why.evaluate((e) => (e.matches('details') ? (e as HTMLDetailsElement).open : !!e.querySelector('details[open]')));
    assert.equal(open, false, `${label}: Why so few? collapsed by default`);
    const h = (await why.boundingBox())!.height;
    assert.ok(h <= 56, `${label}: Why so few? is one line (${h} px)`);
  }
  // The role's tab row keeps its height (it once shrank to nothing in a column that ran out of room).
  const tabs = (await f.locator('.detail [role="tablist"]').boundingBox())!;
  assert.ok(tabs.height >= 30, `${label}: the role's tabs are shown (${tabs.height} px)`);
  const apply = f.getByRole('button', { name: /^Apply/ }).first();
  await apply.scrollIntoViewIfNeeded();
  const hit = await apply.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onTop: !!at && (at === e || e.contains(at)), inView: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0 };
  });
  assert.ok(hit.inView && hit.onTop, `${label}: Apply reachable and not covered: ${JSON.stringify(hit)}`);
  const overlaps = await f.evaluate(() => {
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.sr'); };
    // Only what can be seen: a control scrolled out of its own pane is clipped, not overlapping.
    const visible = (e: Element) => { if (e.parentElement?.closest('details:not([open])') && !e.matches('details > summary')) return false; const r = e.getBoundingClientRect(); for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflow !== 'visible') { const q = p.getBoundingClientRect(); if (r.bottom <= q.top + 1 || r.top >= q.bottom - 1 || r.right <= q.left + 1 || r.left >= q.right - 1) return false; } } return true; };
    const els = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary')].filter((e) => shown(e) && visible(e));
    const out: string[] = [];
    const name = (e: Element) => `${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 30)}"`;
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      const w = Math.min(x.right, y.right) - Math.max(x.left, y.left), h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
      if (w > 1 && h > 1) out.push(`${name(a)} and ${name(b)}`);
    }
    return out;
  });
  assert.deepEqual(overlaps, [], `${label}: overlapping controls`);
}

for (const [width, height] of [[870, 800], [760, 700], [1000, 900], [1280, 800]] as const) {
  test(`Today at ${width}×${height} with a role selected: Apply in reach, nothing overlapping, Why so few? one line`, { skip: noBrowser, timeout: 60_000 }, async () => {
    const page = await newPage(width, height);
    await page.goto(`http://localhost:${s.port}/jobs/#today`);
    await page.locator('.qitem').first().waitFor({ timeout: 15_000 });
    await checkToday(page, `${width}x${height}`, page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, 'no sideways overflow');
    if (width >= 760 && width <= 1000) {
      // Two rows: the tabs and Find, then status · sources · Paste a link.
      const [tabs, find, agent, add] = await Promise.all(['.tabsnav', '.top .find', '.agent', '.addlink'].map((x) => page.locator(x).first().boundingBox().then((b) => b!)));
      assert.ok(Math.abs(find.y + find.height / 2 - (tabs.y + tabs.height / 2)) < 12, 'Find on the tabs row');
      assert.ok(Math.abs(agent.y + agent.height / 2 - (add.y + add.height / 2)) < 12 && agent.y > tabs.y + 20, 'status and link on the second row');
      const top = (await page.locator('.top').boundingBox())!;
      assert.ok(top.height <= 104, `the top bar is two rows (${top.height} px)`);
    }
    await page.evaluate(() => { document.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); window.scrollTo(0, 0); });
    await shot(page, `today-${width}x${height}`);
    // Opening Why so few? shows the fix buttons inside it.
    const why = page.locator('.why summary').first();
    if (await why.count()) {
      await why.click();
      await page.getByRole('button', { name: 'See the preview' }).waitFor();
      await shot(page, `today-why-open-${width}x${height}`);
    }
    await page.close();
  });
}

test('Today inside the shell at 870×800 (the rail narrows the frame): Apply in reach, nothing overlapping', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await newPage(870, 800);
  await page.goto(`http://localhost:${s.port}/#jobs`);
  await page.locator('iframe.on').waitFor({ timeout: 15_000 });
  const frame = page.frames().find((f) => f.url().includes('/jobs/'))!;
  await frame.locator('.qitem').first().waitFor({ timeout: 15_000 });
  await checkToday(frame, 'shell-870x800', page);
  await frame.evaluate(() => { document.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); window.scrollTo(0, 0); });
  await shot(page, 'shell-today-870x800');
  await page.close();
});
