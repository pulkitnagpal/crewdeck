// Test helpers for Jobs: fictional people copied into temp vaults, and the CLI run with a temp CREWDECK_HOME.
// Never the real ~/.crewdeck or vault.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..', '..');
export const PEOPLE: Record<string, string> = {
  example: join(REPO, 'examples', 'jobs'),
  'berlin-analyst': join(REPO, 'test', 'fixtures', 'jobs', 'people', 'berlin-analyst'),
  'us-nurse': join(REPO, 'test', 'fixtures', 'jobs', 'people', 'us-nurse'),
  template: join(REPO, 'vault-template'),
};

const TMP = realpathSync(tmpdir());

/** A temp Crewdeck home + vault with one fictional person's notes, and a config.yaml pointing at them. */
export function tempSetup(person?: keyof typeof PEOPLE) {
  const root = mkdtempSync(join(TMP, 'cd-jobs-'));
  const home = join(root, 'crewdeck'), vault = join(root, 'vault');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(vault, { recursive: true });
  if (person) for (const d of ['me', 'jobs']) cpSync(join(PEOPLE[person], d), join(vault, d), { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `vault: ${vault}\njobs:\n  home: ${join(home, 'jobs')}\n`, { mode: 0o600 });
  return { root, home, vault, jobsHome: join(home, 'jobs') };
}

/** Run `crewdeck jobs …` in a child process, stdin piped (so never a TTY, like an agent's shell). */
export function jobs(home: string, args: string[], input = '') {
  if (!realpathSync(home).startsWith(TMP)) throw new Error('tests must use a temp CREWDECK_HOME');
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', ...args], {
    env: { ...process.env, CREWDECK_HOME: home }, input, encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Write a text file in the temp root (the user's words for --because-file / --text-file). */
export function textFile(root: string, name: string, text: string) {
  const p = join(root, name);
  writeFileSync(p, text);
  return p;
}
