// The Jobs page laid out by a real headless Chromium (the user's own, as Jobs uses it), from the shell server of a
// fictional person. P8's visual check found the top bar wrapping Find onto a row of its own whenever Claude's status was
// long; this keeps that from coming back (the redesign's header: tabs and Find on one row, the status under them). Skipped when no Chromium-based browser is installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import { findBrowser } from '../../src/jobs/browser.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';

const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';

let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
before(async () => {
  if (!found) return;
  s = await jobsServer();
  const role = preparedRole(s.w, 'Example Analytics With A Long Company Name');
  // Claude is applying (a long status line) while a pasted link waits behind it.
  const a = await s.action('approve', { role });
  assert.equal(a.status, 200, a.body);
  assert.equal((await s.claim()).status, 200);
  await s.call('POST', `/api/requests/${a.json.request}/progress`, s.agent(), { cwd: s.workspace, text: 'Step 2 of 4: filled 6 fields from your answers' });
  assert.equal((await s.action('addLink', { url: 'https://jobs.example.com/roles/42' })).status, 200);
  const { chromium } = await import('playwright-core');
  // Only this test's own server on 127.0.0.1: no proxy, no other network.
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

const box = (page: Page, sel: string) => page.locator(sel).first().boundingBox().then((b) => b!);

async function open(width: number) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`http://localhost:${s.port}/jobs/`);
  await page.locator('.agent b', { hasText: 'Claude is working (1 waiting):' }).waitFor({ timeout: 15_000 });
  return page;
}

test('wide window: tabs and Find on the first row, Claude\'s status and Paste a link on the second, the long status ellipsized', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open(1600);
  const [find, add, agent, tabs] = await Promise.all(['.top .find', '.addlink', '.agent', '.tabsnav'].map((x) => box(page, x)));
  assert.ok(Math.abs(find.y + find.height / 2 - (tabs.y + tabs.height / 2)) < 12, `Find on the tabs row: ${JSON.stringify({ find, tabs })}`);
  assert.ok(Math.abs(agent.y + agent.height / 2 - (add.y + add.height / 2)) < 12 && agent.y > tabs.y + 20, `the status and Paste a link share the second row: ${JSON.stringify({ agent, add })}`);
  assert.ok(add.x > find.x - 400, 'Paste a link sits at the right, under Find');
  assert.match(await page.locator('.agent .txt').getAttribute('title') ?? '', /Claude is working \(1 waiting\).*Step 2 of 4/, 'its full text is in the title');
  assert.ok(agent.width <= 1600 - 56 - 260 - 40, 'the status shrinks for Paste a link rather than wrapping the row');
  await page.close();
});

for (const width of [900, 720]) test(`the browser pane beside the chat (${width} px): Find stays on the first row, the status gets its own`, { skip: noBrowser, timeout: 60_000 }, async () => {
  // 720: the Jobs frame inside Crewdeck's rail in a narrow pane, with D41's 14 px tabs (P9i's rehearsal).
  const page = await open(width);
  const [find, tabs, agent] = await Promise.all(['.top .find', '.tabsnav', '.agent'].map((x) => box(page, x)));
  assert.ok(Math.abs(find.y - tabs.y) < 16, 'Find on the tabs row');
  assert.ok(agent.y > tabs.y + 20, 'the status on the next row');
  assert.ok(agent.x < find.x, 'the status starts at the left of its row');
  await page.close();
});
