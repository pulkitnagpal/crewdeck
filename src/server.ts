// The shell: one page with a nav rail and frames for Notes (SilverBullet), each project's Board (Backlog.md) and Jobs,
// plus a small JSON API. Notes and each board run behind their own local proxy port, so none of them shares this page's
// origin; Jobs is Crewdeck's own page and lives here (/jobs/, /api/jobs/*), loaded only when jobs.enabled.
//
// Two kinds of API callers, checked differently:
// - the page itself (Ask Claude, the Jobs page's actions): exact own Origin, same-origin fetch, JSON body;
// - agents (the bridge mod in a Claude session, the CLI): the token in ~/.crewdeck/token, and no browser Origin. An agent
//   first sends only a nonce (POST /api/hello) and checks the proof before its token leaves it; every request-scoped call
//   names the caller's folder, and only a session of the request's own lane may read or close it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { CLI_WRAPPER, REPO, effectiveAddress, pageUrl, type Config } from './config.ts';

/** This Crewdeck's version (package.json): the panel offers an update when the plugin is newer. */
const APP_VERSION: string = (() => { try { return String(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version ?? ''); } catch { return ''; } })();
import { Requests, RequestError, laneFor, publicView } from './requests.ts';
import { TodayError, addTodo, localDate, setTodo, ticketsOf, todosOf } from './today.ts';
import { HttpError, NONCE, fromAgent, fromOwnPage, isLocalHost, json, ownRead, proofFor, readJson, send, useAddress } from './http.ts';
import { tokensCss } from './appearance.ts';
import type { JobsApi, JobsApiOptions } from './jobs/api.ts';

