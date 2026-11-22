// Local servers for the web tests: everything binds 127.0.0.1 on a random port. A fixture "public" site is reached
// through netguard's test-only `testHosts` (a made-up name mapped to 127.0.0.1); nothing here touches a real site.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { findBrowser } from '../../src/jobs/browser.ts';

export type Served = { port: number; hits: string[]; base: (host?: string) => string; close: () => Promise<void> };

export async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Served> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(req.url ?? ''); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port, hits,
    base: (host = '127.0.0.1') => `http://${host}:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Static pages by path. */
export function pages(map: Record<string, string | { status?: number; body?: string; headers?: Record<string, string> }>) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const p = map[(req.url ?? '').split('?')[0]] ?? map[req.url ?? ''];
    if (p === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    const o = typeof p === 'string' ? { body: p } : p;
    res.writeHead(o.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...o.headers }).end(o.body ?? '');
  };
}

/** The fixture host names the tests use, all pointing at the local server. */
export const testHosts = (...names: string[]) => Object.fromEntries(names.map((n) => [n, '127.0.0.1']));

export const BROWSER = findBrowser('auto');
/** Browser tests skip with a clear message only when no Chromium-based browser is installed. */
export const noBrowser = BROWSER && existsSync(BROWSER.path) ? false : 'no Chromium-based browser installed (Chrome, Chromium, Brave or Edge): browser tests skipped';
