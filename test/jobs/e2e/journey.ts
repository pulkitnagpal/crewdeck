// The journeys of design §2, end to end, for one fictional person per file (design §19, P6): the real CLI (spawned, never
// a TTY), the real shell server with the agent token, the real provider sandbox, headless Chromium through the guard proxy,
// and a local fixture site (feeds, posting pages, application forms, the provider files). Nothing here touches a real site
// or the owner's ~/.crewdeck: env.ts sets a temp CREWDECK_HOME before any Crewdeck module loads.
//
// Network steps (installing providers, reading a posting or a form, fetching descriptions) run in-process with netguard's
// test-only `testHosts`, which no flag or variable can reach; the spawned CLI is shown refusing them (impl/06-e2e.md §3.1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { render } from 'preact-render-to-string';
import type { Page } from 'playwright-core';
import { FILES, HOME, ROOT, TMP, VAULT } from './env.ts';
import { CONFIG_PATH, ensureToken, loadConfig } from '../../../src/config.ts';
import { Requests } from '../../../src/requests.ts';
import { createShell } from '../../../src/server.ts';
import { type Ctx, notesOf, openCtx } from '../../../src/jobs/ctx.ts';
import { type Manifest, installProviders, providersStatus, verifyProviders } from '../../../src/jobs/providers.ts';
import { cleanJob, readSourcesState, runSources, sandboxSupport, sourcePlan, writeSourcesState } from '../../../src/jobs/sources.ts';
import { normalizeJob } from '../../../src/jobs/provider-runner.ts';
import { guardedFetch } from '../../../src/jobs/net/netguard.ts';
import { addEvent, upsertRole } from '../../../src/jobs/db.ts';
import { showRequest } from '../../../src/agent-client.ts';
import { link } from '../../../src/jobs/link.ts';
import { readForm } from '../../../src/jobs/read-form.ts';
import { type Guarded, findBrowser, launchGuarded } from '../../../src/jobs/browser.ts';
import { currentAnswers } from '../../../src/jobs/kb/ops.ts';
import { norm } from '../../../src/jobs/fields.ts';
import { PLAN_ACTIONS } from '../../../src/jobs/plan.ts';
import type { Claim } from '../../../src/jobs/kb/cite.ts';
import { serve, type Served } from '../net-helpers.ts';
import { html } from '../../../web/jobs/lib.js';
import { Banners } from '../../../web/jobs/screens/banners.js';
import { ApplyPanel } from '../../../web/jobs/screens/apply.js';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
const CLI = join(REPO, 'src', 'cli.ts');
const PEOPLE = join(REPO, 'test', 'fixtures', 'jobs', 'people');
const TREE = join(REPO, 'test', 'fixtures', 'jobs', 'e2e', 'providers');
const HOSTS = ['raw.example.test', 'jobs.example.test', 'apply.example.test', 'feeds.example.test'];
/** The provider sandbox needs Node 25+ (E1); on 22/24 sourcing refuses and the journey stands in for the provider. */
const SANDBOX = sandboxSupport();
const net = { testHosts: Object.fromEntries(HOSTS.map((h) => [h, '127.0.0.1'])) };

// ---- the person's spec ----

/** A posting in a company's feed, and what the rules must do with it (`keep`, or the rule that drops it). */
export type FeedJob = {
  slug: string; title: string; location: string; description?: string; page?: string;
  salary?: { min: number; max: number; currency: string; period: string }; days?: number; expect: string;
};
export type Feed = { company: string; slug: string; jobs: FeedJob[] };
export type FormQ = { id: string; label: string; kind: 'text' | 'textarea' | 'radio' | 'select' | 'file' | 'password' | 'captcha'; required?: boolean; options?: string[]; max?: number; live?: boolean };
export type Answer = { answer: string | null; claims: Claim[]; reason?: string };

export type Spec = {
  person: 'berlin-analyst' | 'us-nurse';
  preset: string;
  /** Interview answers that differ from the fixture person's notes (top-level search.md keys). */
  search: Record<string, unknown>;
  memory: { kind: string; key?: string; text: string; quote: string; title_words?: string[] }[];
  feeds: Feed[];
  /** Scripted judge: no model. */
  judge: (c: { title: string; company: string; description: string }) => { eligible: 'yes' | 'no'; score: number; evidence: string };
  posting: { slug: string; company: string; title: string; location: string; description: string; salary: Record<string, unknown> };
  forms: { pasted: FormQ[]; second: FormQ[] };
  /** Fixture "model output" for a field Claude drafts (mem: memory id by key). */
  draft: (label: string, mem: (key: string) => string) => Answer | undefined;
  /** The question whose draft fails the citation check, and the option the user picks on the page. */
  citation: { label: string; term: string; option: string };
  /** The question met only on the live form, and how Claude hands it to the user. */
  needsYou: { label: string; answer: string; path: 'learn' | 'request' };
  variant: Record<string, unknown>;
  pref: { sets: [string, string][]; because: string; restores: string[] };
  notInterested: { title: string; reason: string; words: string[]; later: { feed: string; job: FeedJob } };
  broken: { from: string; to: string; path: string; still: RegExp };
};

// ---- small helpers ----

type Run = { code: number | null; out: string; err: string };
/** `crewdeck …` as a child process with the temp home; asynchronous, since the server answers from this process. */
function crewdeck(args: string[], input = ''): Promise<Run> {
  if (!HOME.startsWith(TMP)) throw new Error('journeys must use a temp CREWDECK_HOME');
  return new Promise((ok) => {
    // From the jobs workspace once it exists, like Claude's session (its folder decides the lane).
    let cwd: string | undefined;
    try { const ws = loadConfig().jobs.workspace; if (existsSync(ws)) cwd = ws; } catch {}
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CREWDECK_HOME: HOME } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => ok({ code, out, err }));
    p.stdin.end(input);
  });
}
const jobs = (...args: string[]) => crewdeck(['jobs', ...args]);
/** `request show` as Claude's session runs it: from the jobs workspace (the folder decides the lane, review W5). */
async function showAsClaude(id: string) {
  const prev = process.cwd();
  process.chdir(loadConfig().jobs.workspace);
  try { return await showRequest(id); } finally { process.chdir(prev); }
}
function ok(r: Run, what: string) { assert.equal(r.code, 0, `${what}: exit ${r.code}\n${r.err}${r.out}`); return r.out; }
const okJson = (r: Run, what: string) => JSON.parse(ok(r, what));
let nfile = 0;
/** A file with the user's words, Claude's output or a page's fields (never on the command line, design D11). */
function put(name: string, text: string) { const p = join(FILES, `${++nfile}-${name}`); writeFileSync(p, text); return p; }

const fixtureNote = (person: string, rel: string) => parse(readFileSync(join(PEOPLE, person, rel), 'utf8').split(/^---$/m)[1]);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const dayIn = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ---- the fixture site: feeds, posting pages, forms, the provider files ----

function postingPage(p: { title: string; company: string; location: string; description: string; salary?: unknown; at: string }) {
  const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: p.title, hiringOrganization: { '@type': 'Organization', name: p.company },
    jobLocation: { '@type': 'Place', address: p.location }, description: `<p>${p.description}</p>`, datePosted: p.at, ...(p.salary ? { baseSalary: p.salary } : {}) };
  return `<!doctype html><meta charset="utf-8"><title>${esc(p.title)}</title><script type="application/ld+json">${JSON.stringify(ld)}</script><h1>${esc(p.title)}</h1><p>${esc(p.description)}</p>`;
}

