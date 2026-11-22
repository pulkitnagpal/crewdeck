import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShell } from '../src/server.ts';
import { Requests } from '../src/requests.ts';
import { proofFor } from '../src/http.ts';

const TOKEN = 'a'.repeat(64);
let port = 0;
let server: any;
const c: any = { port: 0, vault: '/tmp/v', silverbullet: { port: 4849 }, projects: [{ name: 'myapp', path: '/code/myapp', label: 'Board', boardPort: 4858 }], apps: [], appearance: 'light' };

type Res = { status: number; headers: Record<string, any>; body: string };
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    r.on('error', bad);
    r.end(body);
  });
}
const page = () => ({ origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });
const agent = (t = TOKEN) => ({ 'x-crewdeck-token': t, 'content-type': 'application/json' });
const ask = (h: Record<string, string>, text = 'plan my week') => call('POST', '/api/requests', h, JSON.stringify({ lane: 'cockpit', text }));

before(async () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cds-')), 'requests.json'));
  server = createShell(c, q, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('a malformed path is a 400 and the server keeps serving', async () => {
  assert.equal((await call('GET', '/%')).status, 400);
  assert.equal((await call('GET', '/api/state')).status, 200);
});

test('only this machine\'s host names: localhost, 127.0.0.1 and [::1]', async () => {
  assert.equal((await call('GET', '/api/state', { host: 'evil.example' })).status, 403);
  assert.equal((await call('GET', '/api/state', { host: `[::1]:${port}` })).status, 200);
  assert.equal((await call('GET', '/api/state', { host: `127.0.0.1:${port}` })).status, 200);
});

test('state gives Notes its own port, never a path on this origin', async () => {
  const s = JSON.parse((await call('GET', '/api/state')).body);
  assert.deepEqual(s.notes, { port: 4849 });
  assert.equal((await call('GET', '/notes/')).status, 404);
});

test('HTML gets a strict CSP; every answer gets nosniff and no CORS header', async () => {
  const r = await call('GET', '/');
  assert.match(r.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('Ask Claude: only the page itself can queue a request', async () => {
  assert.equal((await ask(page())).status, 200);
  assert.equal((await ask({ 'content-type': 'application/json' })).status, 403, 'no Origin (curl, a local process)');
  assert.equal((await ask({ ...page(), origin: 'http://localhost:4747' })).status, 403, 'another local app');
  assert.equal((await ask({ ...page(), origin: 'https://evil.example' })).status, 403, 'another site');
  assert.equal((await ask({ ...page(), 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await ask({ ...page(), 'content-type': 'text/plain' })).status, 403, 'a form post');
  assert.equal((await ask({ ...page(), 'x-crewdeck-token': TOKEN, origin: 'http://localhost:1' })).status, 403, 'a token does not make a page');
});

test('agent endpoints need the token and refuse anything a browser sends', async () => {
  const claim = (h: Record<string, string>) => call('POST', '/api/claim', h, JSON.stringify({ cwd: '/code/myapp', by: 's1', nonce: 'n'.repeat(20) }));
  assert.equal((await claim({ 'content-type': 'application/json' })).status, 401);
  assert.equal((await claim(agent('b'.repeat(64)))).status, 401);
  assert.equal((await claim({ ...agent(), origin: `http://localhost:${port}` })).status, 401, 'the page itself is not an agent');
  assert.equal((await call('POST', '/api/requests/1/done', { 'content-type': 'application/json' }, '{}')).status, 401);
  assert.equal((await call('POST', '/api/requeue', page(), '{"ids":[1]}')).status, 401);
});

test('a claim proves the server knows the token, and delivers only that lane', async () => {
  const id = JSON.parse((await call('POST', '/api/requests', page(), JSON.stringify({ lane: 'project:myapp', text: 'take TASK-3' }))).body).id;
  const nonce = 'abcdefghijklmnop1234';
  const r = JSON.parse((await call('POST', '/api/claim', agent(), JSON.stringify({ cwd: '/code/myapp', by: 's1', nonce }))).body);
  assert.equal(r.lane, 'project:myapp');
  assert.equal(r.proof, proofFor(TOKEN, nonce, port), 'bound to the port the bridge dialled');
  assert.deepEqual(r.requests.map((x: any) => x.id), [id]);
  assert.equal((await call('POST', '/api/claim', agent(), JSON.stringify({ cwd: '/x', nonce: 'short' }))).status, 400, 'nonce required');
  const done = await call('POST', `/api/requests/${id}/done`, agent(), JSON.stringify({ result: 'done!', cwd: '/code/myapp/src' }));
  assert.equal(JSON.parse(done.body).status, 'done');
  assert.equal((await call('POST', `/api/requests/${id}/done`, agent(), JSON.stringify({ cwd: '/code/myapp' }))).status, 400, 'not open any more');
});

test('oversized bodies and unknown endpoints are refused', async () => {
  assert.equal((await call('POST', '/api/requests', page(), JSON.stringify({ lane: 'cockpit', text: 'x'.repeat(200_000) }))).status, 413);
  assert.equal((await call('POST', '/api/whatever', agent(), '{}')).status, 404);
  assert.equal((await call('PUT', '/api/state')).status, 405);
  assert.equal((await call('POST', '/api/requests', page(), '{bad')).status, 400);
});

test('Jobs off: the shell never loads node:sqlite or the Jobs code', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `
    const { createShell } = await import('./src/server.ts');
    const { Requests } = await import('./src/requests.ts');
    const s = createShell({ port: 0, vault: '/tmp/v', silverbullet: { port: 4849 }, projects: [], apps: [], appearance: 'auto', jobs: { enabled: false } },
      new Requests(process.argv[1]), { token: 'a'.repeat(64) });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const port = s.address().port;
    for (const p of ['/', '/api/state', '/jobs/', '/api/jobs/state']) await fetch('http://127.0.0.1:' + port + p);
    s.close();
    console.log(JSON.stringify(process.moduleLoadList.filter((m) => /sqlite/.test(m))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(mkdtempSync(join(tmpdir(), 'cds-')), 'r.json')], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)!), []);
});

test('a claim tells the session its lane\'s hint; typed requests travel without their payload', async () => {
  const nonce = 'abcdefghijklmnop5678';
  const r = JSON.parse((await call('POST', '/api/claim', agent(), JSON.stringify({ cwd: '/elsewhere', by: 's9', nonce }))).body);
  assert.equal(r.lane, 'cockpit');
  assert.equal(r.hint, null);
  assert.equal((await call('POST', '/api/requests/999/show', agent(), '{}')).status, 404);
});

// ---- review pass A ----

test('W4: hello answers a nonce with a port-bound proof before any token is sent; a page cannot use it', async () => {
  const nonce = 'q'.repeat(24);
  const r = await call('POST', '/api/hello', { 'content-type': 'application/json' }, JSON.stringify({ nonce }));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).proof, proofFor(TOKEN, nonce, port));
  assert.notEqual(JSON.parse(r.body).proof, proofFor(TOKEN, nonce, port + 1), 'a relay to Crewdeck on another port gets another proof');
  assert.equal((await call('POST', '/api/hello', { 'content-type': 'application/json' }, '{"nonce":"x"}')).status, 400);
  assert.equal((await call('POST', '/api/hello', { ...page() }, JSON.stringify({ nonce }))).status, 403, 'never for a browser');
});

test('W5: a session reads and closes only its own lane\'s requests (the caller\'s folder decides)', async () => {
  const id = JSON.parse((await call('POST', '/api/requests', page(), JSON.stringify({ lane: 'project:myapp', text: 'take TASK-9' }))).body).id;
  await call('POST', '/api/claim', agent(), JSON.stringify({ cwd: '/code/myapp', by: 'w5', nonce: 'w'.repeat(20) }));
  for (const verb of ['show', 'progress', 'done', 'fail']) {
    const other = await call('POST', `/api/requests/${id}/${verb}`, agent(), JSON.stringify({ cwd: '/elsewhere', text: 'x', result: 'x' }));
    assert.equal(other.status, 403, `${verb} from the cockpit`);
    assert.match(JSON.parse(other.body).error, /belongs to the project:myapp lane/);
    assert.equal((await call('POST', `/api/requests/${id}/${verb}`, agent(), JSON.stringify({ text: 'x' }))).status, 400, `${verb} without a cwd`);
  }
  assert.equal((await call('POST', `/api/requests/${id}/show`, agent(), JSON.stringify({ cwd: '/code/myapp' }))).status, 200);
  assert.equal((await call('POST', `/api/requests/${id}/fail`, agent(), JSON.stringify({ cwd: '/code/myapp', result: 'no' }))).status, 200);
});

test('W3: the page\'s Ask needs Sec-Fetch-Site same-origin; W7: a null or list body is a 400, never a 500', async () => {
  const { 'sec-fetch-site': _, ...noSite } = page();
  assert.equal((await ask(noSite)).status, 403, 'a forged Origin without Fetch Metadata');
  assert.equal((await call('POST', '/api/requests', page(), 'null')).status, 400);
  assert.equal((await call('POST', '/api/requests', page(), '[1]')).status, 400);
  assert.equal((await call('POST', '/api/claim', agent(), 'null')).status, 400);
  assert.equal((await call('POST', '/api/hello', { 'content-type': 'application/json' }, '7')).status, 400);
});

test('W8: state and the request list are never read by another site', async () => {
  for (const p of ['/api/state', '/api/requests']) {
    assert.equal((await call('GET', p, { 'sec-fetch-site': 'cross-site' })).status, 403, p);
    assert.equal((await call('GET', p, { 'sec-fetch-site': 'same-site' })).status, 403, p);
    assert.equal((await call('GET', p, { origin: 'https://evil.example' })).status, 403, `${p}: a browser without Fetch Metadata`);
    assert.equal((await call('GET', p, { 'sec-fetch-site': 'same-origin' })).status, 200, p);
    assert.equal((await call('GET', p)).status, 200, `${p}: a local tool (the CLI)`);
  }
});

test('W6: inherited names are never commands, files or features', async () => {
  for (const p of ['/__proto__', '/constructor', '/jobs/__proto__', '/jobs/vendor/__proto__']) assert.notEqual((await call('GET', p)).status, 500, p);
  const { spawnSync } = await import('node:child_process');
  for (const cmd of ['constructor', '__proto__', 'toString']) {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), cmd], { encoding: 'utf8', env: { ...process.env, CREWDECK_HOME: mkdtempSync(join(tmpdir(), 'cdh-')) } });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stdout, /usage: crewdeck/);
  }
});
