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
