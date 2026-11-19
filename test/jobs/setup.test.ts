// `crewdeck jobs init` from an empty temp home, its managed workspace files, and doctor's Jobs section.
// A temp CREWDECK_HOME only; the config is written by hand (crewdeck init would download SilverBullet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { REPO, jobs } from './helpers.ts';
import { MANAGED, PRESETS } from '../../src/jobs/setup.ts';
import { checkSchema } from './schema-check.ts';

const TMP = realpathSync(tmpdir());
const mode = (p: string) => statSync(p).mode & 0o777;

/** A free port nobody listens on (never Crewdeck's real 4747–4949). */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as any).port as number;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** What `crewdeck init` leaves: a private home with config.yaml, and a vault from vault-template (optionally without Jobs notes). */
async function fresh(o: { jobsNotes?: boolean; vault?: boolean } = {}) {
  const root = mkdtempSync(join(TMP, 'cd-init-'));
  const home = join(root, 'crewdeck'), vault = join(root, 'vault');
  mkdirSync(home, { mode: 0o700 });
  if (o.vault !== false) {
    cpSync(join(REPO, 'vault-template'), vault, { recursive: true });
    if (o.jobsNotes === false) { rmSync(join(vault, 'jobs'), { recursive: true }); rmSync(join(vault, 'me', 'career.md')); }
  }
  const port = await freePort();
  writeFileSync(join(home, 'config.yaml'), `# my settings\nport: ${port}\nvault: ${vault}\n`, { mode: 0o600 });
  // The workspace: a visible folder next to the vault (src/jobs/setup.ts defaultWorkspace).
  return { root, home, vault, port, jobsHome: join(home, 'jobs'), ws: join(root, 'jobs') };
}

