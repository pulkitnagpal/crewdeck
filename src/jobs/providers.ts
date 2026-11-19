// Job-board providers (design §15, D7): third-party code from a pinned career-ops commit. The manifest in
// src/jobs/data/providers.manifest.json lists every file of the allow-listed providers' import closure with its sha256.
// Install downloads exactly those files (through netguard), checks each hash before writing it, and renames a finished
// temp dir to <jobs.home>/providers/<commit>/, so a half-written or tampered install never exists under that name. The
// files are run only by the sandboxed runner (provider-runner.ts), which checks every hash again.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Config, ensureHome } from '../config.ts';
import { type NetOptions, guardedFetch } from './net/netguard.ts';

export type Manifest = {
  repo: string; commit: string;
  license: { spdx: string; copyright: string; text: string; file: string; sha256: string };
  providers: string[]; detectors: string[]; files: Record<string, string>;
  optional_imports: Record<string, string[]>; excluded: Record<string, string>;
};
export type ProvidersStatus = { ready: boolean; message: string; dir?: string; commit?: string };

export const RAW_BASE = 'https://raw.githubusercontent.com';
const MANIFEST_FILE = join(import.meta.dirname, 'data', 'providers.manifest.json');
const MARKER = 'installed.json';
const PARALLEL = 6;

let cached: Manifest | null = null;
export function loadManifest(file = MANIFEST_FILE): Manifest {
  if (file === MANIFEST_FILE && cached) return cached;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (!/^[0-9a-f]{40}$/.test(m.commit) || !/^[\w.-]+\/[\w.-]+$/.test(m.repo)) throw new Error('providers manifest: bad repo or commit');
  for (const p of Object.keys(m.files)) if (!safeRel(p)) throw new Error(`providers manifest: bad path ${p}`);
  if (file === MANIFEST_FILE) cached = m;
  return m;
}

/** A repo-relative path that stays inside its folder. */
export const safeRel = (p: string) => /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.');

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const providersRoot = (c: Pick<Config, 'jobs'>) => join(c.jobs.home, 'providers');
export const providersDir = (c: Pick<Config, 'jobs'>, m: Manifest = loadManifest()) => join(providersRoot(c), m.commit);

/** Remove a folder this module wrote read-only (dirs 0500, files 0400). */
function removeTree(dir: string) {
  if (!existsSync(dir)) return;
  const open = (d: string) => {
    try { chmodSync(d, 0o700); } catch {}
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) open(join(d, e.name));
  };
  try { open(dir); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

/** Make the installed tree read-only for everyone but its owner's reads. */
function seal(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) seal(p); else chmodSync(p, 0o400);
  }
  chmodSync(dir, 0o500);
}

export type InstallOptions = { base?: string; net?: NetOptions; manifest?: Manifest; timeoutMs?: number };

/**
 * Download and verify the pinned providers into <jobs.home>/providers/<commit>/. Throws (after cleaning up) naming the
 * file and why on any failure; `installProviders` turns that into a status for `jobs init`.
 */
