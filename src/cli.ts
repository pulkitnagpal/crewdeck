#!/usr/bin/env node
// crewdeck — init | up | add-project <name> <path> | doctor
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { CONFIG_PATH, HOME, REPO, SB_VERSION, TOKEN_PATH, defaults, ensureHome, ensureToken, expand, loadConfig, readToken, saveConfig, type Config } from './config.ts';
import { supervise, silverbulletBin, backlogBin } from './supervisor.ts';
import { createProxy } from './proxy.ts';
import { createShell } from './server.ts';
import { boardHead, notesAppearancePage, notesHead } from './appearance.ts';

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
  ensureToken();
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
  ensureHome();
  const token = ensureToken();
  const theme = readFileSync(join(REPO, 'themes', 'backlog.css'), 'utf8');
  // Notes follows Crewdeck's appearance through a managed vault page (SilverBullet's own light/dark switch).
  mkdirSync(join(c.vault, 'Library', 'Crewdeck'), { recursive: true });
  writeFileSync(join(c.vault, 'Library', 'Crewdeck', 'Appearance.md'), notesAppearancePage(c.appearance));
  const services = [
    // SilverBullet on an internal port; the public Notes port is a Crewdeck proxy (its own origin, Host/Origin checks).
    { name: 'silverbullet', cmd: silverbulletBin(), args: ['--single', '-L', '127.0.0.1', '-p', String(c.silverbullet.port + 100), c.vault] },
    ...c.projects.map((p) => ({ name: `board-${p.name}`, cmd: backlogBin(), args: ['browser', '-p', String(p.boardPort! + 100), '--no-open'], cwd: p.path })),
    ...c.apps.filter((a) => a.command).map((a) => ({ name: `app-${a.name}`, cmd: a.command!, args: a.args ?? [], cwd: a.cwd })),
  ];
  supervise(services);
  createProxy({ target: { host: '127.0.0.1', port: c.silverbullet.port + 100 }, injectHead: notesHead(c.appearance), injectAt: 'end' }).listen(c.silverbullet.port, '127.0.0.1');
  for (const p of c.projects) {
    createProxy({ target: { host: '127.0.0.1', port: p.boardPort! + 100 }, injectHead: boardHead(c.appearance, theme) })
      .listen(p.boardPort!, '127.0.0.1');
  }
  createShell(c, undefined, { token }).listen(c.port, '127.0.0.1', () => say(`Crewdeck on http://localhost:${c.port}  (notes: ${c.vault}; projects: ${c.projects.map((p) => p.name).join(', ') || 'none yet'})`));
}

async function api(path: string, body?: unknown) {
  const c = loadConfig();
  const token = readToken();
  if (body && !token) throw new Error(`No token at ${TOKEN_PATH}: run crewdeck up once`);
  const r = await fetch(`http://127.0.0.1:${c.port}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-crewdeck-token': token! }, body: JSON.stringify(body) } : {});
  const out = await r.json();
  if (!r.ok) throw new Error(out?.error ?? `HTTP ${r.status}`);
  return out;
}

async function requestsCmd() { for (const r of await api('/api/requests')) say(`${r.id}\t${r.status}\t${r.lane}\t${r.text}${r.result ? `  → ${r.result}` : ''}`); }

/** The result text: --result-file <path>, --result - (stdin), or --result "<text>". Files keep page text out of the shell. */
function resultText(args: string[]): string {
  const file = flag(args, 'result-file');
  if (file) return readFileSync(file, 'utf8').trim();
  const v = flag(args, 'result');
  if (v === '-') return readFileSync(0, 'utf8').trim();
  return v ?? '';
}

async function requestCmd(args: string[]) {
  const [verb, id] = args;
  if (!['done', 'fail'].includes(verb ?? '') || !/^\d+$/.test(id ?? '')) throw new Error('usage: crewdeck request done|fail <id> --result-file <path> | --result - | --result "<one line>"');
  const r = await api(`/api/requests/${Number(id)}/${verb}`, { result: resultText(args) });
  say(`request ${r.id} ${r.status}`);
}

function doctor() {
  const c = loadConfig();
  const ok = (b: boolean, s: string) => say(`${b ? '✓' : '✗'} ${s}`);
  ok(existsSync(silverbulletBin()), `SilverBullet binary (${silverbulletBin()})`);
  ok(existsSync(HOME) && (statSync(HOME).mode & 0o077) === 0, `${HOME} is private (0700)`);
  ok(!!readToken() && (statSync(TOKEN_PATH).mode & 0o077) === 0, `bridge token ${TOKEN_PATH} (0600)`);
  ok(existsSync(join(c.vault, 'CLAUDE.md')), `vault ${c.vault}`);
  for (const p of c.projects) ok(existsSync(join(p.path, 'backlog', 'config.yml')), `board ${p.name} (${p.path})`);
}

const flag = (a: string[], n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const [cmd, ...rest] = process.argv.slice(2);
const run: Record<string, (a: string[]) => unknown> = { init, up, 'add-project': addProject, doctor, requests: requestsCmd, request: requestCmd };
if (!cmd || !run[cmd]) { say('usage: crewdeck init [--vault <path>] | add-project <name> <repo> | up | doctor | requests | request done|fail <id> --result-file <path>'); process.exit(cmd ? 1 : 0); }
Promise.resolve(run[cmd](rest)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
