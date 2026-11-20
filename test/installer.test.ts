// The one-click setup's script (plugin/hooks/install-script.ts, docs/everywhere.md E13): a download that doesn't match
// its pinned checksum stops it with nothing installed; a step that's done is skipped next time. The full run, with the
// real Node, release and packages, is in docs/everywhere.md §7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_URL, CREWDECK_VERSION, INSTALL_SH, NODE_SHA256, NODE_VERSION } from '../plugin/hooks/install-script.ts';

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
function run(env: Record<string, string>) {
  const r = spawnSync('sh', ['-s'], { input: INSTALL_SH, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.CREWDECK_HOME, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** A tarball holding one top folder with the given files. */
function tarball(dir: string, name: string, files: Record<string, string>): string {
  const root = join(dir, `${name}-src`, 'top');
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), text, { mode: 0o755 }); }
  const out = join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', join(dir, `${name}-src`), 'top']);
  return out;
}

test('E13: the pins are real: Node 25.9.0 for the four platforms, the release URL by version', () => {
  assert.equal(NODE_VERSION, '25.9.0');
  assert.deepEqual(Object.keys(NODE_SHA256).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  for (const h of Object.values(NODE_SHA256)) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(APP_URL, `https://github.com/pulkitnagpal/crewdeck/releases/download/v${CREWDECK_VERSION}/crewdeck-${CREWDECK_VERSION}.tar.gz`);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, CREWDECK_VERSION);
  assert.doesNotMatch(INSTALL_SH, /\bsudo\b|\bgit\b|\beval\b/);
});

test('E13: a Node download that does not match its checksum stops setup, and nothing is installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cds-inst-'));
  const home = join(dir, 'home');
  const bogus = join(dir, 'node.tar.gz');
  writeFileSync(bogus, 'not node');
  const r = run({ CREWDECK_HOME: home, CREWDECK_NODE_URL: `file://${bogus}`, CREWDECK_NODE_SHA256: 'a'.repeat(64) });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /^STEP 1\/5 Downloading Node 25\.9\.0/m);
  assert.match(r.out, /^FAIL the Node download does not match its checksum: nothing was installed$/m);
  assert.ok(!existsSync(join(home, 'runtime')), 'no runtime');
  assert.deepEqual(execFileSync('ls', ['-A', home], { encoding: 'utf8' }).trim(), '', 'the temp folder is cleaned up');
});

test('E13: Node in place, a Crewdeck download that does not match stops before anything of it is unpacked; Node is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cds-inst-'));
  const home = join(dir, 'home');
  const node = tarball(dir, 'node', { 'bin/node': '#!/bin/sh\necho fake node\n' });
  const app = tarball(dir, 'app', { 'package.json': '{}' });
  const r = run({ CREWDECK_HOME: home, CREWDECK_NODE_URL: `file://${node}`, CREWDECK_NODE_SHA256: sha(node), CREWDECK_APP_URL: `file://${app}`, CREWDECK_APP_SHA256: 'b'.repeat(64) });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /FAIL the Crewdeck download does not match its checksum: nothing was installed/);
  const platform = Object.keys(NODE_SHA256).find((p) => existsSync(join(home, 'runtime', `node-v25.9.0-${p}`, 'bin', 'node')));
  assert.ok(platform, 'Node is unpacked into the runtime folder');
  assert.ok(!existsSync(join(home, 'app')), 'no app');
  // Run again: Node is not downloaded again (a missing URL would fail if it were).
  const again = run({ CREWDECK_HOME: home, CREWDECK_NODE_URL: 'file:///nonexistent', CREWDECK_APP_URL: `file://${app}`, CREWDECK_APP_SHA256: 'b'.repeat(64) });
  assert.match(again.out, /^STEP 1\/5 Node 25\.9\.0 is already here$/m);
});
