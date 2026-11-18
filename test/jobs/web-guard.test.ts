// Fitness checks for design §13/§14: every web request in src/jobs goes through netguard (no bare fetch, no
// http.request outside src/jobs/net), the browser is only launched through launchGuarded, and the web code never
// clicks, submits or types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO } from './helpers.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}
const SRC = files(join(REPO, 'src', 'jobs')).map((f) => ({ f: relative(REPO, f), src: readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '') }));

// Type-only imports (the Jobs API's request/response types) make no requests.
test('no web request in src/jobs bypasses netguard', () => {
  const bad = SRC.filter(({ f, src }) => !f.startsWith('src/jobs/net/') && (/(?<![\w.])fetch\(/.test(src) || /\bhttps?\.(request|get)\(/.test(src) || /\bnet\.connect\(/.test(src) || /^import (?!type )[^;]*from 'node:(http|https|net|dgram)'/m.test(src)));
  assert.deepEqual(bad.map((x) => x.f), []);
});

test('the browser is launched only through launchGuarded, with the guard proxy', () => {
  const launches = SRC.filter(({ src }) => /chromium\.launch|launchPersistentContext|connectOverCDP/.test(src)).map((x) => x.f);
  assert.deepEqual(launches, ['src/jobs/browser.ts']);
  const b = SRC.find((x) => x.f === 'src/jobs/browser.ts')!.src;
  assert.match(b, /args: \[\.\.\.proxyArgs\(proxy\)/);
  assert.match(b, /serviceWorkers: 'block'/);
});

test('web code never clicks, submits, types or fills', () => {
  for (const f of ['src/jobs/read-form.ts', 'src/jobs/link.ts', 'src/jobs/linkedin.ts', 'src/jobs/resume.ts', 'src/jobs/browser.ts']) {
    const src = SRC.find((x) => x.f === f)!.src;
    assert.ok(!/\.(click|fill|type|press|check|selectOption|setInputFiles|submit|requestSubmit|dispatchEvent)\(/.test(src), f);
  }
});
