// `crewdeck jobs source` (design §2.4 step 1, §15): fetch new roles without spending a token. The pinned providers run in
// the sandboxed child (provider-runner.ts), which has no network: its fetches come here over a private channel and go
// out through netguard (E1). Every job it sends is checked here before it reaches the tracker. Then
// LinkedIn guest search (only when the user switched it on, paused after a stop), the rule prefilter, and full
// descriptions for every role the rules kept that came without one (pipeline/details.ts). What happened is written to <jobs.home>/state/sources.json for the Jobs page.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { ensureHome } from '../config.ts';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { addEvent, upsertRole } from './db.ts';
import type { JobNotes } from './notes.ts';
import { catalogEntry, fillEntry } from './catalog.ts';
import { checkRoleUrl } from './fields.ts';
import { type Manifest, loadManifest, providersDir, providersStatus, sandboxSupport } from './providers.ts';

export { sandboxSupport };
import { runPrefilter } from './pipeline/prefilter.ts';
import type { DetailOptions, DetailsResult } from './pipeline/details.ts';
import { DESC_CAP } from './text.ts';
import { type NetOptions, NetError, guardedFetch } from './net/netguard.ts';
import type { FetchAnswer, FetchAsk } from './provider-runner.ts';

export const RUNNER = join(import.meta.dirname, 'provider-runner.ts');
const MAX_LINES = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;

// ---- the plan: which entries, which providers, in the user's order ----

export type PlannedEntry = { i: number; key: string; name: string; kind: 'ats' | 'board'; entry: Record<string, unknown>; filled?: string[] };
/**
 * The entries in priority order (design D21). `linkedinAt` is how many provider entries come before LinkedIn's row
 * (all of them when the note has no LinkedIn row). `skipped` names every switched-on source that can't run and why.
 */
export type Plan = { entries: PlannedEntry[]; ids: string[]; skipped: { key?: string; name: string; why: string }[]; linkedinAt?: number; linkedinKey?: string };

