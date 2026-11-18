// Per-user configuration: ~/.crewdeck/config.yaml. Never inside the repo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.CREWDECK_HOME ?? join(homedir(), '.crewdeck');
export const CONFIG_PATH = join(HOME, 'config.yaml');
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
  /** light (default) or dark: applied to the shell, Notes and boards so they look like one product. */
  appearance: 'light' | 'dark';
};

export const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaults(): Config {
  return { port: 4848, vault: '~/Crewdeck/vault', silverbullet: { port: 4849, version: SB_VERSION }, projects: [], apps: [], appearance: 'light' };
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
  c.appearance = c.appearance === 'dark' ? 'dark' : 'light';
  c.vault = expand(c.vault);
  return c;
}

export function saveConfig(c: Config, path = CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(c));
}