/** An application form; `live` adds what only the live form has (a new question, a password field, a CAPTCHA). */
function formPage(slug: string, qs: FormQ[], live: boolean) {
  const star = (q: FormQ) => (q.required ? ' <span class="req">*</span>' : '');
  const req = (q: FormQ) => (q.required ? ' required' : '');
  const field = (q: FormQ) => {
    switch (q.kind) {
      case 'textarea': return `<div class="f"><label for="${q.id}">${esc(q.label)}${star(q)}</label><textarea id="${q.id}" name="${q.id}"${q.max ? ` maxlength="${q.max}"` : ''}${req(q)}></textarea></div>`;
      case 'radio': return `<fieldset><legend>${esc(q.label)}${star(q)}</legend>${q.options!.map((o) => `<label><input type="radio" name="${q.id}" value="${esc(o)}"${req(q)}> ${esc(o)}</label>`).join('')}</fieldset>`;
      case 'select': return `<div class="f"><label for="${q.id}">${esc(q.label)}${star(q)}</label><select id="${q.id}" name="${q.id}"${req(q)}><option value="">Select...</option>${q.options!.map((o) => `<option>${esc(o)}</option>`).join('')}</select></div>`;
      case 'file': return `<div class="f"><label for="${q.id}">${esc(q.label)}${star(q)}</label><input type="file" id="${q.id}" name="${q.id}"></div>`;
      case 'password': return `<div class="f"><label for="${q.id}">${esc(q.label)}</label><input type="password" id="${q.id}" name="${q.id}" autocomplete="new-password"></div>`;
      case 'captcha': return `<div class="g-recaptcha"><input type="checkbox" id="${q.id}" name="${q.id}"><label for="${q.id}">${esc(q.label)}</label></div>`;
      default: return `<div class="f"><label for="${q.id}">${esc(q.label)}${star(q)}</label><input type="text" id="${q.id}" name="${q.id}"${req(q)}></div>`;
    }
  };
  return `<!doctype html><meta charset="utf-8"><title>Apply</title>
<form method="post" action="/apply/${slug}/submit">
${qs.filter((q) => live || !q.live).map(field).join('\n')}
<button type="submit" id="submit">Submit application</button>
</form>
<script>
window.__submits = 0; window.__submitClicks = 0;
document.querySelector('form').addEventListener('submit', (e) => { window.__submits++; e.preventDefault(); });
document.getElementById('submit').addEventListener('click', () => { window.__submitClicks++; });
</script>`;
}

const LICENSE = 'MIT License\n\nCopyright (c) 2026 Example Maintainers\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this fixture.\n';
const PROVIDER_FILES = ['providers/_http.mjs', 'providers/careers-page.mjs'];
/** The fixture tree's manifest: the pinned career-ops manifest's shape. */
export function e2eManifest(): Manifest {
  return {
    repo: 'example/e2e-providers', commit: 'e'.repeat(40),
    license: { spdx: 'MIT', copyright: 'Copyright (c) 2026 Example Maintainers', text: LICENSE, file: 'LICENSE', sha256: sha(LICENSE) },
    providers: ['careers-page'], detectors: ['careers-page'],
    files: Object.fromEntries(PROVIDER_FILES.map((p) => [p, sha(readFileSync(join(TREE, p)))])),
    optional_imports: {}, excluded: {},
  };
}

// ---- the journey ----

/** Reading forms, the resume and the driver need a Chromium-based browser; without one the journey is skipped, saying why. */
const noBrowser = findBrowser('auto') ? false : 'no Chromium-based browser installed (Chrome, Chromium, Brave or Edge): journey skipped';
/** One step of the journey: the steps share one world and run in order. */
const step = (name: string, fn: (t: any) => unknown) => test(name, { skip: noBrowser, timeout: 120_000 }, fn);

