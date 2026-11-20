#!/usr/bin/env node
// crewdeck — setup | init | up | add-project <name> <path> | doctor | jobs <cmd>
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, sep } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { CONFIG_PATH, HOME, REPO, SB_VERSION, TOKEN_PATH, defaults, effectiveAddress, ensureHome, ensureToken, expand, loadConfig, pageUrl, readToken, rotateToken, saveConfig, writeCliWrapper, type Config } from './config.ts';
import { useAddress } from './http.ts';
import { freePort, notesSocketPath, silverbulletService } from './services.ts';
import { supervise, silverbulletBin, backlogBin } from './supervisor.ts';
import { createProxy } from './proxy.ts';
import { createShell } from './server.ts';
import { boardHead, notesAppearancePage, notesHead, notesHelpersPage, notesJournalTemplate } from './appearance.ts';
import { findBrowser, installHint } from './jobs/browser.ts';
import { agentCall, localRead } from './agent-client.ts';
import { checkedPath, notCrewdeckFile } from './files.ts';

const say = (s: string) => console.log(s);

/** SHA-256 of each SilverBullet server build Crewdeck installs, as its GitHub release publishes them (asset digests). */
const SB_SHA256: Record<string, string> = {
  '2.12.1/darwin-aarch64': 'cd83db88e1759e929eadd5f78130a41f0d4c8ed150a3fa79c914fb8985721c37',
  '2.12.1/darwin-x86_64': '36fc5c30d5b1471faad3b5a903ff177015839589f880d9861b627c924b4ec0ca',
  '2.12.1/linux-aarch64': '33000b6f7c879d04d3c72f0bb2e3c79b6f51e829c43f1f95ce1fa24b937a10e2',
  '2.12.1/linux-x86_64': '0ea5c0575021de354b79bf53fb85f170aca93e228b5593959869ff8841dbb1d3',
};

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
  const zip = Buffer.from(await r.arrayBuffer());
  // Checked against the digest SilverBullet's release publishes, before anything is unpacked or run.
  const want = SB_SHA256[`${version}/${os}-${arch}`];
  if (!want) throw new Error(`No pinned checksum for SilverBullet ${version} (${os}-${arch})`);
  const got = createHash('sha256').update(zip).digest('hex');
  if (got !== want) throw new Error(`SilverBullet download does not match its checksum (got ${got}): nothing was installed`);
  const dir = join(tmpdir(), `crewdeck-sb-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sb.zip'), zip);
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

/** A port nothing on this machine listens on (127.0.0.1). */
function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createNetServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)));
  });
}

async function init(args: string[], quiet = false) {
  const fresh = !existsSync(CONFIG_PATH);
  const c: Config = fresh ? defaults() : loadConfigRaw();
  const v = flag(args, 'vault'); if (v) c.vault = v;
  const p = flag(args, 'port');
  if (p !== undefined) {
    if (!/^\d+$/.test(p) || Number(p) < 1024 || Number(p) > 65000) throw new Error('--port: a number from 1024 to 65000');
    c.port = Number(p); c.silverbullet = { ...c.silverbullet, port: Number(p) + 1 };
  } else if (fresh && !((await portFree(c.port)) && (await portFree(c.silverbullet.port)))) {
    // Something else already uses Crewdeck's usual ports: a new install takes the next free pair instead of failing.
    for (let base = c.port + 100; base < c.port + 2000; base += 100) {
      if ((await portFree(base)) && (await portFree(base + 1))) { c.port = base; c.silverbullet = { ...c.silverbullet, port: base + 1 }; say(`· port ${defaults().port} is in use: Crewdeck uses ${base}`); break; }
    }
  }
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
  if (/❯\s*crewdeck@crewdeck/.test(plugins)) {
    // Claude keeps a copy of an installed plugin per version: refresh the marketplace from this checkout, then update,
    // so new skills reach new sessions (a no-op when nothing changed).
    try { claude(['plugin', 'marketplace', 'update', 'crewdeck']); claude(['plugin', 'update', 'crewdeck@crewdeck']); }
    catch (e: any) { return { ok: false, text: `the crewdeck plugin is installed, but updating it failed: ${String(e?.stderr || e?.message).trim().slice(0, 300)}. Try: claude plugin marketplace update crewdeck && claude plugin update crewdeck@crewdeck` }; }
    return { ok: true, text: 'the crewdeck plugin is installed and up to date (new Claude sessions load it)' };
  }
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
  // --from-plugin: the /crewdeck panel's one-click setup runs this; the plugin is already in Claude, and the panel shows
  // the next steps itself.
  const fromPlugin = args.includes('--from-plugin');
  let plugin = fromPlugin;
  if (fromPlugin) { /* already installed */ }
  else if (args.includes('--no-plugin')) say('· plugin not installed (--no-plugin)');
  else { const p = installPlugin(c.port); plugin = p.ok; say(`${p.ok ? '✓' : '✗'} ${p.text}`); }
  // Always on (docs/everywhere.md E4): only when asked. The README's install prompt has Claude ask the person first.
  const svc = await import('./service.ts');
  if (args.includes('--service')) { for (const l of svc.installService()) say(l); }
  else if (!args.includes('--no-service') && !svc.serviceInstalled()) say('· Crewdeck runs only while crewdeck up runs. To keep it running in the background (it starts when you log in): crewdeck service install');
  if (fromPlugin) return;
  const running = svc.serviceInstalled() && (await svc.waitForCrewdeck(c.port, 15_000));
  say(['', 'Done. Now:',
    running ? `  1. Crewdeck is running at ${pageUrl(c)} (open it in any browser, or in Claude desktop's browser pane).` : `  1. Start Crewdeck: crewdeck up (leave it running), then open ${pageUrl(c)}`,
    plugin ? '  2. In any new Claude session, type /crewdeck for today\'s to-dos, jobs and tickets beside the chat.' : '  2. With the crewdeck plugin (crewdeck setup without --no-plugin), /crewdeck in any Claude session shows today beside the chat.',
    `  3. For Jobs: open a Claude Code session in your jobs folder, ${c.jobs.workspace}: run crewdeck open session`,
    '     (Claude desktop asks you to confirm the folder; press Enter on the hello). Then click "Set up with Claude" on',
    '     the Jobs page: Claude interviews you in that session.',
  ].join('\n'));
}

