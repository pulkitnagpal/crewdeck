// The playbooks and the pieces that ship with them: presets validate, every `crewdeck …` command the skills (and the
// generated workspace CLAUDE.md, and the vault's CLAUDE.md) tell Claude to run exists with those flags, and the plugin is
// named crewdeck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO } from './helpers.ts';
import { splitNote } from '../../src/jobs/notes.ts';
import { validate } from '../../src/jobs/schema.ts';
import { JOBS_COMMANDS } from '../../src/jobs/cli.ts';
import { PRESETS, presetSources, workspaceClaudeMd } from '../../src/jobs/setup.ts';
import { PRESET_QUERIES } from '../../src/jobs/suggest.ts';
import { defaults } from '../../src/config.ts';

const SKILLS = join(REPO, 'plugin', 'skills');
const read = (...p: string[]) => readFileSync(join(REPO, ...p), 'utf8');

// ---- presets ----

test('presets (deprecated alias, D39): each one is a valid search.md; sources come from the catalog query, not a file', () => {
  assert.deepEqual(readdirSync(join(REPO, 'presets', 'jobs')).sort(), [...PRESETS].sort());
  for (const p of PRESETS) {
    assert.deepEqual(readdirSync(join(REPO, 'presets', 'jobs', p)), ['search.md'], `${p} has no sources.md any more`);
    const text = read('presets', 'jobs', p, 'search.md');
    const { front } = splitNote(text);
    assert.ok(front, `${p}/search.md has frontmatter`);
    assert.deepEqual(validate('search', parse(front!)).filter((i) => i.level === 'error'), [], `${p}/search.md`);
    assert.doesNotMatch(text, /@(?!example\.)[a-z0-9-]+\.[a-z]/i, `${p}/search.md has no real email`);
    assert.match(text, /\n## Changes\n/, 'a Changes heading for the seeding line');
    assert.ok(Object.hasOwn(PRESET_QUERIES, p), `${p} is a catalog query`);
  }
  // What each preset is for (design §7.7, §24.11).
  const search = (p: string) => parse(splitNote(read('presets', 'jobs', p, 'search.md')).front!);
  assert.deepEqual(search('remote-any-country').workplace, ['remote']);
  assert.ok(search('onsite-city').workplace.includes('onsite'));
  const hc = search('healthcare-us');
  assert.equal(hc.pay.period, 'hour');
  assert.equal(hc.pay.currency, 'USD');
  assert.ok(hc.employment_types.includes('per-diem'));
  assert.ok(hc.roles.titles.length > 0);
  assert.deepEqual(PRESET_QUERIES['healthcare-us'], { families: ['healthcare'], countries: ['us'] });
  assert.deepEqual(PRESET_QUERIES['remote-any-country'], { workplace: ['remote'] });
  // The proposals: real catalog ids, never one of the entries that can't fetch as written (audit 1.4).
  const ids = new Set(JSON.parse(read('src', 'jobs', 'data', 'providers.manifest.json')).providers as string[]);
  for (const p of PRESETS) for (const id of presetSources(p, join(REPO, 'no-such-vault'), '2026-11-20').ids) {
    assert.ok(ids.has(id), `${p}: ${id} is a pinned provider`);
    assert.ok(!['neogov', 'themuse', 'remote-com', 'occ', 'builtin', 'wttj', 'arbeitsagentur', 'jobstreet', 'nofluffjobs', 'justjoin'].includes(id), `${p}: ${id} can't fetch from a preset alone`);
  }
});

// ---- skills ----

const skillNames = () => readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, 'SKILL.md')));