export function runJourney(spec: Spec) {
  const manifest = e2eManifest();
  const fixture = { profile: fixtureNote(spec.person, 'me/profile.md'), career: fixtureNote(spec.person, 'me/career.md'), search: fixtureNote(spec.person, 'jobs/search.md') };
  const search = { ...fixture.search, ...spec.search };
  delete (search as any).tags;
  const tz: string = (search as any).schedule.timezone;
  const daily: number = (search as any).schedule.daily_picks;
  const log: Record<string, unknown> = { person: spec.person };

  let site: Served;
  const live = { on: false, extra: false };
  let submits = 0;
  let token = '';
  let port = 0;
  let server: ReturnType<typeof createShell>;
  let q: Requests;
  let ctx: Ctx;
  let guarded: Guarded | null = null;
  let form: Page | null = null;
  const W = {} as { a: string; b: string; picks: string[]; link: number; postingUrl: string; applyUrl: string; remembered: string };

  const feedJobs = () => spec.feeds.flatMap((f) => [...f.jobs, ...(live.extra && spec.notInterested.later.feed === f.slug ? [spec.notInterested.later.job] : [])].map((j) => ({ ...j, company: f.company })));
  const jobUrl = (slug: string) => `${site.base('jobs.example.test')}/postings/${slug}`;
  const ago = (days = 1) => new Date(Date.now() - days * 86_400_000).toISOString();

  after(async () => {
    await guarded?.close();
    try { ctx?.db.close(); } catch {}
    if (server) await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
    await site?.close();
  });

  // ---- the page and the agent, over real HTTP ----
  type Res = { status: number; headers: Record<string, any>; body: string; json: any };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> => new Promise((done, bad) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(t); } catch {}
        done({ status: res.statusCode!, headers: res.headers, body: t, json });
      });
    });
    r.on('error', bad);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const pageHeaders = () => ({ origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  const agentHeaders = () => ({ 'x-crewdeck-token': token, 'content-type': 'application/json' });
  /** A click on the Jobs page. */
  const click = (action: string, body: unknown = {}) => call('POST', `/api/jobs/action/${action}`, pageHeaders(), body);
  const read = async (path: string) => {
    const r = await call('GET', `/api/jobs/${path}`, { 'sec-fetch-site': 'same-origin' });
    assert.equal(r.status, 200, `${path}: ${r.body}`);
    return r.json;
  };
  /** The bridge mod's claim from a session in the jobs workspace: the token, and a proof that this is the real server. */
  const claim = async () => {
    const nonce = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`.replace(/[^A-Za-z0-9_-]/g, '');
    const r = await call('POST', '/api/claim', agentHeaders(), { cwd: loadConfig().jobs.workspace, by: `session@${spec.person}`, nonce });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.proof, sha(`crewdeck-proof:${token}:${nonce}:${port}`), 'the server proves it holds the token (and its port)');
    assert.equal(r.json.lane, 'jobs');
    assert.equal(r.json.hint, 'Use the jobs-workspace skill.');
    return r.json as { requests: { id: number; kind: string; ref: string | null; keys: string[] }[]; cli: string };
  };
  const progress = (id: number, line: string) => crewdeck(['progress', String(id), '--text-file', put('progress.txt', line)]).then((r) => ok(r, 'progress'));
  const close = (id: number, result: string, verb: 'done' | 'fail' = 'done') => crewdeck(['request', verb, String(id), '--result-file', put('result.txt', result)]).then((r) => ok(r, `request ${verb}`));
  const role = (id: string) => ctx.db.prepare('select r.*, c.name company, c.cooldown_until from roles r join companies c on c.id=r.company_id where r.id=?').get(id) as any;
  const byTitle = (title: string, company?: string) => ctx.db.prepare(`select r.*, c.name company from roles r join companies c on c.id=r.company_id where r.title=?${company ? ' and c.name=?' : ''}`).get(...(company ? [title, company] : [title])) as any;
  const field = (roleId: string, label: string) => {
    const f = currentAnswers(ctx.db, roleId).find((a) => norm(a.label) === norm(label));
    assert.ok(f, `${label} is on ${roleId}'s form`);
    return f!;
  };
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** Refresh sources on the page, and wait for the scheduler's run to finish. */
  const refreshSources = async () => {
    const before = (await read('state')).sources.last?.finished ?? '';
    const r = await click('refreshSources');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.started, true);
    return waitFor('the sourcing run', async () => {
      const s = (await read('state')).sources;
      return !s.running && s.last?.finished && s.last.finished !== before ? s : null;
    });
  };

  // ---- the test-only form driver: reads the live form, applies exactly the plan, never presses a button ----
  type LiveField = { label: string; type: string; options?: string[]; required: boolean; sel: string; name: string };
  const openForm = async (url: string) => {
    guarded ??= await launchGuarded({ net });
    if (!form) { form = await guarded.context.newPage(); await form.goto(url, { waitUntil: 'domcontentloaded' }); }
    return form;
  };
  const readLive = (page: Page): Promise<LiveField[]> => page.evaluate(() => {
    const out: LiveField[] = [];
    const seen = new Set<string>();
    const clean = (s: string | null | undefined) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    for (const el of document.querySelectorAll('input, select, textarea, button')) {
      const e = el as HTMLInputElement;
      const type = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'BUTTON' ? (e.type || 'submit') : (e.getAttribute('type') || 'text');
      if (type === 'hidden') continue;
      if (type === 'radio') {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        const fs = e.closest('fieldset')!;
        out.push({ label: clean(fs.querySelector('legend')?.textContent), type: 'radio', options: [...fs.querySelectorAll('label')].map((l) => clean(l.textContent)), required: e.required, sel: `input[type=radio][name="${e.name}"]`, name: e.name });
        continue;
      }
      const label = el.tagName === 'BUTTON' ? clean(el.textContent) : clean(e.labels?.[0]?.textContent);
      const options = el.tagName === 'SELECT' ? [...(el as HTMLSelectElement).options].filter((o) => o.value !== '').map((o) => o.text.trim()) : undefined;
      out.push({ label, type, ...(options ? { options } : {}), required: !!e.required, sel: `#${el.id}`, name: e.name || el.id });
    }
    return out;
  });
  /** What each field holds now: text, the chosen option, checked or not, attached files. */
  const values = (page: Page, fields: LiveField[]) => page.evaluate((fs) => Object.fromEntries(fs.map((f) => {
    if (f.type === 'radio') return [f.label, (document.querySelector(`${f.sel}:checked`) as HTMLInputElement | null)?.value ?? ''];
    const el = document.querySelector(f.sel) as any;
    if (!el) return [f.label, null];
    if (f.type === 'checkbox') return [f.label, el.checked ? 'checked' : ''];
    if (f.type === 'file') return [f.label, el.files.length ? 'attached' : ''];
    if (f.type === 'select') return [f.label, el.value === '' ? '' : el.options[el.selectedIndex].text.trim()];
    if (el.tagName === 'BUTTON') return [f.label, ''];
    return [f.label, el.value];
  })), fields);
  /** Fill exactly the plan's fill/select/choose items, each by the selector recorded when the field was read. */
  async function applyPlan(page: Page, fields: LiveField[], plan: any) {
    const by = new Map(fields.map((f) => [norm(f.label), f]));
    let n = 0;
    for (const it of plan.items) {
      if (!['fill', 'select', 'choose'].includes(it.action)) continue;
      const f = by.get(norm(it.label));
      assert.ok(f, `the plan's "${it.label}" is a field on the page`);
      assert.ok(!['password', 'file', 'submit', 'button', 'checkbox'].includes(f!.type), `never ${f!.type}: ${it.label}`);
      if (it.action === 'fill') await page.locator(f!.sel).fill(it.value);
      else if (it.action === 'select') await page.locator(f!.sel).selectOption({ label: it.value });
      else await page.locator(`${f!.sel}[value="${it.value.replace(/"/g, '\\"')}"]`).check();
      n++;
    }
    const now = await values(page, fields);
    const planned = new Map(plan.items.filter((it: any) => ['fill', 'select', 'choose'].includes(it.action)).map((it: any) => [norm(it.label), it.value]));
    for (const f of fields) {
      const want = planned.get(norm(f.label));
      if (want !== undefined) assert.equal(now[f.label], want, `planned field set: ${f.label}`);
      else assert.equal(now[f.label], '', `not planned, left alone: ${f.label} (${f.type})`);
    }
    const counts = await page.evaluate(() => ({ submits: (window as any).__submits, clicks: (window as any).__submitClicks }));
    assert.deepEqual(counts, { submits: 0, clicks: 0 }, 'the submit button was never clicked and the form never submitted');
    assert.equal(submits, 0, 'the site never received the application');
    return n;
  }

  // The fixture site starts first: sources.md names its port.
  before(async () => {
    site = await serve((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && /^\/apply\/[\w-]+\/submit$/.test(p)) { submits++; res.writeHead(200).end('thanks'); return; }
      if ((m = /^\/feeds\/([\w-]+)\.json$/.exec(p))) {
        const f = spec.feeds.find((x) => x.slug === m![1]);
        if (!f) { res.writeHead(404).end(); return; }
        const list = [...f.jobs, ...(live.extra && spec.notInterested.later.feed === f.slug ? [spec.notInterested.later.job] : [])];
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jobs: list.map((j) => ({
          title: j.title, url: jobUrl(j.slug), company: f.company, location: j.location, description: j.description ?? '', posted: ago(j.days), ...(j.salary ? { salary: j.salary } : {}),
        })) }));
        return;
      }
      if ((m = /^\/postings\/([\w-]+)$/.exec(p))) {
        if (m[1] === spec.posting.slug) {
          const x = spec.posting;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(postingPage({ ...x, at: ago(1) }));
          return;
        }
        const j = feedJobs().find((x) => x.slug === m![1]);
        if (!j) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(postingPage({ title: j.title, company: j.company, location: j.location, description: j.page ?? j.description ?? '', at: ago(j.days) }));
        return;
      }
      if ((m = /^\/apply\/(pasted|second)$/.exec(p))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(formPage(m[1], m[1] === 'pasted' ? spec.forms.pasted : spec.forms.second, live.on));
        return;
      }
      const raw = `/${manifest.repo}/${manifest.commit}/`;
      if (p.startsWith(raw) && PROVIDER_FILES.includes(p.slice(raw.length))) { res.writeHead(200).end(readFileSync(join(TREE, p.slice(raw.length)))); return; }
      res.writeHead(404).end();
    });
  });

  // ---- 1. Setup (§2.2) ----
  step('setup: crewdeck init, jobs init with a preset, the interview written through validated commands, jobs check clean', async () => {
    cpSync(join(REPO, 'vault-template'), VAULT, { recursive: true });
    writeFileSync(CONFIG_PATH, `vault: ${VAULT}\n`, { mode: 0o600 });
    token = ensureToken();
    const init = ok(await jobs('init', '--preset', spec.preset, '--no-providers'), 'jobs init');
    assert.match(init, /✓ Jobs is on/);
    assert.match(init, new RegExp(`jobs/search\\.md.*${spec.preset}|${spec.preset}`));
    assert.match(readFileSync(join(VAULT, 'jobs', 'search.md'), 'utf8'), new RegExp(`created from the ${spec.preset} preset`));

    // The interview: every write through `me set` / `pref set` (validated, typed by the schema); lists and maps as YAML flow.
    for (const k of ['identity', 'standard_answers', 'education']) ok(await jobs('me', 'set', k, '--value-file', put(`${k}.yaml`, JSON.stringify(fixture.profile[k]))), `me set ${k}`);
    for (const k of ['resume', 'sections', 'facts', 'skills']) ok(await jobs('me', 'set', k, '--value-file', put(`${k}.yaml`, JSON.stringify(fixture.career[k]))), `me set ${k}`);
    const because = put('because.txt', 'From the setup interview.');
    for (const [k, v] of Object.entries(search)) {
      const value = typeof v === 'string' ? v : JSON.stringify(v);
      ok(await jobs('pref', 'set', k, '--value-file', put(`${k}.yaml`, value), '--because-file', because), `pref set ${k}`);
    }
    for (const m of spec.memory) {
      const args = ['remember', '--kind', m.kind, '--text-file', put('text.txt', m.text), '--quote-file', put('quote.txt', m.quote)];
      if (m.key) args.push('--key', m.key);
      if (m.title_words) args.push('--title-words-file', put('words.txt', m.title_words.join('\n')));
      assert.match(ok(await jobs(...args), 'remember'), /^remembered m-\d+/);
    }
    // jobs/sources.md has no command: the setup skill edits it (P4). Companies by their careers page.
    const watch = spec.feeds.map((f) => `  - { name: ${JSON.stringify(f.company)}, careers_url: "https://careers.example.test/${f.slug}", feed: "http://feeds.example.test:${site.port}/feeds/${f.slug}.json" }`).join('\n');
    writeFileSync(join(VAULT, 'jobs', 'sources.md'), `---\ntags: jobs\nboards: []\nwatchlist:\n${watch}\n---\n# Job sources\n`);

    const check = await jobs('check');
    assert.equal(check.code, 0, check.out + check.err);
    assert.match(check.out, /\n0 errors, \d+ warnings?\n?$/);
    const rules = ok(await jobs('rules'), 'rules');
    assert.match(rules, /title_gate/);
    const notes = notesOf(openCtxOnce());
    assert.equal(notes.profile.data.identity.email, fixture.profile.identity.email);
    assert.equal(notes.career.data.facts.length, fixture.career.facts.length);
    assert.equal(notes.search.data.schedule.daily_picks, daily);
    const changes = readFileSync(join(VAULT, 'jobs', 'search.md'), 'utf8').split('\n').filter((l) => l.includes('"From the setup interview."'));
    assert.ok(changes.length >= 5, 'each interview answer is a dated Changes line in the user\'s words');
    log.setup = { notes: 'clean', warnings: check.out.split('\n').filter((l) => /warning /.test(l)).map((l) => l.trim()), search_changes: changes.length, memory: notes.memory.data.items.length, facts: notes.career.data.facts.length };
  });

  /** The tracker for in-process steps (the same database the CLI and the server use). */
  function openCtxOnce() { ctx ??= openCtx(loadConfig()); return ctx; }

  /**
   * Node < 25 only: what the careers-page provider does (read each watchlist feed), in this process through netguard,
   * then the same checks the parent applies to the sandbox's jobs. Node 25+ runs the real sandboxed child instead.
   */
  async function standInProvider(c: Ctx) {
    const plan = sourcePlan(notesOf(c), manifest);
    const res = { ran: true as const, fetched: 0, new: 0, refused: 0, skipped: plan.skipped, entries: [] as any[] };
    for (const e of plan.entries) {
      const r = { name: e.name, provider: 'careers-page', ok: true, jobs: 0, new: 0, refused: 0 };
      const data = JSON.parse((await guardedFetch(String(e.entry.feed), net)).body);
      for (const j of data.jobs) {
        const cj = cleanJob(normalizeJob({ ...j, postedAt: Date.parse(j.posted) }, 'careers-page'), { features: c.features, at: c.clock(), fallbackCompany: e.name });
        if (!cj.ok) { r.refused++; res.refused++; continue; }
        const { id, isNew } = upsertRole(c.db, { ...cj.role, source: 'ats' });
        r.jobs++; res.fetched++;
        if (isNew) { r.new++; res.new++; addEvent(c.db, id, 'added', `from ${e.name} (careers-page)`, c.clock().toISOString()); }
      }
      res.entries.push(r);
    }
    return res;
  }

  // ---- 2. The server, before any Claude session (§2.9) ----
  step('the Jobs page with no Claude session on the lane: the banner, requests wait', async () => {
    const c = loadConfig();
    assert.equal(c.jobs.enabled, true);
    q = new Requests(join(HOME, 'requests.json'));
    server = createShell(c, q, {
      token,
      jobs: {
        configPath: CONFIG_PATH, pollMs: 100, confirm: async () => 'yes' as const,
        // Refresh sources runs the real runSources (sandboxed child, checks, prefilter) with the fixture manifest.
        sources: {
          ready: () => providersStatus(c, manifest).ready, firstDelayMs: 3_600_000,
          run: async () => {
            const ctx = openCtxOnce();
            const stood = SANDBOX.ok ? null : await standInProvider(ctx);
            const st = await runSources(ctx, { manifest, sinceDays: 14, net, trigger: 'refresh', entryTimeoutMs: 20_000 });
            if (stood) {
              // This Node refused to run the sandbox, and said so; the stand-in's roles went through the same rules.
              assert.match((st.providers as any).why, /need Node 25 or newer/);
              writeSourcesState(ctx.home, { ...readSourcesState(ctx.home)!, providers: stood, new: st.new + stood.new });
            }
            return { code: st.ok ? 0 : 1, error: st.error };
          },
        },
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as any).port;
    appendFileSync(CONFIG_PATH, `port: ${port}\n`); // where the CLI finds this Crewdeck (like `crewdeck up`'s port)
    const state = await read('state');
    assert.equal(state.setup.needed, false, 'set up: no setup card');
    assert.equal(state.agent.connected, false);
    assert.match(text(render(html`<${Banners} state=${state} />`)), /No Claude session is working Jobs\. Open one in Claude desktop: Open in Claude starts a Code session in your jobs folder/);
    assert.equal(state.agent.workspace, c.jobs.workspace);
    const r = await click('refreshSources');
    assert.equal(r.status, 400, 'nothing to fetch before the providers are installed');
  });

  // ---- 3. Sources (§2.4) ----
  step('sources: providers installed and verified from a local server; Refresh sources runs the sandbox; the rules drop what this person can\'t take', async () => {
    const c = loadConfig();
    const st = await installProviders(c, { base: site.base('raw.example.test'), net, manifest });
    assert.equal(st.ready, true, st.message);
    assert.match(st.message, /1 from example\/e2e-providers@eeeeeee \(MIT\), 2 files verified/);
    assert.equal(verifyProviders(c, manifest).ok, true);
    assert.equal(statSync(st.dir!).mode & 0o777, 0o500, 'sealed read-only');

    const s = await refreshSources();
    assert.equal(s.last.ok, true, JSON.stringify(s.last));
    const all = feedJobs();
    assert.equal(s.last.entries, spec.feeds.length);
    assert.equal(s.last.failed, 0);
    // Every posting got the verdict the person's notes call for.
    const got: Record<string, string> = {};
    for (const j of all) {
      const r = ctx.db.prepare('select status, status_reason, eligibility from roles where url=?').get(jobUrl(j.slug)) as any;
      assert.ok(r, `${j.title} stored`);
      got[`${j.company} / ${j.title}`] = r.status === 'new' ? 'keep' : r.status === 'prefiltered_out' ? String(r.status_reason).split(':')[0] : r.status;
    }
    const want = Object.fromEntries(all.map((j) => [`${j.company} / ${j.title}`, j.expect]));
    assert.deepEqual(got, want);
    const state = JSON.parse(readFileSync(join(c.jobs.home, 'state', 'sources.json'), 'utf8'));
    const drops: Record<string, number> = {};
    for (const v of Object.values(got)) if (v !== 'keep') drops[v] = (drops[v] ?? 0) + 1;
    log.sources = { fetched: state.providers.fetched, new: state.new, kept: Object.values(got).filter((v) => v === 'keep').length, dropped: drops, descriptions_read: state.details.found };
    assert.equal(s.waiting, Object.values(got).filter((v) => v === 'keep').length, 'the page shows what waits for judging');
  });

  // ---- 4. Find (§2.4) ----
  step('find: Find N jobs on the page → claim → budgeted candidates, a scripted judge, pick one per company, the daily count, the local day', async () => {
    const find = await click('find', { count: daily });
    assert.equal(find.status, 200, find.body);
    const cl = await claim();
    assert.deepEqual(cl.requests, [{ id: find.json.request, kind: 'find', ref: null, keys: ['count'] }]);
    const shown = okJson(await jobs('request', 'show', String(find.json.request)), 'request show');
    assert.equal(shown.payload.count, daily);
    assert.equal(shown.context.daily_picks, daily);
    const batches: number[] = [];
    let out = okJson(await jobs('candidates', '--budget', '40', '--batch', '3', '--need', String(shown.payload.count), '--start'), 'candidates');
    while (out.batch.length) {
      await progress(find.json.request, `Judging ${out.batch.length} more (${out.run.judged} of ${out.run.budget} judged so far)`);
      batches.push(out.batch.length);
      assert.ok(out.batch.length <= 3);
      const verdicts = out.batch.map((cand: any) => ({ role: cand.id, ...spec.judge(cand) }));
      const stored = okJson(await jobs('judge', '--results-file', put('verdicts.json', JSON.stringify(verdicts))), 'judge');
      assert.ok(stored.every((x: any) => x.stored));
      out = okJson(await jobs('candidates', '--budget', '40', '--batch', '3', '--need', String(daily)), 'candidates');
    }
    assert.equal(out.run.done, true);
    assert.equal(out.run.why, 'enough', JSON.stringify(out.run));
    assert.ok(out.run.passed >= daily);
    const picked = ok(await jobs('pick'), 'pick').trim().split('\n').map((l) => l.split(/\s+/)[0]);
    assert.equal(picked.length, daily, 'the daily count');
    const rows = picked.map(role);
    assert.equal(new Set(rows.map((r) => r.company_id)).size, picked.length, 'one per company');
    for (const r of rows) {
      assert.equal(r.status, 'picked');
      assert.equal(r.picked_on, dayIn(tz), `picked on the person's own day (${tz})`);
      assert.equal(r.eligibility, 'yes');
    }
    assert.deepEqual(ok(await jobs('pick'), 'pick again').trim().split('\n').map((l) => l.split(/\s+/)[0]), picked, 'idempotent per day');
    await close(find.json.request, `${picked.length} picked: ${rows.map((r) => r.company).join(', ')}`);
    const st = await read('state');
    assert.equal(st.sources.since, q.get(find.json.request)!.created, '"new roles since" counts from this Find');
    assert.equal(st.sources.new_since, 0);
    assert.equal(st.agent.recent[0].result, `${picked.length} picked: ${rows.map((r) => r.company).join(', ')}`);
    W.picks = picked;
    log.find = { judged: out.run.judged, batches, unjudged_left: out.pool.unjudged, passed_companies: out.run.passed, picked: rows.map((r) => `${r.company} — ${r.title}`), bench: Number((ctx.db.prepare(`select count(*) n from roles where status='bench'`).get() as any).n) };
  });

  // ---- 5. Paste a link (§2.3) ----
  step('paste a link: page → jobs lane → the bridge\'s claim → request show → link --request through netguard → picked', async () => {
    W.postingUrl = jobUrl(spec.posting.slug);
    const add = await click('addLink', { url: W.postingUrl });
    assert.equal(add.status, 200, add.body);
    W.link = add.json.request;
    assert.equal((await read('state')).agent.waiting[0].kind, 'link');
    const cl = await claim();
    assert.deepEqual(cl.requests, [{ id: W.link, kind: 'link', ref: null, keys: ['url'] }]);
    assert.ok(!JSON.stringify(cl).includes(spec.posting.slug), 'the claim carries payload keys, never the link');
    assert.equal((await read('state')).agent.connected, true, 'Claude connected');
    const shown = okJson(await jobs('request', 'show', String(W.link)), 'request show');
    assert.equal(shown.kind, 'link');
    assert.equal(shown.payload.url, W.postingUrl);
    await progress(W.link, 'Reading the posting');
    // The CLI can't be pointed at a fixture host: netguard's test allowance is a library option only.
    const refused = await jobs('link', '--request', String(W.link));
    assert.equal(refused.code, 1);
    assert.match(refused.err, /could not be read/);
    // The same command body in-process, with the allowance: the payload from the running server by id, with the token.
    const r = await showAsClaude(String(W.link));
    assert.equal(r.status, 'picked');
    const res = await link(ctx, { url: String(r.payload.url), force: r.payload.force === true }, { net });
    assert.equal(res.picked, true, JSON.stringify(res));
    assert.deepEqual(res.warnings, []);
    assert.equal(res.company, spec.posting.company);
    assert.equal(res.title, spec.posting.title);
    W.a = res.id;
    await close(W.link, `Added ${res.company} — ${res.title} and picked it for today.`);
    const a = role(W.a);
    assert.equal(a.status, 'picked');
    assert.equal(a.source, 'pasted');
    assert.equal(a.picked_on, dayIn(tz));
    assert.ok(a.pay_text, 'pay from JobPosting baseSalary');
    assert.equal(q.get(W.link)!.payload, undefined, 'the payload is cleared once the request closes');
    log.link = { role: `${res.company} — ${res.title}`, pay: a.pay_text, location: a.location };
  });

  // ---- 6. Prepare (§2.3 step 4) ----
  step('prepare: headless form read, draft with profile answers, a citation failure becomes a first-time question, answered on the page and remembered', async () => {
    W.applyUrl = `${site.base('apply.example.test')}/apply/pasted`;
    const read1 = await readForm(ctx, W.a, { url: W.applyUrl, net, browser: loadConfig().jobs.browser });
    assert.equal(read1.needs, undefined, JSON.stringify(read1));
    assert.equal(read1.stored, spec.forms.pasted.filter((x) => !x.live && x.kind !== 'file').length);

    const briefFile = join(FILES, 'brief-a.json');
    const said = ok(await jobs('draft', W.a, '--brief', briefFile), 'draft --brief');
    const brief = JSON.parse(readFileSync(briefFile, 'utf8'));
    assert.match(said, /answered from your profile and memory/);
    assert.match(brief.prompt, new RegExp(fixture.profile.identity.first_name));
    // Profile answers are approved with their profile: source; never first-time questions.
    for (const [label, key] of [['First name', 'first_name'], ['Last name', 'last_name'], ['Email', 'email']]) {
      const f = field(W.a, label);
      assert.equal(f.status, 'approved', label);
      assert.deepEqual(f.sources, [`profile:${key}`]);
    }
    // Claude's half: fixture model output for exactly the fields in the brief.
    const mem = (key: string) => notesOf(ctx).memory.data.items.find((m) => m.key === key && !m.superseded_by)!.id;
    const answers = brief.refs.map((ref: string) => {
      const f = currentAnswers(ctx.db, W.a).find((x) => x.ref === ref)!;
      const a = spec.draft(f.label, mem) ?? { answer: null, claims: [], reason: 'no fixture output' };
      return { field_ref: ref, label: f.label, canonical_key: f.canonical_key, ...a };
    });
    const applied = okJson(await jobs('draft', W.a, '--answers', put('answers-a.json', JSON.stringify({ answers }))), 'draft --answers');
    assert.equal(applied.first_time, 1, 'exactly the unsupported claim becomes a first-time question');
    const cited = field(W.a, spec.citation.label);
    assert.equal(cited.status, 'first_time');
    assert.match(cited.reason ?? '', new RegExp(`"${spec.citation.term}" isn't in the cited sources`));
    const today = await read(`today?role=${W.a}`);
    assert.equal(today.detail.approvable, false);
    assert.equal(today.detail.rows[0].label, spec.citation.label, 'first-time questions sit on top');
    assert.match(today.detail.rows.find((x: any) => x.label === 'Email').source, /your profile/);
    const early = await click('approve', { role: W.a });
    assert.equal(early.status, 400);
    assert.match(early.json.error, /first-time questions first/);

    // The user answers on the page: remembered in jobs/memory.md in their words, for every company (a choice).
    const ans = await click('answer', { role: W.a, field_id: cited.field_id, option: spec.citation.option });
    assert.equal(ans.status, 200, ans.body);
    const item = notesOf(ctx).memory.data.items.find((m) => m.key === cited.canonical_key && !m.superseded_by);
    assert.ok(item, 'remembered');
    assert.equal(item!.text, spec.citation.option);
    assert.equal(item!.scope, 'all');
    assert.match(readFileSync(join(VAULT, 'jobs', 'memory.md'), 'utf8'), new RegExp(`key: ${cited.canonical_key}`));
    W.remembered = item!.id;
    assert.equal((await read(`today?role=${W.a}`)).detail.approvable, true);
    log.prepare = { questions: read1.stored, brief: brief.res, for_claude: brief.refs.length, draft: applied };
  });

  step('prepare: the remembered answer fills the same question on a second role\'s form, with no question to the user', async () => {
    W.b = W.picks[0];
    const read2 = await readForm(ctx, W.b, { url: `${site.base('apply.example.test')}/apply/second`, net, browser: loadConfig().jobs.browser });
    assert.equal(read2.needs, undefined, JSON.stringify(read2));
    const briefFile = join(FILES, 'brief-b.json');
    ok(await jobs('draft', W.b, '--brief', briefFile), 'draft --brief (second role)');
    const brief = JSON.parse(readFileSync(briefFile, 'utf8'));
    const reused = field(W.b, spec.citation.label);
    assert.equal(reused.status, 'approved');
    assert.equal(reused.text, spec.citation.option);
    assert.deepEqual(reused.sources, [W.remembered], 'from the user\'s words, not drafted');
    assert.ok(!brief.refs.includes(reused.ref), 'Claude is not asked again');
    const mem = (key: string) => notesOf(ctx).memory.data.items.find((m) => m.key === key && !m.superseded_by)!.id;
    const answers = brief.refs.map((ref: string) => {
      const f = currentAnswers(ctx.db, W.b).find((x) => x.ref === ref)!;
      return { field_ref: ref, label: f.label, canonical_key: f.canonical_key, ...(spec.draft(f.label, mem) ?? { answer: null, claims: [] }) };
    });
    const applied = okJson(await jobs('draft', W.b, '--answers', put('answers-b.json', JSON.stringify({ answers }))), 'draft --answers (second role)');
    assert.equal(applied.first_time, 0);
    const view = (await read(`today?role=${W.b}`)).detail;
    assert.equal(view.approvable, true);
    assert.match(view.rows.find((x: any) => x.label === spec.citation.label).source, /^Sources: your words, /, 'the page says where the answer came from');
    log.second_role = { role: `${role(W.b).company} — ${role(W.b).title}`, reused: `${spec.citation.label} = ${reused.text} (${W.remembered})`, brief: brief.res, draft: applied };
  });

  step('prepare: the tailored resume PDF from fact ids (headless Chromium, JS and network off), served by the page', async () => {
    const r = okJson(await jobs('resume', W.a, '--variant-file', put('variant.json', JSON.stringify(spec.variant))), 'resume');
    assert.ok(existsSync(r.pdf));
    assert.equal(readFileSync(r.pdf).subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.pages >= 1 && r.pages <= fixture.career.resume.max_pages, `${r.pages} pages`);
    const got = await call('GET', `/api/jobs/resume/${W.a}`, { 'sec-fetch-site': 'same-origin' });
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/pdf');
    assert.equal((await read(`today?role=${W.a}`)).detail.resume.file, r.pdf.split('/').pop());
    log.resume = { pages: r.pages, facts: r.facts, file: r.pdf.split('/').pop() };
  });

  // ---- 7. Apply (§2.3a) ----
  step('apply: approve → claim → fill-plan → the driver fills exactly the plan → needs you → answered on the page → apply again → your turn → applied', async () => {
    const ap = await click('approve', { role: W.a });
    assert.equal(ap.status, 200, ap.body);
    assert.equal(ap.json.mode, 'fill');
    let id: number = ap.json.request;
    assert.equal((await read(`today?role=${W.a}`)).panel.state, 'waiting');
    let cl = await claim();
    assert.deepEqual(cl.requests, [{ id, kind: 'apply', ref: W.a, keys: ['role'] }]);
    const shown = okJson(await jobs('request', 'show', String(id)), 'request show');
    assert.equal(shown.context.role.apply.mode, 'fill');
    assert.equal(shown.context.role.apply_url, W.applyUrl, 'Claude opens the form address Prepare stored');
    await progress(id, 'Opened the application in a new tab');
    assert.equal((await read(`today?role=${W.a}`)).panel.state, 'filling');

    // The employer's live form has more than Prepare saw: a new required question, a password field and a CAPTCHA.
    live.on = true;
    const page = await openForm(shown.context.role.apply_url);
    let fields = await readLive(page);
    const plan1 = okJson(await jobs('fill-plan', '--request', String(id), '--fields-file', put('fields.json', JSON.stringify(fields.map(({ sel, name, ...f }) => f)))), 'fill-plan');
    assert.equal(plan1.mode, 'fill');
    assert.equal(plan1.role, W.a);
    for (const it of plan1.items) assert.ok((PLAN_ACTIONS as readonly string[]).includes(it.action), it.action);
    const item = (re: RegExp) => plan1.items.find((it: any) => re.test(it.label));
    assert.equal(item(/password/i).action, 'skip');
    assert.match(item(/password/i).reason, /only the user/);
    assert.equal(item(/robot/i).action, 'skip');
    assert.match(item(/robot/i).reason, /CAPTCHA/);
    assert.equal(item(/^Submit application$/).action, 'skip');
    assert.equal(item(/resume|cv/i).action, 'upload');
    for (const it of plan1.items.filter((x: any) => /salary|desired pay|gender/i.test(x.label))) {
      assert.equal(it.action, 'skip');
      assert.match(it.reason, /sensitive/);
    }
    const unseen = plan1.items.find((it: any) => it.label === spec.needsYou.label);
    assert.deepEqual([unseen.action, unseen.reason], ['skip', 'required, no answer yet']);
    const filled1 = await applyPlan(page, fields, plan1);
    await progress(id, `Page 1 of 1: filled ${filled1} fields; one new question needs you`);

    // Claude stops on that page and hands the question to the user.
    if (spec.needsYou.path === 'learn') {
      const opts = fields.find((f) => f.label === spec.needsYou.label)!.options ?? [];
      const learned = okJson(await jobs('learn', W.a, '--label-file', put('label.txt', spec.needsYou.label), '--options-file', put('options.json', JSON.stringify(opts)), '--required'), 'learn');
      assert.equal(learned.saved, 'Recorded as a first-time question.');
    }
    await close(id, `needs you: ${spec.needsYou.label}`);
    let today = await read(`today?role=${W.a}`);
    assert.equal(today.panel.state, 'needs_you');
    assert.equal(today.panel.question, spec.needsYou.label);
    assert.equal(today.queue.find((x: any) => x.id === W.a).chip.text, 'Needs you');
    const asking = text(render(html`<${ApplyPanel} d=${today.detail} panel=${today.panel} workspace="" />`));
    assert.match(asking, /Claude needs your answer/);
    assert.ok(asking.includes(spec.needsYou.label), 'the question is in the apply panel');

    // The user answers in Crewdeck; it is remembered and Apply is queued again.
    const body = spec.needsYou.path === 'learn'
      ? { role: W.a, field_id: field(W.a, spec.needsYou.label).field_id, option: spec.needsYou.answer }
      : { role: W.a, request: id, text: spec.needsYou.answer };
    const ans = await click('answer', body);
    assert.equal(ans.status, 200, ans.body);
    assert.ok(ans.json.reapplied, 'apply queued again');
    id = ans.json.reapplied;
    const asked = field(W.a, spec.needsYou.label);
    const kept = notesOf(ctx).memory.data.items.find((m) => m.key === asked.canonical_key && !m.superseded_by);
    assert.ok(kept && kept.text === spec.needsYou.answer && kept.quote.includes(spec.needsYou.answer), 'the answer is in jobs/memory.md, in the user\'s words');
    assert.equal(asked.status, 'approved');
    assert.equal(kept!.scope, 'all', 'a Yes/No about the user is reused on every company\'s form');
    assert.equal((await read(`today?role=${W.a}`)).panel.state, 'waiting');

    // Claude continues from where the form is.
    cl = await claim();
    assert.deepEqual(cl.requests.map((r) => [r.id, r.kind, r.ref]), [[id, 'apply', W.a]]);
    await progress(id, 'Back on the form: answering the new question');
    fields = await readLive(page);
    const plan2 = okJson(await jobs('fill-plan', '--request', String(id), '--fields-file', put('fields.json', JSON.stringify(fields.map(({ sel, name, ...f }) => f)))), 'fill-plan again');
    const now = plan2.items.find((it: any) => it.label === spec.needsYou.label);
    assert.deepEqual([now.action, now.value], ['choose', spec.needsYou.answer]);
    const filled2 = await applyPlan(page, fields, plan2);
    await progress(id, `Filled ${filled2} fields; stopped at Submit for your review`);
    await close(id, 'Stopped at the Submit button: review the form tab and submit it yourself.');

    today = await read(`today?role=${W.a}`);
    assert.equal(today.panel.state, 'your_turn');
    assert.deepEqual(today.panel.progress.map((l: any) => l.text), ['Back on the form: answering the new question', `Filled ${filled2} fields; stopped at Submit for your review`]);
    const panel = text(render(html`<${ApplyPanel} d=${today.detail} panel=${today.panel} workspace=${loadConfig().jobs.workspace} reveal=${false} />`));
    assert.match(panel, /What Claude did/);
    assert.ok(panel.includes(`Filled ${filled2} fields; stopped at Submit for your review`), 'progress lines in the apply panel');
    assert.ok(panel.includes('Back on the form: answering the new question'));
    assert.match(panel, /submit/i);

    // Something still open for the role (an "Ask Claude" on an answer) closes when the role is applied.
    const why = currentAnswers(ctx.db, W.a).find((a) => a.status === 'drafted')!;
    const improve = await click('improve', { role: W.a, field_id: why.field_id, instruction: 'a little shorter' });
    assert.equal(improve.status, 200, improve.body);
    const applied = await click('markApplied', { role: W.a });
    assert.equal(applied.status, 200, applied.body);
    const a = role(W.a);
    assert.equal(a.status, 'applied');
    const cooldownDays = (search as any).schedule.cooldown_days;
    const until = Date.parse(a.cooldown_until);
    assert.ok(Math.abs(until - (Date.now() + cooldownDays * 86_400_000)) < 3_600_000, `cooldown of ${cooldownDays} days`);
    const journal = join(VAULT, 'journal', `${dayIn(tz)}.md`);
    const line = `- Applied: ${spec.posting.company} — ${spec.posting.title}`;
    assert.ok(readFileSync(journal, 'utf8').split('\n').includes(line), 'the journal line in the vault');
    const closed = q.get(improve.json.request)!;
    assert.equal(closed.status, 'done');
    assert.equal(closed.result, 'Nothing to do: this role is already applied');
    assert.ok(!q.ofLane('jobs').some((r) => r.ref === W.a && (r.status === 'new' || r.status === 'picked')), 'no open request for the role');
    today = await read(`today?role=${W.a}`);
    assert.equal(today.panel.state, 'applied');
    const apps = await read('applications');
    const rec = apps.rows.find((r: any) => r.id === W.a);
    assert.equal(rec.status, 'Applied');
    log.application = { ...rec, cooldown_until: a.cooldown_until.slice(0, 10), journal: `journal/${dayIn(tz)}.md: ${line.slice(2)}`, filled: [filled1, filled2], submits: submits };
  });

  step('apply: pasting the same link again comes back with the applied and cooldown warnings', async () => {
    const add = await click('addLink', { url: W.postingUrl });
    assert.equal(add.status, 200, add.body);
    const cl = await claim();
    assert.deepEqual(cl.requests.map((r) => r.kind), ['link']);
    const r = await showAsClaude(String(add.json.request));
    const res = await link(ctx, { url: String(r.payload.url) }, { net });
    assert.equal(res.picked, false);
    assert.ok(res.warnings.some((w) => /already applied/.test(w)), res.warnings.join('; '));
    assert.ok(res.warnings.some((w) => /cooldown until/.test(w)), res.warnings.join('; '));
    await close(add.json.request, `Not picked (warning): ${res.warnings.join('; ')}`);
    assert.equal(role(W.a).status, 'applied');
  });

  step('paste a link: a company with a role in progress is a warning; the page\'s "Add it anyway" carries the override', async () => {
    const busy = role(W.b);
    const other = feedJobs().find((j) => j.company === busy.company && j.expect === 'keep' && jobUrl(j.slug) !== busy.url);
    assert.ok(other, `another posting at ${busy.company}`);
    const url = jobUrl(other!.slug);
    const first = await click('addLink', { url });
    await claim();
    const r1 = await showAsClaude(String(first.json.request));
    const res1 = await link(ctx, { url: String(r1.payload.url), force: r1.payload.force === true }, { net });
    assert.equal(res1.picked, false);
    assert.deepEqual(res1.warnings, [`${busy.company} already has "${busy.title}" in progress`]);
    await close(first.json.request, `Not picked (warning): ${res1.warnings[0]}`);
    assert.notEqual(role(res1.id).status, 'picked');
    // The user clicks "Add it anyway": the override comes from the page's request, never from Claude's command line.
    const again = await click('addLink', { url, force: true });
    await claim();
    const r2 = await showAsClaude(String(again.json.request));
    assert.equal(r2.payload.force, true);
    const res2 = await link(ctx, { url: String(r2.payload.url), force: r2.payload.force === true }, { net });
    assert.equal(res2.picked, true);
    assert.deepEqual(res2.warnings, []);
    assert.match(role(res2.id).status_reason, /chosen by the user despite: .*in progress/);
    await close(again.json.request, `Added ${res2.company} — ${res2.title} (your override).`);
    log.link_in_progress = { warning: res1.warnings[0], override: role(res2.id).status_reason };
  });

  // ---- 8. Preference change, Not interested (§2.5, §2.6) ----
  step('preference change: pref set with the user\'s words → Changes line → refilter brings back what the new preference allows', async () => {
    const because = put('because.txt', spec.pref.because);
    for (const [path, value] of spec.pref.sets) ok(await jobs('pref', 'set', path, value, '--because-file', because), `pref set ${path}`);
    const note = readFileSync(join(VAULT, 'jobs', 'search.md'), 'utf8');
    for (const [path] of spec.pref.sets) assert.ok(note.split('\n').some((l) => l.startsWith(`- ${dayIn(tz)}: ${path}: `) && l.endsWith(`"${spec.pref.because}"`)), `a Changes line for ${path}`);
    const r = await jobs('refilter', '--days', '14');
    const res = JSON.parse(ok(r, 'refilter').split('\n').filter((l) => !/back for judging/.test(l)).join('\n'));
    assert.deepEqual(res.roles.map((x: any) => x.title), spec.pref.restores);
    assert.match(r.out, new RegExp(`${spec.pref.restores.length} roles? (is|are) back for judging`));
    for (const x of res.roles) assert.equal(role(x.id).status, 'new');
    log.preference = { changed: spec.pref.sets.map(([p, v]) => `${p} = ${v}`), refilter: { checked: res.checked, restored: res.restored, roles: res.roles.map((x: any) => `${x.company} — ${x.title}`) } };
  });

  step('not interested: the reason remembered, title words excluded in search.md, the next fetch drops a new posting with them', async () => {
    const target = byTitle(spec.notInterested.title);
    // Something open for the role first (its form stored by hand, then "Ask Claude" on an answer).
    ok(await jobs('form', target.id, '--fields-file', put('questions.json', JSON.stringify([{ label: 'Why us?', kind: 'textarea', required: true }]))), 'form --fields-file');
    const asking = await click('improve', { role: target.id, field_id: field(target.id, 'Why us?').field_id, instruction: 'more concrete' });
    assert.equal(asking.status, 200, asking.body);
    const r = await click('notInterested', { role: target.id, reason: spec.notInterested.reason, titleWords: spec.notInterested.words });
    assert.equal(r.status, 200, r.body);
    assert.equal(role(target.id).status, 'skipped');
    assert.deepEqual([q.get(asking.json.request)!.status, q.get(asking.json.request)!.result], ['done', 'Nothing to do: this role is already skipped'], 'its requests close');
    const notes = notesOf(ctx);
    const avoid = notes.memory.data.items.find((m) => m.kind === 'avoid' && m.text === spec.notInterested.reason);
    assert.ok(avoid, 'an avoid item in the user\'s words');
    for (const w of spec.notInterested.words) assert.ok(notes.search.data.roles.exclude_title_words.includes(w), w);
    assert.ok(readFileSync(join(VAULT, 'jobs', 'search.md'), 'utf8').includes(`"${spec.notInterested.reason}"`), 'a Changes line with the reason');
    assert.ok(ok(await jobs('judge-brief'), 'judge-brief').includes(`"${spec.notInterested.reason}" (${avoid!.id}`), 'the judge must apply it');

    live.extra = true;
    const s = await refreshSources();
    assert.equal(s.last.ok, true);
    assert.equal(s.last.new, 1);
    const later = ctx.db.prepare('select status, status_reason from roles where url=?').get(jobUrl(spec.notInterested.later.job.slug)) as any;
    assert.equal(later.status, 'prefiltered_out');
    assert.match(later.status_reason, new RegExp(`^title_exclude: title has "${spec.notInterested.words[0]}"`, 'i'));
    log.not_interested = { skipped: `${target.company} — ${target.title}`, remembered: avoid!.id, words: spec.notInterested.words, later: `${spec.notInterested.later.job.title}: ${later.status_reason}` };
  });

  // ---- 9. Risky features (§2.8, §12) ----
  step('risky features: off until the user switches them on the page; the CLI refuses without a terminal', async () => {
    const li = 'https://www.linkedin.com/jobs/view/4000000001/';
    const refused = await click('addLink', { url: li });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /LinkedIn links are off/);
    const cli = await jobs('link', '--url-file', put('url.txt', li));
    assert.equal(cli.code, 1);
    assert.match(cli.err, /LinkedIn links are off/);
    const fieldsFile = put('fields.json', JSON.stringify([{ label: 'First name', type: 'text' }, { label: 'Submit application', type: 'submit' }]));
    const pageUrl = put('page-url.txt', li);
    const copy = okJson(await jobs('fill-plan', W.b, '--fields-file', fieldsFile, '--page-url-file', pageUrl), 'fill-plan on LinkedIn');
    assert.equal(copy.mode, 'copy');
    assert.match(copy.reason, /Easy Apply filling is off/);
    const tty = await jobs('features', 'linkedin_links', 'on');
    assert.equal(tty.code, 1);
    assert.match(tty.err, /Only you can change feature switches/);
    const agent = await call('POST', '/api/jobs/action/feature', agentHeaders(), { name: 'linkedin_links', value: true });
    assert.equal(agent.status, 403, 'an agent token is not the page');
    assert.doesNotMatch(readFileSync(CONFIG_PATH, 'utf8'), /linkedin_links: true/);

    // The user switches them on in Jobs → Settings.
    for (const [name, value] of [['linkedin_links', true], ['easy_apply', true], ['daily_quick_apply', 1]] as const) {
      const r = await click('feature', { name, value });
      assert.equal(r.status, 200, r.body);
    }
    assert.match(readFileSync(CONFIG_PATH, 'utf8'), /linkedin_links: true/);
    const settings = await read('settings');
    assert.equal(settings.features.find((f: any) => f.name === 'linkedin_links').on, true);
    const queued = await click('addLink', { url: li });
    assert.equal(queued.status, 200, queued.body);
    const fill = okJson(await jobs('fill-plan', W.b, '--fields-file', fieldsFile, '--page-url-file', pageUrl), 'fill-plan on LinkedIn, Easy Apply on');
    assert.equal(fill.mode, 'fill');
    assert.deepEqual(fill.quick_apply, { used: 1, cap: 1 });
    assert.deepEqual(fill.items.map((i: any) => i.action), ['fill', 'skip']);
    // And off again.
    for (const [name, value] of [['linkedin_links', false], ['easy_apply', false], ['daily_quick_apply', 0]] as const) assert.equal((await click('feature', { name, value })).status, 200);
    await close(queued.json.request, 'Not read: switched off again by the user.', 'fail');
    assert.equal((await click('addLink', { url: li })).status, 400);
    log.features = { linkedin_link: 'refused off, queued on', easy_apply: 'copy off, fill on (1 of 1)', cli_without_tty: 'refused' };
  });

  // ---- 10. A broken note (§2.9) ----
  step('a broken note: the field path and fix, the last valid version in use, cleared once fixed', async () => {
    const file = join(VAULT, 'jobs', 'search.md');
    const good = readFileSync(file, 'utf8');
    assert.ok(good.includes(spec.broken.from), `search.md has ${spec.broken.from}`);
    writeFileSync(file, good.replace(spec.broken.from, spec.broken.to)); // the user, in Notes
    const check = await jobs('check');
    assert.equal(check.code, 1);
    assert.match(check.out, /✗ jobs\/search\.md {2}\(using its last valid version\)/);
    assert.match(check.out, new RegExp(`error +${spec.broken.path.replace(/\./g, '\\.')}: `));
    assert.match(check.out, /using its last valid version \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)/);
    const state = await read('state');
    const b = state.banners.find((x: any) => x.kind === 'note');
    assert.ok(b, 'a banner');
    assert.ok(b.text.includes(spec.broken.path), b.text);
    assert.match(b.fix, /Until then Jobs uses the last valid version/);
    assert.equal(b.page, 'jobs/search');
    assert.match(ok(await jobs('rules'), 'rules'), spec.broken.still, 'the rules still come from the last valid version');
    writeFileSync(file, good);
    assert.equal((await jobs('check')).code, 0);
    assert.equal((await read('state')).banners.filter((x: any) => x.kind === 'note').length, 0);
    log.broken_note = { path: spec.broken.path, banner: b.text };
  });

  step('captured outputs', (t) => {
    assert.equal(submits, 0);
    t.diagnostic(`e2e ${spec.person}: ${JSON.stringify(log)}`);
    writeFileSync(join(ROOT, 'e2e-log.json'), JSON.stringify(log, null, 1));
  });
}
