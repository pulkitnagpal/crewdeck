import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

test('config: expands ~, assigns board ports, rejects unsafe project names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, 'port: 5000\nvault: ~/v\nprojects:\n  - name: alpha\n    path: ~/code/alpha\n  - name: beta\n    path: /tmp/beta\n');
  const c = loadConfig(p);
  assert.equal(c.vault, join(homedir(), 'v'));
  assert.deepEqual(c.projects.map((x) => x.boardPort), [5010, 5011]);
  writeFileSync(p, 'projects:\n  - name: "../etc"\n    path: /tmp/x\n');
  assert.throws(() => loadConfig(p), /lowercase/);
});

test('config: one project is labelled "Board"; apps must be local http URLs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, 'projects:\n  - name: alpha\n    path: /tmp/a\napps:\n  - name: dashboard\n    url: http://localhost:4747/\n');
  const c = loadConfig(p);
  assert.equal(c.projects[0].label, 'Board');
  assert.equal(c.appearance, 'auto', 'follows the system unless set');
  writeFileSync(p, 'projects:\n  - name: alpha\n    path: /tmp/a\n  - name: beta\n    path: /tmp/b\n');
  assert.deepEqual(loadConfig(p).projects.map((x) => x.label), ['alpha', 'beta']);
  writeFileSync(p, 'apps:\n  - name: evil\n    url: https://example.com/\n');
  assert.throws(() => loadConfig(p), /localhost/);
});

test('home and token: private folder (0700), a 64-hex token (0600), stable once made', async () => {
  const { ensureHome, ensureToken, readToken } = await import('../src/config.ts');
  const { statSync, chmodSync } = await import('node:fs');
  const home = join(mkdtempSync(join(tmpdir(), 'cdh-')), 'crew');
  ensureHome(home);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const p = join(home, 'token');
  const t = ensureToken(p);
  assert.match(t, /^[a-f0-9]{64}$/);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(ensureToken(p), t);
  assert.equal(readToken(join(home, 'missing')), null);
  writeFileSync(p, 'not a token');
  assert.equal(readToken(p), null);
  chmodSync(home, 0o777); ensureHome(home); assert.equal(statSync(home).mode & 0o777, 0o700, 'tightened');
});

test('jobs config: off by default, home under the Crewdeck home, workspace defaults to home', async () => {
  const { HOME } = await import('../src/config.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cd-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, 'port: 5000\n');
  const j = loadConfig(p).jobs;
  assert.equal(j.enabled, false);
  assert.equal(j.home, join(HOME, 'jobs'));
  assert.equal(j.workspace, j.home);
  assert.equal(j.browser, 'auto');
  assert.equal(j.fetch_every, '12h');
  assert.deepEqual(j.features, { linkedin_search: false, linkedin_links: false, easy_apply: false, daily_quick_apply: 0, email_drafts: false, max_emails_per_day: 10, linkedin_message_text: false });
  writeFileSync(p, 'jobs:\n  enabled: true\n  home: ~/jobs-state\n  workspace: /tmp/jobs-ws\n  features: { easy_apply: true, daily_quick_apply: 25 }\n');
  const k = loadConfig(p).jobs;
  assert.equal(k.home, join(homedir(), 'jobs-state'));
  assert.equal(k.workspace, '/tmp/jobs-ws');
  assert.equal(k.features.daily_quick_apply, 25);
});

test('jobs config: hard caps and unknown switches are errors that name the field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-'));
  const p = join(dir, 'config.yaml');
  const bad: [string, RegExp][] = [
    ['jobs: { features: { daily_quick_apply: 26 } }', /daily_quick_apply: at most 25/],
    ['jobs: { features: { max_emails_per_day: 21 } }', /max_emails_per_day: at most 20/],
    ['jobs: { features: { easy_apply: "yes" } }', /easy_apply: use true or false/],
    ['jobs: { features: { auto_submit: true } }', /auto_submit: unknown feature/],
    ['jobs: { fetch_every: 5m }', /fetch_every/],
    ['jobs: { browser: chrome }', /jobs.browser/],
    ['jobs: { homee: /tmp }', /jobs.homee: unknown setting/],
  ];
  for (const [yaml, re] of bad) { writeFileSync(p, yaml + '\n'); assert.throws(() => loadConfig(p), re, yaml); }
});

test('setFeature changes one switch and keeps the rest of config.yaml', async () => {
  const { setFeature } = await import('../src/config.ts');
  const { readFileSync, statSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'cd-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, '# my settings\nport: 5000 # the shell\njobs:\n  enabled: true\n');
  setFeature('easy_apply', true, p);
  setFeature('daily_quick_apply', 3, p);
  const text = readFileSync(p, 'utf8');
  assert.match(text, /# my settings/);
  assert.match(text, /port: 5000 # the shell/);
  assert.equal(loadConfig(p).jobs.features.easy_apply, true);
  assert.equal(loadConfig(p).jobs.features.daily_quick_apply, 3);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.throws(() => setFeature('daily_quick_apply', 30, p), /at most 25/);
  assert.equal(loadConfig(p).jobs.features.daily_quick_apply, 3);
});