test('skills: the four playbooks, each with a name that matches its folder and a description that says when to use it', () => {
  assert.deepEqual(skillNames().sort(), ['crewdeck-memory', 'jobs-daily-run', 'jobs-setup', 'jobs-workspace']);
  for (const name of skillNames()) {
    const text = read('plugin', 'skills', name, 'SKILL.md');
    const fm = parse(splitNote(text).front!);
    assert.equal(fm.name, name);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 80 && fm.description.length < 1024, `${name} description`);
    assert.match(fm.description, /Use (when|for|in)/, `${name} says when to use it`);
    assert.doesNotMatch(text, /\b[\w.+-]+@(?!example\.)[a-z0-9-]+\.[a-z]{2,}/i, `${name}: no real email`);
    assert.doesNotMatch(text, /\/Users\/|\/home\//, `${name}: no home paths`);
  }
  const ws = read('plugin', 'skills', 'jobs-workspace', 'SKILL.md');
  for (const kind of ['setup', 'find', 'link', 'apply', 'improve', 'source']) assert.match(ws, new RegExp(`^## ${kind}\\b`, 'm'), `jobs-workspace works ${kind}`);
  assert.match(ws, /never click/i);
  assert.match(ws, /needs you: /);
  assert.match(ws, /submitted: /);
  assert.match(ws, /background tab/);
  assert.match(ws, /Not picked \(warning\)/, 'the result the page recognises to offer Add it anyway');
  const daily = read('plugin', 'skills', 'jobs-daily-run', 'SKILL.md');
  assert.match(daily, /batches of 10/);
  assert.match(daily, /light, fast model/);
  assert.match(daily, /candidates --budget 40 --batch 10 --need N --start/);
  assert.match(daily, /run\.done/, 'the skill stops where the budgeted candidates say so');
  assert.match(daily, /judged 20 of 40; 112 left in the pool/, 'the Find result reports judged and remaining');
  assert.match(read('plugin', 'skills', 'crewdeck-memory', 'SKILL.md'), /refilter --days 14/);
});

// ---- the command lint ----

const SRC_TOP = read('src', 'cli.ts');
const SRC_JOBS = read('src', 'jobs', 'cli.ts') + read('src', 'jobs', 'commands.ts') + read('src', 'jobs', 'sources-cmd.ts');
const TOP = ['init', 'up', 'add-project', 'doctor', 'requests', 'request', 'progress', 'jobs'];
/** Commands whose next word is a verb. */
const VERBS = new Set(['me', 'pref', 'request', 'event', 'question', 'linkedin', 'contact', 'message', 'followup', 'view', 'sources']);
const literal = (src: string, w: string) => src.includes(`'${w}'`) || src.includes(`"${w}"`);

/** Every `crewdeck …` command line in a Markdown text: inline code spans and fenced code lines. */
export function commandLines(md: string): string[] {
  const spans: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) spans.push(line);
    else for (const m of line.matchAll(/`([^`]+)`/g)) spans.push(m[1]);
  }
  return spans.flatMap((s) => [...s.matchAll(/(?:^|[\s(])crewdeck\s+([^\n]+)/g)].map((m) => m[1].trim()));
}

/** Problems with one command line (empty = it exists, with those flags). */
export function lintCommand(cmd: string): string[] {
  const t = cmd.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const plain = (w?: string) => !!w && /^[a-z][a-z|-]*$/.test(w);
  const [top] = t;
  if (!plain(top)) return []; // e.g. "crewdeck …" in prose
  for (const c of top.split('|')) if (!TOP.includes(c)) out.push(`unknown command "crewdeck ${c}"`);
  let src = SRC_TOP, rest = t.slice(1);
  if (top === 'jobs') {
    src = SRC_JOBS;
    const [sub, verb] = rest;
    if (!plain(sub)) return out;
    for (const c of sub.split('|')) {
      if (!JOBS_COMMANDS.includes(c)) out.push(`unknown command "crewdeck jobs ${c}"`);
      if (VERBS.has(c) && plain(verb)) for (const v of verb.split('|')) if (!literal(src, v)) out.push(`"crewdeck jobs ${c} ${v}": no such verb`);
    }
    rest = rest.slice(1);
  } else if (top === 'request' && plain(rest[0])) {
    for (const v of rest[0].split('|')) if (!literal(src, v)) out.push(`"crewdeck request ${v}": no such verb`);
  }
  for (const tok of rest) {
    const m = /^--([a-z][a-z-]*)/.exec(tok);
    if (m && !literal(src, m[1]) && !literal(src, `--${m[1]}`)) out.push(`"${cmd}": no flag --${m[1]}`);
  }
  return out;
}

test('the lint itself: it catches an unknown command, verb and flag', () => {
  assert.deepEqual(commandLines('run `crewdeck jobs link --request 3`, then\n```bash\ncrewdeck request done 3 --result-file "$T/r.txt"\n```\nthe `crewdeck` plugin'), ['jobs link --request 3', 'request done 3 --result-file "$T/r.txt"']);
  assert.deepEqual(lintCommand('jobs link --request 3'), []);
  assert.deepEqual(lintCommand('jobs apply-now 3'), ['unknown command "crewdeck jobs apply-now"']);
  assert.deepEqual(lintCommand('jobs pref reset x'), ['"crewdeck jobs pref reset": no such verb']);
  assert.deepEqual(lintCommand('jobs link --request 3 --submit'), ['"jobs link --request 3 --submit": no flag --submit']);
  assert.deepEqual(lintCommand('request close 3'), ['"crewdeck request close": no such verb']);
  assert.deepEqual(lintCommand('jobs me|pref|remember …'), []);
});

test('every crewdeck command in the skills, the generated workspace CLAUDE.md and the vault CLAUDE.md exists', () => {
  const c = defaults();
  c.vault = '/vault';
  c.jobs = { ...c.jobs, home: '/jobs-home', workspace: '/jobs-home' };
  const docs: [string, string][] = [
    ...skillNames().map((n): [string, string] => [`plugin/skills/${n}`, read('plugin', 'skills', n, 'SKILL.md')]),
    ['workspace CLAUDE.md', workspaceClaudeMd(c)],
    ['vault-template/CLAUDE.md', read('vault-template', 'CLAUDE.md')],
  ];
  let seen = 0;
  const problems: string[] = [];
  for (const [where, text] of docs) {
    const lines = commandLines(text);
    seen += lines.length;
    for (const l of lines) for (const p of lintCommand(l)) problems.push(`${where}: ${p}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(seen > 60, `checked ${seen} command lines`);
});

