// The Jobs page's screens rendered in Node (preact-render-to-string) from the real view models of a fictional person.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { Today } from '../../web/jobs/screens/today.js';
import { ApplyPanel } from '../../web/jobs/screens/apply.js';
import { Applications } from '../../web/jobs/screens/applications.js';
import { Knowledge } from '../../web/jobs/screens/knowledge.js';
import { Preferences } from '../../web/jobs/screens/preferences.js';
import { Settings } from '../../web/jobs/screens/settings.js';
import { SetupCard } from '../../web/jobs/screens/setup.js';
import { Banners } from '../../web/jobs/screens/banners.js';
import { TopBar, agentLine } from '../../web/jobs/screens/topbar.js';
import { applyPanel } from '../../src/jobs/panel.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';
import { REPO } from './helpers.ts';

let s: Awaited<ReturnType<typeof jobsServer>>;
let ready = '', first = '', copy = '';
before(async () => {
  s = await jobsServer();
  ready = preparedRole(s.w, 'Example Labs');
  first = preparedRole(s.w, 'Sample Studio', { firstTime: true });
  copy = preparedRole(s.w, 'Placeholder Bank', { url: 'https://www.linkedin.com/jobs/view/4000000004' });
});
after(() => s.close());

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const req = (status: string, result?: string, progress: { at: string; text: string }[] = []) => ({ id: 7, lane: 'jobs', text: 'Apply to a role', status, result, tries: 0, created: '', updated: '', kind: 'apply', ref: 'x', progress }) as any;

test('today: the queue, the role\'s answers with sources, first-time questions on top, the apply panel', async () => {
  const state = (await s.get('state')).json;
  const d = (await s.get(`today?role=${first}`)).json;
  const out = render(html`<${Today} data=${d} state=${state} />`);
  const t = text(out);
  assert.match(t, /Today · 3/);
  for (const c of ['Example Labs', 'Sample Studio', 'Placeholder Bank']) assert.ok(t.includes(c));
  assert.ok(t.indexOf('Are you comfortable with occasional travel?') < t.indexOf('First name'), 'first-time on top');
  assert.match(t, /Sources: your profile/);
  assert.match(t, /1 first-time question/);
  assert.match(out, /<button[^>]*disabled[^>]*>Apply<\/button>/, 'Apply waits for the first-time answer');
  assert.match(out, /aria-label="Apply"/);
  const r = text(render(html`<${Today} data=${(await s.get(`today?role=${ready}`)).json} state=${state} />`));
  assert.match(r, /Claude opens the real form/);
});

test('apply panel: every state, as design §2.3a describes it', async () => {
  const d = (await s.get(`today?role=${ready}`)).json.detail;
  const withPdf = { ...d, resume: { file: 'Sam Example Resume.pdf', url: `/api/jobs/resume/${ready}`, note: 'Tailored for this role' } };
  const lines = [{ at: '2026-11-19T10:00:00Z', text: 'Opened the application in a new tab' }, { at: '2026-11-19T10:01:00Z', text: 'Step 2 of 4: filled 6 fields' }];
  const show = (panel: any, detail = withPdf, extra = {}) => text(render(html`<${ApplyPanel} d=${detail} panel=${panel} workspace="/tmp/jobs-folder" reveal=${true} ...${extra} />`));
  const P = (request: any, o: any = {}) => applyPanel({ status: 'picked', apply: { mode: 'fill' }, request, connected: true, ...o });

  assert.match(show(P(null)), /Apply.*questions.*Claude opens the real form/);
  const waiting = show(P(req('new')));
  assert.match(waiting, /Waiting for Claude/);
  assert.match(waiting, /picks it up as soon as the chat is idle/);
  assert.match(show(P(req('new'), { connected: false })), /No Claude session is working Jobs: open one in \/tmp\/jobs-folder/);
  const filling = show(P(req('picked', undefined, lines)));
  assert.match(filling, /Claude is filling the form/);
  assert.match(filling, /Open the form/);
  assert.match(filling, /What Claude did.*Step 2 of 4: filled 6 fields.*Opened the application/);
  assert.match(filling, /Sam Example Resume\.pdf Open Download Show in Finder/);
  assert.doesNotMatch(show(P(req('picked')), withPdf, { reveal: false }), /Show in Finder/);
  const needs = show(P(req('done', 'needs you: What is your earliest start date?')));
  assert.match(needs, /Claude needs your answer/);
  assert.match(needs, /What is your earliest start date\?/);
  assert.match(needs, /Save and continue/);
  const turn = show(P(req('done', 'Stopped at Review; the resume upload is yours.')));
  assert.match(turn, /Your turn: review the form tab and click Submit/);
  assert.match(turn, /I submitted it/);
  assert.match(show(P(req('done', 'submitted: The page says thanks for applying'))), /Claude sees the confirmation page.*thanks for applying.*Mark applied/);
  const stopped = show(P(req('failed', 'The site asks you to sign in again.')));
  assert.match(stopped, /Claude stopped.*sign in again.*Try again.*I submitted it/);
  assert.match(show(P(null, { status: 'applied', applied: '19 Nov' })), /Applied · 19 Nov/);
  const cp = (await s.get(`today?role=${copy}`)).json;
  const copyText = show(cp.panel, cp.detail);
  assert.match(copyText, /Copy these answers into the form.*Easy Apply filling is off/);
  assert.match(copyText, /First name Sam Copy/);
  assert.match(show(P(req('picked')), { ...d, resume: null }), /Not made yet/);
  // C4: a waiting or picked request can be cancelled from the panel; a picked one with no session says so.
  assert.match(waiting, /Cancel/);
  assert.match(filling, /Open the form\s*Cancel/);
  assert.match(show(P(req('picked'), { connected: false })), /No Claude session is connected: if it closed, cancel and try again/);
  assert.doesNotMatch(turn, /Cancel/);
});

