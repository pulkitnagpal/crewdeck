// Files named on the command line (`--text-file`, `--fields-file`, `--result-file`, …) (E5). The unsandboxed `crewdeck`
// wrapper is the one command the jobs sandbox lets out, so a file flag must not become a way to read what the sandbox
// hides (the token, config.yaml) or anything else on the machine: the real path, links resolved, must sit under one of
// the allowed folders (Jobs' home or workspace), and Crewdeck's token and config are refused wherever they are.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { CONFIG_PATH, HOME, TOKEN_PATH } from './config.ts';

export type FileRoots = { roots: string[]; /** tests only: more folders (e.g. a temp dir), passed explicitly in code */ extraRoots?: string[] };

const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Crewdeck's own secrets and settings: never read or written through a file flag. */
function forbidden(p: string): boolean {
  for (const f of [TOKEN_PATH, CONFIG_PATH]) {
    const d = real(dirname(f));
    const r = real(f) ?? (d ? join(d, basename(f)) : null);
    if (r && p === r) return true;
  }
  return false;
}

/** The checked real path of a file to read, or an error that says where files may live. */
export function checkedPath(path: string, what: string, o: FileRoots, mode: 'read' | 'write' = 'read'): string {
  const roots = [...o.roots, ...(o.extraRoots ?? [])].map(real).filter((r): r is string => !!r);
  // A file to write may not exist yet: its folder must.
  const p = mode === 'read' ? real(path) : (() => { const d = real(dirname(path)); return d ? join(d, basename(path)) : null; })();
  if (!p) throw new Error(`${what}: ${path} does not exist`);
  if (forbidden(p)) throw new Error(`${what}: Crewdeck's token and config are never read or written through a file flag`);
  if (!roots.some((r) => under(p, r))) throw new Error(`${what}: files must be inside ${o.roots.join(' or ')} (write them to <jobs home>/out/tmp with the Write tool)`);
  if (mode === 'read' && !statSync(p).isFile()) throw new Error(`${what}: ${path} is not a regular file`);
  return p;
}

/** A file's text through `checkedPath`, or stdin for "-". */
export function readChecked(path: string, what: string, o: FileRoots): string {
  if (path === '-') return readFileSync(0, 'utf8');
  return readFileSync(checkedPath(path, what, o), 'utf8');
}

/** Outside the jobs lane only Crewdeck's own files are refused: everything else in its home, the token and config. */
export function notCrewdeckFile(path: string, what: string, jobsHome: string): string {
  const p = real(path);
  if (!p) throw new Error(`${what}: ${path} does not exist`);
  const home = real(HOME), jobs = real(jobsHome);
  if (forbidden(p) || (home && under(p, home) && !(jobs && under(p, jobs)))) throw new Error(`${what}: Crewdeck's own files are never read through a file flag`);
  if (!statSync(p).isFile()) throw new Error(`${what}: ${path} is not a regular file`);
  return p;
}
