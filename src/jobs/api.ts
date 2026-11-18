// The Jobs page's API, inside the shell server (design D2): views, the page's own actions, the live refresh stream and
// the tailored resume. Loaded only when jobs.enabled. Heavy work (reading pages, forms, PDFs) stays in CLI processes run
// by Claude; the server's database work is small, with a 250 ms busy timeout that answers "busy, retry".
//
// Who may call what (design D16):
// - page actions (POST /api/jobs/action/*): this origin's own page only (exact Origin, same-origin fetch, JSON). They are
//   the only way a request reaches the jobs lane, each checked for its kind, and the only way (besides a terminal) a
//   risky switch changes.
// - reads (GET /api/jobs/*): never for another site (no CORS headers; Sec-Fetch-Site other than same-origin/none refused).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { type FSWatcher, existsSync, readFileSync, realpathSync, watch } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { type Config, CONFIG_PATH, FEATURE_CAPS, FEATURE_DEFAULTS, type JobsFeatures, featureValue, setFeature } from '../config.ts';
import { HttpError, SECURITY_HEADERS, fromOwnPage, json, ownRead, readJson, send } from '../http.ts';
import { type JobKind, type Request, type Requests, RequestError, isOpen } from '../requests.ts';
import { type Ctx, makeCtx, notesOf, todayOf } from './ctx.ts';
import { type Db, ROLE_ID, getRole, openJobsDb } from './db.ts';
import { NOTES, NOTE_NAMES, type JobNotes } from './notes.ts';
import { EMPLOYMENT, LEVELS, TRAVEL, WORKPLACES } from './schema.ts';
import { setFields } from './edit.ts';
import { checkRoleUrl, isLinkedinHost, isXHost } from './fields.ts';
import { canonicalJobUrl, linkedinJobId } from './linkedin.ts';
import { answerFirstTime, currentAnswers, editAnswer } from './kb/ops.ts';
import { learnField } from './kb/learn.ts';
import { markApplied, notInterested } from './pipeline/apply.ts';
import { KNOWLEDGE_TABS, type KnowledgeTab, applicationsView, applyMode, canApprove, copyModel, knowledgeView, resumeFileName, resumePath, todayView } from './views.ts';
import { NEEDS_YOU, applyPanel } from './panel.ts';
import { FEATURE_INFO, RISK } from './features.ts';
import { findBrowser, installHint } from './browser.ts';

export type JobsApi = {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** What `request show` adds for Claude: the role (and field) a jobs request is about. */
  contextFor(r: Request): unknown;
  /** Tell open pages to refresh (the server's own writes). */
  emit(topic: string): void;
  close(): void;
};
export type JobsApiOptions = {
  configPath?: string; pollMs?: number; platform?: string;
  /** Show a file in Finder (tests replace it). */
  reveal?: (file: string) => Promise<void>;
  browser?: () => { name: string; path: string } | null;
};

const LANE = 'jobs';
const LABEL: Record<JobKind, string> = { setup: 'Set up Jobs', find: 'Find jobs', link: 'Add a job link', apply: 'Apply to a role', improve: 'Improve an answer' };
const MAX_CLIENTS = 20;
const SET_ON_PAGE = '(set on the Jobs page)';

