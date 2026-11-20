// Headless Chromium's only way out (design §14): an in-process HTTP proxy on 127.0.0.1 that applies netguard to every
// request the browser makes (plain HTTP, CONNECT tunnels for HTTPS and WebSockets, ws:// upgrades). Chromium is
// started with --proxy-server pointing here and --proxy-bypass-list=<-loopback>, so even loopback goes through the
// proxy, where it is refused. A form page can't reach this machine, the local network, or cloud metadata.
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { type Address, type NetOptions, checkHost } from './netguard.ts';
import { cleanHost, isLinkedinHost, isXHost } from '../fields.ts';

export type Blocked = { host: string; reason: string };
export type GuardProxy = { port: number; url: string; blocked: Blocked[]; allowed: number; close(): Promise<void> };
export type ProxyOptions = { net?: NetOptions; allowLinkedin?: boolean; denyAll?: boolean };

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

/** host:port from a CONNECT target ("example.com:443", "[::1]:443"). */
function target(s: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/** Connects to exactly the addresses that were checked: no second DNS answer between check and use. */
const pinned = (addrs: Address[]) => (_h: string, opts: any, cb: any) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (opts?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
};

export async function startGuardProxy(o: ProxyOptions = {}): Promise<GuardProxy> {
  const blocked: Blocked[] = [];
  const sockets = new Set<Duplex>();
  let allowed = 0;
  const track = (s: Duplex) => { sockets.add(s); s.on('close', () => sockets.delete(s)); return s; };

  async function admit(host: string): Promise<Address[]> {
    const h = cleanHost(host);
    try {
      if (o.denyAll) throw new Error('the network is off for this browser');
      if (isXHost(h)) throw new Error('X is never used');
      if (isLinkedinHost(h) && !o.allowLinkedin) throw new Error('LinkedIn is not opened by headless code');
      const addrs = await checkHost(h, o.net);
      allowed++;
      return addrs;
    } catch (e: any) {
      if (blocked.length < 500) blocked.push({ host: h, reason: e.message });
      throw e;
    }
  }

  const server = http.createServer(async (req, res) => {
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { res.writeHead(400).end('proxy requests only'); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end('http only (https goes through CONNECT)'); return; }
    let addrs: Address[];
    try { addrs = await admit(u.hostname); } catch (e: any) { res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by Crewdeck: ${e.message}`); return; }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    const up = http.request(u, { method: req.method, headers, lookup: pinned(addrs), agent: false } as any, (r) => {
      const h: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v;
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502).end('upstream error'); else res.destroy(); });
    req.pipe(up);
  });

  // HTTPS and wss://: a byte tunnel to a checked address.
  server.on('connect', async (req, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const t = target(req.url ?? '');
    if (!t) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    let addrs: Address[];
    try { addrs = await admit(t.host); } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = track(net.connect({ host: addrs[0].address, port: t.port }));
    up.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
    client.on('close', () => up.destroy());
  });

  // ws://: the upgrade request is replayed to a checked address, then bytes flow both ways.
  server.on('upgrade', async (req, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    let addrs: Address[];
    try { addrs = await admit(u.hostname); } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const up = track(net.connect({ host: addrs[0].address, port: Number(u.port) || 80 }));
    up.on('connect', () => {
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (!/^proxy-/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
  });
  server.on('connection', (s) => track(s));

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, url: `http://127.0.0.1:${port}`, blocked,
    get allowed() { return allowed; },
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

/** Chromium flags that send everything (loopback included) through the proxy and leave no UDP path around it. */
export const proxyArgs = (p: { url: string }) => [
  `--proxy-server=${p.url}`, '--proxy-bypass-list=<-loopback>', '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
];
