// The Jobs page's API, inside the shell server (design D2): views, the page's own actions, the live refresh stream and
// the tailored resume. Loaded only when jobs.enabled. Heavy work (reading pages, forms, PDFs) stays in CLI processes run
// by Claude; the server's database work is small, with a 250 ms busy timeout that answers "busy, retry".
//
// Who may call what (design D16):
// - page actions (POST /api/jobs/action/*): this origin's own page only (exact Origin, same-origin fetch, JSON). They are
//   the only way a request reaches the jobs lane, each checked for its kind. A risky switch also needs a native dialog
//   the user clicks (or, with none, a one-time code typed in a terminal): headers alone can't prove a human (confirm.ts).
// - reads (GET /api/jobs/*): never for another site (no CORS headers; a browser must send Sec-Fetch-Site same-origin or
//   none). The live stream also needs a same-origin browser or the token, so a local process can't take its slots.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { type FSWatcher, existsSync, readFileSync, realpathSync, statSync, watch } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { basename, join, sep } from 'node:path';
import { type Config, CONFIG_PATH, HOME, REPO, FEATURE_CAPS, FEATURE_DEFAULTS, type JobsFeatures, featureValue, normaliseJobs, setFeature } from '../config.ts';
import { JOBS_SESSION_PROMPT, JOBS_SETUP_PROMPT, type JobsTask, jobsTaskLink, sessionLink, taskPrompt } from '../session-link.ts';
import { HttpError, SECURITY_HEADERS, fromAgent, fromOwnPage, json, ownRead, readJson, send } from '../http.ts';
import { type JobKind, type Request, type Requests, RequestError, isOpen } from '../requests.ts';
import { type Ctx, makeCtx, notesOf, todayOf } from './ctx.ts';
import { type Db, ROLE_ID, getRole, openJobsDb } from './db.ts';
import { NOTES, NOTE_NAMES, type JobNotes } from './notes.ts';
import { COOLDOWN_SCOPES, EMPLOYMENT, LANGUAGE_LEVELS, PAY_PERIODS, SHIFTS, TRAVEL, WORKPLACES } from './schema.ts';
import { setFields } from './edit.ts';
import { LEVELS_WANTED, MATCH_MODES, targetsOf } from './titles.ts';
import { runPreview } from './preview.ts';
import { findFunnel, funnelSummary } from './funnel.ts';
import { readFindRun } from './pipeline/rank.ts';
import { checkRoleUrl, isLinkedinHost, isXHost } from './fields.ts';
import { canonicalJobUrl, linkedinJobId } from './linkedin.ts';
import { answerFirstTime, currentAnswers, editAnswer } from './kb/ops.ts';
import { learnField } from './kb/learn.ts';
import { markApplied, notInterested } from './pipeline/apply.ts';
import { KNOWLEDGE_TABS, type KnowledgeTab, applicationsView, applyMode, canApprove, copyModel, knowledgeView, resumeFileName, resumePath, todayView } from './views.ts';
import { NEEDS_YOU, applyPanel } from './panel.ts';
import { FEATURE_INFO, RISK, confirmText, featureChanges, widens } from './features.ts';
import { type Confirm, codeFile, issueCode, nativeConfirm } from './confirm.ts';
import { findBrowser, installHint } from './browser.ts';
import { providersStatus } from './providers.ts';
import { parseEvery, readSourcesState, sandboxSupport, writeSourcesState } from './sources.ts';
import { type SourceOp, changeSources, isKey, listSources, refreshSourcesList } from './sources-note.ts';
import { type SchedulerOptions, createSourceScheduler } from './schedule.ts';
import { type ResolveState, sourcesScreen } from './sources-view.ts';
import type { ResolveResult } from './resolve.ts';
import { type ApplyEnv, ProposalError, addProposal, approve as approveProposal, checkProposal, listProposals, pendingCount, proposalView, reject as rejectProposal, undo as undoProposal } from './proposals.ts';

export type JobsApi = {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** What `request show` adds for Claude: the role (and field) a jobs request is about. */
  contextFor(r: Request): unknown;
  /** Tell open pages to refresh (the server's own writes). */
  emit(topic: string): void;
  scheduler: import('./schedule.ts').SourceScheduler;
  /** Today panel's look at Jobs (docs/everywhere.md E7): what waits on the person, never any payload or posting text. */
  glance(): JobsGlance;
  /**
   * The agent endpoints Tell Crewdeck adds (token checked by the server): `/api/tell` { text } queues a tell request;
   * `/api/proposals` { op: list | propose | approve | reject | undo, … } (the panel and `crewdeck jobs propose|proposals`).
   */
  agent(path: '/api/tell' | '/api/proposals', body: any): unknown;
  /** The Today panel's Jobs buttons (agent endpoint POST /api/today/jobs): Find now, Apply or Prepare a pick. */
  panelAction(b: any): Promise<unknown>;
  close(): void;
};
export type JobsGlance = {
  /** What the Jobs chat is doing now, or just did (30 min): for the panel in any chat. */
  activity: { state: 'working' | 'waiting' | 'fetching' | 'done' | 'failed'; label: string; detail: string; id?: number } | null;
  setup_needed: boolean; connected: boolean;
  /** Opens a Claude Code session in the jobs folder (claude://code/new…). */
  session_link: string;
  counts: { needs_you: number; ready: number; in_progress: number; applied_today: number };
  /** Proposal items waiting for the person's Approve or Reject (P3): the panel lists them with POST /api/proposals. */
  proposals: number;
  queue: { id: string; company: string; title: string; chip: string; kind: string }[];
  /** P4: today's picks nobody is applying to yet, best first (the panel's "N jobs ready" with Apply on each). */
  picks: { id: string; company: string; title: string; prepared: boolean }[];
  ready_total: number;
};
export type JobsApiOptions = {
  configPath?: string; pollMs?: number; platform?: string;
  /** Show a file in Finder (tests replace it). */
  reveal?: (file: string) => Promise<void>;
  /** Open a claude://code/new link with the system's handler (tests replace it). */
  openLink?: (link: string) => Promise<void>;
  /**
   * Open a Jobs chat by itself (the real server only: `crewdeck up`): Find, Prepare and Apply open one in front for their
   * request (ADR-0004); other work opens one when none is connected.
   */
  autoOpenChat?: boolean;
  /** Find waits for a fresh fetch when sources are stale (the real server only: `crewdeck up`). */
  fetchBeforeFind?: boolean;
  browser?: () => { name: string; path: string } | null;
  /** The sourcing timer (tests replace the child run and the delays). */
  sources?: Partial<Pick<SchedulerOptions, 'run' | 'firstDelayMs' | 'everyMs' | 'ready'>>;
  /** The agent token (the live stream accepts it; the terminal fallback's code is keyed with it). */
  token?: string;
  /** The native yes/no dialog for risky switches (tests replace it). */
  confirm?: Confirm;
  /** Where the terminal fallback's one-time code is kept (default ~/.crewdeck/feature-code.json). */
  codeFile?: string;
  /**
   * Check a careers page from the Sources screen (P9e): by default `crewdeck jobs sources resolve <key> --json` in a
   * child process, like the scheduled fetch (the sandbox and netguard stay out of the server). Tests replace it.
   */
  resolve?: (key: string) => Promise<ResolveResult>;
};

const LANE = 'jobs';
/** Careers pages checked at once from the Sources screen (each is a sandboxed child of ≤ 35 s). */
const MAX_RESOLVING = 2;
const LABEL: Record<JobKind, string> = { setup: 'Set up Jobs', find: 'Find jobs', link: 'Add a job link', apply: 'Apply to a role', improve: 'Improve an answer', source: 'Find a jobs page', tell: 'Tell Crewdeck', prepare: 'Prepare a role' };
/** A request kept for the Jobs chat opened for it; after this, any Jobs chat may take it (the person closed the dialog). */
const CHAT_HOLD_MS = 10 * 60_000;
const MAX_CLIENTS = 20;
const SET_ON_PAGE = '(set on the Jobs page)';

/** The longest text the Tell box takes (a request payload is at most 4000 characters as JSON). */
export const MAX_TELL = 3000;
/** The prompt of the Jobs chat opened for a tell request (ADR-0004: work runs in a Jobs chat in front of the person). */
export const tellPrompt = (id: number) => taskPrompt({ kind: 'tell', request: id });

