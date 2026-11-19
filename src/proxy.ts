// A small reverse proxy: HTTP and WebSocket pass-through to a local service, with an optional
// stylesheet injected into its HTML pages. Each tool (SilverBullet, every Backlog.md board) gets its own proxy port,
// so it has its own origin, and only this machine's pages on that same origin can change anything through it.
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { connect } from 'node:net';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { isLocalHost, isSafeMethod, originIsOwnOrAbsent } from './http.ts';

/**
 * target: a local TCP port, or a Unix socket (SilverBullet: no TCP port at all, only this user can open the socket's
 * folder). injectAt: 'start' (default) puts injectHead first in <head>; 'end' puts it last, after the page's own styles.
 */
export type Target = { host: string; port: number } | { socketPath: string };
export type ProxyOpts = { target: Target; injectHead?: string; injectAt?: 'start' | 'end' };

const isSocket = (t: Target): t is { socketPath: string } => 'socketPath' in t;
/** The Host header the upstream sees (a socket has no host: localhost, which SilverBullet expects). */
const upstreamHost = (t: Target) => (isSocket(t) ? 'localhost' : `${t.host}:${t.port}`);
const where = (t: Target) => (isSocket(t) ? { socketPath: t.socketPath } : { host: t.host, port: t.port });

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function decoder(enc: string | undefined) {
  if (enc === 'gzip') return createGunzip();
  if (enc === 'br') return createBrotliDecompress();
  if (enc === 'deflate') return createInflate();
  return null;
}

/** Forward one request; when the response is HTML and injectHead is set, insert it before </head>. */
export function forward(req: IncomingMessage, res: ServerResponse, o: ProxyOpts, path = req.url ?? '/') {
  const headers = { ...req.headers, host: upstreamHost(o.target) };
  // Ask for an uncompressed body only when we may rewrite it.
  if (o.injectHead) delete headers['accept-encoding'];
  const up = request({ ...where(o.target), method: req.method, path, headers }, (r) => {
    const type = String(r.headers['content-type'] ?? '');
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
    if (o.injectHead && type.includes('text/html')) {
      const chunks: Buffer[] = [];
      const dec = decoder(String(r.headers['content-encoding'] ?? ''));
      const src = dec ? r.pipe(dec) : r;
      src.on('data', (c: Buffer) => chunks.push(c));
      src.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        if (o.injectAt === 'end' && /<\/head>/i.test(html)) html = html.replace(/<\/head>/i, (m) => o.injectHead + m);
        else html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + o.injectHead) : o.injectHead + html;
        delete out['content-length']; delete out['content-encoding']; delete out['etag'];
        res.writeHead(r.statusCode ?? 200, out);
        res.end(html);
      });
      src.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      return;
    }
    res.writeHead(r.statusCode ?? 200, out);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('starting up… refresh in a moment'); });
  req.pipe(up);
}

/** Pass a WebSocket (or any Upgrade) through untouched. */
export function forwardUpgrade(req: IncomingMessage, socket: any, head: Buffer, o: ProxyOpts, path = req.url ?? '/') {
  const t = o.target;
  const up = connect(isSocket(t) ? { path: t.socketPath } : { port: t.port, host: t.host }, () => {
    const lines = [`${req.method} ${path} HTTP/${req.httpVersion}`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${k === 'host' ? upstreamHost(t) : v}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close); socket.on('error', close);
}

/**
 * A whole-server proxy (one port per tool). Answers only to this machine's host names (DNS rebinding), and lets a
 * request change something (POST/PUT/DELETE…, WebSockets) only from this port's own pages or from a non-browser client.
 */
export function createProxy(o: ProxyOpts): Server {
  const s = createServer((req, res) => {
    if (!isLocalHost(req.headers.host)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!isSafeMethod(req.method) && !originIsOwnOrAbsent(req)) { res.writeHead(403); res.end('forbidden'); return; }
    forward(req, res, o);
  });
  s.on('upgrade', (req, socket, head) => {
    if (!isLocalHost(req.headers.host) || !originIsOwnOrAbsent(req)) { socket.destroy(); return; }
    forwardUpgrade(req, socket, head, o);
  });
  s.on('clientError', (_e, socket) => socket.destroy());
  return s;
}
