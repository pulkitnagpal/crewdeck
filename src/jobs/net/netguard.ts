// The only way Jobs code fetches a web page (design §14, SSRF). A pasted link is the user's, but the page behind it and
// every redirect is not: nothing may reach this machine, its network, or cloud metadata. So: http(s) only; DNS is
// resolved inside the connect (Node's `lookup` hook) and every address is checked, then the socket connects to a
// checked address; redirects are followed by hand (≤ 5), each checked again; one deadline covers DNS, redirects and the
// body; the body is capped after decoding (gzip bombs); proxy environment variables are never used.
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

export type Address = { address: string; family: 4 | 6 };
/**
 * Test injection only (never from config, env or the command line): `resolve` replaces DNS, `testHosts` maps a fixture
 * name to a local address that is exempt from the block list (a local "public" site).
 */
export type NetOptions = { resolve?: (host: string) => Promise<Address[]>; testHosts?: Record<string, string> };
export type FetchOptions = NetOptions & {
  timeoutMs?: number; maxBytes?: number; maxRedirects?: number; redirect?: 'follow' | 'manual';
  headers?: Record<string, string>;
  /** GET (default), HEAD or POST; a POST body is sent as is (the providers' fetches, through the sandbox's parent) */
  method?: 'GET' | 'HEAD' | 'POST' | string; body?: Buffer;
};
export type Fetched = { status: number; statusText?: string; url: string; headers: http.IncomingHttpHeaders; body: string; redirects: string[]; /** the decoded body's bytes (hashes) */ bytes?: Buffer };

export type NetErrorCode = 'blocked' | 'scheme' | 'timeout' | 'too_large' | 'redirects' | 'dns' | 'network';
export class NetError extends Error {
  code: NetErrorCode;
  constructor(code: NetErrorCode, message: string) { super(message); this.code = code; this.name = 'NetError'; }
}

