#!/usr/bin/env node
// crewdeck — setup | init | up | add-project <name> <path> | doctor | jobs <cmd>
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { CONFIG_PATH, HOME, REPO, SB_VERSION, TOKEN_PATH, defaults, ensureHome, ensureToken, expand, loadConfig, readToken, rotateToken, saveConfig, writeCliWrapper, type Config } from './config.ts';
import { freePort, notesSocketPath, silverbulletService } from './services.ts';
import { supervise, silverbulletBin, backlogBin } from './supervisor.ts';
import { createProxy } from './proxy.ts';
import { createShell } from './server.ts';
import { boardHead, notesAppearancePage, notesHead } from './appearance.ts';
import { findBrowser, installHint } from './jobs/browser.ts';
import { agentCall, localRead } from './agent-client.ts';
import { checkedPath, notCrewdeckFile } from './files.ts';

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

async function init(args: string[], quiet = false) {
  const c: Config = existsSync(CONFIG_PATH) ? (loadConfigRaw()) : defaults();
  const v = flag(args, 'vault'); if (v) c.vault = v;
  saveConfig(c);
  ensureToken();
  await installSilverBullet(c.silverbullet.version);
  initVault(expand(c.vault));
  if (!quiet) say(`\nConfig: ${CONFIG_PATH}\nNext: crewdeck add-project <name> <path-to-git-repo>, then crewdeck up`);
}

