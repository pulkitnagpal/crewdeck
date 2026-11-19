// `crewdeck jobs source` (design §2.4 step 1, §15): fetch new roles without spending a token. The pinned providers run in
// the sandboxed child (provider-runner.ts), which has no network: its fetches come here over a private channel and go
// out through netguard (E1). Every job it sends is checked here before it reaches the tracker. Then
// LinkedIn guest search (only when the user switched it on), the rule prefilter, and descriptions for the best-ranked
// roles that came without one. What happened is written to <jobs.home>/state/sources.json for the Jobs page.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { ensureHome } from '../config.ts';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { addEvent, upsertRole } from './db.ts';
import type { JobNotes } from './notes.ts';
import type { SourceEntry } from './schema.ts';
import { checkRoleUrl } from './fields.ts';
import { type Manifest, loadManifest, providersDir, providersStatus, sandboxSupport } from './providers.ts';

export { sandboxSupport };
import { runPrefilter } from './pipeline/prefilter.ts';
import { type NetOptions, NetError, guardedFetch } from './net/netguard.ts';
import type { FetchAnswer, FetchAsk } from './provider-runner.ts';

export const RUNNER = join(import.meta.dirname, 'provider-runner.ts');
const MAX_LINES = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;

// ---- the plan: which entries, which providers ----

export type PlannedEntry = { i: number; name: string; list: 'boards' | 'watchlist'; kind: 'ats' | 'board'; entry: Record<string, unknown> };
export type Plan = { entries: PlannedEntry[]; ids: string[]; skipped: { name: string; why: string }[] };

/** Only plain values reach third-party code: strings (≤ 2000), finite numbers, booleans, and lists of strings. */
export function cleanEntry(e: SourceEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ok = (v: unknown): boolean => (typeof v === 'string' && v.length <= 2000) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
  for (const [k, v] of Object.entries(e)) {
    if (!/^[A-Za-z_][\w-]{0,40}$/.test(k) || k === 'parser' || k === 'enabled') continue;
    if (ok(v)) out[k] = v;
    else if (Array.isArray(v) && v.length <= 100 && v.every((x) => typeof x === 'string' && x.length <= 300)) out[k] = [...v];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      // One level of plain options (e.g. arbeitsagentur: { keywords: [...] }).
      const inner: Record<string, unknown> = {};
      for (const [k2, v2] of Object.entries(v)) if (/^[A-Za-z_][\w-]{0,40}$/.test(k2) && (ok(v2) || (Array.isArray(v2) && v2.length <= 100 && v2.every((x) => typeof x === 'string' && x.length <= 300)))) inner[k2] = v2;
      out[k] = inner;
    }
  }
  return out;
}

