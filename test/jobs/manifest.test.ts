// scripts/update-providers-manifest.mjs (design §15): the import lexer, the closure, the exclusions and the failures, on
// in-memory trees. With CAREER_OPS_CHECKOUT pointing at a career-ops checkout, the committed manifest is rebuilt from it
// and must match byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore: a plain .mjs script
import { buildManifest, gitReader, importsOf } from '../../scripts/update-providers-manifest.mjs';
import { REPO } from './helpers.ts';

const specs = (src: string) => importsOf(src).map((i: any) => `${i.dynamic ? 'dyn:' : ''}${i.spec}`);

test('importsOf: static, side-effect, re-export and dynamic imports; never strings, comments, templates or regexes', () => {
  const src = `
    import a from './a.mjs';
    import { b, c as d } from "../lib/b.mjs";
    import * as e from 'node:fs';
    import './side.mjs';
    export { f } from './f.mjs';
    export * from './g.mjs';
    export * as h from './h.mjs';
    export const url = 'https://example.com/import x from "./nope.mjs"'; // import y from './comment.mjs'
    /* import z from './block.mjs' */
    const t = \`import q from './template.mjs' \${'import r from "./nested.mjs"'}\`;
    const re = /import s from '.\\/regex.mjs'/;
    const div = 10 / 2 / 1;
    const lazy = await import('./lazy.mjs');
    const computed = await import(name);
    obj.import('./not-a-keyword.mjs');
    const meta = import.meta.url;
    /** @typedef {import('./_types.js').Job} Job */
  `;
  assert.deepEqual(specs(src), ['./a.mjs', '../lib/b.mjs', 'node:fs', './side.mjs', './f.mjs', './g.mjs', './h.mjs', 'dyn:./lazy.mjs', 'dyn:null']);
});

function tree(files: Record<string, string>) {
  return { read: (p: string) => files[p] ?? null, list: () => Object.keys(files).filter((p) => p.startsWith('providers/')), commit: 'b'.repeat(40), license: 'MIT License\n\nCopyright (c) 2026 Example Maintainers\n' };
}

test('closure: helpers, lib and root modules of the allowed providers; npm users and their chain excluded; local-parser never', () => {
  const m = buildManifest(tree({
    'providers/alpha.mjs': `import { get } from './_http.mjs'; export default { id: 'alpha', detect(e) { return null; }, fetch: async () => [] };`,
    'providers/beta.mjs': `import { kw } from './_keywords.mjs'; export default { id: 'beta', fetch: async () => [] };`,
    'providers/gamma.mjs': `import { norm } from '../url-key.mjs'; import { readFileSync } from 'node:fs'; export default { id: 'gamma', fetch: async () => [] };`,
    'providers/local-parser.mjs': `import { execFile } from 'child_process'; export default { id: 'local-parser' };`,
    'providers/_http.mjs': `import { isIP } from 'node:net'; import { ua } from '../user-agent.mjs'; export const get = 1; async function p() { await import('undici'); }`,
    'providers/_keywords.mjs': `import { loadYaml } from '../lib/yaml.mjs'; export const kw = 1;`,
    'providers/_registry.mjs': `import fs from 'fs'; export const all = 1;`,
    'providers/_unused.mjs': `export const x = 1;`,
    'lib/yaml.mjs': `import yaml from 'js-yaml'; export const loadYaml = 1;`,
    'url-key.mjs': `import { parse } from './lib/parse.mjs'; export const norm = 1;`,
    'lib/parse.mjs': `export const parse = 1;`,
    'user-agent.mjs': `export const ua = 'x';`,
  }));
  assert.deepEqual(m.providers, ['alpha', 'gamma']);
  assert.deepEqual(m.detectors, ['alpha']);
  assert.deepEqual(Object.keys(m.files), ['lib/parse.mjs', 'providers/_http.mjs', 'providers/alpha.mjs', 'providers/gamma.mjs', 'url-key.mjs', 'user-agent.mjs']);
  assert.equal(m.files['providers/_unused.mjs'], undefined, 'only what the allowed providers import');
  assert.equal(m.excluded['providers/beta.mjs'], 'imports providers/_keywords.mjs → lib/yaml.mjs (needs the npm package js-yaml)');
  assert.equal(m.excluded['providers/_keywords.mjs'], 'imports lib/yaml.mjs (needs the npm package js-yaml)');
  assert.equal(m.excluded['lib/yaml.mjs'], 'needs the npm package js-yaml');
  assert.match(m.excluded['providers/local-parser.mjs'], /runs local commands/);
  assert.deepEqual(m.optional_imports, { 'providers/_http.mjs': ['undici'] });
  assert.equal(m.license.copyright, 'Copyright (c) 2026 Example Maintainers');
  assert.match(m.files['providers/alpha.mjs'], /^[0-9a-f]{64}$/);
});

test('closure: a computed dynamic import, a denied built-in, an import leaving the repo or an unknown file fail the script', () => {
  const base = { 'providers/_http.mjs': 'export const get = 1;' };
  const fails = (src: string, re: RegExp) => assert.throws(() => buildManifest(tree({ ...base, 'providers/x.mjs': src })), re);
  fails(`const m = await import(someName);`, /dynamic import of a computed specifier/);
  fails(`import { Worker } from 'node:worker_threads';`, /imports node:worker_threads/);
  fails(`import vm from 'vm';`, /imports vm/);
  fails(`import x from '../../outside.mjs';`, /leaves the repository/);
  fails(`import x from './missing.mjs';`, /providers\/missing\.mjs is not in the commit/);
  fails(`import x from './data';`, /has no \.mjs\/\.js extension/);
  // A dynamic npm import outside the reviewed list counts as an npm dependency (the provider is excluded, not run).
  const m = buildManifest(tree({ ...base, 'providers/x.mjs': `async function f() { await import('undici'); }` }));
  assert.match(m.excluded['providers/x.mjs'], /needs the npm package undici/);
});

test('the committed manifest is what the script builds from the pinned commit (when a career-ops checkout is given)', (t) => {
  const checkout = process.env.CAREER_OPS_CHECKOUT;
  if (!checkout || !existsSync(join(checkout, '.git'))) return t.skip('set CAREER_OPS_CHECKOUT to a career-ops checkout to rebuild the manifest');
  const committed = JSON.parse(readFileSync(join(REPO, 'src', 'jobs', 'data', 'providers.manifest.json'), 'utf8'));
  const r = gitReader(checkout, committed.commit);
  assert.deepEqual(buildManifest({ ...r, commit: committed.commit, license: r.read('LICENSE') }), committed);
});