const WEB = join(REPO, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** What a session is told about its lane's requests, besides the requests themselves. */
const HINTS: Record<string, string> = { jobs: 'Use the jobs-workspace skill.' };

export function shellState(c: Config) {
  return {
    // Ports only: the page builds each URL on its own host, so every frame is same-site (not a blocked third party).
    notes: { port: c.silverbullet.port },
    projects: c.projects.map((p) => ({ name: p.name, label: p.label, boardPort: p.boardPort })),
    apps: c.apps.map((a) => ({ name: a.name, label: a.label ?? a.name, url: a.url })),
    jobs: c.jobs?.enabled ? { path: '/jobs/' } : null,
    appearance: c.appearance,
  };
}

export type ShellOptions = { token: string; jobs?: JobsApiOptions };

/** How a session runs Crewdeck's CLI: the managed wrapper when `crewdeck up` wrote one, else node + this checkout. */
const shq = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const cliFor = () => (existsSync(CLI_WRAPPER) ? shq(CLI_WRAPPER) : `node ${shq(join(REPO, 'src', 'cli.ts'))}`);

export function createShell(c: Config, requests = new Requests(), opts: ShellOptions): Server {
  // The names and origins every port in this process answers to (crewdeck.localhost, and the user's extra names).
  useAddress(effectiveAddress(c));
  // Jobs: imported (and its database opened) only when switched on.
  let jobs: Promise<JobsApi> | null = null;
  const jobsApi = (): Promise<JobsApi> => (jobs ??= import('./jobs/api.ts').then((m) => m.createJobsApi(c, requests, { ...opts.jobs, token: opts.token })).catch((e) => {
    jobs = null; // the next request tries again (e.g. after the user fixed jobs.home's permissions)
    throw new HttpError(500, `Jobs could not start: ${e?.message ?? e}`);
  }));
  const jobsOn = () => !!c.jobs?.enabled;

  const dateOf = (d: unknown) => {
    if (d === undefined || d === null || d === '') return localDate();
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(400, 'date is YYYY-MM-DD');
    return d;
  };
  async function todayGlance(d: unknown) {
    const date = dateOf(d);
    let jobs: unknown = null;
    if (jobsOn()) { try { jobs = (await jobsApi()).glance(); } catch { jobs = { error: 'Jobs could not start' }; } }
    return {
      date, url: pageUrl(c), notes_page: `journal/${date}`, version: APP_VERSION,
      todos: todosOf(c.vault, date), jobs, ...ticketsOf(c.projects),
      projects: c.projects.map((p) => ({ name: p.name, label: p.label ?? p.name, path: p.path })),
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLocalHost(req.headers.host)) return send(res, 403, 'forbidden', 'text/plain');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/jobs/')) {
      if (!jobsOn()) throw new HttpError(404, 'not found');
      return (await jobsApi()).handle(req, res, url);
    }
    if (req.method === 'POST') {
      // The page's own endpoint: Ask Claude (plain text; never the jobs lane).
      if (path === '/api/requests') {
        if (!fromOwnPage(req)) throw new HttpError(403, 'forbidden');
        const b = await readJson(req);
        return json(res, 200, publicView(requests.add(String(b.lane), String(b.text))));
      }
      const port = req.socket.localPort ?? 0;
      // The challenge comes first: a nonce in, the proof out, no token yet (a squatter learns nothing it can use).
      if (path === '/api/hello') {
        if (req.headers.origin !== undefined) throw new HttpError(403, 'forbidden');
        const nonce = String((await readJson(req)).nonce ?? '');
        if (!NONCE.test(nonce)) throw new HttpError(400, 'nonce required');
        return json(res, 200, { proof: proofFor(opts.token, nonce, port) });
      }
      // Agent endpoints.
      const m = /^\/api\/requests\/(\d+)\/(done|fail|show|progress)$/.exec(path);
      const tellOrProposals = path === '/api/tell' || path === '/api/proposals';
      if (path !== '/api/claim' && path !== '/api/requeue' && path !== '/api/today' && path !== '/api/today/todo' && path !== '/api/today/jobs' && !tellOrProposals && !m) throw new HttpError(404, 'not found');
      if (!fromAgent(req, opts.token)) throw new HttpError(401, 'missing or wrong token');
      const b = await readJson(req);
      // Tell Crewdeck (P3): the panel or `crewdeck jobs tell` queues a tell request; the panel and `crewdeck jobs
      // propose|proposals` list, write and decide proposals. A proposal answering a tell request comes from the jobs lane.
      if (tellOrProposals) {
        if (!jobsOn()) throw new HttpError(404, 'not found');
        if (path === '/api/proposals' && b.op === 'propose' && b.proposal?.request !== undefined && laneFor(c, String(b.cwd ?? '')) !== 'jobs') throw new HttpError(403, 'a proposal for a tell request is written from the jobs workspace');
        return json(res, 200, (await jobsApi()).agent(path, b));
      }
      // The Today panel (docs/everywhere.md E7): today's to-dos, a look at Jobs, open tickets, and where to open them.
      if (path === '/api/today') return json(res, 200, await todayGlance(b.date));
      if (path === '/api/today/todo') {
        const date = dateOf(b.date);
        try {
          if (b.op === 'add') addTodo(c.vault, date, b.text);
          else if (b.op === 'set') setTodo(c.vault, date, b.line, b.text, b.done);
          else throw new TodayError('op is add or set');
        } catch (e) { if (e instanceof TodayError) throw new HttpError(400, e.message); throw e; }
        return json(res, 200, await todayGlance(date));
      }
      // The panel's Jobs buttons (Find now, Apply on a pick): the same checked actions as the Jobs page's, which open the
      // task's Jobs chat in front (ADR-0004); then the panel's fresh look.
      if (path === '/api/today/jobs') {
        if (!jobsOn()) throw new HttpError(404, 'not found');
        const out = await (await jobsApi()).panelAction(b);
        return json(res, 200, { ...(await todayGlance(b.date)), done: out });
      }
      if (path === '/api/claim') {
        const nonce = String(b.nonce ?? '');
        if (!NONCE.test(nonce)) throw new HttpError(400, 'nonce required');
        const lane = laneFor(c, String(b.cwd ?? ''));
        // take: false is a busy session saying it's still there (presence and its leases) without taking new work.
        // want: the request a Jobs chat was opened for, named in its first prompt (at most a few ids).
        const want = Array.isArray(b.want) ? b.want.slice(0, 4).map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [];
        const claimed = requests.claim(lane, String(b.by ?? 'session'), b.take !== false, want);
        // Typed requests travel as kind, ref and payload keys: their values (links, posting text) never reach the prompt.
        const list = claimed.map((r) => (r.kind ? { id: r.id, kind: r.kind, ref: r.ref ?? null, keys: Object.keys(r.payload ?? {}) } : { id: r.id, text: r.text }));
        // The CLI path lets the session close requests without knowing where Crewdeck is installed.
        return json(res, 200, { lane, cli: cliFor(), hint: Object.hasOwn(HINTS, lane) ? HINTS[lane] : null, proof: proofFor(opts.token, nonce, port), requests: list });
      }
      if (path === '/api/requeue') {
        const ids = Array.isArray(b.ids) ? b.ids.map(Number) : [];
        return json(res, 200, { back: requests.requeue(ids, String(b.by ?? 'session')) });
      }
      const id = Number(m![1]);
      const r = requests.get(id);
      if (!r) throw new HttpError(404, `no request ${id}`);
      // A session reads and closes only its own lane's requests: the caller's folder decides its lane, as for claims.
      if (typeof b.cwd !== 'string' || !b.cwd) throw new HttpError(400, 'cwd required (the folder the command runs in)');
      const lane = laneFor(c, b.cwd);
      if (lane !== r.lane) throw new HttpError(403, `request ${id} belongs to the ${r.lane} lane, not ${lane}: run this from that lane's session`);
      if (m![2] === 'show') {
        requests.take(id);
        const context = r.lane === 'jobs' && jobsOn() ? (await jobsApi()).contextFor(r) : undefined;
        return json(res, 200, { id: r.id, lane: r.lane, kind: r.kind ?? null, ref: r.ref ?? null, status: r.status, hold: r.hold ?? null, text: r.kind ? undefined : r.text, payload: r.payload ?? null, result: r.result ?? null, context });
      }
      if (m![2] === 'progress') return json(res, 200, publicView(requests.progress(id, String(b.text ?? ''))));
      return json(res, 200, publicView(requests.finish(id, String(b.result ?? ''), m![2] === 'fail')));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (path.startsWith('/api/') && !ownRead(req)) throw new HttpError(403, 'forbidden');
    if (path === '/api/state') return json(res, 200, shellState(c));
    if (path === '/tokens.css') return send(res, 200, tokensCss(c.appearance), 'text/css; charset=utf-8');
    if (path === '/api/requests') return json(res, 200, requests.list().map(publicView));
    if (path.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (path === '/jobs' || path.startsWith('/jobs/')) {
      if (!jobsOn()) return send(res, 404, 'not found', 'text/plain');
      if (path === '/jobs') { res.writeHead(301, { location: '/jobs/' }); return res.end(); }
      const { serveJobsStatic } = await import('./jobs/static.ts');
      if (!serveJobsStatic(path, res)) send(res, 404, 'not found', 'text/plain');
      return;
    }
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB + sep) || file.startsWith(join(WEB, 'jobs') + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, readFileSync(file), (Object.hasOwn(TYPES, extname(file)) ? TYPES[extname(file)] : 'application/octet-stream'));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return json(res, e.code, { error: e.message });
      if (e instanceof URIError) return json(res, 400, { error: 'bad path' });
      // Queue rules (bad lane, empty, limits, closed) are the caller's to fix; anything else stays opaque.
      if (e instanceof RequestError) return json(res, 400, { error: e.message });
      json(res, 500, { error: 'internal' });
    });
  });
  // Start Jobs with the server: open requests of roles already applied or skipped close, the live refresh watches.
  if (jobsOn()) jobsApi().catch((e) => console.error(e.message));
  // Closing the server ends Jobs' live streams too (they would otherwise keep their connections open).
  const close = server.close.bind(server);
  server.close = ((cb?: (e?: Error) => void) => { jobs?.then((j) => j.close(), () => {}); return close(cb); }) as typeof server.close;
  return server;
}
