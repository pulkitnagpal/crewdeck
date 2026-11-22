// A human's yes for a risky switch (review W3/C1). Headers can't prove a person clicked (any local process can forge
// them, and `script` fakes a terminal), so switching a risky feature on, or raising its daily number, needs one of:
// - a native dialog Crewdeck shows itself: macOS osascript, Linux zenity or kdialog. Claude's sandboxed shell can't
//   click it (no Apple Events, no display socket);
// - with no dialog available: the user runs `crewdeck jobs features …` in a terminal and types a one-time code that
//   only the Jobs page shows (10 minutes, single use, stored as an HMAC under the agent token).
import { execFile } from 'node:child_process';
import { createHmac, randomInt } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOME, ensureHome } from '../config.ts';
import { sameSecret } from '../http.ts';

export type Answer = 'yes' | 'no' | 'unavailable';
export type Confirm = (title: string, text: string) => Promise<Answer>;
/** Runs a dialog program: its exit code and output, or an error (not found, no display). Tests replace it. */
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; error?: string }>;

const TIMEOUT_S = 120;
const YES = 'Switch on';

const run: Runner = (cmd, args, timeoutMs) => new Promise((ok) => {
  execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (e: any, stdout, stderr) => {
    if (!e) return ok({ code: 0, stdout, stderr });
    if (typeof e.code === 'number') return ok({ code: e.code, stdout, stderr });
    ok({ code: -1, stdout, stderr, error: String(e.code ?? e.message) }); // ENOENT, killed by the timeout…
  });
});

const onPath = (name: string, env = process.env) => (env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, name)));

/** The system's own yes/no dialog, or 'unavailable' (no GUI session, no dialog program). */
export function nativeConfirm(o: { platform?: string; runner?: Runner; env?: NodeJS.ProcessEnv; has?: (name: string) => boolean } = {}): Confirm {
  const platform = o.platform ?? process.platform, runner = o.runner ?? run, env = o.env ?? process.env;
  const has = o.has ?? ((n: string) => onPath(n, env));
  const ms = (TIMEOUT_S + 10) * 1000;
  // Never a real dialog on the user's screen from the test runner (node --test sets NODE_TEST_CONTEXT, children inherit it).
  const testRun = !o.runner && !!env.NODE_TEST_CONTEXT;
  return async (title, text) => {
    if (testRun) return 'unavailable';
    if (platform === 'darwin') {
      // The text travels as an argument (argv), never inside the AppleScript source.
      const r = await runner('/usr/bin/osascript', ['-e', 'on run argv',
        '-e', `display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Cancel", "${YES}"} default button "Cancel" cancel button "Cancel" with icon caution giving up after ${TIMEOUT_S}`,
        '-e', 'end run', title, text], ms);
      if (r.code === 0) return /button returned:Switch on/.test(r.stdout) && !/gave up:true/.test(r.stdout) ? 'yes' : 'no';
      // -128: the user clicked Cancel. Anything else (no window server, osascript missing) means no dialog here.
      return /-128/.test(r.stderr) ? 'no' : 'unavailable';
    }
    if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
      if (has('zenity')) {
        const r = await runner('zenity', ['--question', '--no-markup', `--title=${title}`, `--text=${text}`, `--ok-label=${YES}`, '--cancel-label=Cancel', `--timeout=${TIMEOUT_S}`], ms);
        return r.error ? 'unavailable' : r.code === 0 ? 'yes' : 'no';
      }
      if (has('kdialog')) {
        const r = await runner('kdialog', ['--title', title, '--warningcontinuecancel', text, '--continue-label', YES], ms);
        return r.error ? 'unavailable' : r.code === 0 ? 'yes' : 'no';
      }
    }
    return 'unavailable';
  };
}

// ---- the terminal fallback: a one-time code ----

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
export const CODE_MS = 10 * 60_000;
export const codeFile = (home = HOME) => join(home, 'feature-code.json');
const mac = (token: string, code: string, name: string, value: unknown) => createHmac('sha256', token).update(`crewdeck-feature:${name}:${JSON.stringify(value)}:${code}`).digest('hex');

/** A new code for exactly this change (replacing any earlier one), shown only on the page that asked. */
export function issueCode(token: string, name: string, value: boolean | number, file = codeFile(), now = Date.now()): { code: string; expires: string } {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expires = new Date(now + CODE_MS).toISOString();
  ensureHome(dirname(file));
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify({ name, value, expires, mac: mac(token, raw, name, value) }), { mode: 0o600 });
  renameSync(tmp, file);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires };
}

/** Is this the code the page showed for this change? Used once: right or wrong, a code is spent after three tries. */
export function useCode(token: string, name: string, value: boolean | number, typed: string, file = codeFile(), now = Date.now()): boolean {
  let s: any;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
  const code = String(typed ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ok = s?.name === name && JSON.stringify(s?.value) === JSON.stringify(value) && Date.parse(s?.expires) > now && sameSecret(mac(token, code, name, value), String(s?.mac ?? ''));
  const tries = Number(s?.tries ?? 0) + 1;
  if (ok || tries >= 3 || !(Date.parse(s?.expires) > now)) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify({ ...s, tries }), { mode: 0o600 });
  return ok;
}
