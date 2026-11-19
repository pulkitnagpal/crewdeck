// Per-user configuration: ~/.crewdeck/config.yaml. Never inside the repo.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, stringify } from 'yaml';
import { normaliseAppearance, type Appearance } from './appearance.ts';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.CREWDECK_HOME ?? join(homedir(), '.crewdeck');
export const CONFIG_PATH = join(HOME, 'config.yaml');
export const TOKEN_PATH = join(HOME, 'token');
/** A small script that runs this checkout's CLI with this Crewdeck home: the one command the jobs sandbox lets out. */
export const CLI_WRAPPER = join(HOME, 'bin', 'crewdeck');
export const SB_VERSION = '2.12.1';

/** label: what the nav shows (defaults to "Board" with one project, else the project name). */
export type Project = { name: string; path: string; label?: string; boardPort?: number };
/** Any other local web app to show in Crewdeck (e.g. a dashboard). Crewdeck starts `command` if given. */
export type App = { name: string; label?: string; url: string; command?: string; args?: string[]; cwd?: string };
export type Config = {
  port: number;
  vault: string;
  silverbullet: { port: number; version: string };
  projects: Project[];
  apps: App[];
  /** auto (default: follow the system, i.e. Claude desktop's light/dark), light or dark: one look for every tool. */
  appearance: Appearance;
  jobs: JobsConfig;
};

/** Risky Jobs features (design §12): all off until the user switches them on (Jobs → Settings or a real terminal). */
export type JobsFeatures = {
  linkedin_search: boolean; linkedin_links: boolean; easy_apply: boolean; daily_quick_apply: number;
  email_drafts: boolean; max_emails_per_day: number; linkedin_message_text: boolean;
};
export type JobsConfig = {
  enabled: boolean;
  /** Machine state: jobs.db, out/, providers/, state/ (0700). */
  home: string;
  /** The folder a Claude session opens to work the jobs lane (defaults to home). */
  workspace: string;
  /** 'auto' (find Chrome/Chromium/Edge) or the absolute path of a Chromium-based browser. */
  browser: string;
  /** How often sources are fetched, e.g. 12h, 30m, 1d. */
  fetch_every: string;
  features: JobsFeatures;
};
export const FEATURE_DEFAULTS: JobsFeatures = {
  linkedin_search: false, linkedin_links: false, easy_apply: false, daily_quick_apply: 0,
  email_drafts: false, max_emails_per_day: 10, linkedin_message_text: false,
};
/** Hard caps no setting can raise. */
export const FEATURE_CAPS = { daily_quick_apply: 25, max_emails_per_day: 20 } as const;

export const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaults(): Config {
  return { port: 4848, vault: '~/Crewdeck/vault', silverbullet: { port: 4849, version: SB_VERSION }, projects: [], apps: [], appearance: 'auto', jobs: normaliseJobs(undefined) };
}

/** Validate and default the `jobs` section; errors name the field. */
export function normaliseJobs(raw: unknown): JobsConfig {
  const j = (raw ?? {}) as Record<string, any>;
  if (typeof j !== 'object' || Array.isArray(j)) throw new Error('jobs: must be a map of settings');
  const known = ['enabled', 'home', 'workspace', 'browser', 'fetch_every', 'features'];
  for (const k of Object.keys(j)) if (!known.includes(k)) throw new Error(`jobs.${k}: unknown setting (known: ${known.join(', ')})`);
  const bool = (v: unknown, name: string, d: boolean) => { if (v === undefined || v === null) return d; if (typeof v !== 'boolean') throw new Error(`${name}: use true or false`); return v; };
  const path = (v: unknown, name: string, d: string) => { if (v === undefined || v === null || v === '') return d; if (typeof v !== 'string') throw new Error(`${name}: must be a folder path`); return expand(v); };
  const home = path(j.home, 'jobs.home', join(HOME, 'jobs'));
  const browser = j.browser ?? 'auto';
  if (typeof browser !== 'string' || (browser !== 'auto' && !isAbsolute(browser) && !browser.startsWith('~/'))) throw new Error('jobs.browser: use auto or the absolute path of a Chromium-based browser');
  const every = j.fetch_every ?? '12h';
  const m = typeof every === 'string' ? /^(\d+)(m|h|d)$/.exec(every) : null;
  if (!m || Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2] as 'm'] < 30) throw new Error('jobs.fetch_every: use a duration of at least 30m, like 30m, 12h or 1d');
  const f = (j.features ?? {}) as Record<string, unknown>;
  if (typeof f !== 'object' || Array.isArray(f)) throw new Error('jobs.features: must be a map of switches');
  const features = { ...FEATURE_DEFAULTS };
  for (const [k, v] of Object.entries(f)) {
    if (!Object.hasOwn(FEATURE_DEFAULTS, k)) throw new Error(`jobs.features.${k}: unknown feature (known: ${Object.keys(FEATURE_DEFAULTS).join(', ')})`);
    (features as any)[k] = featureValue(k as keyof JobsFeatures, v);
  }
  return { enabled: bool(j.enabled, 'jobs.enabled', false), home, workspace: path(j.workspace, 'jobs.workspace', home), browser: browser === 'auto' ? 'auto' : expand(browser), fetch_every: every, features };
}

