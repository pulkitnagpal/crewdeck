// Apply kinds (src/jobs/apply-kind.ts): detection from fictional addresses in the real shapes, what is stored on the
// role and handed to the Apply chat, the never-click list against the skill's playbooks, the quiet chip on Today, and
// Quick apply's eligibility and daily cap. Fictional people and companies; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { render } from 'preact-render-to-string';
import { html } from '../../web/jobs/lib.js';
import { Today } from '../../web/jobs/screens/today.js';
import { APPLY_KINDS, NEVER_CLICK, STOP_AT, SUBMITTED_TEXT, applyContext, detectApplyKind, kindOfUrl, neverClick } from '../../src/jobs/apply-kind.ts';
import { getRole } from '../../src/jobs/db.ts';
import { setApplyKind, setApplyUrl } from '../../src/jobs/pipeline/roles.ts';
import { planForRole } from '../../src/jobs/plan.ts';
import { quickApplyView } from '../../src/jobs/quick-apply.ts';
import { createJobsApi } from '../../src/jobs/api.ts';
import { parseTaskPrompt, taskPrompt } from '../../src/session-link.ts';
import { jobsServer, preparedRole } from './api-helpers.ts';
import { REPO, role, world } from './helpers.ts';
import { setFeature } from '../../src/config.ts';

const LI = (n: number) => `https://www.linkedin.com/jobs/view/${4100000000 + n}`;

test('kind detection: each site in its real address shape (fictional companies)', () => {
  const cases: [Parameters<typeof detectApplyKind>[0], string, boolean?][] = [
    [{ url: LI(1), apply_kind: 'easy' }, 'linkedin_easy'],
    [{ url: LI(2), apply_kind: 'linkedin_easy' }, 'linkedin_easy'],
    [{ url: LI(3), apply_kind: 'external' }, 'linkedin_external'],
    [{ url: LI(4) }, 'linkedin_external', false],
    [{ url: LI(5), apply_kind: 'unknown' }, 'linkedin_external', false],
    // A LinkedIn posting whose Apply led to the employer's ATS: the form's address decides.
    [{ url: LI(6), apply_kind: 'external', apply_url: 'https://jobs.lever.co/examplerobotics/4f1c2b9e-0000-4000-8000-000000000001/apply' }, 'lever'],
    [{ url: LI(7), apply_url: 'https://example-health.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Data-Analyst_R-00012' }, 'workday'],
    [{ url: LI(8), apply_url: 'https://careers.example.org/jobs/123' }, 'generic'],
    [{ url: 'https://jobs.lever.co/examplerobotics/4f1c2b9e-0000-4000-8000-000000000002' }, 'lever'],
    [{ url: 'https://jobs.eu.lever.co/exampleco/4f1c2b9e-0000-4000-8000-000000000003/apply' }, 'lever'],
    [{ url: 'https://boards.greenhouse.io/examplelabs/jobs/7000001' }, 'greenhouse'],
    [{ url: 'https://job-boards.eu.greenhouse.io/examplelabs/jobs/7000002' }, 'greenhouse'],
    [{ url: 'https://careers.example.com/open-roles?gh_jid=7000003' }, 'greenhouse'],
    [{ url: 'https://jobs.ashbyhq.com/exampleai/0b6d5d1a-0000-4000-8000-000000000004' }, 'ashby'],
    [{ url: 'https://example.com/careers?ashby_jid=0b6d5d1a-0000-4000-8000-000000000005' }, 'ashby'],
    [{ url: 'https://exampleretail.myworkdaysite.com/recruiting/exampleretail/External/job/Pune/Analyst_JR1' }, 'workday'],
    [{ url: 'https://www.naukri.com/job-listings-data-analyst-example-analytics-pvt-ltd-pune-3-to-6-years-201126000001' }, 'naukri'],
    [{ url: 'https://naukri.com/job-listings-backend-engineer-example-tech-bengaluru-2-to-5-years-201126000002' }, 'naukri'],
    [{ url: 'https://careers.example.org/jobs/data-analyst-42' }, 'generic'],
    // A hint Claude recorded wins over generic, never over a known address.
    [{ url: 'https://careers.example.org/jobs/99', apply_kind: 'workday' }, 'workday'],
    [{ url: 'https://jobs.lever.co/exampleco/4f1c2b9e-0000-4000-8000-000000000006', apply_kind: 'greenhouse' }, 'lever'],
    [{ url: 'https://careers.example.org/jobs/7', apply_kind: 'linkedin_easy' }, 'generic'],
  ];
  for (const [input, kind, sure = true] of cases) assert.deepEqual(detectApplyKind(input), { kind, sure }, JSON.stringify(input));
  assert.equal(kindOfUrl('not a url'), null);
  assert.equal(kindOfUrl('https://notlever.co.example.com/x'), null, 'host suffixes only');
  assert.equal(kindOfUrl('https://naukri.com.example.net/x'), null);
});