/** crewdeck open [jobs|notes]: start Crewdeck if it isn't running, then open it in the default browser. */
async function openCmd(args: string[]) {
  const c = loadConfig();
  const where = args.find((a) => !a.startsWith('--')) ?? '';
  if (where === 'session') {
    // A Claude Code session in the jobs folder, in Claude desktop (it asks to confirm the folder; the hello is not sent).
    const { sessionLink, JOBS_SESSION_PROMPT } = await import('./session-link.ts');
    const link = sessionLink(c.jobs.workspace, JOBS_SESSION_PROMPT);
    const o = (await import('./service.ts')).opener();
    if (o && !args.includes('--print')) execFileSync(o[0], [...o[1], link], { stdio: 'ignore' });
    return say(link);
  }
  const paths: Record<string, string> = { '': '/', jobs: '/#jobs', notes: '/#notes' };
  if (!Object.hasOwn(paths, where)) throw new Error('usage: crewdeck open [jobs|notes|session]');
  const svc = await import('./service.ts');
  const who = await svc.whoAnswers(c.port);
  if (who === 'other') throw new Error(`Another program answers on port ${c.port}: stop it, or change port in ${CONFIG_PATH}`);
  if (who === 'none') {
    say(`Starting Crewdeck (${svc.startDetached()})…`);
    if (!(await svc.waitForCrewdeck(c.port))) throw new Error(`Crewdeck did not start in 20 s: see ${join(HOME, 'logs')}`);
  }
  const url = pageUrl(c, paths[where]);
  const o = svc.opener();
  if (o && !args.includes('--print')) execFileSync(o[0], [...o[1], url], { stdio: 'ignore' });
  say(url);
}

