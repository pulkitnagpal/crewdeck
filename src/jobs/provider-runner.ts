// The provider sandbox (design D7, §15): third-party career-ops code runs here, never in a Crewdeck process that can read
// the user's files. The parent (sources.ts) spawns
//   node --permission --allow-fs-read=<providers dir> --allow-fs-read=<this file> [--allow-net]
//        --disallow-code-generation-from-strings <this file> <providers dir>
// with an empty environment, so this process can read only the verified providers and itself, can't write files, start
// processes or workers, and sees no proxy or credential variables. It imports nothing but node: built-ins (one read grant).
//
// The job arrives on stdin as JSON; jobs go out on stdout as JSON lines (`{"t":"job"|"entry"|"fatal"|"done"}`). Every hash
// is checked before anything is imported, and the load hook hashes the exact source it hands to V8. The resolve hook
// refuses files outside the manifest, packages from npm, and the built-ins a provider has no business with.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type RunnerJob = {
  files: Record<string, string>; ids: string[]; detectors: string[];
  entries: { i: number; entry: Record<string, unknown> }[];
  since_ms?: number; timeout_ms?: number; max_jobs?: number; max_pages?: number; concurrency?: number;
};
export type Normalised = { url: string; title: string; company: string; location: string; description: string; pay_text?: string; posted_at?: string };

export const DENIED_BUILTINS = ['child_process', 'cluster', 'worker_threads', 'inspector', 'wasi', 'repl', 'vm', 'v8', 'module', 'trace_events', 'sqlite', 'http2'];
const bare = (s: string) => s.replace(/^node:/, '').split('/')[0];

function payText(s: any): string | undefined {
  if (!s || typeof s !== 'object' || (s.min == null && s.max == null)) return undefined;
  const range = [s.min, s.max].filter((v) => typeof v === 'number' && Number.isFinite(v)).join('-');
  if (!range) return undefined;
  return `${typeof s.currency === 'string' ? s.currency : ''} ${range}${typeof s.period === 'string' ? ` per ${s.period}` : ''}`.trim();
}
const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** A career-ops Job as a role (ported from the Job Agent): Hacker News "Company | Role | Place" titles are split. */
export function normalizeJob(job: any, provider: string): Normalised {
  let company = text(job.company).trim();
  let title = text(job.title).trim();
  let location = [job.location, job.workplaceType, job.eligibilityText].map(text).filter(Boolean).join(' · ');
  if (provider === 'hackernews') {
    // HN first lines look like "Company | Role | Location | Pay": the board's name is not the company.
    const segs = (title.includes('|') ? title : text(job.description)).split('|').map((x) => x.trim()).filter(Boolean);
    if (segs.length >= 2) {
      company = segs[0];
      title = segs[1];
      location = [location, ...segs.slice(2)].filter(Boolean).join(' | ');
    } else if (/hacker news/i.test(company)) company = '';
  }
  const at = typeof job.postedAt === 'number' && Number.isFinite(job.postedAt) ? new Date(job.postedAt) : null;
  return {
    url: text(job.url).trim(), title, company, location, description: text(job.description),
    pay_text: payText(job.salary), posted_at: at && !Number.isNaN(at.getTime()) ? at.toISOString() : undefined,
  };
}

