// `crewdeck jobs source` (design §2.4 step 1, §15): fetch new roles without spending a token. The pinned providers run in
// the sandboxed child (provider-runner.ts); every job it prints is checked here before it reaches the tracker. Then
// LinkedIn guest search (only when the user switched it on), the rule prefilter, and descriptions for the best-ranked
// roles that came without one. What happened is written to <jobs.home>/state/sources.json for the Jobs page.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome } from '../config.ts';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { addEvent, upsertRole } from './db.ts';
import type { JobNotes } from './notes.ts';
import type { SourceEntry } from './schema.ts';
import { checkRoleUrl } from './fields.ts';
import { type Manifest, loadManifest, providersDir, providersStatus } from './providers.ts';
import { runPrefilter } from './pipeline/prefilter.ts';
import type { NetOptions } from './net/netguard.ts';

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

/** Node's flags for the sandbox: read the providers and the runner only; network where the permission model gates it. */
export function runnerArgs(dir: string, runner = RUNNER): string[] {
  const net = process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : [];
  return ['--permission', `--allow-fs-read=${dir}`, `--allow-fs-read=${runner}`, ...net, '--disallow-code-generation-from-strings', '--max-old-space-size=512', runner, dir];
}

export type RunnerLine = { t: 'job'; i: number; provider: string; job: any } | { t: 'entry'; i: number; ok: boolean; provider?: string; jobs?: number; old?: number; error?: string; ms?: number } | { t: 'fatal'; error: string } | { t: 'done' };

export type SpawnOptions = { dir?: string; runner?: string; manifest?: Manifest; timeoutMs?: number; entryTimeoutMs?: number; sinceDays?: number; maxPages?: number };

/** Run the child and hand each protocol line to `onLine`. Resolves with the exit and what went to stderr (tail). */
export function spawnRunner(plan: Plan, onLine: (l: RunnerLine) => void, o: SpawnOptions & { dir: string }): Promise<{ code: number | null; stderr: string; done: boolean; killed: boolean; bad: number }> {
  const m = o.manifest ?? loadManifest();
  const dir = realpathSync(o.dir), runner = realpathSync(o.runner ?? RUNNER);
  const input = JSON.stringify({
    files: m.files, ids: plan.ids, detectors: m.detectors, entries: plan.entries.map((e) => ({ i: e.i, entry: e.entry })),
    since_ms: o.sinceDays ? Date.now() - o.sinceDays * 86_400_000 : 0, timeout_ms: o.entryTimeoutMs ?? 90_000, max_jobs: 2000, max_pages: o.maxPages ?? 10, concurrency: 4,
  });
  return new Promise((resolve) => {
    // An empty environment: no proxy variables, no tokens, nothing of the user's.
    const child = spawn(process.execPath, runnerArgs(dir, runner), { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', bytes = 0, lines = 0, stderr = '', done = false, killed = false, bad = 0;
    const kill = () => { killed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(kill, o.timeoutMs ?? 15 * 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      bytes += d.length;
      if (bytes > MAX_BYTES) return kill();
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (++lines > MAX_LINES) return kill();
        let l: any;
        try { l = JSON.parse(line); } catch { bad++; continue; }
        if (!l || typeof l !== 'object' || !['job', 'entry', 'fatal', 'done'].includes(l.t)) { bad++; continue; }
        if (l.t === 'done') done = true;
        onLine(l);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr, done, killed, bad }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
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
  if (st.ready) {
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