/** jobs/search.md fields the Preferences form edits, and the shape of each value. */
export const PREF_FIELDS: Record<string, 'list' | 'num' | 'optnum' | 'str' | 'bool' | 'langs' | 'targets' | 'licences'> = {
  'roles.targets': 'targets', 'roles.match': 'str', 'roles.level': 'str', 'roles.titles': 'list', 'roles.seniority_prefer': 'list', 'roles.exclude_title_words': 'list',
  workplace: 'list', 'places.onsite': 'list', 'places.remote_from': 'list', 'places.commute_km': 'num',
  // P9g (D37): moving, and where the user may work without sponsorship.
  'places.relocate_to': 'list', 'places.authorized_in': 'list',
  languages: 'langs', employment_types: 'list', licenses: 'licences', needs_sponsorship: 'bool',
  // P9g (D30): how the user can work.
  'work_pattern.hours_per_week.min': 'optnum', 'work_pattern.hours_per_week.max': 'optnum', 'work_pattern.shifts': 'list', 'work_pattern.shifts_avoid': 'list', 'work_pattern.term_time_only': 'bool',
  'exclude.companies': 'list', 'exclude.industries': 'list', 'exclude.travel': 'str',
  'pay.currency': 'str', 'pay.floor': 'num', 'pay.period': 'str', 'pay.hours_per_week': 'optnum', 'pay.days_per_week': 'optnum', 'pay.per_unit': 'str',
  'pay.rule': 'str', 'pay.unlisted': 'str', 'pay.locale': 'str',
  'schedule.timezone': 'str', 'schedule.daily_picks': 'num', 'schedule.cooldown_days': 'num', 'schedule.cooldown_scope': 'str', 'schedule.per_company': 'num', judge_notes: 'str',
};

