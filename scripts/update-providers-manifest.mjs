#!/usr/bin/env node
// Build src/jobs/data/providers.manifest.json from a career-ops checkout at a pinned commit (design §15, D7).
//
//   node scripts/update-providers-manifest.mjs <career-ops checkout> <commit> [--out <file>]
//
// Files are read from git at <commit> (`git show <commit>:<path>`), never from the working tree, so the hashes are those
// raw.githubusercontent.com serves for that commit. The checkout is only read. No network.
//
// What goes in: every provider (providers/*.mjs not starting with "_") that isn't excluded, and the full import closure of
// those providers (helpers, lib/ and root modules), each with its sha256. What stays out, with the reason: providers that
// run local commands, and anything whose closure needs an npm package. The script fails on any bare import that is not
// a Node built-in, and on a dynamic import whose specifier isn't a plain string, unless the file is excluded first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'career-ops-hq/career-ops';

/** Never allowed, whatever they import (reviewed by hand). */
export const EXCLUDE = {
  'providers/local-parser.mjs': 'runs local commands (child_process.execFile)',
  'providers/_registry.mjs': 'imports every file in a folder; the runner imports providers by id instead',
};

/**
 * Dynamic imports of npm packages that are allowed to stay in the closure because the runner never reaches them: both
 * load undici only for a trusted proxy (CAREER_OPS_TRUST_PROXY_EGRESS=1 + proxy variables) or a connection scope that
 * the runner doesn't open. The runner's environment is empty and its resolve hook refuses the package anyway.
 */
export const OPTIONAL_DYNAMIC = {
  'providers/_http.mjs': ['undici'],
  'providers/_connection-scope.mjs': ['undici'],
};

/** Built-ins a provider has no business with; the closure must not import them (the runner's hook refuses them too). */
export const DENIED_BUILTINS = ['child_process', 'cluster', 'worker_threads', 'inspector', 'wasi', 'repl', 'vm', 'v8', 'module', 'trace_events', 'sqlite', 'http2'];
const bare = (s) => s.replace(/^node:/, '').split('/')[0];

/**
 * The import specifiers of one ES module: static `import … from`, `import '…'`, `export … from`, and dynamic `import(…)`.
 * A small lexer skips comments, strings, template literals and regex literals, so a URL in a string or a commented-out
 * import is never taken for one. Dynamic imports whose argument isn't one plain string come back as `{ dynamic: true,
 * spec: null }`.
 */