export async function downloadProviders(c: Pick<Config, 'jobs'>, o: InstallOptions = {}): Promise<{ dir: string; files: number }> {
  const m = o.manifest ?? loadManifest();
  const base = (o.base ?? RAW_BASE).replace(/\/+$/, '');
  ensureHome(c.jobs.home);
  const root = providersRoot(c);
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  const tmp = join(root, `.tmp-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const todo = Object.entries(m.files);
    let next = 0;
    const one = async () => {
      while (next < todo.length) {
        const [path, want] = todo[next++];
        const url = `${base}/${m.repo}/${m.commit}/${path}`;
        let r;
        try { r = await guardedFetch(url, { ...o.net, timeoutMs: o.timeoutMs ?? 20_000, maxBytes: 2_000_000, redirect: 'manual', headers: { accept: '*/*', 'accept-encoding': 'identity' } }); }
        catch (e: any) { throw new Error(`${path}: download failed (${e.message})`); }
        if (r.status !== 200) throw new Error(`${path}: download failed (HTTP ${r.status})`);
        const bytes = r.bytes ?? Buffer.from(r.body, 'utf8');
        const got = sha256(bytes);
        if (got !== want) throw new Error(`${path}: sha256 mismatch (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…): refused`);
        const dest = join(tmp, path);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        writeFileSync(dest, bytes, { mode: 0o400 });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, one));
    if (sha256(m.license.text) !== m.license.sha256) throw new Error('LICENSE: the manifest\'s copy does not match its sha256');
    writeFileSync(join(tmp, 'LICENSE'), m.license.text, { mode: 0o400 });
    writeFileSync(join(tmp, MARKER), JSON.stringify({ repo: m.repo, commit: m.commit, files: todo.length, installed: new Date().toISOString() }), { mode: 0o400 });
    seal(tmp);
    const dir = join(root, m.commit);
    removeTree(dir);
    renameSync(tmp, dir);
    // Other pinned commits are no longer used.
    for (const e of readdirSync(root)) if (e !== m.commit && /^([0-9a-f]{40}|\.tmp-[0-9a-f]+)$/.test(e)) removeTree(join(root, e));
    return { dir, files: todo.length };
  } catch (e) {
    removeTree(tmp);
    throw e;
  }
}

/** `jobs init` / `providers install`: download and verify, as a status line (never throws for a network problem). */
export async function installProviders(c: Pick<Config, 'jobs'>, o: InstallOptions = {}): Promise<ProvidersStatus> {
  const m = o.manifest ?? loadManifest();
  try {
    const r = await downloadProviders(c, { ...o, manifest: m });
    return { ready: true, dir: r.dir, commit: m.commit, message: `job-board providers: ${m.providers.length} from ${m.repo}@${m.commit.slice(0, 7)} (MIT), ${r.files} files verified` };
  } catch (e: any) {
    return { ready: false, commit: m.commit, message: `job-board providers could not be installed: ${e.message}. Pasted links, Prepare and Apply work without them; try again with crewdeck jobs providers install` };
  }
}

/**
 * Whether this Node can run the sandbox (E1): only from Node 25 does the permission model deny the network (and
 * `--allow-net` exist); on 22 and 24 a provider could open sockets, so sourcing refuses instead.
 */
export function sandboxSupport(version = process.versions.node, flags: ReadonlySet<string> = process.allowedNodeEnvironmentFlags): { ok: true } | { ok: false; why: string } {
  const major = Number(String(version).split('.')[0]);
  if (major >= 25 && flags.has('--allow-net')) return { ok: true };
  return { ok: false, why: `job-board providers need Node 25 or newer (this is Node ${version}): before 25 Node's permission model can't keep their code off the network. Install Node 25+ to fetch from boards; pasted links, Prepare and Apply work on this Node` };
}

/** Quick check (doctor, the server's timer): the verified install for the pinned commit is in place. */
export function providersStatus(c: Pick<Config, 'jobs'>, m: Manifest = loadManifest()): ProvidersStatus {
  const dir = providersDir(c, m);
  let marker: any;
  try { marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')); } catch {
    return { ready: false, dir, commit: m.commit, message: 'job-board providers are not installed: crewdeck jobs providers install (pasted links work without them)' };
  }
  const missing = Object.keys(m.files).filter((p) => !existsSync(join(dir, p)));
  if (marker.commit !== m.commit || missing.length) return { ready: false, dir, commit: m.commit, message: `job-board providers are incomplete (${missing.length} files missing): crewdeck jobs providers install` };
  const mode = statSync(dir).mode & 0o777;
  return { ready: true, dir, commit: m.commit, message: `job-board providers: ${m.providers.length} from ${m.repo}@${m.commit.slice(0, 7)}, installed ${String(marker.installed).slice(0, 10)}${mode & 0o222 ? ' (writable: reinstall)' : ''}` };
}

/** Every installed file against its sha256 (crewdeck jobs providers verify). */
export function verifyProviders(c: Pick<Config, 'jobs'>, m: Manifest = loadManifest()): { ok: boolean; bad: string[]; checked: number } {
  const dir = providersDir(c, m);
  const bad: string[] = [];
  for (const [p, want] of Object.entries(m.files)) {
    let got = '';
    try { got = sha256(readFileSync(join(dir, p))); } catch { bad.push(`${p}: missing`); continue; }
    if (got !== want) bad.push(`${p}: sha256 mismatch`);
  }
  try { if (sha256(readFileSync(join(dir, 'LICENSE'), 'utf8')) !== m.license.sha256) bad.push('LICENSE: changed'); } catch { bad.push('LICENSE: missing'); }
  return { ok: !bad.length, bad, checked: Object.keys(m.files).length };
}
