// Starts the services Crewdeck reuses (SilverBullet, Backlog.md) and keeps them running.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, REPO } from './config.ts';

/** before: run right before each start (and restart). */
export type Service = { name: string; cmd: string; args: string[]; cwd?: string; env?: Record<string, string>; before?: () => void };

export function supervise(services: Service[], log: (s: string) => void = console.log) {
  const logs = join(HOME, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const children = new Map<string, ChildProcess>();
  let stopping = false;

  const start = (svc: Service, attempt = 0) => {
    try { svc.before?.(); } catch (e: any) { log(`${svc.name}: ${e?.message ?? e}`); }
    const out = createWriteStream(join(logs, `${svc.name}.log`), { flags: 'a', mode: 0o600 });
    const child = spawn(svc.cmd, svc.args, { cwd: svc.cwd, env: { ...process.env, ...svc.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(out); child.stderr?.pipe(out);
    children.set(svc.name, child);
    const startedAt = Date.now();
    child.on('exit', (code) => {
      children.delete(svc.name);
      if (stopping) return;
      // Back off when it keeps dying straight away; reset once it has run for a while.
      const next = Date.now() - startedAt > 30_000 ? 0 : attempt + 1;
      const wait = Math.min(30_000, 1000 * 2 ** Math.min(next, 5));
      log(`${svc.name} exited (${code}); restarting in ${Math.round(wait / 1000)}s — see ~/.crewdeck/logs/${svc.name}.log`);
      setTimeout(() => start(svc, next), wait);
    });
  };

  for (const s of services) start(s);
  const stop = () => { stopping = true; for (const c of children.values()) c.kill('SIGTERM'); };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  return { stop, children };
}

export const silverbulletBin = () => join(HOME, 'bin', process.platform === 'win32' ? 'silverbullet.exe' : 'silverbullet');
export function backlogBin() {
  const local = join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'backlog.cmd' : 'backlog');
  return existsSync(local) ? local : 'backlog';
}