/** The plugin in the user's Claude Code (and Claude desktop): from this checkout, so it always matches this server. */
function installPlugin(port: number): { ok: boolean; text: string } {
  const claude = (a: string[]) => execFileSync('claude', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  try { claude(['--version']); } catch {
    return { ok: false, text: 'Claude Code\'s command line (claude) is not on PATH, so the plugin was not installed. In Claude desktop: + → Plugins → Add marketplace ' + REPO + ' → install crewdeck.' };
  }
  const markets = (() => { try { return claude(['plugin', 'marketplace', 'list']); } catch { return ''; } })();
  if (!/^\s*❯\s*crewdeck\s*$/m.test(markets)) {
    try { claude(['plugin', 'marketplace', 'add', REPO]); } catch (e: any) { return { ok: false, text: `adding the crewdeck marketplace failed: ${String(e?.stderr || e?.message).trim().slice(0, 300)}` }; }
  } else if (!markets.includes(REPO)) {
    return { ok: false, text: `a marketplace called crewdeck is already added from somewhere else. To use this checkout: claude plugin marketplace remove crewdeck, then crewdeck setup again.` };
  }
  const plugins = (() => { try { return claude(['plugin', 'list']); } catch { return ''; } })();
  if (/crewdeck-bridge@/.test(plugins)) say('  note: the old crewdeck-bridge plugin is installed; remove it with claude plugin uninstall crewdeck-bridge@crewdeck');
  if (/❯\s*crewdeck@crewdeck/.test(plugins)) return { ok: true, text: 'the crewdeck plugin is already installed' };
  try { claude(['plugin', 'install', 'crewdeck@crewdeck', '--config', `port=${port}`]); }
  catch (e: any) { return { ok: false, text: `installing the crewdeck plugin failed: ${String(e?.stderr || e?.message).trim().slice(0, 300)}` }; }
  return { ok: true, text: 'installed the crewdeck plugin in Claude (it loads in new sessions)' };
}

/**
 * crewdeck setup [--vault <path>] [--preset <name>] [--no-plugin]: everything a new user needs, in one command —
 * Crewdeck's home and vault, Jobs, and the plugin in Claude. Safe to run again.
 */
async function setup(args: string[]) {
  say('Setting up Crewdeck…');
  await init(args, true);
  const { jobsInit } = await import('./jobs/setup.ts');
  const preset = flag(args, 'preset');
  for (const l of await jobsInit({ preset, quiet: true })) say(l);
  const c = loadConfig();
  if (args.includes('--no-plugin')) say('· plugin not installed (--no-plugin)');
  else { const p = installPlugin(c.port); say(`${p.ok ? '✓' : '✗'} ${p.text}`); }
  say(['', 'Done. Now:',
    '  1. Start Crewdeck: crewdeck up   (leave it running)',
    `  2. Open http://localhost:${c.port} (in Claude desktop: ask Claude to open it in the browser pane) and click Jobs.`,
    `  3. In Claude desktop, start a new Code session in the folder ${c.jobs.workspace}`,
    '     and say hello. Then click "Set up with Claude" on the Jobs page: Claude interviews you there.',
  ].join('\n'));
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

async function up() {
  const c = loadConfig();
  ensureHome();
  // A fresh token every start: one that leaked stops working (the bridge re-reads it when the proof stops matching).
  const token = rotateToken();
  writeCliWrapper();
  // The jobs workspace's CLAUDE.md and sandbox settings are managed: rewritten on every start, so they follow this Crewdeck.
  if (c.jobs.enabled) (await import('./jobs/setup.ts')).writeWorkspaceFiles(c);
  const theme = readFileSync(join(REPO, 'themes', 'backlog.css'), 'utf8');
  // Notes follows Crewdeck's appearance through a managed vault page (SilverBullet's own light/dark switch).
  mkdirSync(join(c.vault, 'Library', 'Crewdeck'), { recursive: true });
  writeFileSync(join(c.vault, 'Library', 'Crewdeck', 'Appearance.md'), notesAppearancePage(c.appearance));
  // SilverBullet on a private Unix socket (no TCP port); each board on a random internal port. Only the public proxy
  // ports (their own origins, Host/Origin checks) are documented; internal ports are never shown (design §14, W1/W2).
  const socket = notesSocketPath(HOME);
  const boards = await Promise.all(c.projects.map(async (p) => ({ p, internal: await freePort() })));
  const services = [
    silverbulletService(silverbulletBin(), c.vault, socket),
    ...boards.map(({ p, internal }) => ({ name: `board-${p.name}`, cmd: backlogBin(), args: ['browser', '-p', String(internal), '--no-open'], cwd: p.path })),
    ...c.apps.filter((a) => a.command).map((a) => ({ name: `app-${a.name}`, cmd: a.command!, args: a.args ?? [], cwd: a.cwd })),
  ];
  supervise(services);
  createProxy({ target: { socketPath: socket }, injectHead: notesHead(c.appearance), injectAt: 'end' }).listen(c.silverbullet.port, '127.0.0.1');
  for (const { p, internal } of boards) {
    createProxy({ target: { host: '127.0.0.1', port: internal }, injectHead: boardHead(c.appearance, theme) })
      .listen(p.boardPort!, '127.0.0.1');
  }
  createShell(c, undefined, { token }).listen(c.port, '127.0.0.1', () => say(`Crewdeck on http://localhost:${c.port}  (notes: ${c.vault}; projects: ${c.projects.map((p) => p.name).join(', ') || 'none yet'})`));
}

const api = agentCall;

async function requestsCmd() { for (const r of await api('/api/requests')) say(`${r.id}\t${r.status}\t${r.lane}\t${r.kind ? `${r.kind}${r.ref ? ` ${r.ref}` : ''}` : r.text}${r.result ? `  → ${r.result}` : ''}`); }

/**
 * A file named by --result-file / --text-file (E5). In the jobs workspace (the sandboxed lane, where this command is the
 * one let out) it must be inside Jobs' home or workspace; anywhere else only Crewdeck's own files are refused.
 */
function flagFile(file: string, what: string): string {
  const c = loadConfig();
  let inJobs = false;
  try { const ws = realpathSync(c.jobs.workspace), cwd = realpathSync(process.cwd()); inJobs = cwd === ws || cwd.startsWith(ws + sep); } catch {}
  return readFileSync(inJobs ? checkedPath(file, what, { roots: [...new Set([c.jobs.home, c.jobs.workspace])] }) : notCrewdeckFile(file, what, c.jobs.home), 'utf8');
}

/** The result text: --result-file <path>, --result - (stdin), or --result "<text>". Files keep page text out of the shell. */
function resultText(args: string[]): string {
  const file = flag(args, 'result-file');
  if (file) return flagFile(file, '--result-file').trim();
  const v = flag(args, 'result');
  if (v === '-') return readFileSync(0, 'utf8').trim();
  return v ?? '';
}

async function requestCmd(args: string[]) {
  const [verb, id] = args;
  if (verb === 'show' && /^\d+$/.test(id ?? '')) return say(JSON.stringify(await api(`/api/requests/${Number(id)}/show`, {}), null, 1));
  if (!['done', 'fail'].includes(verb ?? '') || !/^\d+$/.test(id ?? '')) throw new Error('usage: crewdeck request done|fail <id> --result-file <path> | --result - | --result "<one line>"  |  request show <id>');
  const r = await api(`/api/requests/${Number(id)}/${verb}`, { result: resultText(args) });
  say(`request ${r.id} ${r.status}`);
}

/** crewdeck progress <id> --text-file <f> | --text - : a line the page shows while Claude works on a request. */
async function progressCmd(args: string[]) {
  const [id] = args;
  const file = flag(args, 'text-file'), v = flag(args, 'text');
  if (!/^\d+$/.test(id ?? '') || (!file && v === undefined)) throw new Error('usage: crewdeck progress <id> --text-file <path> | --text - (stdin)');
  if (!file && v !== '-') throw new Error('progress text comes from a file (--text-file) or stdin (--text -), never the command line');
  const text = file ? flagFile(file, '--text-file') : readFileSync(0, 'utf8');
  await api(`/api/requests/${Number(id)}/progress`, { text: text.trim() });
  say('noted');
}

/** What the running Crewdeck says about the jobs lane (a page read; never starts or stops anything). */
async function jobsPresence(c: Config) {
  try {
    // A local tool's read (no Fetch Metadata): Node's fetch would be refused as a browser (W8).
    const r = await localRead(c.port, '/api/jobs/state', 2000);
    if (r.status === 404) return { jobs: false as const };
    if (r.status !== 200) return null;
    const s = r.json;
    // Another Crewdeck (another CREWDECK_HOME) on this port answers for its own Jobs, not this one's.
    const other = typeof s?.home === 'string' && s.home !== c.jobs.home ? String(s.vault ?? s.home) : undefined;
    return { jobs: true as const, connected: !!s?.agent?.connected, seen: s?.agent?.seen ?? null, ...(other ? { other } : {}) };
  } catch { return null; }
}

async function doctor() {
  const c = loadConfig();
  const ok = (b: boolean, s: string) => say(`${b ? '✓' : '✗'} ${s}`);
  ok(existsSync(silverbulletBin()), `SilverBullet binary (${silverbulletBin()})`);
  ok(existsSync(HOME) && (statSync(HOME).mode & 0o077) === 0, `${HOME} is private (0700)`);
  ok(!!readToken() && (statSync(TOKEN_PATH).mode & 0o077) === 0, `bridge token ${TOKEN_PATH} (0600)`);
  ok(existsSync(join(c.vault, 'CLAUDE.md')), `vault ${c.vault}`);
  for (const p of c.projects) ok(existsSync(join(p.path, 'backlog', 'config.yml')), `board ${p.name} (${p.path})`);
  // Jobs reads forms and prints resumes in the user's own Chromium-based browser, headless.
  const b = findBrowser(c.jobs.browser);
  if (!c.jobs.enabled) ok(!!b, b ? `browser for Jobs (forms, resume PDFs): ${b.name} (${b.path})` : `no Chromium-based browser for Jobs (forms, resume PDFs). ${installHint()}`);
  say('\nJobs');
  const { jobsDoctor, mark } = await import('./jobs/doctor.ts');
  for (const l of await jobsDoctor(c, c.jobs.enabled ? await jobsPresence(c) : null)) say(`${mark(l.ok)} ${l.text}`);
}

const flag = (a: string[], n: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const [cmd, ...rest] = process.argv.slice(2);
// Jobs loads only when used.
const jobs = (a: string[]) => import('./jobs/cli.ts').then((m) => m.main(a));
const run: Record<string, (a: string[]) => unknown> = { setup, init: (a: string[]) => init(a), up, 'add-project': addProject, doctor, requests: requestsCmd, request: requestCmd, progress: progressCmd, jobs };
const USAGE = 'usage: crewdeck setup [--vault <path>] [--preset <name>] [--no-plugin] | init [--vault <path>] | add-project <name> <repo> | up | doctor | requests | request done|fail|show <id> [--result-file <path>] | progress <id> --text-file <path> | jobs <cmd>';
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || !Object.hasOwn(run, cmd)) { say(USAGE); process.exit(cmd && !['--help', '-h', 'help'].includes(cmd) ? 1 : 0); }
// --help never runs a command (jobs has its own help).
if (cmd !== 'jobs' && (rest.includes('--help') || rest.includes('-h'))) { say(USAGE); process.exit(0); }
Promise.resolve(run[cmd](rest)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