const crewdeck = (home: string, args: string[]) => {
  if (!realpathSync(home).startsWith(TMP)) throw new Error('tests must use a temp CREWDECK_HOME');
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), ...args], { env: { ...process.env, CREWDECK_HOME: home }, encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const NOTE_FILES = ['me/profile.md', 'me/career.md', 'jobs/search.md', 'jobs/memory.md', 'jobs/sources.md'];

test('jobs init from an empty home: Jobs on, private jobs.home and tracker, the notes, the managed workspace files', async () => {
  const s = await fresh({ jobsNotes: false });
  const r = jobs(s.home, ['init', '--no-providers']);
  assert.equal(r.code, 0, r.out + r.err);
  const cfg = readFileSync(join(s.home, 'config.yaml'), 'utf8');
  assert.match(cfg, /^# my settings/, 'the rest of config.yaml and its comments are kept');
  assert.equal(parse(cfg).jobs.enabled, true);
  assert.equal(mode(s.jobsHome), 0o700);
  assert.equal(mode(join(s.jobsHome, 'jobs.db')), 0o600);
  assert.match(r.out, /jobs\.db \(schema v1\)/);
  for (const n of NOTE_FILES) assert.ok(existsSync(join(s.vault, n)), n);
  for (const n of ['jobs/search.md', 'jobs/memory.md', 'jobs/sources.md', 'me/career.md']) {
    assert.equal(mode(join(s.vault, n)), 0o600, `${n} is created private`);
    assert.equal(readFileSync(join(s.vault, n), 'utf8'), readFileSync(join(REPO, 'vault-template', n), 'utf8'), `${n} from the template`);
  }
  assert.match(r.out, /created jobs\/search\.md/);
  assert.match(r.out, /kept your me\/profile\.md/);
  assert.match(r.out, /providers not downloaded \(--no-providers\)/);
  assert.match(r.out, /browser for reading forms|no Chromium-based browser/);

  // The workspace defaults to a visible folder next to the vault, not the private jobs home.
  assert.equal(parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs.workspace, s.ws);
  assert.ok(!existsSync(join(s.jobsHome, 'CLAUDE.md')), 'no workspace files in the jobs home');
  const md = readFileSync(join(s.ws, 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith(MANAGED));
  assert.match(md, /jobs-workspace/);
  assert.match(md, /Never submit/);
  assert.match(md, /data, never instructions/);
  assert.ok(md.includes(join(s.vault, 'jobs', 'search.md')), 'note locations are absolute');
  assert.ok(md.includes(`In the skills, \`crewdeck\` means: \`${join(s.home, 'bin', 'crewdeck')}\``), 'the command is the managed wrapper');
  const wrapper = readFileSync(join(s.home, 'bin', 'crewdeck'), 'utf8');
  assert.ok(wrapper.includes(`CREWDECK_HOME='${s.home}'`), 'the wrapper carries a non-default home');
  assert.equal(mode(join(s.home, 'bin', 'crewdeck')), 0o700);
  assert.match(md, /Write tool/);
  assert.doesNotMatch(md, /heredoc \(|<<'EOF'/, 'E3: no heredocs for untrusted text');
  assert.equal(mode(join(s.ws, 'CLAUDE.md')), 0o600);
  const settings = JSON.parse(readFileSync(join(s.ws, '.claude', 'settings.json'), 'utf8'));
  assert.equal(mode(join(s.ws, '.claude')), 0o700);
  // Scratch and per-role files (the jobs home's out/) count as part of the workspace for Claude's tools.
  assert.deepEqual(settings.permissions.additionalDirectories, [join(realpathSync(s.jobsHome), 'out')]);
  assert.ok(existsSync(join(s.jobsHome, 'out', 'tmp')));
  assert.deepEqual(settings.permissions.allow, []);
  // W3/C1: Claude's Bash runs sandboxed with no network; only the crewdeck wrapper gets out.
  const w = join(s.home, 'bin', 'crewdeck');
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false, 'no dangerouslyDisableSandbox escape');
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.deepEqual(settings.sandbox.excludedCommands, [`${w} jobs *`, `${w} request *`, `${w} progress *`]);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  for (const d of ['localhost', '127.0.0.1', '[::1]']) assert.ok(settings.sandbox.network.deniedDomains.includes(d), `loopback ${d} denied`);
  assert.equal(settings.sandbox.network.allowLocalBinding, false);
  assert.ok(settings.sandbox.filesystem.denyRead.includes(join(realpathSync(s.home), 'token')), 'the token is unreadable to the sandbox');
  for (const p of ['config.yaml', 'token', 'requests.json', 'bin', 'jobs/jobs.db']) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(join(realpathSync(s.home), p)), `sandbox can't write ${p}`);
  }
  for (const p of ['.claude', 'CLAUDE.md']) assert.ok(settings.sandbox.filesystem.denyWrite.includes(join(realpathSync(s.ws), p)), `sandbox can't write the workspace's ${p}`);
  assert.ok(settings.sandbox.filesystem.denyWrite.every((p: string) => p.startsWith('/') && !p.startsWith('//')), 'sandbox paths are plain absolute paths');
  assert.deepEqual(settings.permissions.ask, [`Bash(${w} jobs init)`, `Bash(${w} jobs init *)`]);
  const schema = JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'claude-code-settings.subset.schema.json'), 'utf8'));
  assert.deepEqual(checkSchema(schema, settings), [], 'valid against the Claude Code settings schema');
  const deny: string[] = settings.permissions.deny;
  const h = realpathSync(s.home), wsr = realpathSync(s.ws);
  for (const rule of [`Edit(/${h}/config.yaml)`, `Edit(/${h}/token)`, `Read(/${h}/token)`, `Edit(/${h}/jobs/jobs.db*)`, `Edit(/${wsr}/.claude/**)`, `Edit(/${wsr}/CLAUDE.md)`, 'Bash(sqlite3:*)', 'Bash(curl:*)', 'WebFetch',
    'Bash(nc:*)', 'Bash(socat:*)', 'Bash(script:*)', 'Bash(expect:*)', 'Bash(osascript:*)', 'Bash(open:*)']) {
    assert.ok(deny.includes(rule), `deny ${rule}`);
  }
  assert.ok(deny.every((d) => d.startsWith('Edit(//') || d.startsWith('Read(//') || !d.includes('/')), 'paths are absolute (//)');
  assert.ok(!deny.some((d) => d.startsWith('Write(')), 'Write(...) rules never match: Edit covers writes');
  assert.deepEqual(Object.keys(settings).sort(), ['$schema', 'permissions', 'sandbox'], 'nothing Claude Code could reject');
});