test('stored on the role: from the address on insert, re-detected when the form address or what Claude saw changes', () => {
  const w = world('example');
  const lever = role(w.ctx, { company: 'Example Robotics', url: 'https://jobs.lever.co/examplerobotics/4f1c2b9e-0000-4000-8000-000000000010' });
  const naukri = role(w.ctx, { company: 'Example Analytics', url: 'https://www.naukri.com/job-listings-data-analyst-example-analytics-pune-3-to-6-years-201126000010' });
  const easy = role(w.ctx, { company: 'Example Li Co', url: LI(10), apply_kind: 'easy' });
  const unsure = role(w.ctx, { company: 'Example Ext', url: LI(11), source: 'portal' });
  const kind = (id: string) => getRole(w.ctx.db, id).apply_kind;
  assert.deepEqual([kind(lever), kind(naukri), kind(easy), kind(unsure)], ['lever', 'naukri', 'linkedin_easy', null]);
  // A rescan without a hint keeps what is known.
  role(w.ctx, { company: 'Example Li Co', url: LI(10) });
  assert.equal(kind(easy), 'linkedin_easy');
  // linkedin_external: Claude clicked Apply, the employer's form is on Greenhouse.
  setApplyKind(w.ctx, unsure, 'linkedin_external');
  assert.equal(kind(unsure), 'linkedin_external');
  setApplyUrl(w.ctx, unsure, 'https://job-boards.greenhouse.io/exampleext/jobs/7000010');
  assert.equal(kind(unsure), 'greenhouse');
  assert.throws(() => setApplyKind(w.ctx, lever, 'mystery'), /--apply-kind must be one of/);
  assert.equal(setApplyKind(w.ctx, lever, 'workday'), 'lever', 'the address decides first');
});

test('never click: the submit buttons in many languages; Naukri\'s own Apply; opening a form, Next and Review are allowed', () => {
  for (const t of ['Submit application', 'Submit your application', 'Send application', 'Submit', '  Submit  ', 'Send', 'Finish', 'Complete application',
    'Confirm and submit', 'Envoyer', 'Envoyer ma candidature', 'Soumettre', 'Bewerbung absenden', 'Absenden', 'Enviar candidatura', 'Invia candidatura',
    'Versturen', 'Skicka ansökan']) assert.ok(neverClick(t, 'lever'), t);
  for (const t of ['Easy Apply', 'Apply', 'Apply now', 'Apply for this job', 'Next', 'Continue', 'Review', 'Review your application', 'Add another', 'Save and continue', 'Yes', 'No', ''])
    assert.equal(neverClick(t, 'linkedin_easy'), null, t);
  for (const t of ['Apply', 'Apply now', 'I am interested', 'Save']) assert.ok(neverClick(t, 'naukri'), `Naukri: ${t}`);
  assert.equal(neverClick('Apply', 'linkedin_external'), null, 'LinkedIn\'s Apply only leaves LinkedIn');
  assert.equal(neverClick('Apply', null), null);
  // Each kind has a stop and a confirmation, and the confirmations match the sites' words.
  for (const k of APPLY_KINDS) { assert.ok(STOP_AT[k]); assert.ok(SUBMITTED_TEXT[k]); }
  assert.match('Application sent', SUBMITTED_TEXT.linkedin_easy);
  assert.match('Application submitted!', SUBMITTED_TEXT.lever);
  assert.match('Applied', SUBMITTED_TEXT.naukri);
  assert.doesNotMatch('Apply', SUBMITTED_TEXT.naukri);
  const c = applyContext({ url: 'https://www.naukri.com/job-listings-x-201126000011' });
  assert.equal(c.kind, 'naukri');
  assert.ok(c.never_click.some((n) => n.label === 'Apply now (Naukri)'));
  assert.ok(!applyContext({ url: LI(12), apply_kind: 'easy' }).never_click.some((n) => /Naukri/.test(n.label)));
});

