// The CLI's calls to the running Crewdeck server's agent endpoints: the token from ~/.crewdeck/token, no browser Origin.
import { loadConfig, readToken, TOKEN_PATH } from './config.ts';

export async function agentCall(path: string, body?: unknown): Promise<any> {
  const c = loadConfig();
  const token = readToken();
  if (body !== undefined && !token) throw new Error(`No token at ${TOKEN_PATH}: run crewdeck up once`);
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${c.port}${path}`, body !== undefined
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-crewdeck-token': token! }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }
      : { signal: AbortSignal.timeout(15_000) });
  } catch (e: any) { throw new Error(e?.name === 'TimeoutError' ? `Crewdeck on port ${c.port} did not answer in 15 s` : `Crewdeck is not running on port ${c.port}: start it with crewdeck up`); }
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new Error(out?.error ?? `HTTP ${r.status}`);
  return out;
}

/** A request's payload and context, for request-scoped commands (`--request <id>`). */
export async function showRequest(id: string | undefined): Promise<any> {
  if (!/^\d+$/.test(id ?? '')) throw new Error('--request needs a request id (a number)');
  return agentCall(`/api/requests/${Number(id)}/show`, {});
}
