// How `crewdeck up` runs the tools it reuses so that only Crewdeck's proxies can reach them (design §14, review W1/W2).
// - SilverBullet listens on a Unix socket in a private folder (no TCP port at all) with its shell backend off, so no
//   web page (cross-site POST /.shell, DNS rebinding) and no other user can reach it; the Notes proxy is the only door.
// - Backlog.md can only listen on 127.0.0.1:<port> with no auth, Host or Origin check (checked in 1.55.3's source): each
//   board gets a random internal port chosen per launch, never shown in /api/state. A residual risk (README).
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Service } from './supervisor.ts';

/** Unix socket paths are short (104 bytes on macOS, 108 on Linux, including the NUL). */
const MAX_SOCKET = 100;

/** A private (0700) folder for SilverBullet's socket: <home>/run, or a private temp folder when that path is too long. */
export function notesSocketPath(home: string): string {
  const dir = join(home, 'run');
  let path = join(dir, 'notes.sock');
  if (Buffer.byteLength(path) <= MAX_SOCKET) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return path;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'crewdeck-'));
  chmodSync(tmp, 0o700);
  path = join(tmp, 'notes.sock');
  if (Buffer.byteLength(path) > MAX_SOCKET) throw new Error(`No short enough private folder for SilverBullet's socket (tried ${path})`);
  return path;
}

/** SilverBullet on a Unix socket, shell commands off (SB_SHELL_BACKEND=off answers "Shell commands are disabled"). */
export function silverbulletService(bin: string, vault: string, socket: string): Service {
  return {
    name: 'silverbullet', cmd: bin, args: ['--single', vault],
    env: { SB_UNIX_SOCKET: socket, SB_SHELL_BACKEND: 'off' },
    // A socket left by a crash would stop the next start from binding.
    before: () => { if (existsSync(socket)) rmSync(socket, { force: true }); },
  };
}

/** A free TCP port on 127.0.0.1 chosen by the system (random, per launch). */
export function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port as number;
      s.close(() => ok(port));
    });
  });
}