test('skill: a playbook per kind, each with its STOP; the never-click list; Quick apply; applied only on evidence', () => {
  const ws = readFileSync(join(REPO, 'plugin', 'skills', 'jobs-workspace', 'SKILL.md'), 'utf8');
  const apply = ws.slice(ws.indexOf('## apply:'), ws.indexOf('## improve:'));
  const books = apply.slice(apply.indexOf('### Playbooks by kind'));
  for (const k of APPLY_KINDS) assert.ok(books.includes(`**${k}**`), `a playbook for ${k}`);
  // Each playbook ends at a STOP (linkedin_external hands over to the re-detected kind's, and stops for an account).
  const blocks = books.split(/\n\*\*(?=[a-z_]+\*\*)/).slice(1);
  assert.ok(blocks.length >= 6);
  for (const b of blocks) assert.match(b, /STOP/, b.split('\n')[0]);
  assert.match(books, /\*\*linkedin_easy\*\*[\s\S]*STOP at the step whose button is "Submit application"/);
  assert.match(books, /\*\*lever\*\*[\s\S]*STOP before "Submit application"/);
  assert.match(books, /\*\*naukri\*\*[\s\S]*never clicks it[\s\S]*click \*\*Apply\*\* on\s+the posting yourself[\s\S]*STOP before its final Submit or Save/);
  assert.match(books, /\*\*linkedin_external\*\*[\s\S]*--apply-url-file[\s\S]*re-detected kind[\s\S]*needs an account[\s\S]*STOP and ask/);
  // The never-click list in the skill is the code's list.
  for (const n of NEVER_CLICK) assert.ok(apply.includes(n.label), `never-click in the skill: ${n.label}`);
  assert.match(apply, /context\.playbook\.never_click/);
  assert.match(apply, /Never solve a CAPTCHA, never type a password or a one-time code, never create an account without a clear yes/);
  assert.match(apply, /Never upload a file unless the tailored resume PDF exists and the person said yes/);
  // Applied only on the page's words or the person's.
  assert.match(apply, /LinkedIn "Application sent",\s+Lever "Application submitted", Naukri "Applied"/);
  assert.match(apply, /`crewdeck jobs applied <role>`/);
  assert.match(apply, /no evidence and no word from them, no `applied`/);
  const quick = ws.slice(ws.indexOf('## quick_apply:'), ws.indexOf('## improve:'));
  assert.ok(ws.includes('`Crewdeck: quick apply (request <id>)` → the **quick_apply** section'));
  for (const re of [/one at a time/, /Never auto-submit/, /daily_quick_apply/, /STOP and tell the person/, /crewdeck jobs applied <role>/]) assert.match(quick, re);
});

test('the Quick apply prompt: exact shape, read back; register.tsx claims it', () => {
  assert.equal(taskPrompt({ kind: 'quick_apply', request: 12 }), 'Crewdeck: quick apply (request 12)');
  assert.deepEqual(parseTaskPrompt('Crewdeck: quick apply (request 12)'), { kind: 'quick_apply', request: 12 });
  for (const bad of ['Crewdeck: quick apply (request 0)', 'Crewdeck: quick apply (request 12) now', 'Crewdeck: quick apply request 12']) assert.equal(parseTaskPrompt(bad), null, bad);
  const reg = readFileSync(join(REPO, 'plugin', 'hooks', 'register.tsx'), 'utf8');
  assert.ok(reg.includes('/^Crewdeck: quick apply \\(request ([1-9][0-9]{0,9})\\)$/'));
});

/** A prepared Easy Apply pick whose questions are all answered (or, with firstTime, one is not). */
function easyPick(w: ReturnType<typeof world>, company: string, n: number, firstTime = false) {
  const id = preparedRole(w, company, { url: LI(100 + n), firstTime });
  w.ctx.db.prepare(`update roles set apply_kind='linkedin_easy', status='prepared' where id=?`).run(id);
  return id;
}
const FIELDS = [{ label: 'First name', type: 'text' }];

test('Quick apply: only prepared Easy Apply picks with every question answered, never past daily_quick_apply', () => {
  const off = world('example', { features: { easy_apply: false, daily_quick_apply: 0 } });
  easyPick(off, 'Example Off', 1);
  assert.deepEqual(quickApplyView(off.ctx).roles, []);
  assert.equal(quickApplyView(off.ctx).on, false);

  const w = world('example', { features: { easy_apply: true, daily_quick_apply: 2 }, now: '2026-11-19T10:00:00Z' });
  const a = easyPick(w, 'Example A', 1), b = easyPick(w, 'Example B', 2), c = easyPick(w, 'Example C', 3);
  easyPick(w, 'Example Asks', 4, true); // a required question without an answer
  const lever = preparedRole(w, 'Example Lever', { url: 'https://jobs.lever.co/examplelever/4f1c2b9e-0000-4000-8000-000000000020' });
  w.ctx.db.prepare(`update roles set status='prepared' where id=?`).run(lever);
  const v = quickApplyView(w.ctx);
  assert.equal(v.eligible, 3, 'Easy Apply only, every question answered');
  assert.equal(v.roles.length, 2, 'capped at daily_quick_apply');
  assert.deepEqual(quickApplyView(w.ctx, (id) => id === v.roles[0].id).roles.length, 2, 'a busy role is left out, the next takes its place');
  // Two forms planned today: the cap is used; those two are free again (counted once a day), a third is not offered.
  const [x, y] = v.roles.map((r) => r.id);
  assert.equal(planForRole(w.ctx, x, FIELDS).mode, 'fill');
  assert.equal(planForRole(w.ctx, y, FIELDS).mode, 'fill');
  const after = quickApplyView(w.ctx);
  assert.deepEqual([after.used, after.left], [2, 0]);
  assert.deepEqual(after.roles.map((r) => r.id).sort(), [x, y].sort());
  const third = [a, b, c].find((id) => id !== x && id !== y)!;
  assert.match((planForRole(w.ctx, third, FIELDS) as any).reason, /limit \(2\) is used/);
  w.ctx.db.prepare(`update roles set status='applied' where id in (?, ?)`).run(x, y);
  assert.deepEqual(quickApplyView(w.ctx).roles, [], 'nothing left today');
});

