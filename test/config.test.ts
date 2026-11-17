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
