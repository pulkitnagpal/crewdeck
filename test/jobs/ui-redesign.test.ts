// The Jobs redesign (For you, Explore, Applied, Sources, the Find sheet, the phone's bottom bar), from a fictional person's
// real view models: each tab and the sheet rendered in Node; then in a real headless Chromium at 360, 390, 820 and 1280 px
// (no sideways overflow, controls inside the window, none overlapping, 44 px targets on a phone, at most four bottom tabs
// under 700 px, visible focus), the sheet's focus trap and Esc, Explore's search and filters, Save and Judge these N, and the
// Find sheet's choices arriving in the request. Skipped without a Chromium-based browser. CREWDECK_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact-render-to-string';
import type { Browser, Page } from 'playwright-core';
import { html } from '../../web/jobs/lib.js';
import { Explore, EMPTY_QUERY, judgeHint, whereText } from '../../web/jobs/screens/explore.js';
import { FindSheet, estimate, readable, tokenText } from '../../web/jobs/screens/find.js';
import { Sources, everyText } from '../../web/jobs/screens/sources.js';
import { Today, Progress, chipText, whyPoints } from '../../web/jobs/screens/today.js';
import { ApplyPanel } from '../../web/jobs/screens/apply.js';
import { Portals } from '../../web/jobs/screens/portals.js';
import { BottomTabs, MORE, MoreMenu, SCREENS, TopBar, tabCount } from '../../web/jobs/screens/topbar.js';
import { findBrowser } from '../../src/jobs/browser.ts';
import { updatePortal } from '../../src/jobs/portals/state.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';
import { role } from './helpers.ts';
import { audit } from './ui-audit.ts';

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const SPARK = 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z';
const sparks = (markup: string) => (markup.match(new RegExp(SPARK, 'g')) ?? []).length;
const found = findBrowser();
const noBrowser = found ? false : 'no Chromium-based browser on this machine';
const SHOTS = process.env.CREWDECK_SHOTS;