test('Today: the apply kind as a quiet chip; Quick apply (N) opens one fresh chat whose context has each playbook', async () => {
  const opened: string[] = [];
  const s = await jobsServer('example', { features: { easy_apply: true, daily_quick_apply: 3 }, api: { autoOpenChat: true, platform: 'darwin', openLink: async (l) => { opened.push(l); } } });
  try {
    // The server reads its switches from the temp home's config.yaml (as the Settings toggle writes them).
    setFeature('easy_apply', true, join(s.w.home, 'config.yaml'));
    setFeature('daily_quick_apply', 3, join(s.w.home, 'config.yaml'));
    const e1 = easyPick(s.w, 'Example One', 31), e2 = easyPick(s.w, 'Example Two', 32);
    preparedRole(s.w, 'Example Lever', { url: 'https://jobs.lever.co/examplelever/4f1c2b9e-0000-4000-8000-000000000030' });
    preparedRole(s.w, 'Example Naukri', { url: 'https://www.naukri.com/job-listings-data-analyst-example-naukri-pune-3-to-6-years-201126000030' });
    preparedRole(s.w, 'Example Careers');
    const d = (await s.get('today')).json;
    const chip = (co: string) => d.queue.find((q: any) => q.company === co).apply.text;
    assert.deepEqual(['Example One', 'Example Lever', 'Example Naukri', 'Example Careers'].map(chip), ['Easy Apply', 'Lever', 'Naukri one-click', 'Company site']);
    assert.equal(d.quick_apply.n, 2);
    const out = render(html`<${Today} data=${d} state=${(await s.get('state')).json} />`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const t of ['Easy Apply', 'Lever', 'Naukri one-click', 'Company site', 'Quick apply (2)']) assert.ok(out.includes(t), t);
    assert.match(render(html`<${Today} data=${d} state=${{}} />`), /class="chip kind"/);

    const r = await s.action('quickApply');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.roles, 2);
    const req = s.q.get(r.json.request)!;
    assert.equal(req.kind, 'quick_apply');
    assert.deepEqual((req.payload!.roles as string[]).sort(), [e1, e2].sort());
    assert.equal(opened.length, 1, 'one chat in front');
    assert.match(decodeURIComponent(opened[0]), new RegExp(`q=Crewdeck: quick apply \\(request ${req.id}\\)$`));
    assert.equal((await s.action('quickApply')).json.already, true, 'a second click does not start another');
    const t2 = (await s.get('today')).json;
    assert.equal(t2.queue.find((q: any) => q.id === e1).chip.text, 'In Quick apply');
    assert.ok(t2.quick_apply.request);
    const api = createJobsApi(s.c, s.q, { configPath: join(s.w.home, 'config.yaml'), pollMs: 50, browser: () => null });
    try {
      const ctx = api.contextFor(req) as any;
      assert.equal(ctx.roles.length, 2);
      assert.deepEqual(ctx.daily_quick_apply, { cap: 3, used: 0 });
      for (const x of ctx.roles) {
        assert.equal(x.apply_kind, 'linkedin_easy');
        assert.equal(x.playbook.stop_at, STOP_AT.linkedin_easy);
        assert.ok(x.playbook.never_click.some((n: any) => n.label === 'Submit application'));
      }
      assert.equal(api.glance().quick_apply, 0, 'no second button while one runs');
      // An Apply request's context names the kind and its playbook.
      const lever = d.queue.find((q: any) => q.company === 'Example Lever').id;
      const a = await s.action('approve', { role: lever });
      assert.equal(a.status, 200, a.body);
      const ac = api.contextFor(s.q.get(a.json.request)!) as any;
      assert.equal(ac.role.apply_kind, 'lever');
      assert.deepEqual([ac.playbook.kind, ac.playbook.known, ac.playbook.submitted], ['lever', true, '"Application submitted"']);
    } finally { api.close(); }
  } finally { await s.close(); }
});
