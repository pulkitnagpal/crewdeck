// Headless form reading (design §2.3 step 4): fixture forms served by a local server on a made-up host, read through
// the guarded browser, stored per role. LinkedIn, copy-only sites and sign-in walls come back as `needs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readForm } from '../../src/jobs/read-form.ts';
import { REPO, role, world } from './helpers.ts';
import { noBrowser, serve, testHosts } from './net-helpers.ts';

const FORMS = join(REPO, 'test', 'fixtures', 'jobs', 'forms');

async function site() {
  return serve((req, res) => {
    const name = (req.url ?? '').replace(/^\/forms\//, '').replace(/\?.*$/, '');
    if (!/^[a-z-]+\.html$/.test(name)) { res.writeHead(404).end(); return; }
    let body: Buffer;
    try { body = readFileSync(join(FORMS, name)); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
}
const net = { testHosts: testHosts('apply.example.test') };

test('a form with a fieldset, select, textarea, file and consent checkbox is read and stored', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await site();
  const w = world('berlin-analyst');
  t.after(() => s.close());
  const id = role(w.ctx, { company: 'Example GmbH', title: 'Senior Data Analyst' });
  const r = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/fieldset-radio.html`, net });
  assert.equal(r.needs, undefined);
  const by = Object.fromEntries(r.questions.map((q) => [q.label, q]));
  assert.deepEqual(r.questions.map((q) => q.label), ['Name', 'Email', 'Experience with SQL', 'Why Example GmbH?', 'Resume', 'Will you require visa sponsorship?', 'I agree to the privacy policy']);
  assert.deepEqual(by['Experience with SQL'].options, ['Only the basics', 'Daily, in production', 'I teach it']);
  assert.equal(by['Experience with SQL'].kind, 'radio');
  assert.equal(by['Experience with SQL'].required, true);
  assert.equal(by['Why Example GmbH?'].char_limit, 500);
  assert.equal(by['Why Example GmbH?'].kind, 'textarea');
  assert.deepEqual(by['Will you require visa sponsorship?'].options, ['Yes', 'No'], 'the "Select..." placeholder is not an option');
  assert.equal(by['I agree to the privacy policy'].kind, 'checkbox');
  assert.equal(by['I agree to the privacy policy'].required, true);
  assert.equal(by.Resume.kind, 'file');
  // Stored per role (the file input is not a question to answer), and the form's address is the role's apply URL.
  assert.equal(r.stored, 6);
  const rows = w.ctx.db.prepare('select label, kind, required from form_fields where role_id=? order by ord').all(id) as any[];
  assert.deepEqual(rows.map((x) => x.label), ['Name', 'Email', 'Experience with SQL', 'Why Example GmbH?', 'Will you require visa sponsorship?', 'I agree to the privacy policy']);
  assert.equal(rows.find((x) => x.label === 'Will you require visa sponsorship?').kind, 'sensitive');
  assert.equal(rows.find((x) => x.label === 'Experience with SQL').kind, 'choice');
  assert.equal((w.ctx.db.prepare('select apply_url from roles where id=?').get(id) as any).apply_url, `${s.base('apply.example.test')}/forms/fieldset-radio.html`);
});

test('ATS-style layouts: radios without a fieldset, Yes/No buttons, comboboxes; hidden, read-only and disabled skipped', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await site();
  const w = world('us-nurse');
  t.after(() => s.close());
  const id = role(w.ctx, { company: 'Example Health', title: 'Telehealth Nurse' });
  const r = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/ats-like.html`, net });
  const labels = r.questions.map((q) => q.label);
  assert.deepEqual(labels, ['Familiarity with Epic', 'Comfortable with night shifts?', 'Location', 'First name', 'Email address', 'Years of experience', 'Have you worked in telehealth triage?']);
  const by = Object.fromEntries(r.questions.map((q) => [q.label, q]));
  assert.deepEqual(by['Familiarity with Epic'].options, ['Never used it', 'Charted in it daily']);
  assert.deepEqual(by['Have you worked in telehealth triage?'].options, ['Yes', 'No']);
  assert.equal(by['Have you worked in telehealth triage?'].required, true);
  assert.equal(by.Location.kind, 'combobox');
  assert.equal(by['Years of experience'].required, true);
  assert.ok(!labels.includes('Website') && !labels.includes('Licence number') && !labels.includes('token'));
});

test('questions inside an iframe are read', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await site();
  const w = world('berlin-analyst');
  t.after(() => s.close());
  const id = role(w.ctx, { company: 'Example Labs' });
  const r = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/iframe-host.html`, net });
  assert.ok(r.questions.some((q) => q.label === 'Experience with SQL'));
  assert.ok(r.stored >= 5);
});

test('sign-in walls and pages without a form come back as needs; nothing is stored', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await site();
  const w = world('berlin-analyst');
  t.after(() => s.close());
  const id = role(w.ctx, { company: 'Example Signin' });
  const signin = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/signin.html`, net });
  assert.match(signin.needs ?? '', /password.*only the user signs in/);
  const empty = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/empty.html`, net });
  assert.match(empty.needs ?? '', /no questions could be read headlessly.*crewdeck jobs learn/);
  const missing = await readForm(w.ctx, id, { url: `${s.base('apply.example.test')}/forms/missing.html`, net });
  assert.match(missing.needs ?? '', /HTTP (404|error)/);
  assert.equal((w.ctx.db.prepare('select count(*) n from form_fields where role_id=?').get(id) as any).n, 0);
});

test('a form on this machine is refused by the guard proxy', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await site();
  const w = world('berlin-analyst');
  t.after(() => s.close());
  const id = role(w.ctx, { company: 'Example Local' });
  const r = await readForm(w.ctx, id, { url: `${s.base()}/forms/fieldset-radio.html` });
  assert.match(r.needs ?? '', /refused/);
  assert.ok(r.blocked.includes('127.0.0.1'));
  assert.deepEqual(s.hits, []);
});

test('LinkedIn and copy-only hosts are never read headlessly', async () => {
  const w = world('berlin-analyst', { features: { linkedin_links: true } });
  const li = role(w.ctx, { company: 'Example Li', url: 'https://www.linkedin.com/jobs/view/4000000001' });
  assert.match((await readForm(w.ctx, li)).needs ?? '', /LinkedIn forms are read in the user's own signed-in browser/);
  const wf = role(w.ctx, { company: 'Example Startup', url: 'https://wellfound.com/jobs/123-analyst' });
  assert.match((await readForm(w.ctx, wf)).needs ?? '', /wellfound\.com forbids automated use/);
});

test('CLI: form reads headlessly when no fields file is given (a local address is refused, exit 2)', { skip: noBrowser, timeout: 60_000 }, async () => {
  const { jobs, textFile } = await import('./helpers.ts');
  const w = world('berlin-analyst');
  const id = role(w.ctx, { company: 'Example Cli' });
  const r = jobs(w.home, ['form', id, '--url-file', textFile(w.root, 'form-url.txt', 'http://127.0.0.1:9/apply')]);
  assert.equal(r.code, 2, r.err);
  const out = JSON.parse(r.out);
  assert.match(out.needs, /refused|could not be opened/);
  assert.match(jobs(w.home, ['form', 'nope']).err, /not a role id/);
});
