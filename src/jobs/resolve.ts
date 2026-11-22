// Employers (design D24, §24.3): which provider reads an employer's careers page, checked at once. The detectors run in
// the provider sandbox, then a one-page test fetch through netguard (≤ 30 s); nothing reaches the tracker. The answer is
// written to jobs/sources.md right away: the provider, or `fetch: none` with the reason, so a page Crewdeck can't read
// stays on the list as "paste its postings" (and Claude can be asked to find the real jobs page: a `source` request).
import { loadConfig } from '../config.ts';
import { type Ctx, notesOf, openCtx } from './ctx.ts';
import { flag } from './cli.ts';
import { catalogEntry } from './catalog.ts';
import { type Manifest, loadManifest, providersDir, providersStatus, sandboxSupport } from './providers.ts';
import { type Plan, cleanEntry, spawnRunner } from './sources.ts';
import type { NetOptions } from './net/netguard.ts';
import { changeSources, isKey } from './sources-note.ts';
import { urlFrom } from './sources-cmd.ts';
import { showRequest } from '../agent-client.ts';

export type ResolveResult = { key: string; name: string; ok: boolean; provider?: string; provider_name?: string; jobs?: number; why?: string; ms?: number; changed: boolean; line: string };
export type ResolveOptions = { dir?: string; manifest?: Manifest; net?: NetOptions; timeoutMs?: number };

export const RESOLVE_TIMEOUT_MS = 30_000;
const NOT_READ = 'no provider reads this page: paste its postings, or ask Claude to find its jobs page';

/** Resolve one source by key and write the answer to the note. Throws (note unchanged) when it can't be tried. */
export async function resolveSource(ctx: Ctx, key: string, o: ResolveOptions = {}): Promise<ResolveResult> {
  if (!isKey(key)) throw new Error('a source key is lowercase letters, digits and - (crewdeck jobs sources list shows them)');
  const it = notesOf(ctx).sources.data.items.find((x) => x.key === key);
  if (!it) throw new Error(`no source with key ${key} (crewdeck jobs sources list shows the keys)`);
  if (it.linkedin) throw new Error('LinkedIn has no careers page to resolve');
  const page = it.careers_url ?? it.url;
  if (!page) throw new Error(`${it.name} is a board (${it.provider}), not a careers page: nothing to resolve`);
  const support = sandboxSupport();
  if (!support.ok) throw new Error(support.why);
  const m = o.manifest ?? loadManifest();
  const st = o.dir ? { ready: true, message: '' } : providersStatus({ jobs: { home: ctx.home } } as any, m);
  if (!st.ready) throw new Error(st.message);

  // The page as a careers_url (the detectors' input); a provider named on the entry is tried as named.
  const { url: _u, provider, ...rest } = it.entry as Record<string, unknown>;
  const entry = cleanEntry({ ...rest, careers_url: page, ...(it.provider && it.careers_url ? { provider } : {}) });
  const plan: Plan = { entries: [{ i: 0, key, name: it.name, kind: 'ats', entry }], ids: typeof entry.provider === 'string' ? [entry.provider] : [], skipped: [] };
  let line: { ok: boolean; provider?: string; jobs?: number; error?: string; ms?: number } | undefined;
  let fatal = '';
  const t = o.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const out = await spawnRunner(plan, (l) => {
    if (l.t === 'entry' && l.i === 0) line = { ok: !!l.ok, provider: typeof l.provider === 'string' ? l.provider.slice(0, 60) : undefined, jobs: typeof l.jobs === 'number' ? l.jobs : 0, error: l.ok ? undefined : String(l.error ?? 'failed').slice(0, 300), ms: l.ms };
    if (l.t === 'fatal') fatal = String(l.error ?? '').slice(0, 300);
  }, { dir: o.dir ?? providersDir({ jobs: { home: ctx.home } } as any, m), manifest: m, net: o.net, maxPages: 1, entryTimeoutMs: t, timeoutMs: t + 5_000 });
  if (fatal) throw new Error(`the provider sandbox refused to run: ${fatal}`);
  if (!line) line = { ok: false, error: out.killed ? `no answer within ${Math.round(t / 1000)} s` : 'the provider sandbox stopped early' };

  const r = line;
  const pname = r.provider ? (catalogEntry(r.provider)?.name ?? r.provider) : undefined;
  if (r.ok && r.provider) {
    const msg = `resolved ${it.name}: ${pname}, ${r.jobs} role${r.jobs === 1 ? '' : 's'} on a one-page test`;
    const w = changeSources(ctx, { op: 'set', key, fields: { provider: r.provider, careers_url: page, url: null, fetch: null, why: null }, line: msg });
    return { key, name: it.name, ok: true, provider: r.provider, provider_name: pname, jobs: r.jobs, ms: r.ms, changed: w.changed, line: msg };
  }
  const why = !r.provider || /no provider recognises/.test(r.error ?? '') ? NOT_READ : `${pname} couldn't read it (${r.error}): paste its postings, or ask Claude to find its jobs page`;
  const msg = `${it.name} isn't readable by Crewdeck: ${why}`;
  const w = changeSources(ctx, { op: 'set', key, fields: { fetch: 'none', why }, line: msg });
  return { key, name: it.name, ok: false, ...(r.provider ? { provider: r.provider, provider_name: pname } : {}), why, ms: r.ms, changed: w.changed, line: msg };
}