export function importsOf(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = ''; // last significant token (for regex-vs-division)
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const skipWs = (j) => {
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (src.startsWith('//', j)) { while (j < n && src[j] !== '\n') j++; continue; }
      if (src.startsWith('/*', j)) { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
      return j;
    }
  };
  const readString = (j) => { // src[j] is ' or "
    const q = src[j];
    let s = '';
    j++;
    while (j < n && src[j] !== q) {
      if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
      if (src[j] === '\n') break;
      s += src[j++];
    }
    return { s, end: j + 1 };
  };
  const skipTemplate = (j) => { // src[j] is `
    j++;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue; }
      if (src.startsWith('${', j)) {
        let depth = 1; j += 2;
        while (j < n && depth) {
          const c = src[j];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '\'' || c === '"') { j = readString(j).end; continue; }
          else if (c === '`') { j = skipTemplate(j); continue; }
          j++;
        }
        continue;
      }
      j++;
    }
    return j + 1;
  };
  const skipRegex = (j) => { // src[j] is /
    j++;
    let cls = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') break;
      if (cls) { if (c === ']') cls = false; }
      else if (c === '[') cls = true;
      else if (c === '/') { j++; break; }
      j++;
    }
    while (j < n && isId(src[j])) j++;
    return j;
  };
  const regexAllowedAfter = (t) => t === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(t) || ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', '=>'].includes(t);

  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '\'' || c === '"') { i = readString(i).end; prev = 'str'; continue; }
    if (c === '`') { i = skipTemplate(i); prev = 'str'; continue; }
    if (c === '/') {
      if (regexAllowedAfter(prev)) { i = skipRegex(i); prev = 'str'; continue; }
      i++; prev = '/'; continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      const word = src.slice(i, j);
      const before = src[i - 1];
      const member = before === '.' && src[i - 2] !== '.'; // obj.import is not a keyword
      if (!member && word === 'import') {
        const k = skipWs(j);
        if (src[k] === '(') { // dynamic import
          const a = skipWs(k + 1);
          if (src[a] === '\'' || src[a] === '"') {
            const { s, end } = readString(a);
            const after = skipWs(end);
            out.push({ spec: src[after] === ')' || src[after] === ',' ? s : null, dynamic: true });
          } else out.push({ spec: null, dynamic: true });
          i = k + 1; prev = '('; continue;
        }
        if (src[k] === '.') { i = k + 1; prev = '.'; continue; } // import.meta
        if (src[k] === '\'' || src[k] === '"') { const { s, end } = readString(k); out.push({ spec: s, dynamic: false }); i = end; prev = 'str'; continue; }
        // import … from '…': scan to the `from` keyword at this statement's top level
        let m = k;
        while (m < n) {
          m = skipWs(m);
          if (src[m] === '\'' || src[m] === '"') break;
          if (src[m] === ';') break;
          if (src.startsWith('from', m) && !isId(src[m + 4] ?? '') && !isId(src[m - 1] ?? '')) {
            const q = skipWs(m + 4);
            if (src[q] === '\'' || src[q] === '"') { const { s, end } = readString(q); out.push({ spec: s, dynamic: false }); m = end; }
            break;
          }
          m++;
        }
        i = m; prev = 'str'; continue;
      }
      if (!member && word === 'export') {
        // export … from '…' (re-exports); other exports are plain declarations
        let m = skipWs(j);
        if (src[m] === '*' || src[m] === '{') {
          let depth = 0;
          while (m < n) {
            const ch = src[m];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { m++; break; } }
            else if (ch === '*' && depth === 0) { m++; const p = skipWs(m); if (src.startsWith('as', p)) { m = skipWs(p + 2); while (m < n && isId(src[m])) m++; } break; }
            m++;
          }
          const f = skipWs(m);
          if (src.startsWith('from', f)) {
            const q = skipWs(f + 4);
            if (src[q] === '\'' || src[q] === '"') { const { s, end } = readString(q); out.push({ spec: s, dynamic: false }); i = end; prev = 'str'; continue; }
          }
          i = m; prev = '}'; continue;
        }
      }
      i = j; prev = word; continue;
    }
    prev = c === ')' || c === ']' ? 'str' : c; // after ) or ] a / is division
    i++;
  }
  return out;
}

/** A relative specifier from `file` (repo-relative, posix), or null when it leaves the repo. */
export function resolveRel(file, spec) {
  const p = posix.normalize(posix.join(posix.dirname(file), spec));
  return p.startsWith('../') || p.startsWith('/') ? null : p;
}

/**
 * The manifest's content, from a reader over the commit's tree.
 * `read(path)` returns the file's text (null when missing); `list()` returns every repo path under providers/.
 */
