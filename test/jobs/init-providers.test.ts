// `jobs init` installs the providers, and stays usable when that fails (offline, design §2.9); `jobs providers status|
// verify` and `doctor` report them. The download goes to a local fixture server or an unreachable one, never GitHub.
// CREWDECK_HOME is set before anything reads it, so this file imports Crewdeck modules dynamically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'cd-init-prov-'));
const home = join(root, 'crewdeck'), vault = join(root, 'vault');
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(vault, { recursive: true });
process.env.CREWDECK_HOME = home;

test('jobs init: offline, the providers line says why and what to do, and everything else is set up', async () => {
  const { REPO } = await import('./helpers.ts');
  cpSync(join(REPO, 'vault-template'), vault, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `vault: ${vault}\njobs:\n  home: ${join(home, 'jobs')}\n`, { mode: 0o600 });
  const { jobsInit } = await import('../../src/jobs/setup.ts');
  const { fixtureManifest } = await import('./provider-helpers.ts');
  const lines = await jobsInit({ providers: { base: 'http://raw.example.test:9', net: { testHosts: { 'raw.example.test': '127.0.0.1' } }, manifest: fixtureManifest(), timeoutMs: 2000 } });
  const p = lines.find((l) => /providers/.test(l) && /^✗/.test(l));
  assert.ok(p, lines.join('\n'));
  assert.match(p!, /could not be installed: .*download failed.*Pasted links, Prepare and Apply work without them; try again with crewdeck jobs providers install/);
  assert.ok(lines.some((l) => /^✓ Jobs is on/.test(l)));
  assert.match(readFileSync(join(home, 'config.yaml'), 'utf8'), /enabled: true/);
});

test('jobs init with the fixture server: providers installed and verified; the CLI status and verify report against the pinned manifest', async () => {
  const { jobsInit } = await import('../../src/jobs/setup.ts');
  const { fixtureManifest, FIXTURE_TREE } = await import('./provider-helpers.ts');
  const { serve } = await import('./net-helpers.ts');
  const m = fixtureManifest();
  const srv = await serve((req, res) => {
    const p = (req.url ?? '').replace(`/${m.repo}/${m.commit}/`, '');
    try { res.writeHead(200).end(readFileSync(join(FIXTURE_TREE, p))); } catch { res.writeHead(404).end(); }
  });
  try {
    const lines = await jobsInit({ providers: { base: srv.base('raw.example.test'), net: { testHosts: { 'raw.example.test': '127.0.0.1' } }, manifest: m } });
    assert.ok(lines.some((l) => /^✓ job-board providers: 11 from example\/providers@aaaaaaa \(MIT\), 13 files verified$/.test(l)), lines.join('\n'));
  } finally { await srv.close(); }
  // The CLI checks the real pinned manifest: this home holds the fixture commit, so it reports "not installed".
  const { jobs } = await import('./helpers.ts');
  const st = jobs(home, ['providers', 'status']);
  assert.equal(st.code, 1);
  assert.match(st.out, /not installed: crewdeck jobs providers install/);
  assert.match(st.out, /pinned: career-ops-hq\/career-ops@[0-9a-f]{40} \(MIT, Copyright \(c\) /);
  assert.match(st.out, /excluded: .*local-parser/);
  const v = jobs(home, ['providers', 'verify']);
  assert.equal(v.code, 1);
  assert.match(v.out, /missing/);
  assert.match(jobs(home, ['providers', 'nope']).err, /usage: crewdeck jobs providers install \| status \| verify/);
});