const say = (s: string) => console.log(s);

async function withCtx<T>(fn: (ctx: Ctx) => T | Promise<T>): Promise<T> {
  const ctx = openCtx(loadConfig());
  try { return await fn(ctx); } finally { ctx.db.close(); }
}

/** `crewdeck jobs sources resolve <key> [--json]` */
export function resolveCmd(key: string | undefined, args: string[]) {
  if (!key) throw new Error('usage: crewdeck jobs sources resolve <key> [--json]');
  return withCtx(async (ctx) => {
    const r = await resolveSource(ctx, key);
    if (args.includes('--json')) return say(JSON.stringify(r, null, 1));
    say(r.ok ? `${r.name}: ${r.provider_name}, ${r.jobs} role${r.jobs === 1 ? '' : 's'} on a one-page test (jobs/sources.md updated)` : `${r.name}: not readable by Crewdeck. ${r.why}`);
    if (!r.ok) process.exitCode = 2;
  });
}

/**
 * `crewdeck jobs sources set-url <key> --url-file f` or `set-url --request <id> --url-file f`: the real jobs page for a
 * source (found by Claude in the pane). The address replaces the old one as a careers page; run resolve next.
 */
export async function setUrlCmd(key: string | undefined, args: string[]) {
  const usage = 'usage: crewdeck jobs sources set-url <key> --url-file f | set-url --request <id> --url-file f';
  let k = key;
  let request: number | undefined;
  if (flag(args, 'request') !== undefined) {
    const r = await showRequest(flag(args, 'request'));
    if (r.kind !== 'source') throw new Error(`request ${r.id} is ${r.kind ? `kind ${r.kind}` : 'not a Jobs request'}: set-url --request works source requests`);
    if (r.status !== 'new' && r.status !== 'picked') throw new Error(`request ${r.id} is already ${r.status}`);
    k = String(r.payload?.key ?? '');
    request = r.id;
  }
  if (!k || !flag(args, 'url-file')) throw new Error(usage);
  const url = urlFrom(flag(args, 'url-file'), '--url-file');
  return withCtx((ctx) => {
    const it = notesOf(ctx).sources.data.items.find((x) => x.key === k);
    if (!it || it.linkedin || (!it.careers_url && !it.url)) throw new Error(`${k} is not an employer or web-address source (crewdeck jobs sources list)`);
    const r = changeSources(ctx, { op: 'set', key: k!, fields: { careers_url: url, url: null, provider: null, fetch: null, why: null }, line: `new jobs page for ${it.name}${request ? ` (request ${request})` : ''}: ${url}` });
    say(r.changed ? `jobs/sources.md: ${it.name} now reads ${url}. Next: crewdeck jobs sources resolve ${k}` : 'jobs/sources.md: unchanged');
  });
}