let s: Awaited<ReturnType<typeof jobsServer>>;
let browser: Browser;
const roleIds: string[] = [];
let studio = '';
before(async () => {
  s = await jobsServer('berlin-analyst');
  s.c.appearance = 'auto';
  s.c.silverbullet = { ...s.c.silverbullet, port: 9 };
  const mk = (company: string, title: string, over: Record<string, unknown> = {}) => role(s.w.ctx, { company, title, description: 'SQL, dashboards and reporting for the team', source_key: 'arbeitnow', posted_at: new Date(Date.now() - 20 * 3600_000).toISOString(), ...over } as any);
  roleIds.push(mk('Alpha Data', 'Senior Data Analyst'), mk('Bravo Data', 'Data Analyst', { posted_at: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    mk('Charlie Data', 'BI Analyst', { source_key: 'portal:linkedin', source: 'portal', workplace: 'remote', location: 'Germany' }), mk('Delta Care', 'Registered Nurse'));
  s.w.ctx.db.prepare('update roles set workplace=? where id=?').run('remote', roleIds[2]);
  studio = preparedRole(s.w, 'Example Studio', { firstTime: true });
  // LinkedIn is connected and switched on for Find; the others are not connected.
  updatePortal(s.w.jobsHome, 'linkedin', () => ({ connected: true, last_scan: new Date(Date.now() - 2 * 3600_000).toISOString(), last_found: 25 }));
  assert.equal((await s.action('togglePortal', { id: 'linkedin', on: true })).status, 200);
  if (!found) return;
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: found.path, headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'] });
});
after(async () => { await browser?.close(); await s?.close(); });

// ---- rendered in Node ----

test('the header: four tabs with their numbers, More behind a menu, Find jobs with the spark; the phone\'s bottom bar has the same four', async () => {
  assert.deepEqual(SCREENS.map(([, l]) => l), ['For you', 'Explore', 'Applied', 'Sources']);
  assert.deepEqual(MORE.map(([, l]) => l), ['What Claude knows', 'Preferences', 'Settings']);
  const st = (await s.get('state')).json;
  // Explore's number is what its default view lists: the nurse and the designer are behind a chip, so not counted.
  assert.deepEqual(st.counts, { picks: 1, explore: 3, applied: 0 });
  const bar = render(html`<${TopBar} screen="explore" agent=${st.agent} counts=${st.counts} quota=${5} sources=${st.sources} />`);
  const t = text(bar);
  assert.match(t, /For you 1 Explore 3 Applied 0 Sources More Find jobs/);
  assert.doesNotMatch(bar, /class="topsub"|class="addlink"|Feeds updated|Refresh sources/, 'idle: the header is only the tabs, More and Find jobs');
  assert.match(bar, /aria-current="page"[^>]*>Explore/);
  assert.equal(sparks(bar), 1, 'Find jobs carries the spark');
  assert.doesNotMatch(bar.replace(/aria-label="[^"]*"/g, ''), /What Claude knows|Preferences|Settings/, 'behind More');
  assert.equal(tabCount('sources', st.counts), null);
  const bottom = render(html`<${BottomTabs} screen="today" counts=${st.counts} />`);
  assert.equal((bottom.match(/<button/g) ?? []).length, 4, 'at most four bottom tabs');
  assert.match(bottom, /aria-label="Jobs sections"/);
  assert.match(bottom, /aria-current="page"[^>]*><svg[^>]*>.*?<\/svg><span>For you<\/span>/);
  assert.equal(render(html`<${MoreMenu} screen="today" />`).includes('class="menu"'), false, 'closed until it is opened');
  assert.match(render(html`<${MoreMenu} screen="settings" />`), /class="morebtn on"/, 'More is the current place for those screens');
});

test('For you: the progress line, how much Claude read, picks with their state, why it fits, counts, Apply with the spark', async () => {
  const state = (await s.get('state')).json;
  const d = (await s.get(`today?role=${studio}`)).json;
  assert.deepEqual(Object.keys(d.progress).sort(), ['applied_week', 'picked', 'read', 'ready']);
  const out = render(html`<${Today} data=${{ ...d, progress: { ...d.progress, read: { n: 40, of: 802 } } }} state=${state} />`);
  const t = text(out);
  assert.match(t, /1 picked · 0 ready · 0 applied/);
  assert.match(t, /1 picked today.*0 ready to apply.*0 applied this week/);
  assert.match(t, /Claude read 40 of 802 · see all 802/);
  assert.match(t, /Picks · 1.*Example Studio 1 first-time question Senior Product Designer/);
  assert.match(t, /Example Studio · Berlin · posted (just now|\d+ h ago)/);
  assert.match(t, /3 questions 2 answered 0 to check 1 needs you/);
  assert.match(t, /Answers and tailored resume/);
  assert.match(out, /<button[^>]*><span class="spark">.*?<\/span>Apply<\/button>/);
  assert.equal(chipText({ text: 'Ready to apply' }), 'Ready');
  assert.equal(chipText({ text: 'Not prepared yet' }), 'Not prepared');
  assert.deepEqual(whyPoints('Platform work matches your last two roles; remote within India. Staff level, as you prefer.'), ['Platform work matches your last two roles', 'remote within India', 'Staff level, as you prefer']);
  assert.deepEqual(whyPoints('- one\n- two'), ['one', 'two']);
  assert.deepEqual(whyPoints(''), []);
  const why = render(html`<${Today} data=${{ ...d, detail: { ...d.detail, why: 'Matches your SQL work. Berlin, hybrid.' } }} state=${state} />`);
  assert.match(text(why), /Why it fits Matches your SQL work Berlin, hybrid/);
  assert.equal(render(html`<${Progress} progress=${null} />`), '');
  // Quick apply: a dashed strip under the picks, with the spark.
  const qa = render(html`<${Today} data=${{ ...d, quick_apply: { n: 2, cap: 5, used: 0, request: null } }} state=${state} />`);
  assert.match(text(qa), /2 Easy Apply picks are ready Quick apply \(2\)/);
  assert.ok(sparks(qa) >= 2);
  assert.match(text(render(html`<${Today} data=${{ ...d, quick_apply: { n: 2, cap: 5, used: 0, request: 9 } }} state=${state} />`)), /Quick apply is running in your Jobs chat Running/);
  // One input for links and everything else: the Tell box. No separate Add link, in the header or on the phone.
  assert.doesNotMatch(render(html`<${TopBar} screen="today" agent=${state.agent} narrow=${true} />`), /id="add-link"/);
  for (const narrow of [false, true]) {
    const page = render(html`<${Today} data=${d} state=${state} narrow=${narrow} />`);
    assert.doesNotMatch(page, /id="add-link"|phonelink/);
    assert.equal((page.match(/<input/g) ?? []).length, 1, 'one input on For you');
    assert.match(page, /placeholder="Paste a job link, or tell Crewdeck anything/);
  }
});

test('every Claude action carries the same small spark; the free ones never do', async () => {
  const d = (await s.get(`today?role=${studio}`)).json.detail;
  const panel = (p: any, extra: any = {}) => render(html`<${ApplyPanel} d=${d} panel=${p} ...${extra} />`);
  const ready = { ...d, approvable: true, counts: { total: 2, known: 2, drafted: 0, first: 0 } };
  const apply = render(html`<${ApplyPanel} d=${ready} panel=${{ state: 'ready', progress: [] }} />`);
  assert.match(apply, /<button[^>]*><span class="spark">.*?<\/span>Apply<\/button>/);
  assert.match(panel({ state: 'ready', progress: [] }, { prepare: { needed: true, request: null } }), /<span class="spark">.*?<\/span>Prepare \(about 1 min\)/);
  assert.match(panel({ state: 'stopped', reason: 'x', progress: [] }), /<span class="spark">.*?<\/span>Try again/);
  assert.match(panel({ state: 'your_turn', progress: [] }), /<span class="spark">.*?<\/span>Ask Claude to fill it again/);
  assert.ok(sparks(panel({ state: 'ready', progress: [] }, { prepare: { needed: true, request: null } })) >= 1);
  // Free ones: no spark in "I submitted it", Not interested, View posting, Cancel.
  const free = panel({ state: 'confirmation', progress: [] }) + panel({ state: 'waiting', request: 3, progress: [], connected: true });
  assert.equal(sparks(free), 0);
  // Explore: Judge these N has it; Save and Hide do not.
  const x = (await s.get('explore')).json;
  const withSaved = render(html`<${Explore} data=${{ ...x, counts: { ...x.counts, saved: 3 }, judgeable: 3 }} />`);
  assert.match(withSaved, /<span class="spark">.*?<\/span>Judge these 3<\/button>/);
  const rows = withSaved.split('<tbody>')[1]!.split('</tbody>')[0]!;
  assert.equal(sparks(rows), 0, 'the rows\' own buttons are free');
  // Sources: Refresh, Connect and Add a company are free; the Find sheet's Find has it.
  const sheet = render(html`<${FindSheet} portals=${[]} />`);
  assert.match(sheet, /<span class="spark">.*?<\/span>Find<\/button>/);
});

test('Explore: search, the filter chips with their counts, sort, rows with Where / Found on / Posted, Save and Hide, the saved card', async () => {
  const x = (await s.get('explore')).json;
  assert.deepEqual(x.counts, { feeds: 2, accounts: 1, saved: 0, others: 2 }, 'the nurse and the designer are other occupations for a data analyst');
  const out = render(html`<${Explore} data=${x} found=${5} />`);
  const t = text(out);
  assert.match(t, /Search jobs/);
  assert.match(out, /placeholder="Search 5 jobs: title, company, skill"/);
  assert.match(t, /Sort Best match Newest/);
  assert.match(t, /All sources Feeds 2 Your accounts 1 Strong title match Last 7 days Saved 0 Also show other occupations \(2\)/);
  assert.match(out, /aria-pressed="true"[^>]*>All sources/);
  assert.match(t, /Job Where Found on Posted/);
  assert.match(t, /Senior Data Analyst Alpha Data/);
  assert.match(t, /Remote · Germany/, 'the workplace, then where');
  assert.match(t, /Showing 3 of 3/);
  assert.match(out, /aria-label="Save Senior Data Analyst at Alpha Data"/);
  assert.match(out, /aria-label="Hide Senior Data Analyst at Alpha Data"/);
  assert.match(out, /class="srcmark feed"/);
  assert.match(out, /class="srcmark acct"/);
  assert.match(out, /Feeds: fetched for free, every 12 h/);
  assert.match(out, /Your accounts: read when you Find/);
  // A saved one: the bookmark is pressed, the card offers to judge it with the token hint.
  const saved = { ...x, counts: { ...x.counts, saved: 6 }, judgeable: 6, rows: x.rows.map((r: any, i: number) => (i === 0 ? { ...r, saved: true } : r)) };
  const st = text(render(html`<${Explore} data=${saved} query=${{ ...EMPTY_QUERY, saved: true }} />`));
  assert.match(st, /6 saved Ask Claude to check if you are eligible, then prepare the ones that fit\. Judge these 6 about 8k tokens/);
  assert.match(render(html`<${Explore} data=${saved} />`), /aria-pressed="true" aria-label="Saved: remove /);
  assert.match(text(render(html`<${Explore} data=${{ ...saved, judgeable: 4 }} />`)), /Judge these 4 about 5k tokens · 2 judged already/);
  assert.match(text(render(html`<${Explore} data=${{ ...x, counts: { ...x.counts, saved: 0 }, judgeable: 0 }} />`)), /0 saved Save the jobs you like with the bookmark/);
  assert.equal(judgeHint(1), 'about 1k tokens');
  assert.equal(judgeHint(40), 'about 52k tokens');
  assert.equal(whereText({ workplace: 'remote', location: 'India' }), 'Remote · India');
  assert.equal(whereText({ workplace: 'remote', location: 'Remote, India' }), 'Remote, India');
  assert.equal(whereText({ workplace: null, location: '' }), '—');
  // Picked roles show "Picked", not Save. Nothing matches: it says so. More to show: a link, up to 200.
  const picked = text(render(html`<${Explore} data=${{ ...x, rows: [{ ...x.rows[0], status: 'picked' }] }} />`));
  assert.match(picked, /Picked/);
  assert.match(text(render(html`<${Explore} data=${{ ...x, rows: [], total: 0 }} query=${{ ...EMPTY_QUERY, q: 'zzz' }} />`)), /Nothing matches these filters\./);
  assert.match(text(render(html`<${Explore} data=${{ ...x, total: 120 }} />`)), /Showing 3 of 120 · show more/);
  assert.match(text(render(html`<${Explore} data=${{ ...x, total: 400 }} query=${{ ...EMPTY_QUERY, limit: 200 }} />`)), /narrow the search to see the rest/);
  // The row's link only ever opens an http(s) address.
  const evil = render(html`<${Explore} data=${{ ...x, rows: [{ ...x.rows[0], url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>' }] }} />`);
  assert.doesNotMatch(evil, /href="javascript:/);
  assert.doesNotMatch(evil, /<img src=x/);
});

test('Sources: Feeds (automatic, free) and Your accounts, side by side; groups with counts; the quiet icons', async () => {
  const data = (await s.get('sources')).json;
  const portalsView = (await s.get('portals')).json;
  const st = (await s.get('state')).json;
  const out = render(html`<${Sources} data=${data} state=${st} portals=${portalsView.portals} portalsMode=${portalsView.mode} />`);
  const t = text(out);
  assert.match(t, /Feeds Automatic and free\. Updated every 12 h, not fetched yet\. Refresh/);
  assert.match(t, /Company career sites 1.*Job boards 2.*Job APIs 6 on · 4 need a free key/);
  assert.match(t, /Add a company Browse catalog Add a web address Open in Notes/);
  assert.match(t, /Your accounts Sites you sign in to\. Claude reads them, slowly, only when you Find\./);
  assert.match(t, /LinkedIn Signed in · last scan 2 h ago · 25 found/);
  assert.match(t, /In Find/);
  assert.match(t, /Naukri .*Connect/);
  assert.match(t, /More sites for .* \(\d+\)/);
  assert.match(t, /Sites may not allow automation\. Crewdeck stops at the first check and asks you\./);
  assert.match(out, /class="gicon feed"/);
  assert.match(out, /class="gicon acct"/);
  assert.match(out, /aria-label="In Find: LinkedIn"[^>]*>/);
  assert.match(out, /aria-checked="true" aria-label="In Find: LinkedIn"/);
  assert.equal(everyText('12h'), 'every 12 h');
  assert.equal(everyText('30m'), 'every 30 m');
  assert.equal(everyText('weekly'), 'every weekly');
  // Few sources: their lists show; many (more than six): names as chips, the list one click away.
  const many = { ...data, rows: Array.from({ length: 9 }, (_, i) => ({ ...data.rows[0], key: `c${i}`, name: `Company ${i}`, position: i + 1, group: 'careers', kind: 'employer' })) };
  const m = render(html`<${Sources} data=${many} state=${st} />`);
  assert.match(text(m), /Company career sites 9/);
  assert.equal((m.match(/class="namechip/g) ?? []).length, 7);
  assert.match(text(m), /\+2/);
  assert.match(text(m), /Edit order, switches and removal/);
  assert.doesNotMatch(m, /<ol class="slist" aria-label="Your sources: careers/, 'the list is behind its toggle');
});

test('the Find sheet: a dialog with accounts, a budget of 20/40/80 (40), prepare 3/5/0 (3), the estimate and Find', async () => {
  const portals = (await s.get('portals')).json.portals;
  const li = portals.find((p: any) => p.id === 'linkedin');
  assert.equal(li.state, 'connected');
  assert.equal(li.enabled, true);
  assert.ok(li.searches >= 1 && li.pages >= li.searches, 'what one read covers: searches and pages');
  assert.deepEqual(readable(portals).map((p: any) => p.id), ['linkedin'], 'connected and switched on');
  const sheet = render(html`<${FindSheet} portals=${[{ ...li, searches: 3, pages: 3 }, { ...li, id: 'naukri', name: 'Naukri', searches: 4, pages: 4 }]} titles=${['software', 'platform', 'AI']} found=${802} quota=${10} />`);
  const t = text(sheet);
  assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby="find-h"/);
  assert.match(t, /Find jobs for you Claude reads, judges and prepares\. You decide what it spends\./);
  assert.match(t, /Read your accounts now LinkedIn 3 searches Naukri 4 searches Searches cover all your titles: software, platform, AI\./);
  assert.equal((sheet.match(/type="checkbox"[^>]*checked/g) ?? []).length, 2, 'ticked to start');
  assert.match(t, /Judge Best matches Claude reads 20 40 80 From 802 already found, best first\. It stops early once 10 companies fit\./);
  assert.match(sheet, /role="radiogroup"/);
  assert.match(sheet, /role="radio"[^>]*aria-checked="true"[^>]*>40</);
  assert.match(sheet, /aria-checked="false"[^>]*>20</);
  assert.match(t, /Prepare the top 3 5 0/);
  assert.match(sheet, /<option value="3" selected>3<\/option><option value="5">5<\/option><option value="0">0<\/option>/);
  // 7 pages × 5k + 40 judged × 1.3k + 3 prepared × 12k = 123k tokens (to the nearest 5k above 20k), about 6 minutes.
  assert.deepEqual(estimate({ pages: 7, judged: 40, prepared: 3 }), { tokens: 123_000, minutes: 6 });
  assert.match(t, /≈ 125k tokens ≈ 6 min in a Jobs chat up to 10 picks, never padded/);
  assert.equal(tokenText(123_000), '≈ 125k');
  assert.equal(tokenText(6500), '≈ 7k');
  assert.match(t, /Cancel Find/);
  // No account connected: it says so and offers Sources.
  assert.match(text(render(html`<${FindSheet} portals=${[]} />`)), /No account is connected and switched on: Claude judges what your feeds already found\. Connect an account/);
  assert.match(text(render(html`<${FindSheet} portals=${null} />`)), /Checking your accounts…/);
});

// ---- in a real browser ----

const SIZES = [[360, 640], [390, 844], [820, 900], [1280, 860]] as const;
async function open(width: number, height: number, hash: string, scheme: 'light' | 'dark' = 'light') {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  await page.route('**/*', (r) => (new URL(r.request().url()).port === String(s.port) ? r.continue() : r.abort()));
  await page.goto(`http://localhost:${s.port}/jobs/#${hash}`);
  return page;
}

/** No sideways overflow, every visible control inside the window, none overlapping another, 44 px targets on a phone. */
function problems(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page overflows: ${document.documentElement.scrollWidth} > ${vw}`);
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.sr, [inert]') && !e.closest('details:not([open]) > :not(summary)'); };
    const nm = (e: Element) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} "${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 28)}"`;
    const pinned = (e: Element) => { for (let p: Element | null = e; p; p = p.parentElement) { const pos = getComputedStyle(p).position; if (pos === 'sticky' || pos === 'fixed') return true; } return false; };
    const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary')].filter(shown);
    const phone = vw < 700;
    for (const e of controls) {
      const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5) out.push(`outside the window: ${nm(e)} ${Math.round(r.left)}–${Math.round(r.right)} of ${vw}`);
      const link = e.matches('a, .linkbtn, summary, input[type="checkbox"], .switch, .xtitle, .namechip');
      if (phone && !link && r.height < 43.5) out.push(`under 44 px tall: ${nm(e)} ${Math.round(r.height)}`);
    }
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (a.contains(b) || b.contains(a) || a.closest('label')?.contains(b) || b.closest('label')?.contains(a) || pinned(a) !== pinned(b) || a.closest('.menu') || b.closest('.menu')) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      if (Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1) out.push(`overlap: ${nm(a)} and ${nm(b)}`);
    }
    return out;
  });
}

for (const [width, height] of SIZES) {
  test(`each tab and the Find sheet at ${width}×${height}: nothing overflows or overlaps${width < 700 ? ', 44 px targets, a bottom bar of four' : ', tabs on top'}, light and dark`, { skip: noBrowser, timeout: 120_000 }, async () => {
    const all: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      for (const [hash, ready] of [['today', '.qitem'], ['explore', '.xrow'], ['applications', 'table'], ['sources', '.fgroup']] as const) {
        const page = await open(width, height, hash, scheme);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        if (hash === 'sources') { for (const g of await page.locator('.fgroup > summary').all()) await g.click(); }
        const bar = { tabs: await page.locator('.tabsnav').isVisible(), bottom: await page.locator('.bottombar').isVisible(), items: await page.locator('.bottombar button').count() };
        if (width < 700) { assert.deepEqual(bar, { tabs: false, bottom: true, items: 4 }, `${hash}: the phone's bar`); } else { assert.deepEqual([bar.tabs, bar.bottom], [true, false], `${hash}: tabs on top`); }
        all.push(...(await problems(page)).map((p) => `${hash}-${scheme}-${width}: ${p}`));
        if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `redesign-${hash}-${scheme}-${width}.png`) }); }
        await page.close();
      }
      const page = await open(width, height, 'today', scheme);
      await page.locator('.find').waitFor({ timeout: 15_000 });
      await page.locator('.top .find').click();
      await page.getByRole('dialog').waitFor();
      all.push(...(await problems(page)).map((p) => `sheet-${scheme}-${width}: ${p}`));
      const box = (await page.locator('.sheet').boundingBox())!;
      assert.ok(box.x >= -0.5 && box.x + box.width <= width + 0.5 && box.y >= -0.5 && box.y + box.height <= height + 0.5, `the sheet fits the window: ${JSON.stringify(box)}`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `redesign-find-${scheme}-${width}.png`) });
      await page.close();
    }
    assert.deepEqual(all, []);
  });
}

