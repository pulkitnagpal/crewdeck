// Checks every Crewdeck port shares: who may talk to a server that only this machine should reach.
import type { IncomingMessage, IncomingMessage as Req, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

/** The names every Crewdeck port answers to. `crewdeck.localhost` is the one people type (docs/everywhere.md E2): `*.localhost`
 * resolves to this machine in macOS and every Chromium with no hosts file, and a name can't be rebound to another IP. */
export const ADDRESS_NAME = 'crewdeck.localhost';
const BASE_NAMES = ['localhost', '127.0.0.1', '[::1]', ADDRESS_NAME];
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The address options in force (config `address`, set once at start): extra names from the hosts file, and the short form. */
let address: { short: boolean; names: string[] } = { short: false, names: [] };
export function useAddress(a: { short?: boolean; names?: string[] }) {
  const names = (a.names ?? []).map((n) => n.toLowerCase());
  for (const n of names) if (!NAME.test(n) || BASE_NAMES.includes(n)) throw new Error(`address.names: ${n} is not a host name Crewdeck can add`);
  address = { short: !!a.short, names };
}
const allNames = () => [...BASE_NAMES, ...address.names];

/** The Host header names this machine (blocks DNS rebinding: a page on evil.example resolving to 127.0.0.1). */
export function isLocalHost(host?: string): boolean {
  const m = /^(\[::1\]|[^:]+)(?::(\d{1,5}))?$/.exec(host ?? '');
  return !!m && allNames().includes(m[1].toLowerCase());
}

/** The origins a page served by this very port can have (with the short address, the port-less ones too: the redirect
 * from port 80 lands on this port, so the browser's origin has no port). */
export const ownOrigins = (port: number) => [
  ...allNames().map((n) => `http://${n}:${port}`),
  ...(address.short ? [ADDRESS_NAME, ...address.names].map((n) => `http://${n}`) : []),
];

/** No Origin (a tool, curl, the server's own page on GET) or exactly this port's own origin. */
export function originIsOwnOrAbsent(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  return o === undefined || ownOrigins(req.socket.localPort ?? 0).includes(o);
}

/** Methods that change nothing: other origins can't read the answer anyway (no CORS headers anywhere). */
export const isSafeMethod = (m?: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';

/** Constant-time comparison of a presented secret with the expected one. */
export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What the server answers to a client's nonce (POST /api/hello, before any token is sent), so the bridge and the CLI know
 * they reached Crewdeck and not a port squatter. The port is in it: a squatter relaying the nonce to Crewdeck on another
 * port gets a proof for that port, which the client refuses.
 */
export const proofFor = (token: string, nonce: string, port: number) => createHash('sha256').update(`crewdeck-proof:${token}:${nonce}:${port}`).digest('hex');
export const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

/** The shell's CSP: its frames (Notes, boards, apps) are other ports of the names this machine answers to. */
export const shellCsp = () => [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  `frame-src 'self' ${['localhost', '127.0.0.1', ADDRESS_NAME, ...address.names].map((n) => `http://${n}:*`).join(' ')}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
].join('; ');

// ---- shared by the shell server and the Jobs API ----

export const MAX_BODY = 100_000;

export class HttpError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg); this.code = code; }
}

export function send(res: ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, 'content-type': type, ...extra };
  if (type.startsWith('text/html') && !headers['content-security-policy']) headers['content-security-policy'] = shellCsp();
  if (code === 413) headers.connection = 'close';
  res.writeHead(code, headers);
  res.end(body);
}
export const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v));

export function readJson(req: Req): Promise<any> {
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
      let v: unknown;
      try { v = s ? JSON.parse(s) : {}; } catch { return bad(new HttpError(400, 'bad json')); }
      // Every endpoint takes a map: null, a list or a number is the caller's mistake, never a 500.
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(new HttpError(400, 'a JSON object is expected'));
      ok(v);
    });
    req.on('error', () => bad(new HttpError(400, 'bad request')));
  });
}

const isJson = (req: Req) => /^application\/json\b/i.test(String(req.headers['content-type'] ?? ''));

/**
 * A call from this very page: exact own origin, a same-origin fetch (every browser Crewdeck supports sends
 * Sec-Fetch-Site), a JSON body (not a form another site can post). A local process can forge all three: the jobs
 * workspace's sandbox keeps Claude's shell off loopback, and risky switches also need a native confirmation (README).
 */
export function fromOwnPage(req: Req): boolean {
  const origin = req.headers.origin;
  if (!origin || !ownOrigins(req.socket.localPort ?? 0).includes(origin)) return false;
  if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
  return isJson(req);
}

/** A call from an agent (bridge mod, CLI): the token, and no browser Origin. */
export const fromAgent = (req: Req, token: string) => req.headers.origin === undefined && sameSecret(req.headers['x-crewdeck-token'], token);

/** Sent by a browser: browsers add Fetch Metadata (and an Origin on posts); tools like curl or the CLI send neither. */
export const fromBrowser = (req: Req) => req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined || req.headers['sec-fetch-dest'] !== undefined || req.headers.origin !== undefined;

/**
 * A GET of the user's data: from this origin's own pages, or typed in the address bar; never fetched by another site.
 * A browser must say so with Sec-Fetch-Site; a request without any Fetch Metadata is a local tool (the CLI, curl).
 */
export function ownRead(req: Req): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === undefined) return !fromBrowser(req);
  return site === 'same-origin' || site === 'none';
}

/** The Jobs page's CSP: like the shell's, plus its one inline importmap (by hash) and same-origin frames (the resume). */
export const jobsCsp = (importmapHash: string) => [
  "default-src 'self'", `script-src 'self' 'sha256-${importmapHash}'`, "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "frame-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
].join('; ');
