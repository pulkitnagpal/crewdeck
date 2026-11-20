// The CLI's calls to the running Crewdeck server's agent endpoints: the token from ~/.crewdeck/token, no browser Origin.
// Challenge first: the CLI sends a nonce alone and checks the server's proof (bound to the port it dialled) before its
// token leaves the process, so a process squatting Crewdeck's port never sees the token.
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { loadConfig, readToken, TOKEN_PATH } from './config.ts';
import { proofFor, sameSecret } from './http.ts';

const TIMEOUT = 15_000;
/** Inside Claude's sandbox the CLI has no loopback: say how to run it so it is let out. */
const SANDBOX_HINT = 'If Claude ran this, run the crewdeck command on its own (no cd, &&, variables or redirects) so the jobs sandbox lets it reach Crewdeck.';

async function post(port: number, path: string, body: unknown, token?: string): Promise<Response> {
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'content-type': 'application/json', ...(token ? { 'x-crewdeck-token': token } : {}) },
    });
  } catch (e: any) {
    throw new Error(e?.name === 'TimeoutError' ? `Crewdeck on port ${port} did not answer in 15 s` : `Crewdeck is not running on port ${port}: start it with crewdeck up. ${SANDBOX_HINT}`);
  }
}

/**
 * A read of the running server as a local tool: node:http, not fetch. Node's fetch adds `Sec-Fetch-Mode: cors`, which
 * the server's reads take for a browser without Sec-Fetch-Site and refuse (W8), so `crewdeck requests` said
 * "forbidden" and `doctor` said Crewdeck wasn't running (found in P8's visual check). No token: these are page reads.
 */
export function localRead(port: number, path: string, timeout = TIMEOUT): Promise<{ status: number; json: any }> {
  return new Promise((ok, bad) => {
    const r = get({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, accept: 'application/json' }, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        ok({ status: res.statusCode ?? 0, json });
      });
      res.on('error', bad);
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    r.on('error', bad);
  });
}

/** The server on this port knows the token: checked before the token is sent anywhere. */
export async function verifyServer(port: number, token: string): Promise<void> {
  const nonce = randomBytes(16).toString('hex');
  const r = await post(port, '/api/hello', { nonce });
  const out = await r.json().catch(() => null) as any;
  if (!r.ok || !sameSecret(out?.proof, proofFor(token, nonce, port))) {
    throw new Error(`The server on port ${port} failed Crewdeck's identity check (not Crewdeck, or it restarted with a new token): nothing was sent. Restart Crewdeck with crewdeck up if this persists.`);
  }
}

export async function agentCall(path: string, body?: unknown): Promise<any> {
  const c = loadConfig();
  if (body === undefined) {
    let r: { status: number; json: any };
    try { r = await localRead(c.port, path); }
    catch (e: any) { throw new Error(e?.name === 'TimeoutError' ? `Crewdeck on port ${c.port} did not answer in 15 s` : `Crewdeck is not running on port ${c.port}: start it with crewdeck up`); }
    if (r.status < 200 || r.status > 299) throw new Error(r.json?.error ?? `HTTP ${r.status}`);
    return r.json;
  }
  const token = readToken();
  if (!token) throw new Error(`No token at ${TOKEN_PATH}: run crewdeck up once`);
  await verifyServer(c.port, token);
  // The folder this runs in decides the lane, as for the bridge's claims: a session closes only its own lane's requests.
  const r = await post(c.port, path, { ...(body as object), cwd: process.cwd() }, token);
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(out?.error ?? `HTTP ${r.status}`);
  return out;
}

/** A request's payload and context, for request-scoped commands (`--request <id>`). */
export async function showRequest(id: string | undefined): Promise<any> {
  if (!/^\d+$/.test(id ?? '')) throw new Error('--request needs a request id (a number)');
  return agentCall(`/api/requests/${Number(id)}/show`, {});
}
