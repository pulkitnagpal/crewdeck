// Checks every Crewdeck port shares: who may talk to a server that only this machine should reach.
import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** The Host header names this machine (blocks DNS rebinding: a page on evil.example resolving to 127.0.0.1). */
export const isLocalHost = (host?: string) => LOCAL_HOST.test(host ?? '');

/** The origins a page served by this very port can have. */
export const ownOrigins = (port: number) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];

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

/** What the server answers to a bridge's nonce, so the bridge knows it reached Crewdeck and not a port squatter. */
export const proofFor = (token: string, nonce: string) => createHash('sha256').update(`crewdeck-proof:${token}:${nonce}`).digest('hex');

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export const SHELL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  'frame-src http://localhost:* http://127.0.0.1:*', "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'self'",
].join('; ');