export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 2_000_000;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// ---- addresses ----
// Two lists: a BlockList also matches IPv4 addresses against IPv6 rules in their mapped form, so one list holding
// ::ffff:0:0/96 would block every IPv4 address.
const V4 = new BlockList(), V6 = new BlockList();
// 192.0.0/24 (IETF protocol assignments), 198.18/15 (benchmarking) and the three documentation nets are never public sites.
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) V4.addSubnet(net, bits, 'ipv4');
// ::/96 covers ::/128, ::1 and the IPv4-compatible forms; ::ffff:0:0/96 the IPv4-mapped ones and ::ffff:0:0:0/96 the
// IPv4-translated ones (SIIT); 64:ff9b::/96 and 64:ff9b:1::/48 are NAT64 (an IPv4 address behind them may be private).
for (const [net, bits] of [['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
  ['64:ff9b:1::', 48], ['2002::', 16], ['2001:db8::', 32]] as const) V6.addSubnet(net, bits, 'ipv6');

/** True for any address a fetched page must never reach (also anything that isn't an IP address). */
export function isBlockedAddress(ip: string): boolean {
  const a = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v = isIP(a);
  if (v === 4) return V4.check(a, 'ipv4');
  if (v === 6) return V6.check(a, 'ipv6');
  return true;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

/** Every address of a host, checked: refuses the host if any one is blocked (or it has none). */
export async function checkHost(host: string, net: NetOptions = {}): Promise<Address[]> {
  const h = bare(host);
  const fixed = net.testHosts?.[h];
  if (fixed) return [{ address: fixed, family: isIP(fixed) === 6 ? 6 : 4 }];
  const v = isIP(h);
  if (v) {
    if (isBlockedAddress(h)) throw new NetError('blocked', `${host} is a private or local address: refused`);
    return [{ address: h, family: v as 4 | 6 }];
  }
  if (h === 'localhost' || h.endsWith('.localhost')) throw new NetError('blocked', `${host} is this machine: refused`);
  let addrs: Address[];
  try {
    addrs = net.resolve ? await net.resolve(h) : (await dnsLookup(h, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
  } catch (e: any) { throw new NetError('dns', `${host} could not be found (${e?.code ?? e?.message ?? 'DNS error'})`); }
  if (!addrs.length) throw new NetError('dns', `${host} has no addresses`);
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new NetError('blocked', `${host} points to a private or local address (${bad.address}): refused`);
  return addrs;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | Address[], family?: number) => void;
/** A `lookup` for net.connect/http.request: resolves and checks inside the connect, so the socket uses what was checked. */
export function guardedLookup(net: NetOptions = {}) {
  return (host: string, opts: any, cb: LookupCb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    checkHost(host, net).then((addrs) => {
      const fam = opts?.family === 4 || opts?.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
      if (!fam.length) return cb(Object.assign(new Error(`${host}: no IPv${opts.family} address`), { code: 'ENOTFOUND' }));
      if (opts?.all) cb(null, fam);
      else cb(null, fam[0].address, fam[0].family);
    }, (e) => cb(Object.assign(e, { code: e.code === 'blocked' ? 'EBLOCKED' : 'ENOTFOUND', netCode: e.code })));
  };
}

/** A URL a guarded fetch may open: http(s), no credentials. */
export function checkScheme(raw: string | URL): URL {
  let u: URL;
  try { u = new URL(String(raw)); } catch { throw new NetError('scheme', 'not a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new NetError('scheme', `${u.protocol} links are not fetched (http and https only)`);
  if (u.username || u.password) throw new NetError('scheme', 'web addresses with a user name or password are not fetched');
  return u;
}

function decoder(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip());
  if (enc === 'deflate') return res.pipe(createInflate());
  if (enc === 'br') return res.pipe(createBrotliDecompress());
  return res;
}

function charsetOf(ct: string | undefined): string {
  const m = /charset\s*=\s*"?([\w-]+)/i.exec(ct ?? '');
  try { return m ? new TextDecoder(m[1]).encoding : 'utf-8'; } catch { return 'utf-8'; }
}

/** One request (no redirects): resolves with the status, headers and the decoded, capped body. */
function once(u: URL, o: Required<Pick<FetchOptions, 'maxBytes'>> & FetchOptions, signal: AbortSignal): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const lookup = guardedLookup(o);
    // A fresh agent: never the global one (env proxies), never a pooled socket from another host.
    const agent = new mod.Agent({ keepAlive: false, lookup } as any);
    const host = bare(u.hostname);
    const literal = isIP(host) && !o.testHosts?.[host];
    if (literal && isBlockedAddress(host)) return reject(new NetError('blocked', `${u.hostname} is a private or local address: refused`));
    if (signal.aborted) return reject(new NetError('timeout', 'timed out'));
    let req: http.ClientRequest;
    // The deadline covers the body too: on abort, whatever is in flight is destroyed and the promise settles.
    signal.addEventListener('abort', () => { req?.destroy(); agent.destroy(); reject(new NetError('timeout', 'timed out')); }, { once: true });
    const method = o.method ?? 'GET';
    req = mod.request(u, {
      method, agent, lookup, signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, deflate, br', ...o.headers,
        ...(o.body ? { 'content-length': String(o.body.length) } : {}) },
    } as any, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const body = decoder(res);
      const fail = (e: Error) => { res.destroy(); body.destroy(); reject(e); };
      body.on('data', (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) return fail(new NetError('too_large', `the page is larger than ${Math.round(o.maxBytes / 1e6)} MB: refused`));
        chunks.push(c);
      });
      body.on('end', () => {
        agent.destroy();
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', url: u.toString(), headers: res.headers, body: new TextDecoder(charsetOf(res.headers['content-type'])).decode(bytes), redirects: [], bytes });
      });
      body.on('error', (e) => fail(signal.aborted ? new NetError('timeout', 'timed out') : new NetError('network', `the page could not be read (${e.message})`)));
      res.on('error', (e) => fail(signal.aborted ? new NetError('timeout', 'timed out') : new NetError('network', e.message)));
    });
    req.on('error', (e: any) => {
      agent.destroy();
      if (signal.aborted) return reject(new NetError('timeout', 'timed out'));
      if (e?.netCode === 'blocked' || e?.code === 'EBLOCKED') return reject(new NetError('blocked', e.message));
      if (e instanceof NetError) return reject(e);
      if (e?.netCode === 'dns') return reject(new NetError('dns', e.message));
      reject(new NetError('network', `${u.host} could not be reached (${e?.code ?? e?.message})`));
    });
    req.end(o.body);
  });
}

/**
 * GET a page through the guard. `redirect: 'follow'` follows up to 5 redirects (each one checked again);
 * `manual` returns the 3xx as is. Throws NetError for anything refused, too slow or too large; any HTTP status is
 * returned (callers decide what 404 or 429 mean).
 */
export async function guardedFetch(raw: string | URL, opts: FetchOptions = {}): Promise<Fetched> {
  const set = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as FetchOptions;
  const o = { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, maxRedirects: MAX_REDIRECTS, redirect: 'follow' as const, ...set };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  const redirects: string[] = [];
  try {
    let u = checkScheme(raw);
    for (;;) {
      const r = await once(u, o, ctl.signal).catch((e) => { throw ctl.signal.aborted ? new NetError('timeout', `${u.host} did not answer within ${Math.round(o.timeoutMs / 1000)} s`) : e; });
      const loc = r.headers.location;
      if (o.redirect === 'manual' || r.status < 300 || r.status > 399 || r.status === 304 || !loc) return { ...r, redirects };
      if (redirects.length >= o.maxRedirects) throw new NetError('redirects', `more than ${o.maxRedirects} redirects: stopped`);
      let next: URL;
      try { next = new URL(String(loc), u); } catch { throw new NetError('scheme', 'a redirect went to something that is not a web address'); }
      u = checkScheme(next);
      // As browsers do: 303, and 301/302 after a POST, continue as a GET without the body; 307/308 keep both.
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && o.method === 'POST')) Object.assign(o, { method: 'GET', body: undefined });
      redirects.push(u.toString());
    }
  } finally { clearTimeout(timer); }
}
