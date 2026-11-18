// The shell: one page with a nav rail and frames for Notes (SilverBullet) and each project's Board (Backlog.md),
// plus a small JSON API. Each tool runs behind its own local proxy port, so none of them shares this page's origin.
//
// Two kinds of API callers, checked differently:
// - the page itself (Ask Claude): exact own Origin, same-origin fetch, JSON body;
// - agents (the bridge mod in a Claude session, the CLI): the token in ~/.crewdeck/token, and no browser Origin.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { REPO, type Config } from './config.ts';
import { Requests, laneFor } from './requests.ts';
import { SECURITY_HEADERS, SHELL_CSP, isLocalHost, ownOrigins, proofFor, sameSecret } from './http.ts';

const WEB = join(REPO, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const MAX_BODY = 100_000;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export function shellState(c: Config) {
  return {
    // Ports only: the page builds each URL on its own host, so every frame is same-site (not a blocked third party).
    notes: { port: c.silverbullet.port },
    projects: c.projects.map((p) => ({ name: p.name, label: p.label, boardPort: p.boardPort })),
    apps: c.apps.map((a) => ({ name: a.name, label: a.label ?? a.name, url: a.url })),
    appearance: c.appearance,
  };
}

class HttpError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg); this.code = code; }
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((ok, bad) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Too big: stop keeping it, drain the rest so the 413 reaches the client, then the connection closes.
      if (size > MAX_BODY) { if (size - c.length <= MAX_BODY) { chunks.length = 0; bad(new HttpError(413, 'request too large')); } return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { ok(s ? JSON.parse(s) : {}); } catch { bad(new HttpError(400, 'bad json')); }
    });
    req.on('error', () => bad(new HttpError(400, 'bad request')));
  });
}

const isJson = (req: IncomingMessage) => /^application\/json\b/i.test(String(req.headers['content-type'] ?? ''));

/** A call from this very page: exact own origin, a same-origin fetch, a JSON body (not a form another site can post). */
function fromOwnPage(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || !ownOrigins(req.socket.localPort ?? 0).includes(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  return isJson(req);
}

/** A call from an agent (bridge mod, CLI): the token, and no browser Origin. */
const fromAgent = (req: IncomingMessage, token: string) => req.headers.origin === undefined && sameSecret(req.headers['x-crewdeck-token'], token);

export function createShell(c: Config, requests = new Requests(), opts: { token: string }): Server {
  const send = (res: ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8') => {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, 'content-type': type };
    if (type.startsWith('text/html')) headers['content-security-policy'] = SHELL_CSP;
    if (code === 413) headers.connection = 'close';
    res.writeHead(code, headers);
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLocalHost(req.headers.host)) return send(res, 403, 'forbidden', 'text/plain');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'POST') {
      // The page's own endpoint: Ask Claude.
      if (path === '/api/requests') {
        if (!fromOwnPage(req)) throw new HttpError(403, 'forbidden');
        const b = await readJson(req);
        return json(res, 200, requests.add(String(b.lane), String(b.text)));
      }
      // Agent endpoints.
      const agentPath = path === '/api/claim' || path === '/api/requeue' || /^\/api\/requests\/\d+\/(done|fail)$/.test(path);
      if (!agentPath) throw new HttpError(404, 'not found');
      if (!fromAgent(req, opts.token)) throw new HttpError(401, 'missing or wrong token');
      const b = await readJson(req);
      if (path === '/api/claim') {
        const nonce = String(b.nonce ?? '');
        if (!NONCE.test(nonce)) throw new HttpError(400, 'nonce required');
        const lane = laneFor(c, String(b.cwd ?? ''));
        // The CLI path lets the session close requests without knowing where Crewdeck is installed.
        return json(res, 200, { lane, cli: `node ${join(REPO, 'src', 'cli.ts')}`, proof: proofFor(opts.token, nonce), requests: requests.claim(lane, String(b.by ?? 'session')) });
      }
      if (path === '/api/requeue') return json(res, 200, { back: requests.requeue((b.ids ?? []).map(Number), String(b.by ?? 'session')) });
      const m = path.match(/^\/api\/requests\/(\d+)\/(done|fail)$/)!;
      return json(res, 200, requests.finish(Number(m[1]), String(b.result ?? ''), m[2] === 'fail'));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    if (path === '/api/state') return json(res, 200, shellState(c));
    if (path === '/api/requests') return json(res, 200, requests.list());
    if (path.startsWith('/api/')) throw new HttpError(404, 'not found');
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) return json(res, e.code, { error: e.message });
      if (e instanceof URIError) return json(res, 400, { error: 'bad path' });
      // Queue rules (bad lane, empty, limits) are the caller's to fix; anything else stays opaque.
      if (e instanceof Error && /lane|empty|too many|not open/.test(e.message)) return json(res, 400, { error: e.message });
      json(res, 500, { error: 'internal' });
    });
  });
}