const isBusy = (e: any) => e?.errcode === 5 || e?.errcode === 6 || /database is (locked|busy)|SQLITE_BUSY/i.test(String(e?.message ?? ''));
const str = (v: unknown, max: number, what: string) => {
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return t;
};
const intIn = (v: unknown, lo: number, hi: number, what: string) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}`);
  return n;
};

const sourceKey = (v: unknown) => { if (!isKey(v)) throw new HttpError(400, 'unknown source'); return v; };
/** A careers page or job board address from the page: http(s) only, no X, no LinkedIn (it has its own row). */
function pageUrl(raw: unknown): string {
  const t = str(raw, 2000, 'the address');
  let u: URL;
  try { u = new URL(t); } catch { throw new HttpError(400, 'Give a web address (https://…)'); }
  if (!/^https?:$/.test(u.protocol) || /\s/.test(t)) throw new HttpError(400, 'Give a web address (https://…)');
  if (isXHost(u.hostname) || isLinkedinHost(u.hostname)) throw new HttpError(400, 'X and LinkedIn pages are not job sources here (LinkedIn has its own row)');
  return u.href;
}

/** A pasted job link, checked before it becomes a request: http(s), no X, LinkedIn only as a posting and only when on. */
export function checkLink(raw: unknown, features: Pick<JobsFeatures, 'linkedin_links'>): string {
  const t = str(raw, 2000, 'the link');
  let u: URL;
  try { u = new URL(t); } catch { throw new HttpError(400, 'Paste a web address (https://…)'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Paste a web address (https://…)');
  if (isXHost(u.hostname)) throw new HttpError(400, 'X links are never used: paste the company\'s own posting');
  if (isLinkedinHost(u.hostname)) {
    const id = linkedinJobId(t);
    if (!id) throw new HttpError(400, 'That LinkedIn page is not a job posting: paste the job\'s own link (linkedin.com/jobs/view/…)');
    if (!features.linkedin_links) throw new HttpError(400, 'Pasted LinkedIn links are off: switch them on in Jobs → Settings, or paste the company\'s own posting');
    return canonicalJobUrl(id);
  }
  try { return checkRoleUrl(t, features); } catch (e: any) { throw new HttpError(400, e.message); }
}

/** A value from the Preferences form as the text `setFields` types by the schema (lists and maps as YAML flow). */
function prefRaw(path: string, v: unknown): string {
  const kind = Object.hasOwn(PREF_FIELDS, path) ? PREF_FIELDS[path] : undefined;
  if (!kind) throw new HttpError(400, `${path} is not a field the Jobs page edits`);
  if (kind === 'list' || kind === 'langs') {
    if (!Array.isArray(v)) throw new HttpError(400, `${path}: give a list`);
    if (v.length > 100) throw new HttpError(400, `${path}: at most 100 entries`);
    const items = kind === 'list'
      ? v.map((x) => str(x, 200, path)).filter(Boolean)
      : v.map((x: any) => ({ name: str(x?.name, 80, `${path} name`), ...(x?.level ? { level: str(x.level, 20, `${path} level`) } : {}) })).filter((x) => x.name);
    return JSON.stringify(items);
  }
  if (kind === 'targets') {
    // Whole targets (D26): the form sends every target with its titles, families and skills.
    if (!Array.isArray(v)) throw new HttpError(400, `${path}: give a list`);
    if (v.length > 20) throw new HttpError(400, `${path}: at most 20 targets`);
    const words = (x: unknown, what: string) => { if (x === undefined) return []; if (!Array.isArray(x) || x.length > 100) throw new HttpError(400, `${what}: give a list of at most 100`); return x.map((y) => str(y, 200, what)).filter(Boolean); };
    return JSON.stringify(v.map((t: any, i: number) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) throw new HttpError(400, `${path}[${i}]: give a target`);
      const name = t.name === undefined ? '' : str(t.name, 120, `${path}[${i}].name`);
      // Empty lists are left out (the note stays as the user would write it).
      const families = words(t.families, `${path}[${i}].families`), skills = words(t.skills, `${path}[${i}].skills`);
      return { ...(name ? { name } : {}), titles: words(t.titles, `${path}[${i}].titles`), ...(families.length ? { families } : {}), ...(skills.length ? { skills } : {}) };
    }));
  }
  if (kind === 'num') { if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${path}: give a number`); return String(v); }
  // An optional number: null clears it (the key is removed and its default applies).
  if (kind === 'optnum') { if (v === null) return ''; if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${path}: give a number or leave it empty`); return String(v); }
  if (kind === 'licences') {
    // "RN (Ohio)" or { name, where } (D31): the form sends back an entry it loaded as it was.
    if (!Array.isArray(v)) throw new HttpError(400, `${path}: give a list`);
    if (v.length > 50) throw new HttpError(400, `${path}: at most 50 entries`);
    return JSON.stringify(v.map((x: any) => (typeof x === 'string' ? str(x, 200, path) : x && typeof x === 'object' && !Array.isArray(x)
      ? { name: str(x.name, 120, `${path} name`), ...(x.where ? { where: str(x.where, 120, `${path} where`) } : {}) }
      : (() => { throw new HttpError(400, `${path}: give a licence`); })())).filter((x: any) => (typeof x === 'string' ? x : x.name)));
  }
  if (kind === 'bool') { if (typeof v !== 'boolean') throw new HttpError(400, `${path}: use yes or no`); return String(v); }
  return str(v, kind === 'str' && path === 'judge_notes' ? 2000 : 200, path);
}

/** The keys of a target the Preferences form edits; anything else written on a target in the note is kept. */
const TARGET_KEYS = ['name', 'titles', 'families', 'skills'];

/**
 * The Preferences form's changes as `setFields` changes (every field checked as Save checks it). A target the form
 * loaded carries `at`, its place in the note, so Save updates that entry in place (its other keys and comments kept).
 */
function prefChanges(changes: unknown) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'changes must be a map of field → value');
  return Object.entries(changes).map(([path, v]) => {
    const raw = prefRaw(path, v);
    if (path !== 'roles.targets' || !Array.isArray(v)) return { segs: path.split('.'), raw };
    const keep = v.map((t: any) => (Number.isInteger(t?.at) && t.at >= 0 && t.at < 1000 ? t.at as number : null));
    return { segs: path.split('.'), raw, ...(keep.some((k) => k !== null) ? { keep, owns: TARGET_KEYS } : {}) };
  });
}
/** A validation error from the notes, as one issue per field (the form shows each next to its field). */
const fieldIssues = (e: any) => String(e.message).split('\n').map((l) => { const m = /^([\w.\[\]]+): (.*)$/.exec(l); return m ? { path: m[1].replace(/\[(\d+)\]/g, '.$1'), message: m[2] } : { path: '', message: l }; });

const getIn = (o: any, path: string) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

export function createJobsApi(c: Config, requests: Requests, o: JobsApiOptions = {}): JobsApi {
  const configPath = o.configPath ?? CONFIG_PATH;
  const platform = o.platform ?? process.platform;
  const db: Db = openJobsDb(c.jobs.home, { server: true });
  const ctx: Ctx = makeCtx({ db, vault: c.vault, home: c.jobs.home, features: c.jobs.features });
  const browser = (o.browser ?? (() => findBrowser(c.jobs.browser)))();
  const confirm = o.confirm ?? nativeConfirm();
  let confirming = false;
  let selected: string | null = null;

  /**
   * The switches as config.yaml has them now (a terminal may have changed them since start): re-read on every view and
   * action when the file changed, so the page, the plans and the checks never act on a stale switch.
   */
  let configStamp = '';
  function refreshFeatures() {
    let stamp: string;
    try { const st = statSync(configPath); stamp = `${st.mtimeMs}:${st.size}`; } catch { return; }
    if (stamp === configStamp) return;
    try {
      const features = normaliseJobs((parseYaml(readFileSync(configPath, 'utf8')) as any)?.jobs).features;
      c.jobs.features = features;
      ctx.features = { ...features };
      configStamp = stamp;
    } catch { /* a half-written or broken file: keep the last good switches */ }
  }
  refreshFeatures();

  // ---- live refresh: DB (data_version), notes (fs.watch), the queue, presence, the server's own writes ----
  const clients = new Set<ServerResponse>();
  const pending = new Set<string>();
  let flush: NodeJS.Timeout | null = null;
  const emit = (topic: string) => {
    pending.add(topic);
    if (flush) return;
    flush = setTimeout(() => {
      const data = JSON.stringify({ topics: [...pending] });
      pending.clear(); flush = null;
      for (const res of clients) { try { res.write(`event: refresh\ndata: ${data}\n\n`); } catch { clients.delete(res); } }
    }, 150);
  };
  const statusOf = (ref: string) => (ROLE_ID.test(ref) ? (db.prepare('select status from roles where id=?').get(ref) as any)?.status : undefined);
  const reconcile = () => { try { requests.reconcile(statusOf); } catch { /* the next change tries again */ } };
  const dataVersion = () => Number((db.prepare('PRAGMA data_version').get() as any).data_version);
  let dv = dataVersion();
  let wasConnected = requests.presence(LANE).connected;
  const timers = [
    setInterval(() => {
      try {
        const v = dataVersion();
        if (v !== dv) { dv = v; reconcile(); emit('db'); }
      } catch { /* busy: next tick */ }
      const now = requests.presence(LANE).connected;
      if (now !== wasConnected) { wasConnected = now; emit('presence'); }
      try { requests.expire(); } catch { /* the next tick tries again */ }
    }, o.pollMs ?? 500),
    setInterval(() => armWatchers(), 5000),
    setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 25_000),
  ];
  for (const t of timers) t.unref();
  const watchers = new Map<string, FSWatcher>();
  const noteFiles = new Set(Object.values(NOTES));
  function armWatchers() {
    for (const dir of ['me', 'jobs']) {
      const full = join(c.vault, dir);
      if (watchers.has(dir) || !existsSync(full)) continue;
      try {
        const w = watch(full, (_e, name) => { if (!name || noteFiles.has(`${dir}/${name}`)) emit('notes'); });
        w.on('error', () => { try { w.close(); } catch {} watchers.delete(dir); });
        watchers.set(dir, w);
      } catch { /* the folder vanished: the next arm tries again */ }
    }
  }
  armWatchers();
  const offQueue = requests.onChange(() => emit('queue'));
  reconcile();

  // ---- scheduled sourcing (design §2.4 step 1): `crewdeck jobs source` in a child, never two at once, no Claude ----
  let providersReady = { at: 0, ready: false };
  const sourcingReady = () => {
    if (Date.now() - providersReady.at > 60_000) providersReady = { at: Date.now(), ready: providersStatus(c).ready };
    return providersReady.ready || !!ctx.features.linkedin_search;
  };
  const canSource = o.sources?.ready ?? sourcingReady;
  const runSourceChild = (): Promise<{ code: number | null; error?: string }> => new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', 'source', '--scheduled'], { env: { ...process.env, CREWDECK_HOME: HOME }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => { err = (err + d).slice(-2000); });
    const kill = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    const done = (code: number | null, error?: string) => {
      clearTimeout(kill);
      // A child that died before writing its state still shows up on the page.
      const st = readSourcesState(c.jobs.home);
      if (code !== 0 && (!st || (st.finished ?? '') < startedAt)) {
        try { writeSourcesState(c.jobs.home, { started: startedAt, finished: new Date().toISOString(), ok: false, new: 0, trigger: 'scheduled', error: (error ?? err.trim().split('\n').at(-1) ?? `exit ${code}`).slice(0, 300) }); } catch {}
      }
      emit('sources');
      resolve({ code, error });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
  // The sources note's readable list (Notes hides the frontmatter that holds them): brought up to date on start.
  try { refreshSourcesList(join(c.vault, NOTES.sources)); } catch {}
  const scheduler = createSourceScheduler({
    everyMs: o.sources?.everyMs ?? parseEvery(c.jobs.fetch_every),
    run: o.sources?.run ?? runSourceChild,
    lastFinished: () => readSourcesState(c.jobs.home)?.finished ?? null,
    ready: canSource,
    firstDelayMs: o.sources?.firstDelayMs,
    onChange: () => emit('sources'),
  });

  // ---- checking a careers page from the Sources screen (§24.3): a child process; its answer is kept for the screen ----
  const resolving = new Map<string, ResolveState>();
  const resolved = new Map<string, ResolveState>();
  const children = new Set<ChildProcess>();
  const resolveChild = (key: string): Promise<ResolveResult> => new Promise((ok, bad) => {
    // Said at once, without a child, when it can't run here (the child would refuse the same way).
    const support = sandboxSupport();
    if (!support.ok) return bad(new Error(support.why));
    const st = providersStatus(c);
    if (!st.ready) return bad(new Error(st.message));
    const child = execFile(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', 'sources', 'resolve', key, '--json'],
      { env: { ...process.env, CREWDECK_HOME: HOME }, timeout: 45_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        children.delete(child);
        // Exit 2 is "not readable": still an answer, printed as JSON.
        try { const r = JSON.parse(String(stdout)); if (r && typeof r === 'object' && r.key === key) return ok(r); } catch { /* no answer */ }
        bad(new Error((String(stderr).trim().split('\n').at(-1) || err?.message || 'the check stopped').slice(0, 300)));
      });
    children.add(child);
  });
  const resolver = o.resolve ?? resolveChild;
  /** Answers younger than an hour, for sources still in the list. */
  const recentResolves = () => new Map([...resolved].filter(([, v]) => Date.now() - Date.parse(v.at ?? '') < 3_600_000));

  /** "N new roles since <time>": waiting for judging, first seen since the last Find (design §2.4). */
  function sourcesView() {
    const last = readSourcesState(c.jobs.home);
    const lastFind = requests.ofLane(LANE, 'find')[0];
    const since = lastFind?.created ?? null;
    const waiting = Number((db.prepare(`select count(*) n from roles where status='new' and eligibility is null`).get() as any).n);
    const fresh = since ? Number((db.prepare(`select count(*) n from roles where status='new' and eligibility is null and first_seen >= ?`).get(since) as any).n) : waiting;
    const p = last?.providers as any;
    // How many sources the user has switched on (LinkedIn counts only when its switch is on): none means "set up first".
    let listed = 0;
    try { listed = notesOf(ctx).sources.data.items.filter((it) => (it.linkedin ? ctx.features.linkedin_search : it.enabled)).length; } catch {}
    return {
      ready: canSource(), listed, providers: providersReady.ready, linkedin: !!ctx.features.linkedin_search, every: c.jobs.fetch_every,
      ...scheduler.status(), waiting, new_since: fresh, since,
      last: last ? { started: last.started, finished: last.finished ?? null, ok: last.ok, new: last.new, error: last.error ?? null,
        failed: Array.isArray(p?.entries) ? p.entries.filter((e: any) => !e.ok).length : 0, entries: Array.isArray(p?.entries) ? p.entries.length : 0 } : null,
    };
  }

  // ---- views ----
  const notesPage = (file: string | null) => (file ? file.replace(/\.md$/, '') : null);

  function agentView() {
    const p = requests.presence(LANE);
    const all = requests.ofLane(LANE);
    const roleOf = (r: Request) => {
      if (!r.ref || !ROLE_ID.test(r.ref)) return null;
      const x = db.prepare('select r.title, c.name company from roles r join companies c on c.id=r.company_id where r.id=?').get(r.ref) as any;
      return x ? { company: x.company, title: x.title } : null;
    };
    const item = (r: Request) => ({ id: r.id, kind: r.kind, label: r.kind ? LABEL[r.kind] : r.text, ref: r.ref ?? null, role: roleOf(r), status: r.status, result: r.result ?? null, updated: r.updated, last: r.progress?.at(-1) ?? null, ...(r.hold ? { hold: r.hold } : {}) });
    const recent = all.filter((r) => !isOpen(r) && Date.now() - Date.parse(r.updated) < 3_600_000).slice(0, 5);
    const lines = all.flatMap((r) => (r.progress ?? []).map((l) => ({ ...l, request: r.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
    return {
      connected: p.connected, seen: p.seen, workspace: c.jobs.workspace, open_session: platform === 'darwin' || platform === 'linux',
      working: all.filter((r) => r.status === 'picked').map(item), waiting: all.filter((r) => r.status === 'new').reverse().map(item),
      recent: recent.map(item), lines,
    };
  }

  function setupView(notes: JobNotes) {
    const files = NOTE_NAMES.map((n) => ({
      name: n, file: NOTES[n], path: join(c.vault, NOTES[n]), page: notesPage(NOTES[n]), exists: notes[n].exists, source: notes[n].source,
      errors: notes[n].issues.filter((i) => i.level === 'error').length,
    }));
    const core = files.filter((f) => ['profile', 'career', 'search'].includes(f.name));
    const needed = core.some((f) => !f.exists || f.source === 'empty') || !notes.profile.data.identity.first_name || !targetsOf(notes.search.data).length;
    const last = requests.ofLane(LANE, 'setup')[0];
    return { needed, files, request: last ? { id: last.id, status: last.status, result: last.result ?? null, last: last.progress?.at(-1) ?? null } : null };
  }

  /** §2.9: what is missing, in the user's words. */
  function banners(notes: JobNotes) {
    const out: { kind: string; text: string; fix?: string; page?: string | null; copy?: string }[] = [];
    for (const n of NOTE_NAMES) {
      if (!notes[n].exists) continue; // a missing note is the setup card's job
      for (const i of notes[n].issues.filter((x) => x.level === 'error').slice(0, 3)) {
        out.push({ kind: 'note', text: `${i.note}: ${i.path} ${i.message}`, fix: `${i.fix ? `${i.fix}. ` : ''}${notes[n].source === 'last-valid' ? 'Until then Jobs uses the last valid version.' : ''}`.trim(), page: notesPage(NOTES[n]) });
      }
    }
    if (!browser) out.push({ kind: 'browser', text: 'No Chromium-based browser found: reading forms and making resume PDFs need one.', fix: installHint(platform) });
    return out;
  }

  function stateView() {
    const notes = notesOf(ctx);
    return {
      notesPort: c.silverbullet.port, vault: c.vault, home: c.jobs.home, agent: agentView(), setup: setupView(notes), banners: banners(notes),
      quota: notes.search.data.schedule.daily_picks || 5, reveal: platform === 'darwin', features: ctx.features,
      browser: browser ? browser.name : null, sources: sourcesView(),
    };
  }

  /** The preview of the saved notes or of the Preferences form's unsaved changes (≤ 5,000 roles, ≤ 1 s of suggestions). */
  function previewOf(b: any) {
    const changes = b.search === undefined ? [] : prefChanges(b.search);
    const days = b.days === undefined ? 14 : intIn(b.days, 1, 90, 'days');
    try { return { ok: true, ...runPreview(ctx, { days, changes }) }; }
    catch (e: any) { if (e instanceof HttpError) throw e; return { ok: false, issues: fieldIssues(e) }; }
  }

  /** Find's "Why so few?" (D28): the last Find's stored funnel when it picked fewer than asked, once it is over. */
  function findCard() {
    const run = readFindRun(c.jobs.home);
    const last = requests.ofLane(LANE, 'find')[0];
    if (!run?.funnel || (last && isOpen(last)) || ctx.clock().getTime() - Date.parse(run.started) > 24 * 3_600_000) return null;
    // Sources fetched since that Find: its counts are stale, so the card shows the pool as it is now (waiting roles too).
    const fetchedAt = readSourcesState(c.jobs.home)?.finished;
    const funnel = fetchedAt && Date.parse(fetchedAt) > Date.parse(run.funnel.at) ? { ...findFunnel(ctx, run.funnel.need), picked: run.funnel.picked } : run.funnel;
    if (funnel.picked >= funnel.need) return null;
    return { funnel, summary: funnelSummary(funnel), request: last ? { id: last.id, status: last.status, count: Number(last.payload?.count ?? run.funnel.need) } : null };
  }

  /** Today, with the apply panel of the selected role and what Claude is doing for it. */
  function today(sel?: string) {
    const v = todayView(ctx, sel ?? selected ?? undefined);
    const connected = requests.presence(LANE).connected;
    const applyReq = (id: string) => requests.latest(LANE, 'apply', id);
    const queue = v.queue.map((q) => {
      const r = applyReq(q.id);
      // P4: a pick Find didn't prepare ahead waits for the person's Prepare click (no tokens spent on opening it).
      if (q.chip.kind === 'muted' && q.chip.text === 'Preparing' && !openPrepare(q.id)) return { ...q, chip: { kind: 'muted', text: 'Not prepared yet' } };
      if (!r || q.chip.kind === 'applied') return q;
      const p = applyPanel({ status: 'picked', apply: { mode: 'fill' }, request: r, connected });
      const chip = { waiting: { kind: 'info', text: 'Waiting for Claude' }, filling: { kind: 'info', text: 'Claude is applying' }, needs_you: { kind: 'first', text: 'Needs you' },
        your_turn: { kind: 'ready', text: 'Your turn: submit' }, confirmation: { kind: 'ready', text: 'Mark applied?' }, stopped: { kind: 'warn', text: 'Apply stopped' } }[p.state as string];
      return chip ? { ...q, chip } : q;
    });
    const find = findCard();
    const proposals = proposalsView();
    // The Not interested dialog previews what skipping more title words drops (§24.6): it adds to these.
    const exclude_title_words = notesOf(ctx).search.data.roles.exclude_title_words;
    if (!v.detail) return { ...v, queue, panel: null, asking: [], find, exclude_title_words, proposals };
    const d = v.detail;
    const notes = notesOf(ctx);
    const pdf = d.resume ? resumePath(ctx, d.id, notes) : null;
    const panel = applyPanel({ status: d.status, apply: d.apply, applied: d.applied, request: applyReq(d.id), connected });
    const asking = requests.ofLane(LANE, 'improve').filter((r) => isOpen(r) && r.ref === d.id).map((r) => Number(r.payload?.field_id));
    // P4: is this pick prepared, and is a Prepare running for it (the panel's "Prepare (about 1 min)").
    const prep = openPrepare(d.id);
    const prepare = { needed: unprepared(d.id), request: prep ? { id: prep.id, status: prep.status, last: prep.progress?.at(-1)?.text ?? '' } : null };
    return {
      ...v, queue,
      detail: { ...d, resume: pdf ? { file: basename(pdf), url: `/api/jobs/resume/${d.id}`, note: d.resume!.note } : null, copy: d.apply.mode !== 'fill' ? copyModel(db, d.id).answers : null },
      panel, asking, find, exclude_title_words, proposals, prepare,
    };
  }

  function preferences() {
    const notes = notesOf(ctx);
    const s = notes.search;
    const values: Record<string, any> = Object.fromEntries(Object.keys(PREF_FIELDS).map((k) => [k, getIn(s.data, k) ?? null]));
    // Licences as written (text, or { name, where }); the form shows each on one line.
    values.licenses = s.data.licences.map((l) => (l.where ? { name: l.name, where: l.where } : l.name));
    // Each target's place in the note (only when the note itself is read: the last-valid copy's places may differ).
    const rawTargets = (s.raw as any)?.roles?.targets;
    if (s.source === 'note' && Array.isArray(rawTargets) && Array.isArray(values['roles.targets'])) {
      const at = rawTargets.flatMap((t: unknown, i: number) => (t && typeof t === 'object' && !Array.isArray(t) ? [i] : []));
      values['roles.targets'] = values['roles.targets'].map((t: any, j: number) => (at[j] === undefined ? t : { ...t, at: at[j] }));
    }
    return {
      exists: s.exists, source: s.source, file: NOTES.search, page: notesPage(NOTES.search), values,
      issues: s.issues.map((i) => ({ level: i.level, path: i.path, message: i.message, fix: i.fix ?? null })),
      options: { workplace: WORKPLACES, employment_types: EMPLOYMENT, levels: LANGUAGE_LEVELS, travel: TRAVEL, period: PAY_PERIODS, rule: ['top_of_range', 'bottom_of_range'], unlisted: ['keep', 'drop'], match: MATCH_MODES, level: LEVELS_WANTED, shifts: SHIFTS, cooldown_scope: COOLDOWN_SCOPES },
    };
  }

  function settings() {
    return {
      features: FEATURE_INFO.map((f) => ({
        name: f.name, title: f.title, on: !!ctx.features[f.name], risk: RISK[f.name],
        limit: f.limit ? { name: f.limit, value: ctx.features[f.limit], cap: FEATURE_CAPS[f.limit], risk: RISK[f.limit] } : null,
      })),
      browser: browser ? { name: browser.name } : null, browserHint: browser ? null : installHint(platform),
      home: c.jobs.home, workspace: c.jobs.workspace, vault: c.vault,
    };
  }

  // ---- actions ----
  const roleArg = (v: unknown) => {
    if (typeof v !== 'string' || !ROLE_ID.test(v)) throw new HttpError(400, 'unknown role');
    try { return getRole(db, v); } catch { throw new HttpError(404, 'unknown role'); }
  };
  const fieldOf = (role: string, id: unknown) => {
    const f = currentAnswers(db, role).find((a) => a.field_id === Number(id));
    if (!f) throw new HttpError(400, 'no such question on this role');
    return f;
  };
  const queue = (kind: JobKind, ref: string | undefined, payload: Record<string, unknown>, front?: { task: (id: number) => JobsTask; fresh: boolean }) => {
    const r = requests.add(LANE, LABEL[kind], { kind, ref, payload });
    if (front) return { ok: true, request: r.id, status: r.status, ...(openInFront(r.id, front.task(r.id), front.fresh) ? { opened: true } : {}) };
    const opened = openJobsChatIfNone();
    return { ok: true, request: r.id, status: r.status, ...(opened ? { opened_chat: true } : {}) };
  };
  // ---- P4: Jobs work opened in front of the person (ADR-0004 revised, ADR-0006) ----
  const launch = (link: string) => {
    const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
    return (o.openLink ?? ((l: string) => new Promise<void>((ok, bad) => execFile(cmd, [l], (e) => (e ? bad(new HttpError(500, 'Claude desktop did not open: is it installed?')) : ok())))))(link);
  };
  /** Requests a Jobs chat was opened for (never two chats for one request), and their hold timers. */
  const openedFor = new Set<number>();
  const chatHolds = new Map<number, ReturnType<typeof setTimeout>>();
  /**
   * Open a Jobs chat in front whose first prompt names this request, and keep the request for it (`hold: 'chat'`) so
   * another Jobs chat doesn't take it first. An idle connected Jobs chat gets the work instead (its bridge claims it),
   * unless `fresh` (Apply: the form must appear in a chat in front, ADR-0006).
   */
  function openInFront(id: number, task: JobsTask, fresh: boolean): boolean {
    if (!o.autoOpenChat || (platform !== 'darwin' && platform !== 'linux')) return false;
    const r = requests.get(id);
    if (!r || r.status !== 'new' || openedFor.has(id)) return false;
    const p = requests.presence(LANE);
    if (!fresh && p.connected && p.idle) return false;
    openedFor.add(id);
    if (!r.hold) {
      requests.setHold(id, 'chat');
      const t = setTimeout(() => { chatHolds.delete(id); if (requests.get(id)?.hold === 'chat') { requests.setHold(id, undefined); emit('queue'); } }, CHAT_HOLD_MS);
      (t as any).unref?.();
      chatHolds.set(id, t);
    }
    void launch(jobsTaskLink(c.jobs.workspace, task)).catch(() => {});
    return true;
  }
  /** The task prompt for an open jobs request (the page's Open in Claude on a waiting request reopens its chat). */
  const taskOf = (r: Request): JobsTask | null =>
    r.kind === 'find' || r.kind === 'tell' ? { kind: r.kind, request: r.id }
      : (r.kind === 'apply' || r.kind === 'prepare') && r.ref && ROLE_ID.test(r.ref) ? { kind: r.kind, role: r.ref, request: r.id }
        : null;
  /** Picked, never prepared (Find prepares only the top few): nothing has read its form yet. */
  const unprepared = (role: string) => statusOf(role) === 'picked' && !db.prepare('select 1 from form_fields where role_id=? limit 1').get(role);
  const openPrepare = (role: string) => requests.ofLane(LANE, 'prepare').find((r) => r.ref === role && isOpen(r));
  /**
   * Work for Jobs with no Jobs chat connected: Crewdeck opens one in Claude desktop (docs/everywhere.md E14), at most
   * once every 10 minutes so a closed dialog isn't reopened at every click. Claude desktop asks to confirm the folder.
   */
  let lastAutoOpen = 0;
  function openJobsChatIfNone(prompt?: string): boolean {
    if (!o.autoOpenChat || requests.presence(LANE).connected || (platform !== 'darwin' && platform !== 'linux')) return false;
    if (Date.now() - lastAutoOpen < 10 * 60_000) return false;
    lastAutoOpen = Date.now();
    const link = sessionLink(c.jobs.workspace, prompt ?? (setupView(notesOf(ctx)).needed ? JOBS_SETUP_PROMPT : JOBS_SESSION_PROMPT));
    const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
    void (o.openLink ?? ((l: string) => new Promise<void>((ok) => execFile(cmd, [l], () => ok()))))(link).catch(() => {});
    return true;
  }
  const prepareRole = (role: string): Record<string, unknown> => (unprepared(role)
    ? queue('prepare', role, { role }, { task: (id) => ({ kind: 'prepare', role, request: id }), fresh: false })
    : { ok: true, prepared: true });
  const queueApply = (role: string, fresh = true) => queue('apply', role, { role }, { task: (id) => ({ kind: 'apply', role, request: id }), fresh });


  // ---- Tell Crewdeck and proposals (P3) ----
  /**
   * Queue what the person told Crewdeck as a tell request. With no Jobs chat connected, the auto-open rule (above) opens
   * one whose prompt names the request; `link` is that chat's claude://code/new link for a caller that opens it itself.
   */
  function tell(raw: unknown) {
    const text = str(raw, MAX_TELL, 'what you tell Crewdeck');
    if (!text) throw new HttpError(400, 'Tell Crewdeck something first');
    const r = requests.add(LANE, LABEL.tell, { kind: 'tell', payload: { text } });
    // P4: a Jobs chat in front whose first prompt names it, or the idle Jobs chat that is connected.
    const opened = openInFront(r.id, { kind: 'tell', request: r.id }, false);
    return { ok: true, request: r.id, status: r.status, link: sessionLink(c.jobs.workspace, tellPrompt(r.id)), ...(opened ? { opened: true, opened_chat: true } : {}) };
  }
  const applyEnv: ApplyEnv = {
    ctx,
    queueLink: (url) => requests.add(LANE, LABEL.link, { kind: 'link', payload: { url: checkLink(url, ctx.features) } }).id,
    cancelLink: (id) => { const r = requests.get(id); if (!r || r.lane !== LANE || r.kind !== 'link' || !isOpen(r)) return false; requests.cancel(id, LANE); return true; },
  };
  const proposalId = (v: unknown) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'unknown proposal'); return n; };
  const itemNo = (v: unknown) => (v === undefined || v === null ? undefined : intIn(v, 1, 100, 'item'));
  /** A proposal's change, then the refresh: notes and sources changed under the page. */
  const changed = <T>(fn: () => T): T => {
    try { return fn(); }
    catch (e: any) { if (e instanceof ProposalError) throw new HttpError(400, e.message); throw e; }
    finally { emit('proposals'); }
  };
  function proposalsView() {
    const list = listProposals(db).map(proposalView);
    return { pending: list.filter((p) => p.status === 'pending'), recent: list.filter((p) => p.status === 'done').slice(0, 10), count: pendingCount(db) };
  }
  /** The text of an open tell request (what the person typed): auto-apply checks the person's words against it. */
  function toldText(id: number | undefined): string | undefined {
    if (!id) return undefined;
    const r = requests.get(id);
    if (!r || r.lane !== LANE || r.kind !== 'tell' || !isOpen(r)) throw new HttpError(400, `request ${id} is not an open tell request`);
    return typeof r.payload?.text === 'string' ? r.payload.text : undefined;
  }
  function agent(path: string, b: any): unknown {
    try { return agentOp(path, b); }
    catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (isBusy(e)) throw new HttpError(503, 'busy, retry');
      if (e instanceof RequestError || e instanceof ProposalError) throw new HttpError(400, e.message);
      throw e;
    }
  }
  function agentOp(path: string, b: any): unknown {
    refreshFeatures();
    if (path === '/api/tell') { const out = tell(b?.text); emit('server'); return out; }
    const op = String(b?.op ?? 'list');
    if (op === 'list') return proposalsView();
    if (op === 'propose') {
      let input;
      try { input = checkProposal(b.proposal); } catch (e: any) { throw new HttpError(400, e.message); }
      const told = toldText(input.request);
      return changed(() => proposalView(addProposal(applyEnv, input, { told })));
    }
    // The person's own words for the Changes line: the CLI asks for them; the panel says where it was approved.
    const quote = b.quote === undefined ? undefined : str(b.quote, 1000, 'quote');
    if (op === 'approve') return changed(() => { const r = approveProposal(applyEnv, proposalId(b.id), itemNo(b.item), { quote, where: quote ? 'in the chat' : 'in the panel' }); return { ...proposalView(r.proposal), applied: r.applied, failed: r.failed }; });
    if (op === 'reject') return changed(() => proposalView(rejectProposal(applyEnv, proposalId(b.id), itemNo(b.item))));
    if (op === 'undo') return changed(() => proposalView(undoProposal(applyEnv, proposalId(b.id), itemNo(b.item) ?? 0)));
    throw new HttpError(400, 'op is list, propose, approve, reject or undo');
  }
  /** A source the user switched on was never fetched, or none was fetched in the last 6 hours. */
  function sourcesStale(at = Date.now()): boolean {
    const state = readSourcesState(c.jobs.home);
    const items = notesOf(ctx).sources.data.items.filter((it) => (it.linkedin ? ctx.features.linkedin_search : it.enabled && it.fetch !== 'none'));
    if (!items.length) return false;
    return items.some((it) => {
      const last = state?.by_key?.[it.linkedin ? 'linkedin' : it.key];
      return !last || at - Date.parse(last.at) > 6 * 3_600_000;
    });
  }
  /** After the user answers on the page: an apply that stopped for them goes on (design §2.3a step 4). */
  const afterAnswer = (role: string) => {
    const last = requests.latest(LANE, 'apply', role);
    if (last && last.status === 'done' && NEEDS_YOU.test(last.result ?? '') && statusOf(role) !== 'applied' && canApprove(db, role)) return { reapplied: queueApply(role, false).request };
    return {};
  };

  const actions: Record<string, (b: any) => unknown> = {
    setup: () => queue('setup', undefined, {}),
    refreshSources: () => {
      if (!canSource()) throw new HttpError(400, 'Sourcing isn\'t set up: run crewdeck jobs providers install (or switch on LinkedIn search)');
      const r = scheduler.refresh();
      return { ok: true, ...r };
    },
    find: (b) => {
      const out = queue('find', undefined, { count: intIn(b.count ?? (notesOf(ctx).search.data.schedule.daily_picks || 5), 1, 20, 'count') }, { task: (id) => ({ kind: 'find', request: id }), fresh: false });
      // Find fetches first when a source you switched on was never fetched or is older than 6 h: the request waits for
      // the fetch (Claude judges fresh postings, LinkedIn's included), at most 15 minutes.
      if (o.fetchBeforeFind && sourcesStale()) {
        const r = scheduler.refresh();
        if (r.started || r.already) {
          requests.setHold(out.request, 'fetching');
          const release = () => { requests.setHold(out.request, undefined); emit('queue'); };
          const cap = setTimeout(release, 15 * 60_000);
          void scheduler.idle().then(() => { clearTimeout(cap); release(); });
          return { ...out, fetching: true };
        }
      }
      return out;
    },
    addLink: (b) => queue('link', undefined, { url: checkLink(b.url, ctx.features), ...(b.force === true ? { force: true } : {}) }),
    tell: (b) => tell(b.text),
    approveProposal: (b) => changed(() => { const r = approveProposal(applyEnv, proposalId(b.id), itemNo(b.item), { where: 'on the Jobs page' }); return { ok: true, applied: r.applied, failed: r.failed }; }),
    rejectProposal: (b) => changed(() => { rejectProposal(applyEnv, proposalId(b.id), itemNo(b.item)); return { ok: true }; }),
    undoProposal: (b) => changed(() => { undoProposal(applyEnv, proposalId(b.id), itemNo(b.item) ?? 0); return { ok: true }; }),
    approve: (b) => {
      const r = roleArg(b.role);
      if (r.status === 'applied') throw new HttpError(400, 'already applied');
      if (r.status === 'skipped') throw new HttpError(400, 'you skipped this role');
      if (unprepared(r.id)) return { ...prepareRole(r.id), preparing: true };
      const mode = applyMode(ctx, r, notesOf(ctx).profile.data);
      if (mode.mode !== 'fill') return { ok: true, mode: mode.mode, reason: mode.reason, answers: copyModel(db, r.id).answers };
      if (!canApprove(db, r.id)) throw new HttpError(400, 'Answer the required first-time questions first');
      return { ...queueApply(r.id), mode: 'fill' };
    },
    improve: (b) => {
      const r = roleArg(b.role);
      const f = fieldOf(r.id, b.field_id);
      return queue('improve', r.id, { role: r.id, field_id: f.field_id, question: f.ref, instruction: b.instruction === undefined ? '' : str(b.instruction, 500, 'the instruction') });
    },
    editAnswer: (b) => {
      const r = roleArg(b.role);
      fieldOf(r.id, b.field_id);
      const out = editAnswer(ctx, { role: r.id, field_id: Number(b.field_id), text: str(b.text, 5000, 'the answer') });
      if (!out.ok) throw new HttpError(400, out.reason);
      return { ok: true, ...afterAnswer(r.id) };
    },
    answer: (b) => {
      const r = roleArg(b.role);
      if (b.field_id !== undefined && b.field_id !== null) {
        const f = fieldOf(r.id, b.field_id);
        if (b.option !== undefined) {
          const option = str(b.option, 300, 'the option');
          answerFirstTime(ctx, { role: r.id, question: f.ref, value: option, quote: `picked "${option}" on the Jobs page` });
        } else {
          const text = str(b.text, 5000, 'the answer');
          if (!text) throw new HttpError(400, 'the answer is empty');
          answerFirstTime(ctx, { role: r.id, question: f.ref, value: text, quote: text });
        }
        return { ok: true, ...afterAnswer(r.id) };
      }
      // A "needs you" question Claude met on the live form but didn't record: recorded now, with the user's answer.
      const req = requests.get(Number(b.request));
      if (!req || req.lane !== LANE || req.kind !== 'apply' || req.ref !== r.id || req.status !== 'done' || !NEEDS_YOU.test(req.result ?? '')) throw new HttpError(400, 'nothing is waiting for an answer here');
      const text = str(b.text, 5000, 'the answer');
      if (!text) throw new HttpError(400, 'the answer is empty');
      const out = learnField(ctx, r.id, { label: (req.result ?? '').replace(NEEDS_YOU, '').trim().slice(0, 300), answer: text, quote: text, required: true });
      if (!out.ok) throw new HttpError(400, out.reason);
      return { ok: true, ...afterAnswer(r.id) };
    },
    notInterested: (b) => {
      const r = roleArg(b.role);
      const words = Array.isArray(b.titleWords) ? b.titleWords.map((w: unknown) => str(w, 40, 'a title word')).filter(Boolean) : [];
      const out = notInterested(ctx, { role: r.id, reason: str(b.reason, 1000, 'the reason'), titleWords: words });
      reconcile();
      if (selected === r.id) selected = null;
      return { ok: true, ...out };
    },
    markApplied: (b) => {
      const r = roleArg(b.role);
      const out = markApplied(ctx, r.id);
      reconcile();
      return { ok: true, ...out };
    },
    // Opening a pick only shows it: preparing spends tokens, so it waits for the person's Prepare (or Apply) click.
    select: (b) => { selected = roleArg(b.role).id; return { ok: true }; },
    /** P4: prepare one pick Find didn't prepare ahead (about a minute in the Jobs chat). */
    prepare: (b) => {
      const r = roleArg(b.role);
      if (r.status === 'applied' || r.status === 'skipped') throw new HttpError(400, `this role is ${r.status}`);
      return prepareRole(r.id);
    },
    prefs: (b) => {
      const list = prefChanges(b.changes);
      if (!list.length) return { ok: true, changed: [] };
      // A fix offered by Find's "Why so few?" card says so in the note's Changes line.
      const because = b.from === 'find' ? 'added from Find\'s suggestions (set on the Jobs page)' : SET_ON_PAGE;
      let out;
      try { out = setFields(join(c.vault, NOTES.search), 'search', list, { because, today: todayOf(ctx) }); }
      catch (e: any) { return { ok: false, issues: fieldIssues(e) }; }
      return { ok: true, changed: out.filter((r) => r.changed).map((r) => r.path) };
    },
    feature: async (b) => {
      const name = String(b.name ?? '');
      if (!Object.hasOwn(FEATURE_DEFAULTS, name)) throw new HttpError(400, `unknown feature ${name}`);
      const value = featureValue(name as keyof JobsFeatures, b.value);
      const changes = featureChanges(name as keyof JobsFeatures, value, ctx.features);
      if (widens(changes, ctx.features)) {
        // A human must say yes outside the page: a native dialog, or else a code for their own terminal.
        if (confirming) throw new HttpError(409, 'A confirmation is already open on your screen: answer it first');
        confirming = true;
        let answer;
        try { answer = await confirm('Crewdeck', confirmText(changes)); } finally { confirming = false; }
        if (answer === 'no') throw new HttpError(409, 'Not changed: the confirmation was cancelled');
        if (answer === 'unavailable') {
          if (!o.token) throw new HttpError(409, 'No confirmation dialog on this system: run crewdeck jobs features in your own terminal');
          const code = issueCode(o.token, name, value, o.codeFile ?? codeFile());
          const word = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
          return { ok: false, name, value, terminal: { command: `crewdeck jobs features ${name} ${word}`, code: code.code, expires: code.expires } };
        }
        refreshFeatures(); // the dialog took a while: apply to the switches as they are now
      }
      for (const ch of changes) setFeature(ch.name, ch.value, configPath);
      refreshFeatures();
      return { ok: true, name, value, also: changes.slice(1) };
    },
    /** Stop a request the page shows (waiting, or picked by a session that is gone): closed as cancelled. */
    cancel: (b) => {
      const id = Number(b.request);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'unknown request');
      const r = requests.cancel(id, LANE);
      return { ok: true, request: r.id, status: r.status };
    },
    /**
     * D24: Claude finds the real jobs page of a source Crewdeck couldn't read (a careers page or web address in the
     * user's list); the request names the source by its key only.
     */
    findJobsPage: (b) => {
      const key = sourceKey(b.key);
      const it = notesOf(ctx).sources.data.items.find((x) => x.key === key);
      if (!it) throw new HttpError(404, 'no such source');
      if (it.linkedin || (!it.careers_url && !it.url)) throw new HttpError(400, 'only an employer\'s page or a web address can be looked up');
      return queue('source', key, { key });
    },
    /**
     * D23: the user's list, changed from the page with the same validated operations as `crewdeck jobs sources …` (so the
     * note's bytes are the same). LinkedIn's switch is never changed here: the feature action does that.
     */
    sources: (b) => {
      const op = String(b.op ?? '');
      const at = b.at === undefined ? undefined : intIn(b.at, 1, 200, 'the position') - 1;
      let change: SourceOp;
      if (op === 'add') {
        if (b.linkedin === true) change = { op: 'add', source: { linkedin: true }, at };
        else {
          const name = b.name === undefined ? undefined : str(b.name, 200, 'the name');
          if (name !== undefined && /[\r\n]/.test(name)) throw new HttpError(400, 'the name must be one line');
          const provider = b.provider === undefined ? undefined : str(b.provider, 60, 'the provider');
          if (provider !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(provider)) throw new HttpError(400, 'unknown provider');
          const careers_url = b.careers_url === undefined ? undefined : pageUrl(b.careers_url);
          const url = b.url === undefined ? undefined : pageUrl(b.url);
          if ((careers_url || url) && !name) throw new HttpError(400, 'give the name too');
          change = { op: 'add', source: { name, provider, careers_url, url, employer: b.employer === true }, at };
        }
      } else if (op === 'remove' || op === 'enable' || op === 'disable') change = { op, key: sourceKey(b.key) };
      else if (op === 'move') change = { op: 'move', key: sourceKey(b.key), to: intIn(b.to, 1, 200, 'the position') - 1 };
      else if (op === 'set_url') {
        const key = sourceKey(b.key), url = pageUrl(b.url);
        const it = notesOf(ctx).sources.data.items.find((x) => x.key === key);
        if (!it || it.linkedin || (!it.careers_url && !it.url)) throw new HttpError(400, 'only an employer\'s page or a web address has an address to change');
        change = { op: 'set', key, fields: { careers_url: url, url: null, provider: null, fetch: null, why: null }, line: `new jobs page for ${it.name}: ${url}` };
      } else throw new HttpError(400, 'op must be add, remove, move, enable, disable or set_url');
      try {
        const r = changeSources(ctx, change);
        return { ok: true, changed: r.changed, key: r.key, line: r.line };
      } catch (e: any) { throw new HttpError(400, String(e.message).slice(0, 500)); }
    },
    /**
     * D23/D24: check a careers page or web address in the user's list (which provider reads it, a one-page test). It runs
     * in the background; the Sources screen shows "checking…" and then the answer, which is also written to the note.
     */
    resolveSource: (b) => {
      const key = sourceKey(b.key);
      const it = notesOf(ctx).sources.data.items.find((x) => x.key === key);
      if (!it) throw new HttpError(404, 'no such source');
      if (it.linkedin || (!it.careers_url && !it.url)) throw new HttpError(400, 'only an employer\'s page or a web address can be checked');
      if (resolving.has(key)) return { ok: true, key, already: true };
      if (resolving.size >= MAX_RESOLVING) throw new HttpError(409, 'Two pages are being checked already: try again when one is done');
      const started = new Date().toISOString();
      resolving.set(key, { key, started });
      resolved.delete(key);
      const done = (v: ResolveState) => {
        resolved.set(key, v);
        for (const k of [...resolved.keys()].slice(0, Math.max(0, resolved.size - 50))) resolved.delete(k);
      };
      Promise.resolve().then(() => resolver(key))
        .then((result) => done({ key, at: new Date().toISOString(), result }), (e) => done({ key, at: new Date().toISOString(), refused: String(e?.message ?? e).slice(0, 300) }))
        .finally(() => { resolving.delete(key); emit('sources'); });
      return { ok: true, key, started };
    },
    // "Open in Claude": a new Claude Code session in the jobs folder, in Claude desktop (docs/everywhere.md E11). The link
    // is built here from the config, never from the page; the page's frame can't open a claude:// link itself (CSP).
    // With `request` (a waiting Find, Prepare or Apply): that task's chat again, e.g. after the person closed the dialog.
    openSession: async (b) => {
      if (platform !== 'darwin' && platform !== 'linux') throw new HttpError(404, 'Open in Claude needs macOS or Linux');
      const r = b?.request === undefined ? undefined : requests.get(Number(b.request));
      const task = r && r.lane === LANE && r.status === 'new' ? taskOf(r) : null;
      if (task) openedFor.add(r!.id);
      await launch(task ? jobsTaskLink(c.jobs.workspace, task) : sessionLink(c.jobs.workspace, setupView(notesOf(ctx)).needed ? JOBS_SETUP_PROMPT : JOBS_SESSION_PROMPT));
      return { ok: true };
    },
    reveal: async (b) => {
      if (platform !== 'darwin') throw new HttpError(404, 'Show in Finder is only on macOS');
      const r = roleArg(b.role);
      const file = resumeFile(r.id);
      if (!file) throw new HttpError(404, 'no resume for this role yet');
      await (o.reveal ?? ((f: string) => new Promise<void>((ok, bad) => execFile('open', ['-R', f], (e) => (e ? bad(e) : ok())))))(file);
      return { ok: true };
    },
  };
  actions.firstTimeChoice = (b) => actions.answer({ ...b, text: undefined });
  actions.retryApply = actions.approve;

  /** The role's tailored PDF, only inside <jobs.home>/out/ after resolving links. */
  function resumeFile(id: string): string | null {
    if (!ROLE_ID.test(id)) return null;
    const notes = notesOf(ctx);
    let real: string, root: string;
    try { root = realpathSync(join(c.jobs.home, 'out')); real = realpathSync(resumePath(ctx, id, notes)); } catch { return null; }
    return real.startsWith(root + sep) ? real : null;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    try {
      refreshFeatures();
      if (req.method === 'POST' && path === '/api/jobs/preview') {
        // A dry run (D27): the page's own, like an action, but read-only (no refresh event, nothing written).
        if (!fromOwnPage(req)) throw new HttpError(403, 'forbidden');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'a JSON object is expected');
        return json(res, 200, previewOf(body));
      }
      if (req.method === 'POST') {
        const m = /^\/api\/jobs\/action\/([A-Za-z]+)$/.exec(path);
        if (!m || !Object.hasOwn(actions, m[1])) throw new HttpError(404, 'not found');
        if (!fromOwnPage(req)) throw new HttpError(403, 'forbidden');
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'a JSON object is expected');
        const out = await actions[m[1]](body);
        emit('server');
        return json(res, 200, out);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (!ownRead(req)) throw new HttpError(403, 'forbidden');
      if (path === '/api/jobs/events') {
        // A slot only for the page itself (a same-origin browser fetch) or an agent with the token; HEAD never streams.
        if (req.headers['sec-fetch-site'] !== 'same-origin' && !fromAgent(req, o.token ?? '')) throw new HttpError(403, 'forbidden');
        if (req.method === 'HEAD') { res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8' }); return res.end(); }
        return events(req, res);
      }
      const resume = /^\/api\/jobs\/resume\/([^/]+)$/.exec(path);
      if (resume) {
        const file = resumeFile(resume[1]);
        if (!file) throw new HttpError(404, 'no resume');
        const name = resumeFileName(notesOf(ctx).career.data, notesOf(ctx).profile.data);
        const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
        const disposition = `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
        return send(res, 200, readFileSync(file), 'application/pdf', { 'content-disposition': disposition });
      }
      if (path === '/api/jobs/state') return json(res, 200, stateView());
      if (path === '/api/jobs/today') { const r = url.searchParams.get('role'); return json(res, 200, today(r && ROLE_ID.test(r) ? r : undefined)); }
      if (path === '/api/jobs/applications') return json(res, 200, applicationsView(ctx));
      if (path === '/api/jobs/knowledge') {
        const tab = (url.searchParams.get('tab') ?? 'profile') as KnowledgeTab;
        if (!(KNOWLEDGE_TABS as readonly string[]).includes(tab)) throw new HttpError(400, 'unknown tab');
        const k = knowledgeView(ctx, tab);
        return json(res, 200, { ...k, page: notesPage(k.note), pages: Object.fromEntries(Object.entries(k.notes).map(([t, f]) => [t, notesPage(f)])) });
      }
      if (path === '/api/jobs/proposals') return json(res, 200, proposalsView());
      if (path === '/api/jobs/preferences') return json(res, 200, preferences());
      if (path === '/api/jobs/settings') return json(res, 200, settings());
      if (path === '/api/jobs/sources') return json(res, 200, sourcesScreen(ctx, { resolving, results: recentResolves(), notesPage: (f) => notesPage(f)! }));
      throw new HttpError(404, 'not found');
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (isBusy(e)) throw new HttpError(503, 'busy, retry');
      if (e instanceof RequestError) throw new HttpError(400, e.message);
      if (e?.code && String(e.code).startsWith('ERR_SQLITE')) throw e; // internal: no detail to the page
      if (e instanceof Error) throw new HttpError(400, e.message.slice(0, 500));
      throw e;
    }
  }

  function events(req: IncomingMessage, res: ServerResponse) {
    if (clients.size >= MAX_CLIENTS) throw new HttpError(503, 'too many live connections');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function contextFor(r: Request) {
    if (r.lane !== LANE || !r.kind) return undefined;
    refreshFeatures();
    if (r.kind === 'find') return { daily_picks: notesOf(ctx).search.data.schedule.daily_picks, prepare_ahead: notesOf(ctx).search.data.schedule.prepare_ahead };
    if (r.kind === 'source') return { source: listSources(ctx).find((x) => x.key === r.payload?.key) ?? null };
    if ((r.kind !== 'apply' && r.kind !== 'improve' && r.kind !== 'prepare') || !r.ref || !ROLE_ID.test(r.ref)) return {};
    let role;
    try { role = getRole(db, r.ref); } catch { return { role: null }; }
    const out: any = {
      role: { id: role.id, company: role.company, title: role.title, status: role.status, url: role.url, apply_url: role.apply_url ?? null, apply_kind: role.apply_kind ?? null, apply: applyMode(ctx, role, notesOf(ctx).profile.data) },
    };
    if (r.kind === 'improve' && r.payload) {
      const f = currentAnswers(db, role.id).find((a) => a.field_id === Number(r.payload!.field_id));
      if (f) out.field = { ref: f.ref, label: f.label, kind: f.kind, options: f.options, text: f.text, status: f.status, sources: f.sources };
    }
    return out;
  }

  function glance(): JobsGlance {
    const all = requests.ofLane(LANE);
    const label = (r: Request) => (r.kind ? LABEL[r.kind] : 'Request');
    const working = all.find((r) => r.status === 'picked');
    const waiting = all.filter((r) => r.status === 'new');
    const done = all.find((r) => (r.status === 'done' || r.status === 'failed') && Date.now() - Date.parse(r.updated) < 30 * 60_000);
    const activity = working
      ? { state: 'working' as const, label: label(working), detail: working.progress?.at(-1)?.text ?? '' }
      : waiting[0]
        ? { state: (waiting[0].hold ? 'fetching' : 'waiting') as 'fetching' | 'waiting', label: label(waiting[0]), detail: waiting.length > 1 ? `+${waiting.length - 1} more` : '' }
        : done ? { state: (done.status === 'done' ? 'done' : 'failed') as 'done' | 'failed', label: label(done), detail: String(done.result ?? '').slice(0, 160), id: done.id } : null;
    const v = today();
    const kinds = v.queue.map((q: any) => q.chip?.kind as string);
    const count = (k: string) => kinds.filter((x) => x === k).length;
    return {
      activity,
      setup_needed: setupView(notesOf(ctx)).needed,
      connected: requests.presence(LANE).connected,
      session_link: sessionLink(c.jobs.workspace, setupView(notesOf(ctx)).needed ? JOBS_SETUP_PROMPT : JOBS_SESSION_PROMPT),
      counts: { needs_you: count('first') + count('warn'), ready: count('ready'), in_progress: kinds.filter((k) => !['first', 'warn', 'ready', 'applied'].includes(k)).length, applied_today: count('applied') },
      proposals: pendingCount(db),
      queue: v.queue.filter((q: any) => q.chip?.kind !== 'applied').slice(0, 6).map((q: any) => ({ id: String(q.id), company: String(q.company), title: String(q.title), chip: String(q.chip?.text ?? ''), kind: String(q.chip?.kind ?? '') })),
      ...readyPicks(v.queue),
    };
  }

  /** Picks not applied and with no Apply under way, in the page's order (best first): the panel's "N jobs ready". */
  function readyPicks(queue: any[]) {
    const ready = queue.filter((q) => q.chip?.kind !== 'applied' && !requests.latest(LANE, 'apply', q.id));
    return { ready_total: ready.length, picks: ready.slice(0, 3).map((q) => ({ id: String(q.id), company: String(q.company), title: String(q.title), prepared: !unprepared(q.id) })) };
  }

  /** The panel's buttons, through the page's own checked actions (the panel can't call those: they are same-origin only). */
  async function panelAction(b: any): Promise<unknown> {
    refreshFeatures();
    const op = String(b?.op ?? '');
    try {
      if (op === 'find') return await actions.find({});
      if (op === 'apply') {
        const role = String(b.role ?? '');
        if (!ROLE_ID.test(role) || !todayView(ctx).queue.some((q) => q.id === role)) throw new HttpError(400, 'not one of today\'s picks');
        return await actions.approve({ role });
      }
      throw new HttpError(400, 'op is find or apply');
    } catch (e) {
      if (e instanceof RequestError) throw new HttpError(400, e.message);
      throw e;
    } finally { emit('server'); }
  }

  return {
    handle, contextFor, emit, scheduler, glance, agent, panelAction,
    close() {
      scheduler.stop();
      for (const t of chatHolds.values()) clearTimeout(t);
      for (const ch of children) { try { ch.kill('SIGKILL'); } catch {} }
      for (const t of timers) clearInterval(t);
      if (flush) clearTimeout(flush);
      for (const w of watchers.values()) { try { w.close(); } catch {} }
      for (const res of clients) { try { res.end(); } catch {} }
      offQueue();
      try { db.close(); } catch {}
    },
  };
}