export function sourcePlan(notes: Pick<JobNotes, 'sources'>, m: Manifest = loadManifest()): Plan {
  const allowed = new Set(m.providers);
  const plan: Plan = { entries: [], ids: [], skipped: [] };
  const ids = new Set<string>();
  let i = 0;
  for (const list of ['boards', 'watchlist'] as const) for (const e of notes.sources.data[list]) {
    if (e.enabled === false) continue;
    const name = String(e.name ?? '').slice(0, 200) || '(no name)';
    if (typeof e.provider === 'string' && e.provider) {
      if (!allowed.has(e.provider)) { plan.skipped.push({ name, why: `provider ${e.provider} is not one Crewdeck runs` }); continue; }
      ids.add(e.provider);
    } else if (typeof e.careers_url !== 'string' || !/^https?:\/\//.test(e.careers_url)) { plan.skipped.push({ name, why: 'needs a provider or a careers_url' }); continue; }
    plan.entries.push({ i: i++, name, list, kind: list === 'watchlist' || typeof e.careers_url === 'string' ? 'ats' : 'board', entry: cleanEntry(e) });
  }
  plan.ids = [...ids].sort();
  return plan;
}

// ---- the sandboxed child ----

/** Node's flags for the sandbox: read the providers and the runner only. No network: --allow-net is never given. */
export function runnerArgs(dir: string, runner = RUNNER): string[] {
  return ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${runner}`, '--disallow-code-generation-from-strings', '--max-old-space-size=512', runner, dir];
}

export type RunnerLine = { t: 'job'; i: number; provider: string; job: any } | { t: 'entry'; i: number; ok: boolean; provider?: string; jobs?: number; old?: number; error?: string; ms?: number } | { t: 'fatal'; error: string } | { t: 'done' };

export type SpawnOptions = { dir?: string; runner?: string; manifest?: Manifest; timeoutMs?: number; entryTimeoutMs?: number; sinceDays?: number; maxPages?: number; /** netguard test options for the providers' fetches */ net?: NetOptions };

// What the parent fetches for the providers (E1): netguard's checks on every request and redirect, its 15 s deadline
// and 5 redirects; 10 MB per body (career-ops' own cap: some boards send their whole list in one answer), at most 8 in
// flight, 2000 requests and 256 MB per run. GET, HEAD and POST only; request bodies ≤ 1 MB.
export const FETCH_CAPS = { maxBytes: 10_000_000, inFlight: 8, requests: 2000, totalBytes: 256_000_000, bodyBytes: 1_000_000 };
const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect', 'accept-encoding']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** One provider fetch through netguard, as the answer line the child turns back into a Response. */
export async function answerFetch(a: FetchAsk, o: { net?: NetOptions; caps?: typeof FETCH_CAPS; budget: { requests: number; bytes: number } }): Promise<FetchAnswer> {
  const caps = o.caps ?? FETCH_CAPS;
  const id = a.id;
  if (++o.budget.requests > caps.requests) return { id, error: `more than ${caps.requests} requests in one run: stopped`, code: 'budget' };
  const method = String(a.method).toUpperCase();
  if (!['GET', 'HEAD', 'POST'].includes(method)) return { id, error: `${method} requests are not made for providers`, code: 'method' };
  const body = method === 'POST' && typeof a.body === 'string' ? Buffer.from(a.body, 'base64') : undefined;
  if (body && body.length > caps.bodyBytes) return { id, error: 'request body larger than 1 MB', code: 'too_large' };
  const headers: Record<string, string> = {};
  for (const [k, v] of Array.isArray(a.headers) ? a.headers.slice(0, 100) : []) {
    const name = String(k).toLowerCase();
    if (/^[!#$%&'*+.^_`|~0-9a-z-]{1,100}$/.test(name) && !DROP_REQUEST.has(name) && typeof v === 'string' && v.length <= 8000 && !/[\r\n]/.test(v)) headers[name] = v;
  }
  const redirect = a.redirect === 'follow' ? 'follow' : 'manual';
  try {
    const r = await guardedFetch(String(a.url), { ...o.net, method, body, headers, redirect, maxBytes: caps.maxBytes });
    o.budget.bytes += r.bytes?.length ?? 0;
    if (o.budget.bytes > caps.totalBytes) return { id, error: `more than ${Math.round(caps.totalBytes / 1e6)} MB in one run: stopped`, code: 'budget' };
    if (a.redirect === 'error' && r.status >= 300 && r.status <= 399 && r.headers.location) return { id, error: 'unexpected redirect', code: 'redirect' };
    const out: [string, string][] = [];
    for (const [k, v] of Object.entries(r.headers)) if (!DROP_RESPONSE.has(k) && v !== undefined) for (const x of Array.isArray(v) ? v : [v]) out.push([k, String(x)]);
    return { id, status: r.status, statusText: r.statusText ?? '', url: r.url, redirected: r.redirects.length > 0, headers: out, body: (r.bytes ?? Buffer.from(r.body)).toString('base64') };
  } catch (e: any) {
    return { id, error: String(e?.message ?? e).slice(0, 300), code: e instanceof NetError ? e.code : 'network' };
  }
}

