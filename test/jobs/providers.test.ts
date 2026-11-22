// Provider install and verify (design §15): every manifest file downloaded through netguard from a local fixture
// "raw.githubusercontent.com", checked against its sha256, installed by one rename. A tampered or missing file aborts and
// leaves nothing behind. Plus the committed manifest's own invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installProviders, loadManifest, providersDir, providersRoot, providersStatus, verifyProviders } from '../../src/jobs/providers.ts';
import { tempSetup } from './helpers.ts';
import { serve, testHosts } from './net-helpers.ts';
import { FIXTURE_TREE, fixtureManifest } from './provider-helpers.ts';

/** A fixture raw server: /<repo>/<commit>/<path> → the fixture tree's file, with optional overrides. */
async function rawServer(over: Record<string, string | null> = {}) {
  const m = fixtureManifest();
  return serve((req, res) => {
    const prefix = `/${m.repo}/${m.commit}/`;
    const url = req.url ?? '';
    if (!url.startsWith(prefix)) { res.writeHead(404).end(); return; }
    const p = url.slice(prefix.length);
    if (p in over) { if (over[p] === null) res.writeHead(404).end(); else res.writeHead(200).end(over[p]); return; }
    if (!(p in m.files)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(FIXTURE_TREE, p)));
  });
}
const net = { testHosts: testHosts('raw.example.test') };
const conf = () => { const s = tempSetup(); return { s, c: { jobs: { home: s.jobsHome } } as any }; };

test('install: every file verified, one rename into providers/<commit>/ with LICENSE, read-only, status ready, verify clean', async () => {
  const srv = await rawServer();
  try {
    const { c } = conf();
    const m = fixtureManifest();
    const r = await installProviders(c, { base: srv.base('raw.example.test'), net, manifest: m });
    assert.equal(r.ready, true, r.message);
    assert.match(r.message, /14 from example\/providers@aaaaaaa \(MIT\), 16 files verified/);
    const dir = providersDir(c, m);
    assert.equal(readFileSync(join(dir, 'LICENSE'), 'utf8'), m.license.text);
    assert.equal(readFileSync(join(dir, 'providers', 'fixture-board.mjs'), 'utf8'), readFileSync(join(FIXTURE_TREE, 'providers', 'fixture-board.mjs'), 'utf8'));
    assert.equal(existsSync(join(dir, 'providers', 'unlisted.mjs')), false, 'only manifest files are downloaded');
    assert.equal(statSync(join(dir, 'providers', 'fixture-board.mjs')).mode & 0o777, 0o400);
    assert.equal(statSync(dir).mode & 0o777, 0o500);
    assert.deepEqual(readdirSync(providersRoot(c)), [m.commit], 'no temp dir left');
    assert.equal(providersStatus(c, m).ready, true);
    assert.deepEqual(verifyProviders(c, m), { ok: true, bad: [], checked: 16 });
    // Installing again replaces the folder cleanly.
    assert.equal((await installProviders(c, { base: srv.base('raw.example.test'), net, manifest: m })).ready, true);
    assert.deepEqual(readdirSync(providersRoot(c)), [m.commit]);
  } finally { await srv.close(); }
});

test('install: a tampered file aborts with its name; nothing is installed and the temp dir is gone', async () => {
  const srv = await rawServer({ 'providers/fixture-ats.mjs': 'export default { id: "fixture-ats", fetch: async () => [] }; // changed upstream' });
  try {
    const { c } = conf();
    const m = fixtureManifest();
    const r = await installProviders(c, { base: srv.base('raw.example.test'), net, manifest: m });
    assert.equal(r.ready, false);
    assert.match(r.message, /providers\/fixture-ats\.mjs: sha256 mismatch .*refused/);
    assert.match(r.message, /Pasted links, Prepare and Apply work without them/);
    assert.deepEqual(readdirSync(providersRoot(c)), []);
    assert.equal(providersStatus(c, m).ready, false);
  } finally { await srv.close(); }
});

test('install: a missing file (404), an unreachable host (offline) and a loopback base are refused cleanly', async () => {
  const srv = await rawServer({ 'lib/clean.mjs': null });
  try {
    const { c } = conf();
    const m = fixtureManifest();
    const r = await installProviders(c, { base: srv.base('raw.example.test'), net, manifest: m });
    assert.match(r.message, /lib\/clean\.mjs: download failed \(HTTP 404\)/);
    assert.deepEqual(readdirSync(providersRoot(c)), []);
  } finally { await srv.close(); }
  const { c } = conf();
  const offline = await installProviders(c, { base: 'http://raw.example.test:9', net, manifest: fixtureManifest(), timeoutMs: 2000 });
  assert.equal(offline.ready, false);
  assert.match(offline.message, /download failed/);
  const loop = await installProviders(c, { base: 'http://127.0.0.1:9', manifest: fixtureManifest() });
  assert.match(loop.message, /private or local address: refused/, 'downloads go through netguard');
});

test('verify: a changed or missing file after install is named; status notices missing files', async () => {
  const srv = await rawServer();
  try {
    const { c } = conf();
    const m = fixtureManifest();
    await installProviders(c, { base: srv.base('raw.example.test'), net, manifest: m });
    const dir = providersDir(c, m);
    chmodSync(dir, 0o700);
    chmodSync(join(dir, 'lib'), 0o700);
    const f = join(dir, 'lib', 'clean.mjs');
    chmodSync(f, 0o600);
    writeFileSync(f, 'export const clean = (s) => s;');
    const v = verifyProviders(c, m);
    assert.equal(v.ok, false);
    assert.deepEqual(v.bad, ['lib/clean.mjs: sha256 mismatch']);
    const st = providersStatus(c, m);
    assert.equal(st.ready, true);
    assert.match(st.message, /writable: reinstall/);
  } finally { await srv.close(); }
});

test('the pinned manifest: MIT with its notice, every allow-listed provider listed, nothing excluded inside the closure', () => {
  const m = loadManifest();
  assert.match(m.commit, /^[0-9a-f]{40}$/);
  assert.equal(m.repo, 'career-ops-hq/career-ops');
  assert.equal(m.license.spdx, 'MIT');
  assert.match(m.license.text, /^MIT License/);
  assert.match(m.license.copyright, /^Copyright \(c\) \d{4} /);
  for (const id of m.providers) assert.ok(m.files[`providers/${id}.mjs`], id);
  for (const id of m.detectors) assert.ok(m.providers.includes(id), id);
  for (const f of Object.keys(m.excluded)) assert.equal(m.files[f], undefined, `${f} is excluded but in the closure`);
  for (const f of Object.keys(m.files)) {
    assert.match(m.files[f], /^[0-9a-f]{64}$/);
    assert.match(f, /^(providers|lib)\/[\w.-]+\.(mjs|js)$|^[\w.-]+\.mjs$/, f);
  }
  assert.equal(m.excluded['providers/local-parser.mjs'], 'runs local commands (child_process.execFile)');
  for (const id of ['gupy', 'jobbankca', 'jobscz', 'mycareersfuture', 'platsbanken', 'pracecz', 'vdab']) assert.match(m.excluded[`providers/${id}.mjs`], /js-yaml/);
  assert.deepEqual(Object.keys(m.optional_imports).sort(), ['providers/_connection-scope.mjs', 'providers/_http.mjs']);
  for (const v of Object.values(m.optional_imports)) assert.deepEqual(v, ['undici']);
  assert.ok(m.providers.length > 100);
});