test('focus is always visible on the tabs, filters and buttons (a 2 px outline), and the page stays usable with the keyboard alone', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open(1280, 860, 'explore');
  await page.locator('.xrow').first().waitFor({ timeout: 15_000 });
  await page.mouse.click(1, 1);
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const e = document.activeElement as HTMLElement | null; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { name: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 30), outline: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow, parentOutline: getComputedStyle(e.closest('.searchbox, .addlink') ?? e).outlineStyle }; });
    if (!f) continue;
    seen.add(f.name);
    assert.ok((f.outline !== 'none' && f.width >= 2) || f.parentOutline !== 'none' || f.shadow !== 'none', `focus is visible on "${f.name}": ${JSON.stringify(f)}`);
  }
  assert.ok([...seen].some((n) => n.startsWith('Explore')) && [...seen].some((n) => n.startsWith('Find jobs')) && [...seen].some((n) => n.startsWith('All sources')), [...seen].join(' | '));
  await page.close();
});

test('the Find sheet: focus stays inside, Esc closes it and focus returns to Find jobs; Cancel sends nothing', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open(1280, 860, 'today');
  await page.locator('.top .find').waitFor({ timeout: 15_000 });
  await page.locator('.top .find').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('.sheet'));
  await page.waitForFunction(() => !!document.activeElement?.closest('.sheet'));
  assert.equal(await inside(), true, 'focus moves into the sheet');
  assert.equal(await page.locator('.appchrome').getAttribute('inert'), '', 'the page behind is inert');
  const order: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await inside(), true, `Tab ${i + 1} stays inside`);
    order.push(await page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim()));
  }
  assert.ok(order.includes('Close') && order.includes('Find') && order.includes('Cancel') && order.some((n) => /LinkedIn/.test(n) || n === ''), order.join(' | '));
  await page.keyboard.press('Shift+Tab');
  assert.equal(await inside(), true, 'Shift+Tab stays inside too');
  const before = s.q.ofLane('jobs', 'find').length;
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('Find jobs')), true, 'focus back on the button that opened it');
  assert.equal(await page.locator('.appchrome').getAttribute('inert'), null);
  await page.locator('.top .find').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.locator('.top .find').click();
  await page.locator('.scrim').click({ position: { x: 4, y: 4 } });
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(s.q.ofLane('jobs', 'find').length, before, 'closing sent nothing');
  await page.close();
});

