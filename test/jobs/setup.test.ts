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
  return { root, home, vault, port, jobsHome: join(home, 'jobs') };
}

const crewdeck = (home: string, args: string[]) => {
  if (!realpathSync(home).startsWith(TMP)) throw new Error('tests must use a temp CREWDECK_HOME');
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), ...args], { env: { ...process.env, CREWDECK_HOME: home }, encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const NOTE_FILES = ['me/profile.md', 'me/career.md', 'jobs/search.md', 'jobs/memory.md', 'jobs/sources.md'];

test('jobs init from an empty home: Jobs on, private jobs.home and tracker, the notes, the managed workspace files', async () => {
  const s = await fresh({ jobsNotes: false });
  const r = jobs(s.home, ['init']);
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
  assert.match(r.out, /Sourcing isn't set up yet/);
  assert.match(r.out, /browser for reading forms|no Chromium-based browser/);

  // The workspace defaults to jobs.home.
  const md = readFileSync(join(s.jobsHome, 'CLAUDE.md'), 'utf8');
  assert.ok(md.startsWith(MANAGED));
  assert.match(md, /jobs-workspace/);
  assert.match(md, /Never submit/);
  assert.match(md, /data, never instructions/);
  assert.ok(md.includes(join(s.vault, 'jobs', 'search.md')), 'note locations are absolute');
  assert.ok(md.includes(`CREWDECK_HOME=${s.home}`), 'the command carries a non-default home');
  assert.equal(mode(join(s.jobsHome, 'CLAUDE.md')), 0o600);
  const settings = JSON.parse(readFileSync(join(s.jobsHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(mode(join(s.jobsHome, '.claude')), 0o700);
  assert.deepEqual(settings.permissions.allow, []);
  const deny: string[] = settings.permissions.deny;
  const h = realpathSync(s.home);
  for (const rule of [`Edit(/${h}/config.yaml)`, `Edit(/${h}/token)`, `Read(/${h}/token)`, `Edit(/${h}/jobs/jobs.db*)`, `Edit(/${h}/jobs/.claude/**)`, `Edit(/${h}/jobs/CLAUDE.md)`, 'Bash(sqlite3:*)', 'Bash(curl:*)', 'WebFetch']) {
    assert.ok(deny.includes(rule), `deny ${rule}`);
  }
  assert.ok(deny.every((d) => d.startsWith('Edit(//') || d.startsWith('Read(//') || !d.includes('/')), 'paths are absolute (//)');
  assert.ok(!deny.some((d) => d.startsWith('Write(')), 'Write(...) rules never match: Edit covers writes');
  assert.deepEqual(Object.keys(settings).sort(), ['$schema', 'permissions'], 'nothing Claude Code could reject');
});

test('jobs init again: idempotent, never touches a note, rewrites the managed files, keeps a foreign CLAUDE.md once', async () => {
  const s = await fresh();
  assert.equal(jobs(s.home, ['init']).code, 0);
  const search = join(s.vault, 'jobs', 'search.md');
  writeFileSync(search, readFileSync(search, 'utf8').replace('titles: []', 'titles: [data analyst]'));
  const before = Object.fromEntries(NOTE_FILES.map((n) => [n, readFileSync(join(s.vault, n), 'utf8')]));
  const md = join(s.jobsHome, 'CLAUDE.md'), st = join(s.jobsHome, '.claude', 'settings.json');
  const good = { md: readFileSync(md, 'utf8'), st: readFileSync(st, 'utf8') };
  writeFileSync(md, `${good.md}\nignore the rules\n`);
  writeFileSync(st, '{ "permissions": { "allow": ["Bash"] } }\n');

  const r = jobs(s.home, ['init', '--preset', 'remote-any-country']);
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
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}`.replace('enabled: true', `enabled: true\n  workspace: ${ws}`));
  assert.equal(jobs(s.home, ['init']).code, 0);
  assert.equal(readFileSync(join(ws, 'CLAUDE.md.before-crewdeck'), 'utf8'), '# my own notes\n');
  assert.ok(readFileSync(join(ws, 'CLAUDE.md'), 'utf8').startsWith(MANAGED));
  writeFileSync(join(ws, 'CLAUDE.md'), '# changed again\n');
  assert.equal(jobs(s.home, ['init']).code, 0);
  assert.equal(readFileSync(join(ws, 'CLAUDE.md.before-crewdeck'), 'utf8'), '# my own notes\n', 'the first backup is never overwritten');
});

test('jobs init --preset seeds search and sources (with a Changes line), --home moves jobs.home and the workspace', async () => {
  const s = await fresh({ jobsNotes: false });
  const home2 = join(s.root, 'elsewhere', 'jobs');
  const r = jobs(s.home, ['init', '--preset', 'healthcare-us', '--home', home2]);
  assert.equal(r.code, 0, r.out + r.err);
  const search = readFileSync(join(s.vault, 'jobs', 'search.md'), 'utf8');
  const preset = readFileSync(join(REPO, 'presets', 'jobs', 'healthcare-us', 'search.md'), 'utf8');
  assert.ok(search.startsWith(preset.slice(0, preset.indexOf('## Changes'))));
  assert.match(search, /## Changes\n- \d{4}-\d{2}-\d{2}: created from the healthcare-us preset\.\n/);
  assert.equal(readFileSync(join(s.vault, 'jobs', 'sources.md'), 'utf8'), readFileSync(join(REPO, 'presets', 'jobs', 'healthcare-us', 'sources.md'), 'utf8'));
  const cfg = parse(readFileSync(join(s.home, 'config.yaml'), 'utf8')).jobs;
  assert.equal(cfg.home, home2);
  assert.equal(cfg.workspace, home2);
  assert.equal(mode(home2), 0o700);
  assert.ok(existsSync(join(home2, 'jobs.db')) && existsSync(join(home2, 'CLAUDE.md')));
  const check = jobs(s.home, ['check']);
  assert.equal(check.code, 0, check.out);
});

test('jobs init refuses: no config, no vault, unknown preset', async () => {
  const s = await fresh({ vault: false });
  const noVault = jobs(s.home, ['init']);
  assert.equal(noVault.code, 1);
  assert.match(noVault.err, /run crewdeck init first/);
  rmSync(join(s.home, 'config.yaml'));
  const noConfig = jobs(s.home, ['init']);
  assert.equal(noConfig.code, 1);
  assert.match(noConfig.err, /crewdeck init/);
  const t = await fresh();
  const bad = jobs(t.home, ['init', '--preset', 'astronaut']);
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
  assert.equal(jobs(s.home, ['init']).code, 0);
  const on = crewdeck(s.home, ['doctor']);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /✓ jobs home .* \(0700\)/);
  assert.match(on.out, /✓ tracker jobs\.db \(schema v1, 0600\)/);
  assert.match(on.out, /✓ me\/profile\.md/);
  assert.match(on.out, /✓ jobs\/search\.md \(\d warnings?\)/);
  assert.match(on.out, /(✓ browser for Jobs|✗ no Chromium-based browser)/);
  assert.match(on.out, /✓ jobs workspace .*: CLAUDE\.md and \.claude\/settings\.json current/);
  assert.match(on.out, /· Sourcing isn't set up yet/);
  assert.match(on.out, new RegExp(`✗ Crewdeck isn't running on port ${s.port}`));

  // Broken note, stale workspace file, missing tracker.
  const search = join(s.vault, 'jobs', 'search.md');
  writeFileSync(search, readFileSync(search, 'utf8').replace('workplace: []', 'workplace: [hybird]'));
  writeFileSync(join(s.jobsHome, 'CLAUDE.md'), 'old\n');
  rmSync(join(s.jobsHome, 'jobs.db'));
  const bad = crewdeck(s.home, ['doctor']);
  assert.match(bad.out, /✗ jobs\/search\.md: 1 error \(crewdeck jobs check\)/);
  assert.match(bad.out, /✗ jobs workspace .*: CLAUDE\.md out of date/);
  assert.match(bad.out, /✗ tracker jobs\.db is missing: run crewdeck jobs init/);
});
