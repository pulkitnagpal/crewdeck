// Crewdeck in a small, short window (Claude desktop's browser pane can be ~360 px wide and ~480 px tall), in a real
// headless Chromium: the shell (rail, top bar, frames) and every Jobs screen at 360×640, 390×844, 480×480 and 720×480.
// On each: no horizontal page overflow, every visible control inside the viewport's width (or inside a row that scrolls
// on its own), no two controls overlapping, the last tab of every tab list reachable, and no text under 14 px (D41).
// The shell's other frames (Notes, boards) point at a closed port and every request off this test's own server is
// aborted: nothing here reaches another server. CREWDECK_SHOTS=<dir> saves a screenshot of each screen at each size.
// Skipped without a Chromium-based browser.
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
import { audit } from './ui-audit.ts';

const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;
const SIZES = [[360, 640], [390, 844], [480, 480], [720, 480]] as const;
const CLOSED_PORT = 9; // the discard port: the shell's Notes and board frames point here, never at a live server

let s: Awaited<ReturnType<typeof jobsServer>>;
let fresh: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
before(async () => {
  if (!found) return;
  s = await jobsServer('example');
  fresh = await jobsServer('template');
  for (const x of [s, fresh]) {
    x.c.silverbullet = { ...x.c.silverbullet, port: CLOSED_PORT };
    x.c.projects = x.c.projects.map((p) => ({ ...p, label: 'Example Board With A Long Name', boardPort: CLOSED_PORT }));
  }
  // Something on every part of every screen: a Find that picked fewer than asked ("Why so few?"), a role with a
  // first-time question, an applied role, something remembered, and Claude applying (a long status) with a link waiting.
  seedOwner(s.w.ctx, s.w.vault);
  runPrefilter(s.w.ctx);
  const b = budgetedCandidates(s.w.ctx, { budget: 40, batch: 10, need: 5, start: true });
  judge(s.w.ctx, b.batch.map((c, i) => ({ role: c.id, eligible: i === 0 ? 'yes' : 'no', score: i === 0 ? 80 : 0, evidence: 'from the posting', reason: i === 0 ? undefined : 'requires US work authorisation' })) as any);
  recordJudged(s.w.ctx, b.batch.map((c) => c.id));
  pick(s.w.ctx, 5);
  const r = (await s.action('find', { count: 5 })).json;
  s.q.finish(r.request, '1 picked');
  preparedRole(s.w, 'Example Studio', { firstTime: true, url: 'https://jobs.example.com/roles/a-very-long-path-segment-without-any-breaks-in-it-at-all-1234567890' });
  const applying = preparedRole(s.w, 'Example Analytics With A Long Company Name');
  role(s.w.ctx, { company: 'Sample Applied Co', title: 'Backend Engineer' }, 'applied');
  remember(s.w.ctx, { kind: 'preference', text: 'Prefers teams with on-call rotations under one week', quote: 'one week on call at most' } as any);
  const a = await s.action('approve', { role: applying });
  assert.equal(a.status, 200, a.body);
  assert.equal((await s.claim()).status, 200);
  await s.call('POST', `/api/requests/${a.json.request}/progress`, s.agent(), { cwd: s.workspace, text: 'Step 2 of 4: filled 6 fields from your answers' });
  assert.equal((await s.action('addLink', { url: 'https://jobs.example.com/roles/42' })).status, 200);
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); await fresh?.close(); });

async function newPage(width: number, height: number, port: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  // Only this test's own server: anything else (the shell's Notes and board frames) is aborted before it leaves.
  await page.route('**/*', (r) => (new URL(r.request().url()).port === String(port) ? r.continue() : r.abort()));
  return page;
}

/**
 * What doesn't fit: page overflow, a pane scrolling sideways that shouldn't, controls outside the viewport's width or
 * its 12 px gutters, overlapping controls, buttons on one row closer than 8 px, buttons under 32 px tall in a narrow
 * window, and tab lists whose last tab can't be brought into view.
 */