/** crewdeck service install|uninstall|status|restart: Crewdeck in the background, started at login (E4). */
async function serviceCmd(args: string[]) {
  const c = loadConfig();
  const svc = await import('./service.ts');
  const verb = args[0];
  if (verb === 'install') { for (const l of svc.installService()) say(l); if (await svc.waitForCrewdeck(c.port)) say(`✓ running at ${pageUrl(c)}`); else say(`✗ not answering yet: see ${join(HOME, 'logs', 'service.log')}`); return; }
  if (verb === 'uninstall') { for (const l of svc.uninstallService()) say(l); return; }
  if (verb === 'restart') { for (const l of svc.restartService()) say(l); return; }
  if (verb === 'status') {
    const plan = svc.servicePlan();
    say(`${svc.serviceInstalled(plan) ? '✓ installed' : '· not installed'} (${plan.file})`);
    const who = await svc.whoAnswers(c.port);
    say(who === 'this' ? `✓ running at ${pageUrl(c)}` : who === 'other' ? `✗ another program answers on port ${c.port}` : '· not running');
    for (const l of svc.serviceLogTail()) say(`  ${l}`);
    return;
  }
  throw new Error('usage: crewdeck service install|uninstall|status|restart');
}

/** crewdeck address [--short [--name crew.deck]] [--undo]: the address without a port (E3); prints sudo steps, runs none. */
async function addressCmd(args: string[]) {
  const c = loadConfig();
  const { shortAddressPlan, writeShortAddress } = await import('./address.ts');
  if (!args.includes('--short') && !args.includes('--undo')) {
    say(`Crewdeck's address: ${pageUrl(c)}`);
    if (!c.address.short) say('Without the port (http://crewdeck.localhost): crewdeck address --short   (needs your admin password once)');
    return;
  }
  const name = flag(args, 'name');
  const undo = args.includes('--undo');
  if (args.includes('--done')) {
    const { setAddress } = await import('./config.ts');
    if (undo) { setAddress({ short: false, names: [] }); say(`✓ Crewdeck's address is ${pageUrl({ port: c.port })} again`); }
    else {
      const { shortAddressReaches } = await import('./address.ts');
      const token = readToken();
      if (!token || !(await shortAddressReaches(c.port, token))) throw new Error('http://crewdeck.localhost (port 80) does not reach this Crewdeck, or another program answers on [::1]:80: is Crewdeck running, did each sudo step succeed, and is nothing else using port 80? Nothing changed.');
      const names = [...new Set([...c.address.names, ...(name ? [name.toLowerCase()] : [])])];
      setAddress({ short: true, names, port: c.port });
      say(`✓ Crewdeck's address is now http://crewdeck.localhost${names.length ? ` (and ${names.map((n) => `http://${n}`).join(', ')})` : ''}`);
    }
    const svc = await import('./service.ts');
    if (svc.serviceInstalled()) { for (const l of svc.restartService()) say(l); }
    else say('Restart Crewdeck (stop crewdeck up and start it again) so it answers to the new address.');
    return;
  }
  const plan = shortAddressPlan({ port: c.port, name, undo });
  for (const l of writeShortAddress(plan)) say(l);
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

/** A page Crewdeck manages in the vault: written to a temp file and renamed over, so a link planted there is replaced, never
 * followed out of the vault (security review). */
function managedPage(file: string, text: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx' });
  renameSync(tmp, file);
}

async function up() {
  const c = loadConfig();
  ensureHome();
  // Already running (the background service, or another terminal): say where, and leave its token alone. The background
  // service waits instead, and takes over when that one stops (security review #9: launchd wouldn't restart a clean exit).
  const { whoAnswers, takeStartLock } = await import('./service.ts');
  const service = process.env.CREWDECK_SERVICE === '1';
  for (;;) {
    const who = await whoAnswers(c.port);
    if (who === 'other') throw new Error(`Another program answers on port ${c.port}: stop it, or change port in ${CONFIG_PATH}`);
    if (who === 'none' && takeStartLock()) break;
    if (!service) return say(`Crewdeck is already ${who === 'this' ? 'running' : 'starting'}: ${pageUrl(c)}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (c.address.short && c.address.port !== c.port) say(`! The address without a port still points at port ${c.address.port ?? '?'}, not ${c.port}: run crewdeck address --short again. Until then use ${pageUrl({ port: c.port })}`);
  useAddress(effectiveAddress(c));
  // A fresh token every start: one that leaked stops working (the bridge re-reads it when the proof stops matching).
  const token = rotateToken();
  writeCliWrapper();
  // The jobs workspace's CLAUDE.md and sandbox settings are managed: rewritten on every start, so they follow this Crewdeck.
  if (c.jobs.enabled) (await import('./jobs/setup.ts')).writeWorkspaceFiles(c);
  const theme = readFileSync(join(REPO, 'themes', 'backlog.css'), 'utf8');
  // Notes follows Crewdeck's appearance through a managed vault page (SilverBullet's own light/dark switch).
  mkdirSync(join(c.vault, 'Library', 'Crewdeck'), { recursive: true });
  managedPage(join(c.vault, 'Library', 'Crewdeck', 'Appearance.md'), notesAppearancePage(c.appearance));
  // SilverBullet's own file tree, journal and buttons, switched on for newcomers (managed pages, rewritten every start).
  managedPage(join(c.vault, 'Library', 'Crewdeck', 'Notes.md'), notesHelpersPage());
  managedPage(join(c.vault, 'Library', 'Crewdeck', 'Journal Template.md'), notesJournalTemplate());
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
  createShell(c, undefined, { token }).listen(c.port, '127.0.0.1', () => say(`Crewdeck on ${pageUrl(c)}  (notes: ${c.vault}; projects: ${c.projects.map((p) => p.name).join(', ') || 'none yet'})`));
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
  // Always on and from anywhere (docs/everywhere.md).
  const svc = await import('./service.ts');
  try { const plan = svc.servicePlan(); say(svc.serviceInstalled(plan) ? `✓ background service installed (${plan.file})` : '· not running in the background: crewdeck service install keeps it running and starts it at login'); } catch {}
  const who = await svc.whoAnswers(c.port);
  say(who === 'this' ? `✓ Crewdeck answers at ${pageUrl(c)}` : who === 'other' ? `✗ another program answers on port ${c.port}` : `· Crewdeck isn't running: crewdeck open (or crewdeck up)`);
  if (c.address.short) {
    const { answersOn } = await import('./address.ts');
    if (c.address.port !== c.port) say(`✗ the address without a port points at port ${c.address.port ?? '?'}, not ${c.port}: crewdeck address --short again`);
    if (await answersOn('::1', 80)) say('✗ another program answers on [::1]:80, where browsers may look for http://crewdeck.localhost first: stop it, or use the address with the port');
  }
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
const run: Record<string, (a: string[]) => unknown> = { setup, init: (a: string[]) => init(a), up, open: openCmd, service: serviceCmd, address: addressCmd, 'add-project': addProject, doctor, requests: requestsCmd, request: requestCmd, progress: progressCmd, jobs };
const USAGE = 'usage: crewdeck setup [--vault <path>] [--port <n>] [--preset <name>] [--no-plugin|--from-plugin] [--service|--no-service] | init [--vault <path>] | add-project <name> <repo> | up | open [jobs|notes|session] | service install|uninstall|status|restart | address [--short [--name <host>]] [--undo] | doctor | requests | request done|fail|show <id> [--result-file <path>] | progress <id> --text-file <path> | jobs <cmd>';
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || !Object.hasOwn(run, cmd)) { say(USAGE); process.exit(cmd && !['--help', '-h', 'help'].includes(cmd) ? 1 : 0); }
// --help never runs a command (jobs has its own help).
if (cmd !== 'jobs' && (rest.includes('--help') || rest.includes('-h'))) { say(USAGE); process.exit(0); }
Promise.resolve(run[cmd](rest)).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
