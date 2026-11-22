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

/**
 * Write a text file for a --*-file flag (the user's words for --because-file / --text-file): in the temp setup's jobs
 * home, `<jobs home>/out/tmp`, the one place `crewdeck jobs` reads files from (E5), like the skills' `<T>`.
 */
export function textFile(root: string, name: string, text: string) {
  const dir = join(root, 'crewdeck', 'jobs', 'out', 'tmp');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

// ---- P2a: a fictional person's vault + a tracker in a temp jobs.home, with a clock tests can move ----
import type { JobsFeatures } from '../../src/config.ts';
import { openJobsDb, upsertRole, type RoleInput } from '../../src/jobs/db.ts';
import { type Ctx, makeCtx } from '../../src/jobs/ctx.ts';

// No live fetch of the planned sources in tests (src/jobs/sources.ts); spawned CLIs and servers inherit it.
process.env.CREWDECK_PLANNED ??= 'off';
process.env.CREWDECK_PORTALS ??= 'off';
// The existing suites pin the cheap score's order (priority, learned, budgets); hybrid ranking has its own tests (search-*.test.ts), which switch it on.
process.env.CREWDECK_HYBRID_RANK ??= 'off';

export type World = ReturnType<typeof tempSetup> & { ctx: Ctx; at: (iso: string) => void };

export function world(person: keyof typeof PEOPLE = 'berlin-analyst', o: { features?: Partial<JobsFeatures>; now?: string } = {}): World {
  const s = tempSetup(person);
  let now = new Date(o.now ?? '2026-11-19T10:00:00Z');
  const ctx = makeCtx({ db: openJobsDb(s.jobsHome), vault: s.vault, home: s.jobsHome, features: o.features, clock: () => now });
  return { ...s, ctx, at: (iso: string) => { now = new Date(iso); } };
}

let n = 0;
/** A role on a fictional company (status new unless set). */
export function role(ctx: Ctx, over: Partial<RoleInput> & { company: string }, status?: string): string {
  const url = over.url ?? `https://jobs.example.com/${encodeURIComponent(over.company)}/${++n}`;
  const { id } = upsertRole(ctx.db, { title: 'Senior Data Analyst', location: 'Berlin', description: '', source: 'board', ...over, url });
  if (status) ctx.db.prepare('update roles set status=? where id=?').run(status, id);
  return id;
}