/** A feature switch value, checked against its type and cap. */
export function featureValue(name: keyof JobsFeatures, v: unknown): boolean | number {
  if (Object.hasOwn(FEATURE_CAPS, name)) {
    const cap = FEATURE_CAPS[name as keyof typeof FEATURE_CAPS];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`jobs.features.${name}: use a whole number from 0 to ${cap}`);
    if (v > cap) throw new Error(`jobs.features.${name}: at most ${cap} (a hard cap)`);
    return v;
  }
  if (typeof v !== 'boolean') throw new Error(`jobs.features.${name}: use true or false`);
  return v;
}

/**
 * Change one feature switch in config.yaml, keeping the rest of the file (and its comments). Callers make sure a
 * human asked: the Jobs page toggle or an interactive terminal (design D13).
 */
export function setFeature(name: string, value: boolean | number, path = CONFIG_PATH) {
  if (!Object.hasOwn(FEATURE_DEFAULTS, name)) throw new Error(`unknown feature ${name} (known: ${Object.keys(FEATURE_DEFAULTS).join(', ')})`);
  featureValue(name as keyof JobsFeatures, value);
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({}) as any;
  doc.setIn(['jobs', 'features', name], value);
  normaliseJobs((doc.toJS() as any)?.jobs);
  ensureHome(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Change Jobs' own settings (enabled, home, workspace) in config.yaml, keeping the rest of the file and its comments.
 * Used by `crewdeck jobs init`; never the feature switches (those are the user's: setFeature).
 */
export function setJobsSettings(changes: { enabled?: boolean; home?: string; workspace?: string }, path = CONFIG_PATH) {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({}) as any;
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) doc.setIn(['jobs', k], v);
  normaliseJobs((doc.toJS() as any)?.jobs);
  ensureHome(dirname(path));
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, doc.toString(), { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`No config yet. Run: crewdeck init`);
  const c = { ...defaults(), ...(parse(readFileSync(path, 'utf8')) ?? {}) } as Config;
  c.silverbullet = { ...defaults().silverbullet, ...(c.silverbullet ?? {}) };
  c.projects = (c.projects ?? []).map((p, i) => {
    if (!SLUG.test(p.name)) throw new Error(`project name "${p.name}": use lowercase letters, digits and dashes`);
    const label = p.label ?? ((c.projects ?? []).length === 1 ? 'Board' : p.name);
    return { ...p, label, path: expand(p.path), boardPort: p.boardPort ?? c.port + 10 + i };
  });
  c.apps = (c.apps ?? []).map((a) => {
    if (!SLUG.test(a.name)) throw new Error(`app name "${a.name}": use lowercase letters, digits and dashes`);
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?/.test(a.url)) throw new Error(`app ${a.name}: url must be http://localhost:<port>/`);
    return { ...a, cwd: a.cwd ? expand(a.cwd) : undefined };
  });
  c.appearance = normaliseAppearance(c.appearance);
  c.jobs = normaliseJobs((c as any).jobs);
  c.vault = expand(c.vault);
  return c;
}

export function saveConfig(c: Config, path = CONFIG_PATH) {
  ensureHome(dirname(path));
  writeFileSync(path, stringify(c), { mode: 0o600 });
}

/** Crewdeck's own folder: private to the user (0700). Refuses one others can write to after that. */
export function ensureHome(home = HOME) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  if (statSync(home).mode & 0o022) throw new Error(`${home} is writable by other users: fix its permissions first`);
}

const TOKEN = /^[a-f0-9]{64}$/;

/** The secret the bridge and the CLI present to the server's agent endpoints (64 hex chars, file mode 0600). */
export function ensureToken(path = TOKEN_PATH): string {
  const have = readToken(path);
  if (have) { chmodSync(path, 0o600); return have; }
  ensureHome(dirname(path));
  const t = randomBytes(32).toString('hex');
  writeFileSync(path, t + '\n', { mode: 0o600 });
  return t;
}

/**
 * A new token on every `crewdeck up`: one that leaked (to a port squatter, a log) stops working at the next start. The
 * bridge re-reads the file when the server's proof stops matching; the CLI reads it on every run.
 */
export function rotateToken(path = TOKEN_PATH): string {
  ensureHome(dirname(path));
  const t = randomBytes(32).toString('hex');
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, t + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return t;
}

/** Single-quoted for sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Write ~/.crewdeck/bin/crewdeck (0700): node + this checkout's cli.ts + this CREWDECK_HOME, so the call is one plain word. */
export function writeCliWrapper(path = CLI_WRAPPER, home = HOME): string {
  ensureHome(dirname(path));
  const text = `#!/bin/sh\n# Managed by Crewdeck (rewritten by crewdeck up and crewdeck jobs init): this checkout's CLI with this Crewdeck home.\nCREWDECK_HOME=${shq(home)} exec ${shq(process.execPath)} ${shq(join(REPO, 'src', 'cli.ts'))} "$@"\n`;
  if (existsSync(path) && readFileSync(path, 'utf8') === text) { chmodSync(path, 0o700); return path; }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o700 });
  renameSync(tmp, path);
  return path;
}

export function readToken(path = TOKEN_PATH): string | null {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, 'utf8').trim();
  return TOKEN.test(t) ? t : null;
}
