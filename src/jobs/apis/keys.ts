// Per-user API keys (design §11, A3): ~/.crewdeck/keys.json (CREWDECK_HOME), 0600, created on first write, read only by
// the fetch engine (the worker's sandbox denies it). Values never reach a log line: `redactUrl` / `redact` run on every
// line the APIs write, because Adzuna and Jooble put keys in the URL.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import type { KeyReader } from './types.ts';

/** Read at call time (not import time), so tests and the CLI child see their own CREWDECK_HOME. */
export const keysPath = (home = process.env.CREWDECK_HOME ?? join(homedir(), '.crewdeck')) => join(home, 'keys.json');

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
type File = { version: 1; keys: Record<string, { value: string; setAt: string }> };

export class KeyStore implements KeyReader {
  readonly path: string;
  #file: File;
  constructor(path = keysPath()) {
    this.path = path;
    this.#file = KeyStore.#read(path);
  }

  static #read(path: string): File {
    if (!existsSync(path)) return { version: 1, keys: {} };
    // Someone loosened it (an editor, a copy): tighten before reading.
    if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
    let j: any;
    try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error(`${path} is not valid JSON: fix or remove it (crewdeck jobs keys remove <provider> rewrites it)`); }
    const keys: File['keys'] = {};
    for (const [k, v] of Object.entries(j?.keys ?? {})) if (ID.test(k) && typeof (v as any)?.value === 'string') keys[k] = { value: (v as any).value, setAt: String((v as any).setAt ?? '') };
    return { version: 1, keys };
  }

  #write() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#file, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  get(provider: string): string | undefined { return this.#file.keys[provider]?.value; }
  has(provider: string): boolean { return Object.hasOwn(this.#file.keys, provider); }
  providers(): string[] { return Object.keys(this.#file.keys).sort(); }
  setAt(provider: string): string | undefined { return this.#file.keys[provider]?.setAt; }

  set(provider: string, value: string, now = new Date()) {
    if (!ID.test(provider)) throw new Error(`"${provider}" is not a provider id`);
    const v = value.trim();
    if (!v) throw new Error('the key is empty');
    if (/[\s\u0000-\u001f]/.test(v)) throw new Error('the key has spaces or control characters: paste only the key');
    if (v.length > 512) throw new Error('the key is longer than 512 characters');
    this.#file.keys[provider] = { value: v, setAt: now.toISOString() };
    this.#write();
  }

  /** True when there was one. */
  remove(provider: string): boolean {
    if (!this.has(provider)) return false;
    delete this.#file.keys[provider];
    this.#write();
    return true;
  }

  /** Every stored value: what `redact` must never let through. */
  secrets(): string[] {
    const out = new Set<string>();
    for (const { value } of Object.values(this.#file.keys)) {
      out.add(value);
      // "id:key" pairs (Adzuna, USAJobs): each part on its own too.
      for (const p of value.split(':')) if (p.length >= 6) out.add(p);
    }
    return [...out];
  }

  // console.log(store), JSON.stringify(store), `${store}`: never the values.
  toJSON() { return { path: this.path, providers: this.providers() }; }
  toString() { return `KeyStore(${this.providers().join(', ')})`; }
  [inspect.custom]() { return this.toString(); }
}

/** A key as it may be shown: the last 4 characters of a long key, nothing of a short one. */
export function mask(value: string | undefined): string {
  if (!value) return '(not set)';
  const tail = value.split(':').pop() ?? '';
  return tail.length >= 12 ? `••••••••${tail.slice(-4)}` : '••••••••';
}

const SECRET_PARAM = /^(app_?key|app_?id|api_?key|apikey|key|token|access_?token|secret|password|pass|auth|authorization|signature|sig)$/i;

/**
 * A URL safe for a log line: secret-looking query values and Jooble's `/api/<key>` path segment become ***, user info
 * is dropped. Anything that isn't a URL is returned with URLs inside it redacted.
 */
export function redactUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.replace(/https?:\/\/[^\s"'<>]+/g, (m) => redactUrl(m)); }
  u.username = ''; u.password = '';
  for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '***');
  // jooble.org/api/<key>
  u.pathname = u.pathname.replace(/^(\/api\/)[^/]+$/i, (m, p) => (/jooble\./i.test(u.hostname) ? `${p}***` : m));
  return u.toString().replace(/%2A%2A%2A/g, '***');
}

/** Any text for a log line or an error: URLs redacted, then every known secret replaced. */
export function redact(text: string, secrets: string[] = []): string {
  let t = redactUrl(String(text));
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) if (s && s.length >= 4) t = t.split(s).join('***');
  return t;
}
