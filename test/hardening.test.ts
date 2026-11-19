// Review pass A, the services Crewdeck reuses and the agent handshake:
// - W1: SilverBullet on a private Unix socket with its shell off, reached only through the Notes proxy (HTTP and
//   WebSockets), checked against the real binary when it is installed;
// - W2: Backlog.md boards on random internal ports, never shown to pages;
// - W4: the CLI checks the server's port-bound proof before its token leaves; the token rotates on every start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxy } from '../src/proxy.ts';
import { freePort, notesSocketPath, silverbulletService } from '../src/services.ts';
import { createShell, shellState } from '../src/server.ts';
import { Requests } from '../src/requests.ts';
import { verifyServer } from '../src/agent-client.ts';
import { rotateToken, readToken, writeCliWrapper } from '../src/config.ts';

const listen = (s: Server, where: number | string = 0) => new Promise<void>((r) => (typeof where === 'string' ? s.listen(where, r) : s.listen(where, '127.0.0.1', r)));
const portOf = (s: Server) => (s.address() as any).port as number;
const tmp = (p: string) => mkdtempSync(join(realpathSync(tmpdir()), p));

test('W1: the Notes socket lives in a private folder (a short temp one when the home path is too long)', () => {
  const home = tmp('cdsock-');
  const p = notesSocketPath(home);
  assert.equal(p, join(home, 'run', 'notes.sock'));
  assert.equal(statSync(join(home, 'run')).mode & 0o777, 0o700);
  const long = join(home, 'x'.repeat(120));
  mkdirSync(long);
  const q = notesSocketPath(long);
  assert.ok(Buffer.byteLength(q) <= 100, q);
  assert.equal(statSync(join(q, '..')).mode & 0o777, 0o700);
  const svc = silverbulletService('/bin/sb', '/vault', p);
  assert.deepEqual(svc.args, ['--single', '/vault'], 'no -p: no TCP port at all');
  assert.deepEqual(svc.env, { SB_UNIX_SOCKET: p, SB_SHELL_BACKEND: 'off' });
});

test('W1: the proxy reaches a Unix-socket upstream for pages, API calls and WebSockets; Host and Origin checks still apply', async () => {
  const dir = tmp('cdup-');
  const sock = join(dir, 'u.sock');
  const upstream = createServer((req, res) => {
    if (req.url === '/api') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ host: req.headers.host, method: req.method })); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>notes</body></html>');
  });
  upstream.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n'); socket.end(); });
  await listen(upstream, sock);
  const proxy = createProxy({ target: { socketPath: sock }, injectHead: '<style>#n{}</style>', injectAt: 'end' });
  await listen(proxy);
  const p = portOf(proxy);
  try {
    assert.match(await (await fetch(`http://127.0.0.1:${p}/`)).text(), /<style>#n\{\}<\/style><\/head>/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${p}/api`, { method: 'POST' })).json(), { host: 'localhost', method: 'POST' });
    const upgrade = (origin?: string) => new Promise<string>((r) => {
      const req = request({ host: '127.0.0.1', port: p, path: '/ws', headers: { host: `localhost:${p}`, connection: 'upgrade', upgrade: 'websocket', ...(origin ? { origin } : {}) } });
      req.on('upgrade', (_res, s) => { s.destroy(); r('upgraded'); }); req.on('error', () => r('refused')); req.on('response', () => r('response')); req.end();
    });
    assert.equal(await upgrade(`http://localhost:${p}`), 'upgraded');
    assert.equal(await upgrade('https://evil.example'), 'refused');
    const cross = await fetch(`http://127.0.0.1:${p}/api`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
  } finally { proxy.close(); upstream.close(); }
});

/** The real SilverBullet binary when installed (read and run only, with a temp space): CREWDECK_SB_BIN or ~/.crewdeck/bin. */
const SB = [process.env.CREWDECK_SB_BIN, join(homedir(), '.crewdeck', 'bin', process.platform === 'win32' ? 'silverbullet.exe' : 'silverbullet')].find((p) => p && existsSync(p));

