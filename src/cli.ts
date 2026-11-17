#!/usr/bin/env node
// crewdeck — init | up | add-project <name> <path> | doctor
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { CONFIG_PATH, HOME, REPO, SB_VERSION, defaults, expand, loadConfig, saveConfig, type Config } from './config.ts';
import { supervise, silverbulletBin, backlogBin } from './supervisor.ts';
import { createProxy } from './proxy.ts';
import { createShell } from './server.ts';

const say = (s: string) => console.log(s);

async function installSilverBullet(version = SB_VERSION) {
  const bin = silverbulletBin();
  if (existsSync(bin)) {
    const have = execFileSync(bin, ['--version']).toString();
    if (have.includes(version)) return say(`SilverBullet ${version} already installed`);
  }
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform as string];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch as string];
  if (!os || !arch) throw new Error(`No SilverBullet build for ${process.platform}/${process.arch}`);
  const url = `https://github.com/silverbulletmd/silverbullet/releases/download/${version}/silverbullet-server-${os}-${arch}.zip`;
  say(`Downloading SilverBullet ${version}…`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status}): ${url}`);
  const dir = join(tmpdir(), `crewdeck-sb-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sb.zip'), Buffer.from(await r.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', join(dir, 'sb.zip'), '-d', dir]);
  mkdirSync(join(HOME, 'bin'), { recursive: true });
  cpSync(join(dir, os === 'windows' ? 'silverbullet.exe' : 'silverbullet'), bin);
  chmodSync(bin, 0o755);
  rmSync(dir, { recursive: true, force: true });
  say(`Installed ${bin}`);
}

function initVault(vault: string) {
  if (existsSync(join(vault, 'CLAUDE.md'))) return say(`Vault already set up: ${vault}`);
  mkdirSync(vault, { recursive: true });
  // Never overwrite a note the user already has.
  cpSync(join(REPO, 'vault-template'), vault, { recursive: true, force: false, errorOnExist: false });
  say(`Vault ready: ${vault}`);
}

function initBoard(path: string, name: string) {
  if (existsSync(join(path, 'backlog', 'config.yml'))) return;
  if (!existsSync(join(path, '.git'))) throw new Error(`${path} is not a git repository (Backlog.md keeps tickets in the repo)`);
  execFileSync(backlogBin(), ['init', name, '--check-branches', 'false', '--include-remote', 'false', '--auto-open-browser', 'false', '--integration-mode', 'none'], { cwd: path, stdio: 'inherit' });
  // Four columns: the last stop before Done is the human's review.
  const cfg = join(path, 'backlog', 'config.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^statuses:.*$/m, 'statuses: ["To Do", "In Progress", "Needs you", "Done"]'));
}

async function init(args: string[]) {
  const c: Config = existsSync(CONFIG_PATH) ? (loadConfigRaw()) : defaults();
  const v = flag(args, 'vault'); if (v) c.vault = v;
  saveConfig(c);
  await installSilverBullet(c.silverbullet.version);
  initVault(expand(c.vault));
  say(`\nConfig: ${CONFIG_PATH}\nNext: crewdeck add-project <name> <path-to-git-repo>, then crewdeck up`);
}

function loadConfigRaw(): Config {
  return { ...defaults(), ...(parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {}) };
}

function addProject(args: string[]) {
  const [name, path] = args;
  if (!name || !path) throw new Error('usage: crewdeck add-project <name> <path-to-git-repo>');
  const raw = loadConfig(); // validates
  const c = { ...raw, vault: raw.vault, projects: raw.projects.map(({ boardPort, ...p }) => p) };
  if (c.projects.some((p) => p.name === name)) throw new Error(`project ${name} exists`);
  c.projects.push({ name, path });
  initBoard(expand(path), name);
  mkdirSync(join(raw.vault, 'projects', name), { recursive: true });
  const home = join(raw.vault, 'projects', name, 'index.md');
  if (!existsSync(home)) writeFileSync(home, `---\ntags: project\n---\n# ${name}\n\nBoard: Crewdeck → Projects → ${name}. Notes for this project live in this folder.\n`);
  saveConfig(c);
  say(`Added ${name} → ${expand(path)}`);
}

function up() {
  const c = loadConfig();
  const theme = readFileSync(join(REPO, 'themes', 'backlog.css'), 'utf8');
  // Backlog.md reads its light/dark choice from localStorage before it renders: set it first.
  const mode = `<script>try{localStorage.setItem('backlog-theme','${c.appearance}')}catch(e){}</script>`;
  const services = [
    { name: 'silverbullet', cmd: silverbulletBin(), args: ['--single', '-L', '127.0.0.1', '-p', String(c.silverbullet.port), c.vault], env: { SB_URL_PREFIX: '/notes' } },
    ...c.projects.map((p) => ({ name: `board-${p.name}`, cmd: backlogBin(), args: ['browser', '-p', String(p.boardPort! + 100), '--no-open'], cwd: p.path })),
    ...c.apps.filter((a) => a.command).map((a) => ({ name: `app-${a.name}`, cmd: a.command!, args: a.args ?? [], cwd: a.cwd })),
  ];
  supervise(services);
  for (const p of c.projects) {
    createProxy({ target: { host: '127.0.0.1', port: p.boardPort! + 100 }, injectHead: `${mode}<style id="crewdeck-theme">${theme}</style>` })
      .listen(p.boardPort!, '127.0.0.1');
  }
  createShell(c).listen(c.port, '127.0.0.1', () => say(`Crewdeck on http://localhost:${c.port}  (notes: ${c.vault}; projects: ${c.projects.map((p) => p.name).join(', ') || 'none yet'})`));
}

function doctor() {
  const c = loadConfig();
  const ok = (b: boolean, s: string) => say(`${b ? '✓' : '✗'} ${s}`);
  ok(existsSync(silverbulletBin()), `SilverBullet binary (${silverbulletBin()})`);
  ok(existsSync(join(c.vault, 'CLAUDE.md')), `vault ${c.vault}`);
  for (const p of c.projects) ok(existsSync(join(p.path, 'backlog', 'config.yml')), `board ${p.name} (${p.path})`);
}

const flag = (a: string[], n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const [cmd, ...rest] = process.argv.slice(2);
const run: Record<string, (a: string[]) => unknown> = { init, up, 'add-project': addProject, doctor };
if (!cmd || !run[cmd]) { say('usage: crewdeck init [--vault <path>] | add-project <name> <repo> | up | doctor'); process.exit(cmd ? 1 : 0); }
Promise.resolve(run[cmd](rest)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