function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const narrow = vw <= 600;
    const GUTTER = 12;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page overflows: scrollWidth ${document.documentElement.scrollWidth} > ${vw}: ${[...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > vw + 1 && !e.closest('.tabsnav, .tabs, .queue, .rail')).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).join(', ')}`);
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? `.${e.className.split(' ')[0]}` : ''} "${(e.getAttribute('aria-label') || e.textContent || (e as HTMLInputElement).placeholder || '').trim().slice(0, 30)}"`;
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('.sr'); };
    // The rows meant to scroll sideways on their own; any other box that does is content cut off.
    const ROWS = '.tabsnav, .tabs, .queue, .rail, .lines';
    for (const e of document.querySelectorAll('body *')) {
      const o = getComputedStyle(e).overflowX;
      if ((o === 'auto' || o === 'scroll' || o === 'hidden') && e.scrollWidth > e.clientWidth + 1 && !e.matches(ROWS) && shown(e) && !e.matches('.txt, .lbl, .crumb-name, .sent, .file, .ti, .qitem .ti, input, textarea, select, thead')) out.push(`scrolls sideways: ${name(e)} ${e.scrollWidth} > ${e.clientWidth}`);
    }
    const scroller = (e: Element) => e.parentElement?.closest(ROWS) ?? null;
    const pinned = (e: Element) => { for (let p: Element | null = e; p; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'sticky' || pos === 'fixed') return true; } return false; };
    const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="switch"], [role="tab"]')].filter(shown);
    for (const e of controls) {
      const row = scroller(e);
      const box = (row ?? e).getBoundingClientRect();
      const gutter = row ? 0 : GUTTER;
      if (box.left < gutter - 1 || box.right > vw - gutter + 1) out.push(`outside the width or its ${gutter} px gutters: ${name(e)} ${Math.round(box.left)}–${Math.round(box.right)} of ${vw}`);
      const button = e.matches('button, a.btn') && !e.matches('.linkbtn, [role="switch"], .qitem');
      if (narrow && button && e.getBoundingClientRect().height < 31.5) out.push(`under 32 px tall: ${name(e)} ${e.getBoundingClientRect().height}`);
    }
    // Overlaps between controls (not nested in each other, e.g. a checkbox in its label, nor a pinned bar over content),
    // and buttons on one row closer than 8 px (tabs excepted: a tab row is one control).
    const rects = controls.map((e) => ({ e, r: e.getBoundingClientRect(), pinned: pinned(e), tab: e.matches('[role="tab"], .tabsnav button') }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.e.contains(b.e) || b.e.contains(a.e) || a.e.closest('label')?.contains(b.e) || b.e.closest('label')?.contains(a.e) || a.pinned !== b.pinned) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 1 && h > 1) out.push(`overlap: ${name(a.e)} and ${name(b.e)}`);
      else if (h > Math.min(a.r.height, b.r.height) / 2 && w > -7.5 && !a.tab && !b.tab && a.e.matches('button, a.btn') && b.e.matches('button, a.btn')) out.push(`closer than 8 px: ${name(a.e)} and ${name(b.e)} (${Math.round(-w)} px)`);
    }
    // Every tab list's last tab can be brought into view (scrolled to, or wrapped onto a row of its own).
    for (const list of document.querySelectorAll('.tabsnav, [role="tablist"]')) {
      if (!shown(list)) continue;
      const last = [...list.querySelectorAll('button')].filter(shown).pop();
      if (!last) continue;
      last.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = last.getBoundingClientRect(), l = list.getBoundingClientRect();
      if (r.left < Math.max(0, l.left) - 1 || r.right > Math.min(vw, l.right) + 1) out.push(`last tab not reachable: ${name(last)} ${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(l.left)}–${Math.round(l.right)}`);
      list.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
    return out;
  });
}