export function buildManifest({ read, list, commit, license }) {
  const providerFiles = list().filter((p) => /^providers\/[^_/][^/]*\.mjs$/.test(p)).sort();
  const excluded = { ...EXCLUDE };
  const optional = {};
  const errors = [];
  const cache = new Map();

  /** One file's imports, checked: { files: [repo paths], npm: [packages], bad: [reasons] }. */
  function scan(file) {
    if (cache.has(file)) return cache.get(file);
    const text = read(file);
    const r = { files: [], npm: [], bad: [] };
    if (text == null) { r.bad.push(`${file} is not in the commit`); cache.set(file, r); return r; }
    for (const im of importsOf(text)) {
      if (im.spec === null) { r.bad.push(`${file}: dynamic import of a computed specifier`); continue; }
      if (im.spec.startsWith('.')) {
        const target = resolveRel(file, im.spec);
        if (!target) { r.bad.push(`${file}: ${im.spec} leaves the repository`); continue; }
        if (!/\.(mjs|js|json)$/.test(target)) { r.bad.push(`${file}: ${im.spec} has no .mjs/.js extension`); continue; }
        r.files.push(target);
        continue;
      }
      if (isBuiltin(im.spec)) {
        if (DENIED_BUILTINS.includes(bare(im.spec))) r.bad.push(`${file}: imports ${im.spec}`);
        continue;
      }
      if (im.dynamic && OPTIONAL_DYNAMIC[file]?.includes(im.spec)) { (optional[file] ??= new Set()).add(im.spec); continue; }
      r.npm.push(im.spec);
    }
    cache.set(file, r);
    return r;
  }

  /** The closure of one provider, or why it can't be used (with the import chain that leads there). */
  function closure(start) {
    const parent = new Map([[start, null]]);
    const chain = (f) => { const c = []; for (let x = f; x; x = parent.get(x)) c.unshift(x); return c; };
    const stack = [start];
    while (stack.length) {
      const f = stack.pop();
      if (excluded[f] && f !== start) return { why: `imports ${f} (${excluded[f]})`, chain: chain(f) };
      const r = scan(f);
      if (r.npm.length) return { why: `needs the npm package ${r.npm.join(', ')}`, chain: chain(f) };
      if (r.bad.length) return { why: r.bad.join('; '), fatal: true };
      for (const t of r.files) if (!parent.has(t)) { parent.set(t, f); stack.push(t); }
    }
    return { files: new Set(parent.keys()) };
  }

  const files = new Set();
  const allowed = [];
  const cause = new Map(); // excluded file → { chain to the culprit, why }
  for (const p of providerFiles) {
    if (excluded[p]) continue;
    const c = closure(p);
    if (c.why) {
      if (c.fatal) { errors.push(c.why); continue; }
      // The provider and every helper on the way to the culprit are out, each naming the import chain and the cause.
      const end = c.chain.at(-1);
      const root = cause.get(end) ?? { chain: [end], why: excluded[end] && end !== p ? excluded[end] : c.why };
      const full = [...c.chain.slice(0, -1), ...root.chain];
      for (let k = full.length - 1; k >= 0; k--) {
        const f = full[k];
        if (excluded[f]) continue;
        excluded[f] = k === full.length - 1 ? root.why : `imports ${full.slice(k + 1).join(' → ')} (${root.why})`;
        cause.set(f, { chain: full.slice(k), why: root.why });
      }
      continue;
    }
    allowed.push(p);
    for (const f of c.files) files.add(f);
  }
  if (errors.length) throw new Error(`the closure has imports the sandbox can't allow:\n  ${[...new Set(errors)].join('\n  ')}`);

  const sha = (t) => createHash('sha256').update(t).digest('hex');
  const sorted = [...files].sort();
  const id = (p) => posix.basename(p, '.mjs');
  return {
    repo: REPO,
    commit,
    license: { spdx: 'MIT', copyright: (license.match(/^Copyright .*$/m) ?? [''])[0].trim(), text: license, file: 'LICENSE', sha256: sha(license) },
    providers: allowed.map(id).sort(),
    // Providers that can claim a careers_url entry (their default export has detect); career-ops tries them in this order.
    detectors: allowed.filter((p) => /\bdetect\s*(\(|:)/.test(read(p))).map(id).sort(),
    files: Object.fromEntries(sorted.map((p) => [p, sha(read(p))])),
    optional_imports: Object.fromEntries(Object.entries(optional).filter(([f]) => files.has(f)).map(([f, s]) => [f, [...s].sort()])),
    excluded: Object.fromEntries(Object.entries(excluded).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Readers over `git show <commit>:<path>` in a checkout (read only). */
export function gitReader(checkout, commit) {
  const git = (...a) => execFileSync('git', ['-C', checkout, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const all = git('ls-tree', '-r', '--name-only', commit).split('\n').filter(Boolean);
  const set = new Set(all);
  return {
    list: () => all.filter((p) => p.startsWith('providers/')),
    read: (p) => (set.has(p) ? git('show', `${commit}:${p}`) : null),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'jobs', 'data', 'providers.manifest.json');
  const [checkout, commit] = args;
  if (!checkout || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
    console.error('usage: node scripts/update-providers-manifest.mjs <career-ops checkout> <40-character commit> [--out <file>]');
    process.exit(2);
  }
  try {
    const r = gitReader(checkout, commit);
    const license = r.read('LICENSE');
    if (!license || !/MIT License/.test(license)) throw new Error('LICENSE at that commit is not the MIT licence');
    const m = buildManifest({ ...r, commit, license });
    writeFileSync(out, `${JSON.stringify(m, null, 1)}\n`);
    console.log(`${out}: ${m.providers.length} providers, ${Object.keys(m.files).length} files, ${Object.keys(m.excluded).length} excluded`);
    for (const [p, why] of Object.entries(m.excluded)) console.log(`  excluded ${p}: ${why}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