// ---- the plugin ----

test('the plugin is named crewdeck (0.4.0) everywhere; the bridge keeps its token and proof', () => {
  const p = JSON.parse(read('plugin', '.claude-plugin', 'plugin.json'));
  assert.equal(p.name, 'crewdeck');
  assert.equal(p.displayName, 'Crewdeck');
  assert.equal(p.version, '0.4.0');
  const m = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.deepEqual(m.plugins.map((x: any) => x.name), ['crewdeck']);
  const reg = read('plugin', 'hooks', 'register.tsx');
  assert.doesNotMatch(reg + read('plugin', 'types', 'index.d.ts') + read('README.md'), /plugin install crewdeck-bridge|plugin: 'crewdeck-bridge'|'crewdeck-bridge': \{/);
  assert.match(reg, /plugin: 'crewdeck', key: 'busy'/);
  assert.match(reg, /x-crewdeck-token/);
  assert.match(reg, /crewdeck-proof:/);
});

test('W4/C4: the bridge challenges before its token leaves, binds the proof to the port, beats while busy, puts back on start', () => {
  const reg = read('plugin', 'hooks', 'register.tsx');
  assert.match(reg, /'\/api\/hello', \{ nonce: n \}, false\)/, 'hello is sent without the token');
  assert.match(reg, /crewdeck-proof:\$\{token\}:\$\{n\}:\$\{port\}/, 'the proof names the port');
  const post = reg.slice(reg.indexOf('async function post('), reg.indexOf('let lastBeat'));
  assert.match(post, /if \(!\(await verified\(\$, port\)\)\) return null[\s\S]*curl\(\$, port, path, body, true\)/, 'the token is sent only after the proof');
  assert.match(reg, /take: false/, 'a busy session keeps its presence and leases');
  const begin = reg.slice(reg.indexOf('async function begin('));
  assert.match(begin, /'\/api\/requeue', \{ ids: held/, 'what a previous load held goes back on start');
});

test('E3: no heredoc or echo carries untrusted text in the skills, the bridge prompt or the managed CLAUDE.md; C9: the override comes from the request', () => {
  const c = defaults();
  c.vault = '/vault';
  c.jobs = { ...c.jobs, home: '/jobs-home', workspace: '/jobs-home' };
  const texts: [string, string][] = [
    ...skillNames().map((n): [string, string] => [n, read('plugin', 'skills', n, 'SKILL.md')]),
    ['register.tsx', read('plugin', 'hooks', 'register.tsx')], ['workspace CLAUDE.md', workspaceClaudeMd(c)], ['vault CLAUDE.md', read('vault-template', 'CLAUDE.md')],
  ];
  for (const [where, t] of texts) {
    assert.doesNotMatch(t, /<<-?\s*'?EOF|cat > |echo .*>/, `${where}: no heredoc or echo into a file`);
    assert.doesNotMatch(t, /single-quoted heredoc/, `${where}: no heredoc advice`);
  }
  assert.match(read('plugin', 'hooks', 'register.tsx'), /with the Write tool/);
  const ws = read('plugin', 'skills', 'jobs-workspace', 'SKILL.md');
  assert.match(ws, /crewdeck jobs pick --role <role id> --request <id>/, 'pick reads the user\'s override from the request (pass B reads force)');
  assert.doesNotMatch(ws, /pick --role [^`]*--force/);
  assert.doesNotMatch(ws, /\$T\b|mkdir -p/, 'literal paths: the sandbox lets only a plain crewdeck call out');
});
