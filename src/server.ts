// The shell: one page with a nav rail and frames for Notes (SilverBullet) and each project's Board
// (Backlog.md), plus a small JSON API. SilverBullet is proxied same-origin under /notes.
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { REPO, type Config } from './config.ts';
import { forward, forwardUpgrade } from './proxy.ts';

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

export function createShell(c: Config): Server {
  const sb = { host: '127.0.0.1', port: c.silverbullet.port };
  const local = (h?: string) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h ?? '');
  const s = createServer((req, res) => {
    const send = (code: number, body: string | Buffer, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (!local(req.headers.host)) return send(403, 'forbidden', 'text/plain');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/notes' ) { res.writeHead(302, { location: '/notes/' }); res.end(); return; }
    if (url.pathname.startsWith('/notes/')) return forward(req, res, { target: sb });
    if (url.pathname === '/api/state') return send(200, JSON.stringify(shellState(c)));
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