test('W1: the real SilverBullet runs on the socket only, with shell commands disabled, and Notes works through the proxy', { skip: SB ? false : 'SilverBullet is not installed (crewdeck init downloads it): the socket and shell-off checks against the real binary are skipped' }, async () => {
  const root = tmp('cdsb-');
  const space = join(root, 'space');
  mkdirSync(space);
  writeFileSync(join(space, 'index.md'), '# Example notes\n');
  const sock = notesSocketPath(root);
  const svc = silverbulletService(SB!, space, sock);
  svc.before?.();
  const child = spawn(svc.cmd, svc.args, { env: { ...process.env, ...svc.env }, stdio: 'ignore' });
  const proxy = createProxy({ target: { socketPath: sock } });
  try {
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(sock), 'SilverBullet made its socket');
    await listen(proxy);
    const p = portOf(proxy);
    const page = await fetch(`http://127.0.0.1:${p}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    // The shell backend is off: a command never runs, even from a request the proxy lets through.
    const marker = join(root, 'ran');
    const shell = await fetch(`http://127.0.0.1:${p}/.shell`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'touch', args: [marker] }) });
    assert.match(await shell.text(), /Shell commands are disabled/);
    assert.ok(!existsSync(marker), 'nothing ran');
    // No TCP port: the process listens on the socket only.
    const lsof = spawnSync('lsof', ['-a', '-p', String(child.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
    if (!lsof.error) assert.equal(lsof.stdout.trim().split('\n').filter((l) => l.startsWith('n')).length, 0, `no TCP listener: ${lsof.stdout}`);
  } finally { proxy.close(); child.kill('SIGTERM'); }
});

test('W2: each board gets a system-chosen internal port; pages are told only the public proxy ports', async () => {
  const a = await freePort(), b = await freePort();
  assert.ok(a > 0 && b > 0);
  const c: any = { port: 4848, silverbullet: { port: 4849 }, projects: [{ name: 'myapp', label: 'Board', boardPort: 4858, path: '/code/myapp' }], apps: [], appearance: 'auto', jobs: { enabled: false } };
  const st = shellState(c);
  assert.deepEqual(st.projects, [{ name: 'myapp', label: 'Board', boardPort: 4858 }]);
  assert.deepEqual(st.notes, { port: 4849 });
  assert.doesNotMatch(JSON.stringify(st), /4958|4949|sock/, 'no internal port or socket');
});

test('W4: the CLI checks a port-bound proof before its token leaves; a squatter or a relay never sees the token', async () => {
  const TOKEN = 'f'.repeat(64);
  const shell = createShell({ port: 0, vault: '/tmp/v', silverbullet: { port: 4849 }, projects: [], apps: [], appearance: 'light' } as any, new Requests(join(tmp('cdq-'), 'r.json')), { token: TOKEN });
  await listen(shell);
  const real = portOf(shell);
  const seen: string[] = [];
  // A squatter answering with a made-up proof, and a relay forwarding the nonce to the real Crewdeck on another port.
  const fake = (relay: boolean) => createServer(async (req, res) => {
    if (req.headers['x-crewdeck-token']) seen.push(String(req.headers['x-crewdeck-token']));
    let body = ''; for await (const c of req) body += c;
    if (relay) {
      const r = await fetch(`http://127.0.0.1:${real}${req.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ proof: '0'.repeat(64) }));
  });
  const squat = fake(false), relay = fake(true);
  await listen(squat); await listen(relay);
  try {
    await verifyServer(real, TOKEN);
    await assert.rejects(verifyServer(portOf(squat), TOKEN), /failed Crewdeck's identity check/);
    await assert.rejects(verifyServer(portOf(relay), TOKEN), /failed Crewdeck's identity check/, 'a proof for another port');
    assert.deepEqual(seen, [], 'the token never left');
  } finally { shell.close(); squat.close(); relay.close(); }
});

test('W4: a new token on every start (0600); the CLI wrapper runs this checkout with this home', () => {
  const home = tmp('cdtok-');
  const a = rotateToken(join(home, 'token')), b = rotateToken(join(home, 'token'));
  assert.notEqual(a, b);
  assert.equal(readToken(join(home, 'token')), b);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
  const w = writeCliWrapper(join(home, 'bin', 'crewdeck'), home);
  assert.equal(statSync(w).mode & 0o777, 0o700);
  assert.ok(readFileSync(w, 'utf8').includes(`CREWDECK_HOME='${home}'`));
  const r = spawnSync(w, [], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: crewdeck init/);
});
