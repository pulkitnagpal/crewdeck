// The shell: one page with a nav rail and frames for Notes (SilverBullet) and each project's Board
// (Backlog.md), plus a small JSON API. SilverBullet is proxied same-origin under /notes.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { REPO, type Config } from './config.ts';
import { forward, forwardUpgrade } from './proxy.ts';
import { Requests, laneFor } from './requests.ts';

const WEB = join(REPO, 'web');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function shellState(c: Config) {
  return {
    notes: '/notes/',
    // Ports only: the page builds each URL on its own host, so the board is same-site (not a blocked third party).
    projects: c.projects.map((p) => ({ name: p.name, label: p.label, boardPort: p.boardPort })),
    apps: c.apps.map((a) => ({ name: a.name, label: a.label ?? a.name, url: a.url })),
    appearance: c.appearance,
  };
}

function readJson(req: any): Promise<any> {
  return new Promise((ok, bad) => {
    let s = '';
    req.on('data', (c: Buffer) => { s += c; if (s.length > 100_000) { req.destroy(); bad(new Error('too big')); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}

export function createShell(c: Config, requests = new Requests()): Server {
  const sb = { host: '127.0.0.1', port: c.silverbullet.port };
  const local = (h?: string) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h ?? '');
  const s = createServer((req, res) => {
    const send = (code: number, body: string | Buffer, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (!local(req.headers.host)) return send(403, 'forbidden', 'text/plain');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/notes' ) { res.writeHead(302, { location: '/notes/' }); res.end(); return; }
    if (url.pathname.startsWith('/notes/')) return forward(req, res, { target: sb });
    if (url.pathname === '/api/state') return send(200, JSON.stringify(shellState(c)));
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      // Cross-site pages can't post here: no Origin (curl, the mod) or a local one only.
      if (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) return send(403, '{"error":"forbidden"}');
      return void readJson(req).then((b) => {
        try {
          if (url.pathname === '/api/requests') return send(200, JSON.stringify(requests.add(String(b.lane), String(b.text))));
          if (url.pathname === '/api/claim') {
            const lane = laneFor(c, String(b.cwd ?? ''));
            // The CLI path lets the session close requests without knowing where Crewdeck is installed.
            return send(200, JSON.stringify({ lane, cli: `node ${join(REPO, 'src', 'cli.ts')}`, requests: requests.claim(lane, String(b.by ?? 'session')) }));
          }
          if (url.pathname === '/api/requeue') return send(200, JSON.stringify({ back: requests.requeue((b.ids ?? []).map(Number), String(b.by ?? 'session')) }));
          const m = url.pathname.match(/^\/api\/requests\/(\d+)\/(done|fail)$/);
          if (m) return send(200, JSON.stringify(requests.finish(Number(m[1]), String(b.result ?? ''), m[2] === 'fail')));
          send(404, '{"error":"not found"}');
        } catch (e: any) { send(400, JSON.stringify({ error: e?.message ?? String(e) })); }
      }, () => send(400, '{"error":"bad json"}'));
    }
    if (url.pathname === '/api/requests') return send(200, JSON.stringify(requests.list()));
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(WEB, rel));
    if (!file.startsWith(WEB + sep) || !existsSync(file) || !statSync(file).isFile()) return send(404, 'not found', 'text/plain');
    send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
  });
  s.on('upgrade', (req, socket, head) => {
    if (!local(req.headers.host) || !(req.url ?? '').startsWith('/notes/')) { socket.destroy(); return; }
    forwardUpgrade(req, socket, head, { target: sb });
  });
  return s;
}
