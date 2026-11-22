// Crewdeck always on (docs/everywhere.md E4, E5): a per-user background service that runs `crewdeck up` at login and
// after a crash, and the checks `up` and `open` share to know whether this Crewdeck already answers.
//
// macOS: a LaunchAgent in ~/Library/LaunchAgents (no admin). Linux: a systemd --user unit. Both run the Node that
// installed them with this checkout's cli.ts and this CREWDECK_HOME, and write what they print to ~/.crewdeck/logs.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HOME, REPO, readToken } from './config.ts';
import { localRead, verifyServer } from './agent-client.ts';

export const LABEL = 'io.crewdeck.server';

export type ServicePlan = { kind: 'launchd' | 'systemd'; file: string; text: string; logDir?: string; label: string; unit: string };

/** The default home's service is io.crewdeck.server; any other home (a second Crewdeck, a rehearsal) gets its own name,
 * so installing one never replaces another. */
export function serviceNames(home = HOME, userHome = homedir()): { label: string; unit: string } {
  if (home === join(userHome, '.crewdeck')) return { label: LABEL, unit: 'crewdeck.service' };
  const h = createHash('sha256').update(home).digest('hex').slice(0, 8);
  return { label: `${LABEL}.${h}`, unit: `crewdeck-${h}.service` };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** What `service install` writes, for this platform, Node, checkout and home. Pure, so it is tested as text. */
export function servicePlan(o: { platform?: NodeJS.Platform; home?: string; userHome?: string; node?: string; repo?: string } = {}): ServicePlan {
  const platform = o.platform ?? process.platform;
  const home = o.home ?? HOME, userHome = o.userHome ?? homedir(), node = o.node ?? process.execPath, repo = o.repo ?? REPO;
  const cli = join(repo, 'src', 'cli.ts');
  const log = join(home, 'logs', 'service.log');
  const { label, unit } = serviceNames(home, userHome);
  if (platform === 'darwin') {
    const file = join(userHome, 'Library', 'LaunchAgents', `${label}.plist`);
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by Crewdeck: crewdeck service install writes it, crewdeck service uninstall removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>up</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>CREWDECK_HOME</key><string>${xml(home)}</string><key>CREWDECK_SERVICE</key><string>1</string><key>PATH</key><string>${xml(`${dirname(node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    return { kind: 'launchd', file, text, logDir: join(home, 'logs'), label, unit };
  }
  if (platform === 'linux') {
    // systemd unit syntax: % starts a specifier (%%), $ a variable ($$), and inside quotes \ and " are escaped.
    const esc = (s: string) => s.replace(/%/g, '%%').replace(/\$/g, '$$$$');
    const q = (s: string) => `"${esc(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const file = join(process.env.XDG_CONFIG_HOME ?? join(userHome, '.config'), 'systemd', 'user', unit);
    const text = `# Managed by Crewdeck: crewdeck service install writes it, crewdeck service uninstall removes it.
[Unit]
Description=Crewdeck (${home})

[Service]
ExecStart=${q(node)} ${q(cli)} up
WorkingDirectory=${esc(repo)}
Environment=${q(`CREWDECK_HOME=${home}`)}
Environment=CREWDECK_SERVICE=1
Environment=${q(`PATH=${dirname(node)}:/usr/local/bin:/usr/bin:/bin`)}
Restart=on-failure
RestartSec=10
StandardOutput=append:${esc(log)}
StandardError=append:${esc(log)}

[Install]
WantedBy=default.target
`;
    return { kind: 'systemd', file, text, logDir: join(home, 'logs'), label, unit };
  }
  throw new Error(`crewdeck service: ${platform} is not supported yet (macOS and Linux are)`);
}

type Run = (cmd: string, args: string[]) => string;
const sh: Run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const uid = () => process.getuid?.() ?? 0;

/** Write the service file and start it now. Safe to run again: it rewrites and reloads. */
export function installService(o: { plan?: ServicePlan; run?: Run } = {}): string[] {
  const plan = o.plan ?? servicePlan(), run = o.run ?? sh;
  mkdirSync(dirname(plan.file), { recursive: true });
  if (plan.logDir) mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
  const had = existsSync(plan.file);
  writeFileSync(plan.file, plan.text, { mode: 0o644 });
  if (plan.kind === 'launchd') {
    if (had) { try { run('launchctl', ['bootout', `gui/${uid()}/${plan.label}`]); } catch {} }
    run('launchctl', ['bootstrap', `gui/${uid()}`, plan.file]);
  } else {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', plan.unit]);
  }
  return [`✓ Crewdeck runs in the background now, and starts when you log in (${plan.file})`];
}

/** Stop the service and remove exactly the file install wrote. */
export function uninstallService(o: { plan?: ServicePlan; run?: Run } = {}): string[] {
  const plan = o.plan ?? servicePlan(), run = o.run ?? sh;
  if (!existsSync(plan.file)) return ['· the background service is not installed'];
  if (plan.kind === 'launchd') { try { run('launchctl', ['bootout', `gui/${uid()}/${plan.label}`]); } catch {} }
  else { try { run('systemctl', ['--user', 'disable', '--now', plan.unit]); } catch {} }
  rmSync(plan.file);
  if (plan.kind === 'systemd') { try { run('systemctl', ['--user', 'daemon-reload']); } catch {} }
  return [`✓ removed the background service (${plan.file}); start Crewdeck with crewdeck up when you need it`];
}

export const serviceInstalled = (plan?: ServicePlan) => { try { return existsSync((plan ?? servicePlan()).file); } catch { return false; } };

/** Restart the service (after a git pull, say). */
export function restartService(o: { plan?: ServicePlan; run?: Run } = {}): string[] {
  const plan = o.plan ?? servicePlan(), run = o.run ?? sh;
  if (!existsSync(plan.file)) throw new Error('the background service is not installed: crewdeck service install');
  if (plan.kind === 'launchd') run('launchctl', ['kickstart', '-k', `gui/${uid()}/${plan.label}`]);
  else run('systemctl', ['--user', 'restart', plan.unit]);
  return ['✓ restarted Crewdeck'];
}

/**
 * Who answers on the port: this Crewdeck (it proves the token on disk), another program, or nothing. Never sends the
 * token: the proof is checked first (verifyServer).
 */
export async function whoAnswers(port: number): Promise<'this' | 'other' | 'none'> {
  const token = readToken();
  if (!token) {
    try { await localRead(port, '/api/state', 2000); return 'other'; } catch { return 'none'; }
  }
  try {
    await verifyServer(port, token);
    return 'this';
  } catch (e: any) {
    if (/not running/.test(e?.message ?? '')) return 'none';
    return 'other';
  }
}

/** Start Crewdeck in the background: the service when installed, else a detached `crewdeck up` logging to a file. */
export function startDetached(o: { run?: Run } = {}): string {
  if (serviceInstalled()) { restartService(o); return 'the background service'; }
  mkdirSync(join(HOME, 'logs'), { recursive: true, mode: 0o700 });
  const out = openSync(join(HOME, 'logs', 'up.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'up'], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, CREWDECK_HOME: HOME } });
  child.unref();
  return `crewdeck up (logs: ${join(HOME, 'logs', 'up.log')})`;
}

/** Wait until this Crewdeck answers, up to `ms`. */
export async function waitForCrewdeck(port: number, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await whoAnswers(port)) === 'this') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** The command that opens a web address in the person's default browser. */
export const opener = (platform = process.platform): [string, string[]] | null =>
  platform === 'darwin' ? ['open', []] : platform === 'linux' ? ['xdg-open', []] : null;

/** The last lines of the service's log, for `service status`. */
export function serviceLogTail(lines = 5): string[] {
  const f = join(HOME, 'logs', 'service.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trimEnd().split('\n').slice(-lines);
}

/**
 * One `crewdeck up` per home at a time (security review #1): two starting together would each write a new token while
 * only one could listen, leaving the running server with a token nobody has. An exclusive lock file holds the start; a
 * lock whose process is gone (a crash, SIGKILL) is taken over. Released when the process exits.
 */
export function takeStartLock(home = HOME): boolean {
  const dir = join(home, 'run');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'up.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      process.on('exit', () => { try { if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); } catch {} });
      return true;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const pid = Number(readFileSafe(path));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return false;
      try { unlinkSync(path); } catch {}
    }
  }
  return false;
}
const readFileSafe = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