async function main(dir: string) {
  // The protocol channel is ours: providers' console output goes to stderr.
  const write = process.stdout.write.bind(process.stdout);
  const send = (o: unknown) => write(`${JSON.stringify(o)}\n`);
  const toErr = (...a: unknown[]) => process.stderr.write(`${a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')}\n`);
  for (const k of ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const) (console as any)[k] = toErr;

  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RunnerJob;
  const files = job.files;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const root = dir.endsWith(sep) ? dir : dir + sep;

  // 1. Every file, before anything runs.
  for (const [p, want] of Object.entries(files)) {
    let got = '';
    try { got = sha(readFileSync(join(dir, p))); } catch (e: any) { send({ t: 'fatal', error: `${p}: ${e.code ?? e.message}` }); process.exit(3); }
    if (got !== want) { send({ t: 'fatal', error: `${p}: sha256 mismatch: reinstall with crewdeck jobs providers install` }); process.exit(3); }
  }

  // 2. Only listed files, only allowed built-ins; the source V8 runs is the source that was hashed.
  const listed = (url: string): string | null => {
    if (!url.startsWith('file:')) return null;
    const f = fileURLToPath(url);
    if (!f.startsWith(root)) return null;
    const rel = relative(dir, f).split(sep).join('/');
    return Object.hasOwn(files, rel) ? rel : null;
  };
  registerHooks({
    resolve(spec, context, next) {
      if (isBuiltin(spec)) {
        if (DENIED_BUILTINS.includes(bare(spec))) throw new Error(`provider sandbox: ${spec} is not allowed`);
        return next(spec, context);
      }
      let url: string;
      try { url = new URL(spec, context.parentURL).href; } catch { throw new Error(`provider sandbox: ${spec} is not allowed`); }
      if (!/^(\.{0,2}\/|file:)/.test(spec) || !listed(url)) throw new Error(`provider sandbox: ${spec} is not in the providers manifest`);
      return { url, format: 'module', shortCircuit: true };
    },
    load(url, context, next) {
      if (url.startsWith('node:')) return next(url, context);
      const rel = listed(url);
      if (!rel) throw new Error(`provider sandbox: ${url} is not in the providers manifest`);
      const source = readFileSync(fileURLToPath(url));
      if (sha(source) !== files[rel]) throw new Error(`provider sandbox: ${rel} changed after it was verified`);
      return { format: 'module', source, shortCircuit: true };
    },
  });

  // 3. The providers this run needs (explicit ids, plus detectors in career-ops order for careers pages).
  const http = await import(pathToFileURL(join(dir, 'providers', '_http.mjs')).href);
  const providers = new Map<string, any>();
  const load = async (id: string) => {
    if (providers.has(id)) return providers.get(id);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !Object.hasOwn(files, `providers/${id}.mjs`)) throw new Error(`unknown provider ${id}`);
    const m = await import(pathToFileURL(join(dir, 'providers', `${id}.mjs`)).href);
    const p = m.default;
    if (!p || typeof p.fetch !== 'function') throw new Error(`provider ${id} has no fetch`);
    providers.set(id, p);
    return p;
  };
  for (const id of job.ids) { try { await load(id); } catch (e: any) { toErr(`provider ${id}: ${e.message}`); } }
  const detectors: any[] = [];
  if (job.entries.some((e) => !e.entry.provider)) for (const id of [...job.detectors].sort()) { try { detectors.push(await load(id)); } catch (e: any) { toErr(`detector ${id}: ${e.message}`); } }

  const timeout = job.timeout_ms ?? 90_000, maxJobs = job.max_jobs ?? 2000, cutoff = job.since_ms ?? 0;
  const runEntry = async ({ i, entry }: RunnerJob['entries'][number]) => {
    const started = Date.now();
    let p: any;
    try {
      if (typeof entry.provider === 'string') p = await load(entry.provider);
      else p = detectors.find((d) => { try { return typeof d.detect === 'function' && d.detect(entry); } catch { return false; } });
    } catch (e: any) { return send({ t: 'entry', i, ok: false, error: String(e.message).slice(0, 300) }); }
    if (!p) return send({ t: 'entry', i, ok: false, error: 'no provider recognises this careers page' });
    // Board ids a careers page reveals: kept for this run only (no disk).
    const cache = new Map<string, unknown>();
    const ctx = { ...http.makeHttpCtx(), maxPages: job.max_pages ?? 10, idCache: { get: (k: string) => cache.get(k), set: (k: string, v: unknown) => { cache.set(k, v); }, delete: (k: string) => { cache.delete(k); } } };
    let timer: NodeJS.Timeout | undefined;
    try {
      const jobs = await Promise.race([
        Promise.resolve().then(() => p.fetch(entry, ctx)),
        new Promise((_, bad) => { timer = setTimeout(() => bad(new Error(`timed out after ${Math.round(timeout / 1000)} s`)), timeout); }),
      ]);
      if (!Array.isArray(jobs)) throw new Error('the provider returned no list');
      let n = 0, old = 0;
      for (const j of jobs) {
        if (n >= maxJobs) break;
        if (!j || typeof j !== 'object' || !j.url || !j.title) continue;
        if (cutoff && typeof j.postedAt === 'number' && j.postedAt < cutoff) { old++; continue; }
        send({ t: 'job', i, provider: p.id, job: normalizeJob(j, String(p.id)) });
        n++;
      }
      send({ t: 'entry', i, ok: true, provider: p.id, jobs: n, old, total: jobs.length, ms: Date.now() - started });
    } catch (e: any) {
      send({ t: 'entry', i, ok: false, provider: p.id, error: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started });
    } finally { clearTimeout(timer); }
  };
  const queue = [...job.entries];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(job.concurrency ?? 4, 8)) }, async () => { while (queue.length) await runEntry(queue.shift()!); }));
  send({ t: 'done' });
  // Sockets a provider left open must not keep the sandbox alive.
  process.stdout.write('', () => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: provider-runner.ts <providers dir> < job.json\n'); process.exit(2); }
  main(dir).catch((e) => { process.stdout.write(`${JSON.stringify({ t: 'fatal', error: String(e?.message ?? e).slice(0, 500) })}\n`, () => process.exit(3)); });
}