/** Lines `<nonce> <json>` from a stream, capped: anything without the run's nonce is not the runner's and is dropped. */
function protocolLines(s: Readable, nonce: string, on: (l: any) => void, over: () => void) {
  let buf = '', bytes = 0, lines = 0;
  s.setEncoding('utf8');
  s.on('data', (d: string) => {
    bytes += d.length;
    if (bytes > MAX_BYTES) return over();
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (++lines > MAX_LINES) return over();
      if (!line.startsWith(`${nonce} `)) { on(undefined); continue; }
      let l: any;
      try { l = JSON.parse(line.slice(nonce.length + 1)); } catch { on(undefined); continue; }
      on(l);
    }
  });
}

/** Run the child and hand each protocol line to `onLine`. Resolves with the exit and the tail of what it printed. */
export function spawnRunner(plan: Plan, onLine: (l: RunnerLine) => void, o: SpawnOptions & { dir: string }): Promise<{ code: number | null; stderr: string; done: boolean; killed: boolean; bad: number; fetches: number }> {
  const support = sandboxSupport();
  if (!support.ok) return Promise.reject(new Error(support.why));
  const m = o.manifest ?? loadManifest();
  const dir = realpathSync(o.dir), runner = realpathSync(o.runner ?? RUNNER);
  const nonce = randomBytes(24).toString('hex');
  const input = JSON.stringify({
    nonce, files: m.files, ids: plan.ids, detectors: m.detectors, entries: plan.entries.map((e) => ({ i: e.i, entry: e.entry })),
    since_ms: o.sinceDays ? Date.now() - o.sinceDays * 86_400_000 : 0, timeout_ms: o.entryTimeoutMs ?? 90_000, max_jobs: 2000, max_pages: o.maxPages ?? 10, concurrency: 4,
  });
  return new Promise((resolve) => {
    // An empty environment: no proxy variables, no tokens, nothing of the user's. fd 3 (lines from the child) and fd 4
    // (fetch answers to it) are the private channel (E9);
    // stdout and stderr are kept only as a log tail.
    const child = spawn(process.execPath, runnerArgs(dir, runner), { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const chan = child.stdio[3] as unknown as Readable, answers = child.stdio[4] as unknown as Writable;
    let log = '', done = false, killed = false, bad = 0, fetches = 0, inFlight = 0;
    const budget = { requests: 0, bytes: 0 };
    const queued: FetchAsk[] = [];
    const kill = () => { if (!killed) { killed = true; child.kill('SIGKILL'); } };
    const timer = setTimeout(kill, o.timeoutMs ?? 15 * 60_000);
    const pump = () => {
      while (inFlight < FETCH_CAPS.inFlight && queued.length) {
        const a = queued.shift()!;
        inFlight++; fetches++;
        answerFetch(a, { net: o.net, budget }).then((ans) => {
          inFlight--;
          if (!killed && answers.writable) answers.write(`${JSON.stringify(ans)}\n`);
          pump();
        });
      }
    };
    protocolLines(chan, nonce, (l) => {
      if (!l || typeof l !== 'object') { bad++; return; }
      if (l.t === 'fetch') {
        if (!Number.isSafeInteger(l.id) || typeof l.url !== 'string' || l.url.length > 4000 || queued.length > 1000) { bad++; return; }
        queued.push(l as FetchAsk);
        return pump();
      }
      if (!['job', 'entry', 'fatal', 'done'].includes(l.t)) { bad++; return; }
      if (l.t === 'done') done = true;
      onLine(l);
    }, kill);
    const tail = (d: Buffer) => { log = (log + d.toString('utf8')).slice(-4000); };
    child.stdout!.on('data', tail);
    child.stderr!.on('data', tail);
    chan.on('error', () => {});
    answers.on('error', () => {});
    child.on('error', (e) => { log += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: log, done, killed, bad, fetches }); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

// ---- what the child says, checked ----

const isoOk = (s: unknown, at: Date) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && Date.parse(s) <= at.getTime() + 86_400_000 && Date.parse(s) > Date.UTC(1995, 0, 1);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '').slice(0, max);

/** A job from the sandbox as a role, or why it was refused. Every field is typed and bounded; URLs are http(s) only. */
export function cleanJob(raw: any, o: { features: { linkedin_links: boolean }; at: Date; fallbackCompany?: string }): { ok: true; role: { url: string; title: string; company: string; location: string; description: string; pay_text: string | null; posted_at: string | null } } | { ok: false; why: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, why: 'not an object' };
  if (typeof raw.url !== 'string' || raw.url.length > 2000) return { ok: false, why: 'url missing or too long' };
  let url: string;
  try { url = checkRoleUrl(raw.url, o.features, 'the job URL'); } catch (e: any) { return { ok: false, why: e.message }; }
  const title = str(raw.title, 1000);
  if (!title) return { ok: false, why: 'no title' };
  if (title.length > 300) return { ok: false, why: 'title longer than 300 characters' };
  const company = str(raw.company, 200) || (o.fallbackCompany ?? '').slice(0, 200) || 'Unknown';
  return {
    ok: true,
    role: {
      url, title, company, location: str(raw.location, 500),
      description: typeof raw.description === 'string' ? raw.description.slice(0, 200_000) : '',
      pay_text: str(raw.pay_text, 200) || null,
      posted_at: isoOk(raw.posted_at, o.at) ? new Date(raw.posted_at).toISOString() : null,
    },
  };
}

export type EntryResult = { name: string; provider?: string; ok: boolean; jobs: number; new: number; refused: number; error?: string; ms?: number };
export type ProvidersResult = { ran: boolean; fetched: number; new: number; refused: number; entries: EntryResult[]; skipped: Plan['skipped']; error?: string };

/** Run the plan's entries in the sandbox and store what passes. */
export async function runProviders(ctx: Ctx, plan: Plan, o: SpawnOptions & { dir: string }): Promise<ProvidersResult> {
  const res: ProvidersResult = { ran: true, fetched: 0, new: 0, refused: 0, entries: [], skipped: plan.skipped };
  const byI = new Map(plan.entries.map((e) => [e.i, { e, r: { name: e.name, ok: false, jobs: 0, new: 0, refused: 0 } as EntryResult }]));
  const at = ctx.clock();
  let fatal = '';
  const support = sandboxSupport();
  if (!support.ok) return { ...res, ran: false, error: support.why };
  const out = await spawnRunner(plan, (l) => {
    if (l.t === 'fatal') { fatal = String(l.error ?? '').slice(0, 500); return; }
    const x = byI.get((l as any).i);
    if (!x) return;
    if (l.t === 'entry') {
      Object.assign(x.r, { ok: !!l.ok, provider: typeof l.provider === 'string' ? l.provider.slice(0, 60) : undefined, error: l.ok ? undefined : String(l.error ?? 'failed').slice(0, 300), ms: typeof l.ms === 'number' ? l.ms : undefined });
      return;
    }
    if (l.t !== 'job') return;
    const c = cleanJob(l.job, { features: ctx.features, at, fallbackCompany: x.e.kind === 'ats' ? x.e.name : undefined });
    if (!c.ok) { x.r.refused++; res.refused++; return; }
    const { id, isNew } = upsertRole(ctx.db, { ...c.role, source: x.e.kind });
    x.r.jobs++; res.fetched++;
    if (isNew) { x.r.new++; res.new++; addEvent(ctx.db, id, 'added', `from ${x.e.name} (${String(l.provider).slice(0, 60)})`, nowIso(ctx)); }
  }, o);
  res.entries = [...byI.values()].map((x) => x.r);
  if (fatal) res.error = fatal;
  else if (out.killed) res.error = 'the provider sandbox was stopped (too slow or too much output)';
  else if (!out.done) res.error = `the provider sandbox exited early (code ${out.code})${out.stderr ? `: ${out.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` : ''}`;
  for (const r of res.entries) if (!r.ok && !r.error) r.error = res.error ?? 'no answer';
  return res;
}

// ---- the whole run ----

export type SourcesState = {
  started: string; finished?: string; ok: boolean; trigger?: string;
  providers?: ProvidersResult | { ran: false; why: string };
  linkedin?: { ran: boolean; stored?: number; cards?: number; stopped?: string; errors?: string[]; why?: string };
  prefilter?: { kept: number; dropped: number }; details?: { tried: number; found: number; closed: number; errors: number };
  new: number; error?: string;
};

export const stateFile = (home: string) => join(home, 'state', 'sources.json');
export function readSourcesState(home: string): SourcesState | null {
  try { return JSON.parse(readFileSync(stateFile(home), 'utf8')); } catch { return null; }
}
export function writeSourcesState(home: string, s: SourcesState) {
  ensureHome(join(home, 'state'));
  const f = stateFile(home), tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, f);
}

export type SourceOptions = SpawnOptions & { plan?: Plan; linkedin?: Parameters<typeof import('./linkedin.ts').searchLinkedin>[1]; net?: NetOptions; details?: number; trigger?: string };

/** Providers → LinkedIn (gated) → prefilter → descriptions for the best roles → prefilter. */
export async function runSources(ctx: Ctx, o: SourceOptions = {}): Promise<SourcesState> {
  const state: SourcesState = { started: nowIso(ctx), ok: true, new: 0, trigger: o.trigger };
  const notes = notesOf(ctx);
  const st = o.dir ? { ready: existsSync(o.dir), message: '' } : providersStatus({ jobs: { home: ctx.home } } as any, o.manifest);
  const support = sandboxSupport();
  if (st.ready && !support.ok) state.providers = { ran: false, why: support.why };
  else if (st.ready) {
    const plan = o.plan ?? sourcePlan(notes, o.manifest);
    if (plan.entries.length) {
      const r = await runProviders(ctx, plan, { ...o, dir: o.dir ?? providersDir({ jobs: { home: ctx.home } } as any, o.manifest) });
      state.providers = r;
      state.new += r.new;
      if (r.error) { state.ok = false; state.error = r.error; }
    } else state.providers = { ran: false, why: plan.skipped.length ? `no usable entries in jobs/sources.md (${plan.skipped.map((s) => `${s.name}: ${s.why}`).join('; ')})` : 'jobs/sources.md has no boards or watchlist entries switched on' };
  } else state.providers = { ran: false, why: st.message };

  if (ctx.features.linkedin_search) {
    try {
      const { searchLinkedin } = await import('./linkedin.ts');
      const r = await searchLinkedin(ctx, { days: Math.min(30, Math.max(1, o.sinceDays ?? 7)), ...o.linkedin });
      state.linkedin = { ran: true, stored: r.stored, cards: r.cards, stopped: r.stopped, errors: r.errors };
      state.new += r.stored;
    } catch (e: any) { state.linkedin = { ran: false, why: String(e.message).slice(0, 300) }; }
  } else state.linkedin = { ran: false, why: 'LinkedIn search is off' };

  const p1 = runPrefilter(ctx);
  const { fetchDescriptions } = await import('./pipeline/rank.ts');
  state.details = await fetchDescriptions(ctx, { top: o.details ?? 50, net: o.net });
  const p2 = state.details.found || state.details.closed ? runPrefilter(ctx) : { kept: p1.kept, dropped: 0 };
  state.prefilter = { kept: p2.kept, dropped: p1.dropped + p2.dropped };
  state.finished = nowIso(ctx);
  writeSourcesState(ctx.home, state);
  return state;
}

/** "30m", "12h", "1d" → milliseconds (at least 30 minutes). */
export function parseEvery(v: string): number {
  const m = /^(\d{1,4})(m|h|d)$/.exec(String(v ?? '').trim());
  if (!m) throw new Error('use a duration like 30m, 12h or 1d');
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  if (ms < 30 * 60_000) throw new Error('fetching more often than every 30m is not allowed');
  return ms;
}
