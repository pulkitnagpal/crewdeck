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

export type Project = { name: string; path: string; boardPort?: number };
export type Config = {
  port: number;
  vault: string;
  silverbullet: { port: number; version: string };
  projects: Project[];
};

export const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function defaults(): Config {
  return { port: 4848, vault: '~/Crewdeck/vault', silverbullet: { port: 4849, version: SB_VERSION }, projects: [] };
}

export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`No config yet. Run: crewdeck init`);
  const c = { ...defaults(), ...(parse(readFileSync(path, 'utf8')) ?? {}) } as Config;
  c.silverbullet = { ...defaults().silverbullet, ...(c.silverbullet ?? {}) };
  c.projects = (c.projects ?? []).map((p, i) => {
    if (!SLUG.test(p.name)) throw new Error(`project name "${p.name}": use lowercase letters, digits and dashes`);
    return { ...p, path: expand(p.path), boardPort: p.boardPort ?? c.port + 10 + i };
  });
  c.vault = expand(c.vault);
  return c;
}

export function saveConfig(c: Config, path = CONFIG_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(c));
}