/** Only plain values reach third-party code: strings (≤ 2000), finite numbers, booleans, and lists of strings. */
export function cleanEntry(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ok = (v: unknown): boolean => (typeof v === 'string' && v.length <= 2000) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
  for (const [k, v] of Object.entries(e)) {
    // Crewdeck's own keys stay here; `url` (a page no provider reads) is never handed over.
    if (!/^[A-Za-z_][\w-]{0,40}$/.test(k) || ['parser', 'enabled', 'key', 'employer', 'added', 'fetch', 'why', 'url', 'linkedin'].includes(k)) continue;
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

export function sourcePlan(notes: Pick<JobNotes, 'sources'> & Partial<Pick<JobNotes, 'search' | 'profile'>>, m: Manifest = loadManifest()): Plan {
  const allowed = new Set(m.providers);
  const plan: Plan = { entries: [], ids: [], skipped: [] };
  const ids = new Set<string>();
  const search = notes.search?.data ?? ({ roles: { titles: [], targets: [] }, places: { onsite: [], remote_from: [] } } as any);
  let i = 0;
  for (const it of notes.sources.data.items) {
    if (!it.enabled) continue;
    const name = it.name.slice(0, 200) || '(no name)';
    if (it.linkedin) { plan.linkedinAt ??= plan.entries.length; plan.linkedinKey ??= it.key; continue; }
    if (it.fetch === 'none') { plan.skipped.push({ key: it.key, name, why: it.why ? `not fetched: ${it.why}` : 'not fetched (fetch: none)' }); continue; }
    let entry = cleanEntry(it.entry);
    let filled: string[] | undefined;
    if (it.provider) {
      if (!allowed.has(it.provider)) { plan.skipped.push({ key: it.key, name, why: `provider ${it.provider} is not one Crewdeck runs` }); continue; }
      const f = fillEntry(entry, catalogEntry(it.provider), { search, country: notes.profile?.data.identity.country });
      if (f.missing) { plan.skipped.push({ key: it.key, name, why: f.missing }); continue; }
      entry = f.entry;
      if (f.filled.length) filled = f.filled;
      ids.add(it.provider);
    } else if (typeof it.careers_url !== 'string' || !/^https?:\/\//.test(it.careers_url)) { plan.skipped.push({ key: it.key, name, why: 'needs a provider or a careers_url' }); continue; }
    plan.entries.push({ i: i++, key: it.key, name, kind: it.employer || it.careers_url ? 'ats' : 'board', entry, ...(filled ? { filled } : {}) });
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

export type SpawnOptions = {
  dir?: string; runner?: string; manifest?: Manifest; timeoutMs?: number; entryTimeoutMs?: number; sinceDays?: number; maxPages?: number;
  /** netguard test options for the providers' fetches */ net?: NetOptions;
  /** One request/byte budget shared by every sandbox run of one fetch (the runs around LinkedIn's position). */ budget?: { requests: number; bytes: number };
  /** Jobs kept per entry (resolve: a test fetch). */ maxJobs?: number;
};

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
    since_ms: o.sinceDays ? Date.now() - o.sinceDays * 86_400_000 : 0, timeout_ms: o.entryTimeoutMs ?? 90_000, max_jobs: o.maxJobs ?? 2000, max_pages: o.maxPages ?? 10, concurrency: 4,
  });
  return new Promise((resolve) => {
    // An empty environment: no proxy variables, no tokens, nothing of the user's. fd 3 (lines from the child) and fd 4
    // (fetch answers to it) are the private channel (E9);
    // stdout and stderr are kept only as a log tail.
    const child = spawn(process.execPath, runnerArgs(dir, runner), { env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    const chan = child.stdio[3] as unknown as Readable, answers = child.stdio[4] as unknown as Writable;
    let log = '', done = false, killed = false, bad = 0, fetches = 0, inFlight = 0;
    const budget = o.budget ?? { requests: 0, bytes: 0 };
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
export type CleanRole = { url: string; title: string; company: string; location: string; description: string; pay_text: string | null; posted_at: string | null; language: string | null; visa_text: string | null; employment_type: string | null };
export function cleanJob(raw: any, o: { features: { linkedin_links: boolean }; at: Date; fallbackCompany?: string }): { ok: true; role: CleanRole } | { ok: false; why: string } {
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
      description: typeof raw.description === 'string' ? raw.description.slice(0, DESC_CAP) : '',
      pay_text: str(raw.pay_text, 200) || null,
      posted_at: isoOk(raw.posted_at, o.at) ? new Date(raw.posted_at).toISOString() : null,
      // What the provider says beyond the text (design §24.2): kept for the rules and the judge, never trusted further.
      language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(str(raw.language, 20)) ? str(raw.language, 20) : null,
      visa_text: str(raw.visa_text, 500) || null,
      employment_type: str(raw.employment_type, 60) || null,
    },
  };
}

export type EntryResult = { key: string; name: string; provider?: string; ok: boolean; jobs: number; new: number; refused: number; error?: string; ms?: number; /** roles this entry stored (for "kept") */ roles?: string[] };
export type ProvidersResult = { ran: boolean; fetched: number; new: number; refused: number; entries: EntryResult[]; skipped: Plan['skipped']; error?: string };

const BUDGET_STOP = /more than \d+ (requests|MB) in one run: stopped/;

/** Run the plan's entries in the sandbox and store what passes, each role with its source's key. */
export async function runProviders(ctx: Ctx, plan: Plan, o: SpawnOptions & { dir: string }): Promise<ProvidersResult> {
  const res: ProvidersResult = { ran: true, fetched: 0, new: 0, refused: 0, entries: [], skipped: plan.skipped };
  const byI = new Map(plan.entries.map((e) => [e.i, { e, r: { key: e.key, name: e.name, ok: false, jobs: 0, new: 0, refused: 0, roles: [] } as EntryResult }]));
  const at = ctx.clock();
  let fatal = '';
  const support = sandboxSupport();
  if (!support.ok) return { ...res, ran: false, error: support.why };
  const out = await spawnRunner(plan, (l) => {
    if (l.t === 'fatal') { fatal = String(l.error ?? '').slice(0, 500); return; }
    const x = byI.get((l as any).i);
    if (!x) return;
    if (l.t === 'entry') {
      const error = l.ok ? undefined : String(l.error ?? 'failed').slice(0, 300);
      Object.assign(x.r, { ok: !!l.ok, provider: typeof l.provider === 'string' ? l.provider.slice(0, 60) : undefined, error: error && BUDGET_STOP.test(error) ? `not run: the fetch's cap was reached before this source (${error})` : error, ms: typeof l.ms === 'number' ? l.ms : undefined });
      return;
    }
    if (l.t !== 'job') return;
    const c = cleanJob(l.job, { features: ctx.features, at, fallbackCompany: x.e.kind === 'ats' ? x.e.name : undefined });
    if (!c.ok) { x.r.refused++; res.refused++; return; }
    const { id, isNew } = upsertRole(ctx.db, { ...c.role, source: x.e.kind, source_key: x.e.key });
    x.r.jobs++; res.fetched++;
    x.r.roles!.push(id);
    if (isNew) { x.r.new++; res.new++; addEvent(ctx.db, id, 'added', `from ${x.e.name} (${String(l.provider).slice(0, 60)})`, nowIso(ctx)); }
  }, o);
  res.entries = [...byI.values()].map((x) => x.r);
  if (fatal) res.error = fatal;
  else if (out.killed) res.error = 'the provider sandbox was stopped (too slow or too much output)';
  else if (!out.done) res.error = `the provider sandbox exited early (code ${out.code})${out.stderr ? `: ${out.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` : ''}`;
  for (const r of res.entries) if (!r.ok && !r.error) r.error = out.killed ? 'not run: the fetch\'s 15-minute limit was reached first' : res.error ?? 'no answer';
  return res;
}

// ---- the whole run ----

/** One source's last fetch (design §24.2): counts, the error in plain words, or why it didn't run. */
export type KeyState = {
  at: string; ok: boolean; jobs: number; new: number; kept: number; refused: number; error?: string; why?: string; ms?: number;
  /** P1b: of this source's roles the rules kept, how many have a full description (≥ 200 characters, not cut at 4,000). */
  descriptions?: { full: number; total: number };
  /** LinkedIn only: paused after a stop until this instant (1 h, 4 h, 12 h, then 24 h for stops in a row). */
  paused_until?: string;
};
export type SourcesState = {
  started: string; finished?: string; ok: boolean; trigger?: string;
  providers?: ProvidersResult | { ran: false; why: string };
  linkedin?: { ran: boolean; stored?: number; partial?: number; cards?: number; stopped?: string; errors?: string[]; why?: string; paused_until?: string };
  /** After a LinkedIn stop: skip it until `until`; `level` counts the stops in a row (carried over from run to run). */
  linkedin_pause?: { until: string; level: number; reason?: string };
  prefilter?: { kept: number; dropped: number }; details?: Partial<DetailsResult> & { tried: number; found: number; closed: number; errors: number };
  new: number; error?: string;
  /** Per source key: the last fetch, and up to five before it (newest first). Carried over from run to run. */
  by_key?: Record<string, KeyState & { history?: KeyState[] }>;
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

export type SourceOptions = SpawnOptions & {
  plan?: Plan; linkedin?: Parameters<typeof import('./linkedin.ts').searchLinkedin>[1]; net?: NetOptions; trigger?: string;
  /** How many roles' descriptions to read this run (default 1000; 0 = none), and the detail step's other options. */ details?: number; detailOptions?: DetailOptions;
  /** setup's first fetch: only sources never fetched before */ onlyNew?: boolean;
  /** Jobs v2: also fetch the person's planned sources (official APIs, company job feeds). The CLI turns it on; tests opt in. */ planned?: boolean;
};

/** Hours LinkedIn is paused after 1, 2, 3, 4+ stops in a row. */
export const LINKEDIN_PAUSE_HOURS = [1, 4, 12, 24];

const FETCHED_BEFORE = 'fetched before (only new sources this time)';

/** Keep only the sources with no state yet (`--only-new-sources`). */
export function onlyNewSources(plan: Plan, prev: SourcesState | null): Plan {
  const seen = prev?.by_key ?? {};
  const entries = plan.entries.filter((e) => !seen[e.key]);
  const before = plan.linkedinAt === undefined ? undefined : plan.entries.slice(0, plan.linkedinAt).filter((e) => !seen[e.key]).length;
  return { ...plan, entries, ids: [...new Set(entries.map((e) => e.entry.provider).filter((p): p is string => typeof p === 'string'))].sort(), linkedinAt: before, skipped: plan.skipped.filter((s) => !s.key || !seen[s.key]) };
}

function mergeProviders(a: ProvidersResult | undefined, b: ProvidersResult): ProvidersResult {
  if (!a) return b;
  return { ran: true, fetched: a.fetched + b.fetched, new: a.new + b.new, refused: a.refused + b.refused, entries: [...a.entries, ...b.entries], skipped: a.skipped, error: a.error ?? b.error };
}

/**
 * Providers → LinkedIn (gated, paused after a stop) → prefilter → full descriptions → prefilter. Sources run in the user's
 * order: the providers before LinkedIn's row, then LinkedIn, then the rest, sharing one request budget and one
 * deadline, so when a cap is hit it is the later sources that miss out (and their state says so).
 */
export async function runSources(ctx: Ctx, o: SourceOptions = {}): Promise<SourcesState> {
  const state: SourcesState = { started: nowIso(ctx), ok: true, new: 0, trigger: o.trigger };
  const prev = readSourcesState(ctx.home);
  const notes = notesOf(ctx);
  const st = o.dir ? { ready: existsSync(o.dir), message: '' } : providersStatus({ jobs: { home: ctx.home } } as any, o.manifest);
  const support = sandboxSupport();
  let plan = o.plan ?? sourcePlan(notes, o.manifest);
  if (o.onlyNew) plan = onlyNewSources(plan, prev);
  const liKey = plan.linkedinKey ?? 'linkedin';
  const liWanted = ctx.features.linkedin_search && !(o.onlyNew && prev?.by_key?.[liKey]);
  const cut = Math.min(plan.linkedinAt ?? plan.entries.length, plan.entries.length);
  const segments = [plan.entries.slice(0, cut), plan.entries.slice(cut)];
  const budget = { requests: 0, bytes: 0 };
  const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
  let providers: ProvidersResult | undefined;

  const runSegment = async (entries: PlannedEntry[]) => {
    if (!entries.length || !st.ready || !support.ok) return;
    const left = deadline - Date.now();
    const sub: Plan = { ...plan, entries, ids: [...new Set(entries.map((e) => e.entry.provider).filter((p): p is string => typeof p === 'string'))].sort() };
    if (left <= 1000) {
      providers = mergeProviders(providers, { ran: true, fetched: 0, new: 0, refused: 0, skipped: plan.skipped, entries: entries.map((e) => ({ key: e.key, name: e.name, ok: false, jobs: 0, new: 0, refused: 0, error: 'not run: the fetch\'s 15-minute limit was reached first' })) });
      return;
    }
    const r = await runProviders(ctx, sub, { ...o, budget, timeoutMs: left, dir: o.dir ?? providersDir({ jobs: { home: ctx.home } } as any, o.manifest) });
    providers = mergeProviders(providers, r);
  };

  // A pause from an earlier stop is carried over until it ends or a clean run clears it.
  if (prev?.linkedin_pause) state.linkedin_pause = prev.linkedin_pause;
  const runLinkedin = async () => {
    if (!ctx.features.linkedin_search) { state.linkedin = { ran: false, why: 'LinkedIn search is off' }; return; }
    if (!liWanted) { state.linkedin = { ran: false, why: FETCHED_BEFORE }; return; }
    const { localClock } = await import('./pipeline/details.ts');
    const pause = state.linkedin_pause;
    if (pause && Date.parse(pause.until) > ctx.clock().getTime()) {
      state.linkedin = { ran: false, why: `LinkedIn paused until ${localClock(ctx, pause.until)} (it asked Crewdeck to slow down)`, paused_until: pause.until };
      return;
    }
    try {
      const { searchLinkedin } = await import('./linkedin.ts');
      const r = await searchLinkedin(ctx, { days: Math.min(30, Math.max(1, o.sinceDays ?? 7)), ...o.linkedin });
      state.linkedin = { ran: true, stored: r.stored, partial: r.partial, cards: r.cards, stopped: r.stopped, errors: r.errors };
      // A refusal (429, 999, a sign-in redirect, an error status), not the run's own request cap, pauses LinkedIn.
      if (r.stopped && r.stop_status) {
        const level = Math.min((pause?.level ?? 0) + 1, LINKEDIN_PAUSE_HOURS.length);
        const until = new Date(ctx.clock().getTime() + LINKEDIN_PAUSE_HOURS[level - 1] * 3_600_000).toISOString();
        state.linkedin_pause = { until, level, reason: r.stopped };
        state.linkedin.paused_until = until;
        state.linkedin.stopped = `${r.stopped}; LinkedIn paused until ${localClock(ctx, until)}`;
      } else delete state.linkedin_pause;
      (state as any)._liRoles = r.roles;
      state.new += r.stored + r.partial;
    } catch (e: any) { state.linkedin = { ran: false, why: String(e.message).slice(0, 300) }; }
  };

  await runSegment(segments[0]);
  await runLinkedin();
  await runSegment(segments[1]);

  if (!plan.entries.length) state.providers = { ran: false, why: plan.skipped.length ? `no usable entries in jobs/sources.md (${plan.skipped.map((s) => `${s.name}: ${s.why}`).join('; ')})` : o.onlyNew ? 'no new sources to fetch' : 'jobs/sources.md has no sources switched on' };
  else if (!st.ready) state.providers = { ran: false, why: st.message };
  else if (!support.ok) state.providers = { ran: false, why: support.why };
  else if (providers) {
    state.providers = providers;
    state.new += providers.new;
    if (providers.error) { state.ok = false; state.error = providers.error; }
  }

  // Jobs v2: the person's planned sources (official APIs, company job feeds), plain code, before the rules run.
  if (o.planned) {
    try {
      const { runPlanned } = await import('./planned-run.ts');
      const r = await runPlanned(ctx, { net: o.net });
      (state as any).planned = r;
      state.new += r.stored;
    } catch (e: any) { (state as any).planned = { error: String(e?.message ?? e).slice(0, 300) }; }
  }
  const p1 = runPrefilter(ctx);
  // Every rule-passing role without a full description, not only the best-ranked (P1b).
  const { fetchDetails } = await import('./pipeline/details.ts');
  state.details = await fetchDetails(ctx, { net: o.net, ...o.detailOptions, limit: o.details ?? o.detailOptions?.limit ?? 1000 });
  // Any text read (even one too short to count as full) can decide a rule: the prefilter runs again.
  const p2 = state.details.tried ? runPrefilter(ctx) : { kept: p1.kept, dropped: 0 };
  state.prefilter = { kept: p2.kept, dropped: p1.dropped + p2.dropped };
  state.finished = nowIso(ctx);
  state.by_key = keyStates(ctx, state, plan, prev, (state as any)._liRoles ?? [], liKey);
  delete (state as any)._liRoles;
  if (state.providers && 'entries' in state.providers) for (const e of state.providers.entries) delete e.roles;
  writeSourcesState(ctx.home, state);
  return state;
}

/** Each source's line for this run, with the earlier ones carried over (five per key). */
function keyStates(ctx: Ctx, state: SourcesState, plan: Plan, prev: SourcesState | null, liRoles: string[], liKey: string): NonNullable<SourcesState['by_key']> {
  const out: NonNullable<SourcesState['by_key']> = { ...(prev?.by_key ?? {}) };
  const at = state.finished ?? state.started;
  const q = ctx.db.prepare(`select count(*) n from roles where id in (select value from json_each(?)) and status not in ('prefiltered_out','expired')`);
  const kept = (ids: string[]) => (ids.length ? Number((q.get(JSON.stringify(ids)) as any).n) : 0);
  const cov = ctx.db.prepare(`select count(*) total, coalesce(sum(case when length(description) >= 200 and length(description) != 4000 then 1 else 0 end), 0) n_full from roles
      where source_key=? and status not in ('prefiltered_out','expired')`);
  const put = (key: string, s: KeyState) => {
    const old = out[key];
    const history = old ? [{ ...old, history: undefined }, ...(old.history ?? [])].map(({ history: _, ...h }) => h).slice(0, 5) : [];
    const c = cov.get(key === liKey ? 'linkedin' : key) as any;
    out[key] = { ...s, descriptions: { full: Number(c?.n_full ?? 0), total: Number(c?.total ?? 0) }, history };
  };
  const ran = state.providers && 'entries' in state.providers ? state.providers.entries : [];
  for (const e of ran) put(e.key, { at, ok: e.ok, jobs: e.jobs, new: e.new, kept: kept(e.roles ?? []), refused: e.refused, ...(e.error ? { error: e.error } : {}), ...(e.ms !== undefined ? { ms: e.ms } : {}) });
  const why = !state.providers || !('entries' in state.providers) ? (state.providers as any)?.why : undefined;
  if (why) for (const e of plan.entries) put(e.key, { at, ok: false, jobs: 0, new: 0, kept: 0, refused: 0, why });
  for (const s of plan.skipped) if (s.key) put(s.key, { at, ok: false, jobs: 0, new: 0, kept: 0, refused: 0, why: s.why });
  const paused = state.linkedin?.paused_until ? { paused_until: state.linkedin.paused_until } : {};
  if (state.linkedin?.ran) put(liKey, { at, ok: !state.linkedin.errors?.length && !state.linkedin.paused_until, jobs: state.linkedin.cards ?? 0, new: (state.linkedin.stored ?? 0) + (state.linkedin.partial ?? 0), kept: kept(liRoles), refused: 0, ...(state.linkedin.stopped ? { error: state.linkedin.stopped } : {}), ...paused });
  else if (ctx.features.linkedin_search && state.linkedin?.why && state.linkedin.why !== FETCHED_BEFORE) put(liKey, { at, ok: false, jobs: 0, new: 0, kept: 0, refused: 0, why: state.linkedin.why, ...paused });
  return out;
}

/** "30m", "12h", "1d" → milliseconds (at least 30 minutes). */
export function parseEvery(v: string): number {
  const m = /^(\d{1,4})(m|h|d)$/.exec(String(v ?? '').trim());
  if (!m) throw new Error('use a duration like 30m, 12h or 1d');
  const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  if (ms < 30 * 60_000) throw new Error('fetching more often than every 30m is not allowed');
  return ms;
}
