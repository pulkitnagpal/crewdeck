// The shell: one page with a nav rail and frames for Notes (SilverBullet), each project's Board (Backlog.md) and Jobs,
// plus a small JSON API. Notes and each board run behind their own local proxy port, so none of them shares this page's
// origin; Jobs is Crewdeck's own page and lives here (/jobs/, /api/jobs/*), loaded only when jobs.enabled.
//
// Two kinds of API callers, checked differently:
// - the page itself (Ask Claude, the Jobs page's actions): exact own Origin, same-origin fetch, JSON body;
// - agents (the bridge mod in a Claude session, the CLI): the token in ~/.crewdeck/token, and no browser Origin.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { REPO, type Config } from './config.ts';
import { Requests, RequestError, laneFor, publicView } from './requests.ts';
import { HttpError, fromAgent, fromOwnPage, isLocalHost, json, proofFor, readJson, send } from './http.ts';
import { tokensCss } from './appearance.ts';
import type { JobsApi, JobsApiOptions } from './jobs/api.ts';

const WEB = join(REPO, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
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

export function createShell(c: Config, requests = new Requests(), opts: ShellOptions): Server {
  // Jobs: imported (and its database opened) only when switched on.
  let jobs: Promise<JobsApi> | null = null;
  const jobsApi = (): Promise<JobsApi> => (jobs ??= import('./jobs/api.ts').then((m) => m.createJobsApi(c, requests, opts.jobs)).catch((e) => {
    jobs = null; // the next request tries again (e.g. after the user fixed jobs.home's permissions)
    throw new HttpError(500, `Jobs could not start: ${e?.message ?? e}`);
  }));
  const jobsOn = () => !!c.jobs?.enabled;

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
      // Agent endpoints.
      const m = /^\/api\/requests\/(\d+)\/(done|fail|show|progress)$/.exec(path);
      if (path !== '/api/claim' && path !== '/api/requeue' && !m) throw new HttpError(404, 'not found');
      if (!fromAgent(req, opts.token)) throw new HttpError(401, 'missing or wrong token');
      const b = await readJson(req);
      if (path === '/api/claim') {
        const nonce = String(b.nonce ?? '');
        if (!NONCE.test(nonce)) throw new HttpError(400, 'nonce required');
        const lane = laneFor(c, String(b.cwd ?? ''));
        const claimed = requests.claim(lane, String(b.by ?? 'session'));
        // Typed requests travel as kind, ref and payload keys: their values (links, posting text) never reach the prompt.
        const list = claimed.map((r) => (r.kind ? { id: r.id, kind: r.kind, ref: r.ref ?? null, keys: Object.keys(r.payload ?? {}) } : { id: r.id, text: r.text }));
        // The CLI path lets the session close requests without knowing where Crewdeck is installed.
        return json(res, 200, { lane, cli: `node ${join(REPO, 'src', 'cli.ts')}`, hint: HINTS[lane] ?? null, proof: proofFor(opts.token, nonce), requests: list });
      }
      if (path === '/api/requeue') return json(res, 200, { back: requests.requeue((b.ids ?? []).map(Number), String(b.by ?? 'session')) });
      const id = Number(m![1]);
      if (m![2] === 'show') {
        const r = requests.get(id);
        if (!r) throw new HttpError(404, `no request ${id}`);
        const context = r.lane === 'jobs' && jobsOn() ? (await jobsApi()).contextFor(r) : undefined;
        return json(res, 200, { id: r.id, lane: r.lane, kind: r.kind ?? null, ref: r.ref ?? null, status: r.status, text: r.kind ? undefined : r.text, payload: r.payload ?? null, result: r.result ?? null, context });
      }
      if (m![2] === 'progress') return json(res, 200, publicView(requests.progress(id, String(b.text ?? ''))));
      return json(res, 200, publicView(requests.finish(id, String(b.result ?? ''), m![2] === 'fail')));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
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
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
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