async function check(page: Page, label: string, root = 'body') {
  const problems = await layoutProblems(page);
  const small = (await audit(page, root)).filter((x) => x.size < 14);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${label}.png`) }); }
  return [...problems, ...small.map((x) => `text under 14 px: "${x.text}" ${x.size} px`)].map((p) => `${label}: ${p}`);
}

const SCREENS: { name: string; hash: string; ready: string; then?: (p: Page) => Promise<void>; fresh?: boolean }[] = [
  { name: 'today', hash: 'today', ready: '.why' },
  { name: 'today-role', hash: 'today', ready: '.qitem', then: async (p) => { await p.locator('.qitem', { hasText: 'Example Studio' }).click(); await p.locator('.side').waitFor(); } },
  { name: 'today-not-interested', hash: 'today', ready: '.qitem', then: async (p) => { await p.locator('.qitem', { hasText: 'Example Studio' }).click(); await p.getByRole('button', { name: 'Not interested' }).click(); await p.getByText('Not interested in Example Studio?').waitFor(); } },
  { name: 'sources', hash: 'sources', ready: '.srow' },
  { name: 'applications', hash: 'applications', ready: 'table' },
  ...['profile', 'career', 'search', 'memory', 'answers'].map((tab) => ({ name: `knowledge-${tab}`, hash: 'knowledge', ready: '.kb, .tabs', then: async (p: Page) => { await p.getByRole('tab', { name: new RegExp(`^${tab}`, 'i') }).click(); await p.waitForTimeout(300); } })),
  { name: 'preferences', hash: 'preferences', ready: '.prefs h2' },
  { name: 'settings', hash: 'settings', ready: '.switch' },
  { name: 'settings-confirm', hash: 'settings', ready: '.switch', then: async (p) => { await p.locator('.switch').first().click(); await p.getByRole('alertdialog').waitFor(); } },
  { name: 'setup', hash: 'today', ready: '.setup', fresh: true },
];

for (const [width, height] of SIZES) {
  test(`every Jobs screen at ${width}×${height}: no sideways overflow, controls in reach, none overlapping, last tabs reachable, text ≥ 14 px`, { skip: noBrowser, timeout: 240_000 }, async () => {
    const problems: string[] = [];
    for (const sc of SCREENS) {
      const srv = sc.fresh ? fresh : s;
      const page = await newPage(width, height, srv.port);
      await page.goto(`http://localhost:${srv.port}/jobs/#${sc.hash}`);
      await page.locator(sc.ready).first().waitFor({ timeout: 15_000 });
      await sc.then?.(page);
      problems.push(...await check(page, `${sc.name}-${width}x${height}`, '.app'));
      await page.close();
    }
    assert.deepEqual(problems, []);
  });

  test(`the shell at ${width}×${height}: rail, top bar and the Jobs frame fit; the frame fills the rest`, { skip: noBrowser, timeout: 60_000 }, async () => {
    const page = await newPage(width, height, s.port);
    await page.goto(`http://localhost:${s.port}/#jobs`);
    await page.locator('iframe.on').waitFor({ timeout: 15_000 });
    await page.frameLocator('iframe.on').locator('.top').waitFor({ timeout: 15_000 });
    const problems = await check(page, `shell-${width}x${height}`);
    const [frame, bar, rail] = await Promise.all(['iframe.on', '.bar', '.rail'].map((x) => page.locator(x).boundingBox().then((b) => b!)));
    const bottomBar = rail.y > bar.y;
    // The rail sits beside the stage, or along the bottom in a narrow window; the frame takes everything else.
    if (bottomBar) {
      assert.ok(width < 600, `a bottom bar only in narrow windows (${width})`);
      assert.ok(Math.abs(frame.width - width) <= 1, `the frame takes the full width: ${frame.width}`);
      assert.ok(Math.abs(frame.y + frame.height - rail.y) <= 1 && Math.abs(rail.y + rail.height - height) <= 1, `the frame reaches the bottom bar: ${JSON.stringify({ frame, rail })}`);
    } else {
      assert.ok(Math.abs(frame.x - (rail.x + rail.width)) <= 1 && Math.abs(frame.x + frame.width - width) <= 1, `the frame takes the width beside the rail: ${JSON.stringify({ frame, rail })}`);
      assert.ok(Math.abs(frame.y + frame.height - height) <= 1, `the frame reaches the bottom: ${JSON.stringify(frame)}`);
    }
    assert.ok(Math.abs(frame.y - (bar.y + bar.height)) <= 1, 'the frame starts under the top bar');
    assert.ok(frame.height >= height * 0.6, `the frame gets most of the height: ${frame.height} of ${height}`);
    assert.ok(bar.height <= 60 && (!bottomBar || rail.height <= 64), `the shell's own bars are compact: ${rail.height} + ${bar.height}`);
    // The Ask box and its Send stay usable.
    const ask = await page.locator('#ask-text').boundingBox();
    assert.ok(ask && ask.width >= 120, `the Ask box has room: ${ask?.width}`);
    await page.close();
    assert.deepEqual(problems, []);
  });
}