/** jobs/search.md fields the Preferences form edits, and the shape of each value. */
export const PREF_FIELDS: Record<string, 'list' | 'num' | 'str' | 'bool' | 'langs'> = {
  'roles.titles': 'list', 'roles.seniority_prefer': 'list', 'roles.exclude_title_words': 'list',
  workplace: 'list', 'places.onsite': 'list', 'places.remote_from': 'list', 'places.commute_km': 'num',
  languages: 'langs', employment_types: 'list', licenses: 'list', needs_sponsorship: 'bool',
  'exclude.companies': 'list', 'exclude.industries': 'list', 'exclude.travel': 'str',
  'pay.currency': 'str', 'pay.floor': 'num', 'pay.period': 'str', 'pay.rule': 'str', 'pay.unlisted': 'str', 'pay.locale': 'str',
  'schedule.timezone': 'str', 'schedule.daily_picks': 'num', 'schedule.cooldown_days': 'num', judge_notes: 'str',
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

/** A pasted job link, checked before it becomes a request: http(s), no X, LinkedIn only as a posting and only when on. */
export function checkLink(raw: unknown, features: Pick<JobsFeatures, 'linkedin_links'>): string {
  const t = str(raw, 2000, 'the link');
  let u: URL;
  try { u = new URL(t); } catch { throw new HttpError(400, 'Paste a web address (https://…)'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Paste a web address (https://…)');
  if (isXHost(u.hostname.toLowerCase())) throw new HttpError(400, 'X links are never used: paste the company\'s own posting');
  if (isLinkedinHost(u.hostname.toLowerCase())) {
    const id = linkedinJobId(t);
    if (!id) throw new HttpError(400, 'That LinkedIn page is not a job posting: paste the job\'s own link (linkedin.com/jobs/view/…)');
    if (!features.linkedin_links) throw new HttpError(400, 'Pasted LinkedIn links are off: switch them on in Jobs → Settings, or paste the company\'s own posting');
    return canonicalJobUrl(id);
  }
  try { return checkRoleUrl(t, features); } catch (e: any) { throw new HttpError(400, e.message); }
}

/** A value from the Preferences form as the text `setFields` types by the schema (lists and maps as YAML flow). */
function prefRaw(path: string, v: unknown): string {
  const kind = PREF_FIELDS[path];
  if (!kind) throw new HttpError(400, `${path} is not a field the Jobs page edits`);
  if (kind === 'list' || kind === 'langs') {
    if (!Array.isArray(v)) throw new HttpError(400, `${path}: give a list`);
    if (v.length > 100) throw new HttpError(400, `${path}: at most 100 entries`);
    const items = kind === 'list'
      ? v.map((x) => str(x, 200, path)).filter(Boolean)
      : v.map((x: any) => ({ name: str(x?.name, 80, `${path} name`), ...(x?.level ? { level: str(x.level, 20, `${path} level`) } : {}) })).filter((x) => x.name);
    return JSON.stringify(items);
  }
  if (kind === 'num') { if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${path}: give a number`); return String(v); }
  if (kind === 'bool') { if (typeof v !== 'boolean') throw new HttpError(400, `${path}: use yes or no`); return String(v); }
  return str(v, kind === 'str' && path === 'judge_notes' ? 2000 : 200, path);
}

const getIn = (o: any, path: string) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

export function createJobsApi(c: Config, requests: Requests, o: JobsApiOptions = {}): JobsApi {
  const configPath = o.configPath ?? CONFIG_PATH;
  const platform = o.platform ?? process.platform;
  const db: Db = openJobsDb(c.jobs.home, { server: true });
  const ctx: Ctx = makeCtx({ db, vault: c.vault, home: c.jobs.home, features: c.jobs.features });
  const browser = (o.browser ?? (() => findBrowser(c.jobs.browser)))();
  let selected: string | null = null;

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
    const item = (r: Request) => ({ id: r.id, kind: r.kind, label: r.kind ? LABEL[r.kind] : r.text, ref: r.ref ?? null, role: roleOf(r), status: r.status, result: r.result ?? null, updated: r.updated, last: r.progress?.at(-1) ?? null });
    const recent = all.filter((r) => !isOpen(r) && Date.now() - Date.parse(r.updated) < 3_600_000).slice(0, 5);
    const lines = all.flatMap((r) => (r.progress ?? []).map((l) => ({ ...l, request: r.id }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
    return {
      connected: p.connected, seen: p.seen, workspace: c.jobs.workspace,
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
    const needed = core.some((f) => !f.exists || f.source === 'empty') || !notes.profile.data.identity.first_name || !notes.search.data.roles.titles.length;
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
      browser: browser ? browser.name : null,
    };
  }

  /** Today, with the apply panel of the selected role and what Claude is doing for it. */
  function today(sel?: string) {
    const v = todayView(ctx, sel ?? selected ?? undefined);
    const connected = requests.presence(LANE).connected;
    const applyReq = (id: string) => requests.latest(LANE, 'apply', id);
    const queue = v.queue.map((q) => {
      const r = applyReq(q.id);
      if (!r || q.chip.kind === 'applied') return q;
      const p = applyPanel({ status: 'picked', apply: { mode: 'fill' }, request: r, connected });
      const chip = { waiting: { kind: 'info', text: 'Waiting for Claude' }, filling: { kind: 'info', text: 'Claude is applying' }, needs_you: { kind: 'first', text: 'Needs you' },
        your_turn: { kind: 'ready', text: 'Your turn: submit' }, confirmation: { kind: 'ready', text: 'Mark applied?' }, stopped: { kind: 'warn', text: 'Apply stopped' } }[p.state as string];
      return chip ? { ...q, chip } : q;
    });
    if (!v.detail) return { ...v, queue, panel: null, asking: [] };
    const d = v.detail;
    const notes = notesOf(ctx);
    const pdf = d.resume ? resumePath(ctx, d.id, notes) : null;
    const panel = applyPanel({ status: d.status, apply: d.apply, applied: d.applied, request: applyReq(d.id), connected });
    const asking = requests.ofLane(LANE, 'improve').filter((r) => isOpen(r) && r.ref === d.id).map((r) => Number(r.payload?.field_id));
    return {
      ...v, queue,
      detail: { ...d, resume: pdf ? { file: basename(pdf), url: `/api/jobs/resume/${d.id}`, note: d.resume!.note } : null, copy: d.apply.mode === 'copy' ? copyModel(db, d.id).answers : null },
      panel, asking,
    };
  }

  function preferences() {
    const notes = notesOf(ctx);
    const s = notes.search;
    const values = Object.fromEntries(Object.keys(PREF_FIELDS).map((k) => [k, getIn(s.data, k) ?? null]));
    return {
      exists: s.exists, source: s.source, file: NOTES.search, page: notesPage(NOTES.search), values,
      issues: s.issues.map((i) => ({ level: i.level, path: i.path, message: i.message, fix: i.fix ?? null })),
      options: { workplace: WORKPLACES, employment_types: EMPLOYMENT, levels: LEVELS, travel: TRAVEL, period: ['year', 'month', 'hour'], rule: ['top_of_range', 'bottom_of_range'], unlisted: ['keep', 'drop'] },
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
  const queue = (kind: JobKind, ref: string | undefined, payload: Record<string, unknown>) => {
    const r = requests.add(LANE, LABEL[kind], { kind, ref, payload });
    return { ok: true, request: r.id, status: r.status };
  };
  const queueApply = (role: string) => queue('apply', role, { role });
  /** After the user answers on the page: an apply that stopped for them goes on (design §2.3a step 4). */
  const afterAnswer = (role: string) => {
    const last = requests.latest(LANE, 'apply', role);
    if (last && last.status === 'done' && NEEDS_YOU.test(last.result ?? '') && statusOf(role) !== 'applied' && canApprove(db, role)) return { reapplied: queueApply(role).request };
    return {};
  };

  const actions: Record<string, (b: any) => unknown> = {
    setup: () => queue('setup', undefined, {}),
    find: (b) => queue('find', undefined, { count: intIn(b.count ?? (notesOf(ctx).search.data.schedule.daily_picks || 5), 1, 20, 'count') }),
    addLink: (b) => queue('link', undefined, { url: checkLink(b.url, ctx.features), ...(b.force === true ? { force: true } : {}) }),
    approve: (b) => {
      const r = roleArg(b.role);
      if (r.status === 'applied') throw new HttpError(400, 'already applied');
      if (r.status === 'skipped') throw new HttpError(400, 'you skipped this role');
      const mode = applyMode(ctx, r, notesOf(ctx).profile.data);
      if (mode.mode === 'copy') return { ok: true, mode: 'copy', reason: mode.reason, answers: copyModel(db, r.id).answers };
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
    select: (b) => { selected = roleArg(b.role).id; return { ok: true }; },
    prefs: (b) => {
      const changes = b.changes;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'changes must be a map of field → value');
      const list = Object.entries(changes).map(([path, v]) => ({ segs: path.split('.'), raw: prefRaw(path, v) }));
      if (!list.length) return { ok: true, changed: [] };
      let out;
      try { out = setFields(join(c.vault, NOTES.search), 'search', list, { because: SET_ON_PAGE, today: todayOf(ctx) }); }
      catch (e: any) {
        const issues = String(e.message).split('\n').map((l) => { const m = /^([\w.\[\]]+): (.*)$/.exec(l); return m ? { path: m[1].replace(/\[(\d+)\]/g, '.$1'), message: m[2] } : { path: '', message: l }; });
        return { ok: false, issues };
      }
      return { ok: true, changed: out.filter((r) => r.changed).map((r) => r.path) };
    },
    feature: (b) => {
      const name = String(b.name ?? '');
      if (!(name in FEATURE_DEFAULTS)) throw new HttpError(400, `unknown feature ${name}`);
      const value = featureValue(name as keyof JobsFeatures, b.value);
      setFeature(name, value, configPath);
      c.jobs.features = { ...c.jobs.features, [name]: value };
      ctx.features = { ...ctx.features, [name]: value };
      return { ok: true, name, value };
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
      if (path === '/api/jobs/events') return events(req, res);
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
      if (path === '/api/jobs/preferences') return json(res, 200, preferences());
      if (path === '/api/jobs/settings') return json(res, 200, settings());
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
    if (r.kind === 'find') return { daily_picks: notesOf(ctx).search.data.schedule.daily_picks };
    if ((r.kind !== 'apply' && r.kind !== 'improve') || !r.ref || !ROLE_ID.test(r.ref)) return {};
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

  return {
    handle, contextFor, emit,
    close() {
      for (const t of timers) clearInterval(t);
      if (flush) clearTimeout(flush);
      for (const w of watchers.values()) { try { w.close(); } catch {} }
      for (const res of clients) { try { res.end(); } catch {} }
      offQueue();
      try { db.close(); } catch {}
    },
  };
}