test('Find: the sheet\'s accounts, budget and prepare arrive in the request; what is unticked is left out', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open(1280, 860, 'today');
  await page.locator('.top .find').click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('checkbox', { name: /LinkedIn/ }).waitFor();
  assert.equal(await sheet.getByRole('checkbox', { name: /LinkedIn/ }).isChecked(), true);
  const est = (await sheet.locator('.estimate').textContent()) ?? '';
  assert.match(est, /≈ \d+k\s*tokens.*≈ \d+ min.*up to 5\s*picks, never padded/);
  await sheet.getByRole('radio', { name: '80' }).click();
  assert.equal(await sheet.getByRole('radio', { name: '80' }).getAttribute('aria-checked'), 'true');
  assert.notEqual((await sheet.locator('.estimate').textContent()) ?? '', est, 'the estimate follows the choices');
  await sheet.getByRole('radio', { name: '80' }).press('ArrowLeft');
  assert.equal(await sheet.getByRole('radio', { name: '40' }).getAttribute('aria-checked'), 'true', 'arrow keys move along the segments');
  await sheet.getByRole('radio', { name: '80' }).click();
  await sheet.getByLabel('Prepare the top').selectOption('5');
  await sheet.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const req = s.q.ofLane('jobs', 'find').find((r) => r.payload?.budget === 80)!;
  assert.deepEqual(req.payload, { count: 5, portals: ['linkedin'], budget: 80, prepare: 5 });
  s.q.cancel(req.id, 'jobs');
  // Unticked: not read now.
  await page.locator('.top .find').click();
  await page.getByRole('checkbox', { name: /LinkedIn/ }).uncheck();
  await page.getByRole('radio', { name: '20' }).click();
  await page.getByLabel('Prepare the top').selectOption('0');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const req2 = s.q.ofLane('jobs', 'find').find((r) => r.payload?.budget === 20)!;
  assert.deepEqual(req2.payload, { count: 5, portals: [], budget: 20, prepare: 0 });
  s.q.cancel(req2.id, 'jobs');
  await page.close();
});