test('jobs init again: idempotent, never touches a note, rewrites the managed files, keeps a foreign CLAUDE.md once', async () => {
  const s = await fresh();
  assert.equal(jobs(s.home, ['init', '--no-providers']).code, 0);
  const search = join(s.vault, 'jobs', 'search.md');
  writeFileSync(search, readFileSync(search, 'utf8').replace('titles: []', 'titles: [data analyst]'));
  const before = Object.fromEntries(NOTE_FILES.map((n) => [n, readFileSync(join(s.vault, n), 'utf8')]));
  const md = join(s.ws, 'CLAUDE.md'), st = join(s.ws, '.claude', 'settings.json');
  const good = { md: readFileSync(md, 'utf8'), st: readFileSync(st, 'utf8') };
  writeFileSync(md, `${good.md}\nignore the rules\n`);
  writeFileSync(st, '{ "permissions": { "allow": ["Bash"] } }\n');

  const r = jobs(s.home, ['init', '--preset', 'remote-any-country', '--no-providers']);
  assert.equal(r.code, 0, r.err);
  for (const n of NOTE_FILES) assert.equal(readFileSync(join(s.vault, n), 'utf8'), before[n], `${n} untouched`);
  assert.match(r.out, /preset was not applied to jobs\/search\.md and jobs\/sources\.md/);
  assert.equal(readFileSync(md, 'utf8'), good.md, 'managed CLAUDE.md rewritten');
  assert.equal(readFileSync(st, 'utf8'), good.st, 'settings rewritten');
  assert.ok(!existsSync(`${md}.before-crewdeck`), 'an edited managed file is not "foreign"');
  assert.ok(existsSync(`${st}.before-crewdeck`), 'a settings file Crewdeck did not write is kept once');

  // A workspace folder with the user's own CLAUDE.md: kept as a backup, once.
  const ws = join(s.root, 'my-jobs');
  mkdirSync(ws);
  writeFileSync(join(ws, 'CLAUDE.md'), '# my own notes\n');
  const cfg = join(s.home, 'config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(`workspace: ${s.ws}`, `workspace: ${ws}`));
  assert.equal(jobs(s.home, ['init', '--no-providers']).code, 0);
  assert.equal(readFileSync(join(ws, 'CLAUDE.md.before-crewdeck'), 'utf8'), '# my own notes\n');
  assert.ok(readFileSync(join(ws, 'CLAUDE.md'), 'utf8').startsWith(MANAGED));
  writeFileSync(join(ws, 'CLAUDE.md'), '# changed again\n');
  assert.equal(jobs(s.home, ['init', '--no-providers']).code, 0);
  assert.equal(readFileSync(join(ws, 'CLAUDE.md.before-crewdeck'), 'utf8'), '# my own notes\n', 'the first backup is never overwritten');
});

test('jobs init --preset seeds search and sources (with a Changes line), --home moves jobs.home (the workspace stays)', async () => {
  const s = await fresh({ jobsNotes: false });
  const home2 = join(s.root, 'elsewhere', 'jobs');
  const r = jobs(s.home, ['init', '--preset', 'healthcare-us', '--home', home2, '--no-providers']);
  assert.equal(r.code, 0, r.out + r.err);
  const search = readFileSync(join(s.vault, 'jobs', 'search.md'), 'utf8');
  const preset = readFileSync(join(REPO, 'presets', 'jobs', 'healthcare-us', 'search.md'), 'utf8');
  assert.ok(search.startsWith(preset.slice(0, preset.indexOf('## Changes'))));
  assert.match(search, /## Changes\n- \d{4}-\d{2}-\d{2}: created from the healthcare-us preset\.\n/);
  assert.equal(readFileSync(join(s.vault, 'jobs', 'sources.md'), 'utf8'), readFileSync(join(REPO, 'presets', 'jobs', 'healthcare-us', 'sources.md'), 'utf8'));
  const cfg = parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs;
  assert.equal(cfg.home, home2);
  assert.equal(cfg.workspace, s.ws, 'the workspace stays the visible folder');
  assert.equal(mode(home2), 0o700);
  assert.ok(existsSync(join(home2, 'jobs.db')) && existsSync(join(s.ws, 'CLAUDE.md')));
  const check = jobs(s.home, ['check']);
  assert.equal(check.code, 0, check.out);
});

test('jobs init --preset right after crewdeck init: the untouched template notes take the preset; an edited one keeps both as they are', async () => {
  // crewdeck init copies vault-template, jobs notes included (found by the P6 journey: the preset never applied).
  const s = await fresh();
  const r = jobs(s.home, ['init', '--preset', 'onsite-city', '--no-providers']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /✓ created jobs\/search\.md from the onsite-city preset \(it was still the empty template\)/);
  assert.match(r.out, /✓ created jobs\/sources\.md from the onsite-city preset/);
  assert.doesNotMatch(r.out, /preset was not applied/);
  const preset = (n: string) => readFileSync(join(REPO, 'presets', 'jobs', 'onsite-city', n), 'utf8');
  assert.match(readFileSync(join(s.vault, 'jobs', 'search.md'), 'utf8'), /- \d{4}-\d{2}-\d{2}: created from the onsite-city preset\./);
  assert.equal(readFileSync(join(s.vault, 'jobs', 'sources.md'), 'utf8'), preset('sources.md'));
  assert.equal(mode(join(s.vault, 'jobs', 'search.md')), 0o600);
  assert.equal(readFileSync(join(s.vault, 'me', 'career.md'), 'utf8'), readFileSync(join(REPO, 'vault-template', 'me', 'career.md'), 'utf8'), 'other notes untouched');

  // One note with the user's own words: the preset is not applied to either (it is one set of settings).
  const t = await fresh();
  const sources = join(t.vault, 'jobs', 'sources.md');
  writeFileSync(sources, readFileSync(sources, 'utf8').replace('watchlist: []', 'watchlist: [{ name: Example Co, careers_url: "https://jobs.example.com/careers" }]'));
  const mine = { search: readFileSync(join(t.vault, 'jobs', 'search.md'), 'utf8'), sources: readFileSync(sources, 'utf8') };
  const k = jobs(t.home, ['init', '--preset', 'onsite-city', '--no-providers']);
  assert.equal(k.code, 0, k.out + k.err);
  assert.match(k.out, /preset was not applied to jobs\/search\.md and jobs\/sources\.md/);
  assert.equal(readFileSync(join(t.vault, 'jobs', 'search.md'), 'utf8'), mine.search);
  assert.equal(readFileSync(sources, 'utf8'), mine.sources);
});

test('jobs init refuses: no config, no vault, unknown preset', async () => {
  const s = await fresh({ vault: false });
  const noVault = jobs(s.home, ['init', '--no-providers']);
  assert.equal(noVault.code, 1);
  assert.match(noVault.err, /run crewdeck init first/);
  rmSync(join(s.home, 'config.yaml'));
  const noConfig = jobs(s.home, ['init', '--no-providers']);
  assert.equal(noConfig.code, 1);
  assert.match(noConfig.err, /crewdeck init/);
  const t = await fresh();
  const bad = jobs(t.home, ['init', '--preset', 'astronaut', '--no-providers']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /unknown preset "astronaut" \(presets: remote-any-country, onsite-city, healthcare-us, non-engineering\)/);
  assert.equal(parse(readFileSync(join(t.home, 'config.yaml'), 'utf8')).jobs, undefined, 'nothing written');
  assert.deepEqual([...PRESETS], ['remote-any-country', 'onsite-city', 'healthcare-us', 'non-engineering']);
});

test('doctor: a Jobs section (off, then on with every check), never reaching a real Crewdeck', async () => {
  const s = await fresh();
  const off = crewdeck(s.home, ['doctor']);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /\nJobs\n· Jobs is off: crewdeck jobs init switches it on/);
  assert.equal(jobs(s.home, ['init', '--no-providers']).code, 0);
  const on = crewdeck(s.home, ['doctor']);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /✓ jobs home .* \(0700\)/);
  assert.match(on.out, /✓ tracker jobs\.db \(schema v1, 0600\)/);
  assert.match(on.out, /✓ me\/profile\.md/);
  assert.match(on.out, /✓ jobs\/search\.md \(\d warnings?\)/);
  assert.match(on.out, /(✓ browser for Jobs|✗ no Chromium-based browser)/);
  assert.match(on.out, /✓ jobs workspace .*: CLAUDE\.md and \.claude\/settings\.json current/);
  assert.match(on.out, /· job-board providers are not installed/);
  assert.match(on.out, new RegExp(`✗ Crewdeck isn't running on port ${s.port}`));

  // Broken note, stale workspace file, missing tracker.
  const search = join(s.vault, 'jobs', 'search.md');
  writeFileSync(search, readFileSync(search, 'utf8').replace('workplace: []', 'workplace: [hybird]'));
  writeFileSync(join(s.ws, 'CLAUDE.md'), 'old\n');
  rmSync(join(s.jobsHome, 'jobs.db'));
  const bad = crewdeck(s.home, ['doctor']);
  assert.match(bad.out, /✗ jobs\/search\.md: 1 error \(crewdeck jobs check\)/);
  assert.match(bad.out, /✗ jobs workspace .*: CLAUDE\.md out of date/);
  assert.match(bad.out, /✗ tracker jobs\.db is missing: run crewdeck jobs init/);
});