test('settings: no system dialog → the terminal command and the one-time code, shown only here', async () => {
  const st = (await s.get('settings')).json;
  assert.match(text(render(html`<${Settings} data=${st} />`)), /confirm in your computer's own dialog/);
  const { TerminalCode } = await import('../../web/jobs/screens/settings.js');
  const box = text(render(html`<${TerminalCode} t=${{ command: 'crewdeck jobs features easy_apply on', code: 'ABCD-EFGH' }} />`));
  assert.match(box, /Confirm in your own terminal.*not in a Claude chat.*crewdeck jobs features easy_apply on.*ABCD-EFGH/);
});

test('apply panel: a needs-you question the role already holds is answered right there (options as buttons)', async () => {
  const d = (await s.get(`today?role=${first}`)).json.detail;
  const out = render(html`<${ApplyPanel} d=${d} panel=${applyPanel({ status: 'picked', apply: { mode: 'fill' }, request: req('done', 'needs you: travel?'), connected: true })} />`);
  assert.match(out, /<button type="button" class="option"[^>]*>Yes<\/button>/);
});

test('applications, what Claude knows, preferences, settings', async () => {
  const apps = text(render(html`<${Applications} data=${(await s.get('applications')).json} />`));
  assert.match(apps, /Applications.*Example Labs.*Senior Product Designer/);
  assert.match(text(render(html`<${Applications} data=${{ rows: [] }} />`)), /No applications yet/);
  for (const tab of ['profile', 'career', 'search', 'memory', 'answers']) {
    const k = (await s.get(`knowledge?tab=${tab}`)).json;
    const out = text(render(html`<${Knowledge} data=${k} />`));
    assert.match(out, /What Claude knows/);
    assert.equal(/Open in Notes/.test(out), tab !== 'answers', tab);
    if (tab === 'career') assert.match(out, /Built a design system used by 6 product teams/);
    if (tab === 'memory') assert.match(out, /“30 days now”/);
  }
  const p = (await s.get('preferences')).json;
  const pref = render(html`<${Preferences} data=${p} />`);
  assert.match(pref, /<textarea id="p-roles\.titles"[^>]*>product designer\nUX designer\ndesign lead<\/textarea>/);
  assert.match(text(pref), /Remote.*Hybrid.*On-site/);
  assert.match(pref, /<label for="p-pay\.floor">Floor<\/label>/);
  assert.match(text(render(html`<${Preferences} data=${{ ...p, exists: false }} />`)), /jobs\/search\.md is missing/);
  const st = (await s.get('settings')).json;
  const set = render(html`<${Settings} data=${st} />`);
  assert.equal((set.match(/role="switch"/g) ?? []).length, 5);
  assert.match(text(set), /LinkedIn guest search.*terms forbid automated access/);
  assert.match(set, /aria-checked="false"/);
});

test('first run, banners and the top bar', async () => {
  const fresh = await jobsServer('template');
  try {
    const st = (await fresh.get('state')).json;
    const card = text(render(html`<${SetupCard} state=${st} />`));
    assert.match(card, /Set up Jobs/);
    assert.match(card, /Set up with Claude/);
    assert.match(card, /I'll edit the files/);
    assert.ok(card.includes(fresh.workspace));
    const today = text(render(html`<${Today} data=${(await fresh.get('today')).json} state=${st} />`));
    assert.match(today, /Set up with Claude/, 'Today shows the setup card to a new user');
  } finally { await fresh.close(); }
  const st = (await s.get('state')).json;
  const b = text(render(html`<${Banners} state=${{ ...st, banners: [{ kind: 'note', text: 'jobs/search.md: pay.floor must be a number', fix: 'Until then Jobs uses the last valid version.', page: 'jobs/search' }] }} />`));
  assert.match(b, /No Claude session is working Jobs\. Open one in/);
  assert.match(b, /pay\.floor must be a number.*last valid version.*Open in Notes/);
  assert.equal(render(html`<${Banners} state=${{ ...st, agent: { ...st.agent, connected: true }, banners: [] }} />`), '');
  const bar = text(render(html`<${TopBar} screen="today" agent=${st.agent} quota=${3} />`));
  assert.match(bar, /Today Applications What Claude knows Preferences Settings/);
  assert.match(bar, /Find 3 jobs/);
  assert.match(bar, /No Claude session/);
  assert.equal(agentLine({ connected: true, working: [{ label: 'Apply to a role', role: { company: 'Example Labs' }, last: { text: 'Step 1 of 3' } }], waiting: [] }).head, 'Claude is working:');
  assert.equal(agentLine({ connected: false, working: [], waiting: [{ label: 'Find jobs' }] }).text, '1 request waiting');
  assert.equal(agentLine({ connected: true, working: [], waiting: [{ label: 'Find jobs', role: null }] }).dot, 'wait');
});

test('posting text is escaped, and a javascript: link never becomes an href', async () => {
  const d = (await s.get(`today?role=${ready}`)).json;
  const evil = { ...d, detail: { ...d.detail, company: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', rows: d.detail.rows.map((r: any) => ({ ...r, text: '<script>alert(1)</script>' })) } };
  const out = render(html`<${Today} data=${evil} state=${(await s.get('state')).json} />`);
  assert.doesNotMatch(out, /<img src=x/);
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /href="javascript:/);
  assert.match(out, /&lt;img src=x/);
});

test('no innerHTML (or anything like it) with data in the Jobs page', () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|html)$/.test(f)) files.push(p); } };
  walk(join(REPO, 'web', 'jobs'));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, f);
    assert.doesNotMatch(src, /\sstyle=/, `${f}: inline styles are blocked by the page's CSP`);
  }
});
