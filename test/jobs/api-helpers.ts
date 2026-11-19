// A Crewdeck shell with Jobs switched on, over a fictional person's temp vault and tracker, for API tests.
import { request } from 'node:http';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { FEATURE_DEFAULTS, type Config, type JobsFeatures } from '../../src/config.ts';
import { createShell } from '../../src/server.ts';
import { Requests } from '../../src/requests.ts';
import { notesOf } from '../../src/jobs/ctx.ts';
import { storeFormFields } from '../../src/jobs/kb/questions.ts';
import { prepareDraft } from '../../src/jobs/draft/draft.ts';
import type { JobsApiOptions } from '../../src/jobs/api.ts';
import { type PEOPLE, role, world } from './helpers.ts';

export const TOKEN = 'c'.repeat(64);
export type Res = { status: number; headers: Record<string, any>; body: string; json: any };

export async function jobsServer(person: keyof typeof PEOPLE = 'example', o: { features?: Partial<JobsFeatures>; api?: JobsApiOptions; enabled?: boolean } = {}) {
  const w = world(person, { features: o.features });
  const workspace = join(w.root, 'jobs-workspace');
  mkdirSync(workspace);
  const c: Config = {
    port: 0, vault: w.vault, silverbullet: { port: 4849, version: 'x' }, projects: [{ name: 'myapp', path: join(w.root, 'code') , label: 'Board', boardPort: 4858 }], apps: [], appearance: 'light',
    jobs: { enabled: o.enabled ?? true, home: w.jobsHome, workspace, browser: 'auto', fetch_every: '12h', features: { ...FEATURE_DEFAULTS, ...(o.features ?? {}) } },
  };
  const q = new Requests(join(w.home, 'requests.json'));
  const server = createShell(c, q, { token: TOKEN, jobs: { configPath: join(w.home, 'config.yaml'), pollMs: 50, browser: () => ({ name: 'Test Browser', path: '/x' }), confirm: async () => 'yes', codeFile: join(w.home, 'feature-code.json'), ...o.api } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port as number;
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> => new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        ok({ status: res.statusCode!, headers: res.headers, body: text, json });
      });
    });
    r.on('error', bad);
    r.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const page = (): Record<string, string> => ({ origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
  const agent = (): Record<string, string> => ({ 'x-crewdeck-token': TOKEN, 'content-type': 'application/json' });
  const action = (name: string, body: unknown = {}, headers = page()) => call('POST', `/api/jobs/action/${name}`, headers, body);
  const get = (path: string, headers: Record<string, string> = {}) => call('GET', `/api/jobs/${path}`, headers);
  const claim = (cwd = workspace) => call('POST', '/api/claim', agent(), { cwd, by: 'session@test', nonce: 'n'.repeat(24) });
  const close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return { w, c, q, server, port, workspace, call, page, agent, action, get, claim, close };
}

/** A picked role with a read form: name and email from the profile, and one required written question. */
export function preparedRole(w: ReturnType<typeof world>, company: string, extra: { url?: string; firstTime?: boolean } = {}) {
  const id = role(w.ctx, { company, title: 'Senior Product Designer', ...(extra.url ? { url: extra.url } : {}) }, 'picked');
  storeFormFields(w.ctx.db, id, notesOf(w.ctx).profile.data, [
    { label: 'First name', kind: 'text', required: true }, { label: 'Email', kind: 'text', required: true },
    ...(extra.firstTime ? [{ label: 'Are you comfortable with occasional travel?', kind: 'radio', required: true, options: ['Yes', 'No'] }] : []),
  ]);
  prepareDraft(w.ctx, id);
  return id;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