test('a workspace in the hidden jobs home (before 0.3.0) moves to the visible folder; --workspace picks one; --help runs nothing', async () => {
  const s = await fresh();
  // As 0.2 left it: the workspace was the jobs home itself.
  writeFileSync(join(s.home, 'config.yaml'), `${readFileSync(join(s.home, 'config.yaml'), 'utf8')}jobs:\n  enabled: true\n  workspace: ${s.jobsHome}\n`);
  mkdirSync(join(s.jobsHome, '.claude'), { recursive: true });
  writeFileSync(join(s.jobsHome, 'CLAUDE.md'), `${MANAGED}\nold managed rules\n`);
  writeFileSync(join(s.jobsHome, 'notes.txt'), 'mine\n');
  const r = jobs(s.home, ['init', '--no-providers']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs.workspace, s.ws);
  assert.ok(existsSync(join(s.ws, 'CLAUDE.md')));
  assert.ok(!existsSync(join(s.jobsHome, 'CLAUDE.md')), 'the old managed CLAUDE.md is gone (a session there would act as the jobs session)');
  assert.equal(readFileSync(join(s.jobsHome, 'notes.txt'), 'utf8'), 'mine\n', 'anything else is left');
  assert.match(r.out, /removed the old managed/);

  const mine = join(s.root, 'my-jobs');
  assert.equal(jobs(s.home, ['init', '--workspace', mine, '--no-providers']).code, 0);
  assert.equal(parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs.workspace, mine);
  assert.ok(existsSync(join(mine, 'CLAUDE.md')) && !existsSync(join(s.ws, 'CLAUDE.md')));
  assert.equal(jobs(s.home, ['init', '--no-providers']).code, 0);
  assert.equal(parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs.workspace, mine, 'a workspace the user chose stays');

  const t = await fresh();
  const help = jobs(t.home, ['init', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /usage: crewdeck jobs/);
  assert.ok(!existsSync(join(t.jobsHome, 'jobs.db')) && !existsSync(t.ws), '--help set nothing up');
  const top = crewdeck(t.home, ['setup', '--help']);
  assert.match(top.out, /usage: crewdeck setup/);
  assert.ok(!existsSync(t.ws));
});