test('Explore in the page: words and chips filter (free), Save and Hide, Judge these N sends a judge request, the tab shows the default view\'s number', { skip: noBrowser, timeout: 90_000 }, async () => {
  const page = await open(1280, 860, 'explore');
  await page.locator('.xrow').first().waitFor({ timeout: 15_000 });
  const titles = () => page.locator('.xrow .xtitle').allTextContents();
  assert.equal((await titles()).length, 3, 'other occupations are set aside');
  assert.match(await page.locator('.xfoot').textContent() ?? '', /Showing 3 of 3/);
  await page.getByRole('searchbox', { name: 'Search jobs' }).fill('bravo');
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 1);
  assert.deepEqual(await titles(), ['Data Analyst']);
  await page.getByRole('searchbox', { name: 'Search jobs' }).fill('');
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 3);
  // Chips: Your accounts (1); Also show other occupations adds the nurse and the designer, after the rest.
  await page.getByRole('button', { name: /^Your accounts/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 1);
  assert.equal(await page.locator('.xrow .srcmark.acct').count(), 1);
  await page.getByRole('button', { name: 'All sources' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 3);
  await page.getByRole('button', { name: 'Also show other occupations (2)' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 5);
  assert.deepEqual((await titles()).slice(-2).sort(), ['Registered Nurse', 'Senior Product Designer'], 'other occupations come last');
  await page.getByRole('button', { name: /^Also show other occupations/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 3);
  // Sort by newest.
  await page.getByLabel('Sort').selectOption('newest');
  await page.waitForFunction(() => document.querySelector('.xrow .xtitle')?.textContent === 'Senior Data Analyst');
  // Save two, then Judge: one request, exactly those two.
  await page.getByRole('button', { name: 'Save Senior Data Analyst at Alpha Data' }).click();
  await page.getByRole('button', { name: 'Save Data Analyst at Bravo Data' }).click();
  await page.getByRole('button', { name: /^Judge these 2/ }).waitFor();
  assert.match(await page.locator('.xsaved').textContent() ?? '', /2 saved.*about 3k tokens/);
  await page.getByRole('button', { name: /^Judge these 2/ }).click();
  await page.getByText(/Jobs chat|Sent to your Jobs chat/).first().waitFor();
  const req = s.q.ofLane('jobs', 'judge')[0]!;
  assert.deepEqual([...(req.payload!.roles as string[])].sort(), [roleIds[0], roleIds[1]].sort());
  s.q.cancel(req.id, 'jobs');
  // Hide one: it is gone, and the Explore number drops.
  const tab = async () => (await page.locator('.tabsnav button', { hasText: 'Explore' }).textContent()) ?? '';
  assert.match(await tab(), /Explore\s*3/, 'the default view\'s 3, not the pool\'s 5');
  await page.getByRole('button', { name: 'Hide Data Analyst at Bravo Data' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.xrow').length === 2);
  // The tab's number is cached for 30 s (it runs the rules over the pool), so it is not asserted to drop here.
  await page.close();
  assert.equal((await s.action('unsaveRole', { role: roleIds[1] })).status, 200);
  assert.equal((await s.action('unsaveRole', { role: roleIds[0] })).status, 200);
});

test('For you at a phone width: the progress line, the picks as cards, Paste a link in the page, the bottom bar switches tabs', { skip: noBrowser, timeout: 60_000 }, async () => {
  const page = await open(390, 844, 'today');
  await page.locator('.qitem').first().waitFor({ timeout: 15_000 });
  assert.match(await page.locator('.progress .line').textContent() ?? '', /1 picked · 0 ready · 0 applied/);
  assert.equal(await page.locator('.stats3').isVisible(), false);
  assert.equal(await page.locator('.top .addlink').count(), 0, 'not in the header');
  assert.equal(await page.locator('.phonelink, .addlink, #add-link').count(), 0, 'no separate Add link: the Tell box takes links');
  assert.equal(await page.getByRole('textbox', { name: 'Tell Crewdeck' }).isVisible(), true);
  assert.match(await page.getByRole('textbox', { name: 'Tell Crewdeck' }).getAttribute('placeholder') ?? '', /^Paste a job link, or tell Crewdeck anything/);
  assert.equal((await page.locator('.phonetitle').textContent()), 'For you');
  await page.locator('.bottombar button', { hasText: 'Explore' }).click();
  await page.locator('.xrow').first().waitFor();
  assert.equal(await page.locator('.phonetitle').textContent(), 'Explore');
  assert.equal(await page.locator('.bottombar button[aria-current="page"]').textContent().then((x) => x?.trim().startsWith('Explore')), true);
  await page.locator('.morebtn').click();
  await page.locator('.menu button', { hasText: 'Settings' }).click();
  await page.locator('.switch').first().waitFor();
  assert.equal(await page.locator('.phonetitle').textContent(), 'Settings', 'a screen behind More names itself');
  await page.close();
});

test('D41 on the redesign in light and dark: nothing under 14 px, AA contrast; the quiet icons carry no text of their own', { skip: noBrowser, timeout: 120_000 }, async () => {
  for (const scheme of ['light', 'dark'] as const) for (const [hash, ready] of [['explore', '.xrow'], ['sources', '.fgroup']] as const) {
    const page = await open(1280, 860, hash, scheme);
    await page.locator(ready).first().waitFor({ timeout: 15_000 });
    const items = await audit(page, '.app');
    assert.ok(items.length > 20, `${hash}: ${items.length} texts`);
    assert.deepEqual(items.filter((x) => x.size < 14), [], `${hash}-${scheme}: 14 px`);
    assert.deepEqual(items.filter((x) => x.ratio < 4.5), [], `${hash}-${scheme}: AA`);
    await page.close();
  }
});

test('the redesign\'s pages put nothing from data into inline styles or HTML; Applied and Sources keep their words', () => {
  const out = render(html`<${Portals} portals=${[{ id: 'x', name: '<b>x</b>', countries: [], fields: [], state: 'not_connected', enabled: false, risk: 'r', signup_url: 'javascript:alert(1)', login_url: '', verified: true, needs_reader: false, blurb: '<i>a</i>' }]} />`);
  assert.doesNotMatch(out, /<b>x<\/b>|<i>a<\/i>/);
});
