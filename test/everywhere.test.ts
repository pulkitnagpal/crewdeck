// docs/everywhere.md: the crewdeck.localhost address, the background service, crewdeck open/up, the Today endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShell } from '../src/server.ts';
import { Requests } from '../src/requests.ts';
import { isLocalHost, ownOrigins, shellCsp, useAddress } from '../src/http.ts';
import { effectiveAddress, normaliseAddress, pageUrl } from '../src/config.ts';
import { servicePlan, installService, uninstallService, serviceNames, LABEL } from '../src/service.ts';
import { shortAddressPlan } from '../src/address.ts';
import { addTodo, setTodo, todosOf, ticketsOf, cleanTodo, localDate } from '../src/today.ts';

const TOKEN = 'b'.repeat(64);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

test('E2: crewdeck.localhost is one of this machine\'s names; nothing else is added', () => {
  useAddress({});
  for (const h of ['crewdeck.localhost', 'crewdeck.localhost:4848', 'CrewDeck.LocalHost:4848', 'localhost:4848', '127.0.0.1:1', '[::1]:4848']) assert.ok(isLocalHost(h), h);
  for (const h of ['evil.localhost', 'crewdeck.localhost.evil.example', 'crew.deck', 'crewdeck.localhost:abc', '', 'localhost:4848:1', 'xcrewdeck.localhost'])
    assert.ok(!isLocalHost(h), h);
  assert.ok(ownOrigins(4848).includes('http://crewdeck.localhost:4848'));
  assert.ok(!ownOrigins(4848).includes('http://crewdeck.localhost'), 'the port-less origin only with the short address');
  assert.match(shellCsp(), /frame-src 'self' http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* http:\/\/crewdeck\.localhost:\*/);
});

test('E3: extra names and the port-less origin only when the config says so', () => {
  useAddress({ short: true, names: ['crew.deck'] });
  try {
    assert.ok(isLocalHost('crew.deck'));
    assert.ok(ownOrigins(4848).includes('http://crewdeck.localhost'));
    assert.ok(ownOrigins(4848).includes('http://crew.deck'));
    assert.match(shellCsp(), /http:\/\/crew\.deck:\*/);
  } finally { useAddress({}); }
  assert.ok(!isLocalHost('crew.deck'));
  assert.throws(() => useAddress({ names: ['localhost'] }));
  assert.throws(() => normaliseAddress({ names: ['crewdeck.localhost'] }), /address.names/);
  assert.throws(() => normaliseAddress({ names: ['bad name'] }), /address.names/);
  assert.throws(() => normaliseAddress({ port: 80 }), /address.port: the shell port/);
  assert.throws(() => normaliseAddress({ host: 'x' }), /address.host: unknown/);
  assert.deepEqual(normaliseAddress(undefined), { short: false, names: [] });
  assert.equal(pageUrl({ port: 4848 }), 'http://crewdeck.localhost:4848');
  assert.equal(pageUrl({ port: 4848, address: { short: true, names: [], port: 4848 } }, '/#jobs'), 'http://crewdeck.localhost/#jobs');
  // The redirect was set up for another port: the page goes back to the address with the port (review #7).
  assert.equal(pageUrl({ port: 5000, address: { short: true, names: [], port: 4848 } }), 'http://crewdeck.localhost:5000');
  assert.deepEqual(effectiveAddress({ port: 5000, address: { short: true, names: ['crew.deck'], port: 4848 } }), { short: false, names: ['crew.deck'], port: 4848 });
});

test('E4: the LaunchAgent runs this Node, checkout and home, restarts after a crash, and logs to the home', () => {
  // The default home's service has the plain name; another home (a rehearsal, a second Crewdeck) never replaces it.
  assert.deepEqual(serviceNames('/h/.crewdeck', '/h'), { label: LABEL, unit: 'crewdeck.service' });
  const other = serviceNames('/tmp/x/home', '/h');
  assert.match(other.label, /^io\.crewdeck\.server\.[0-9a-f]{8}$/);
  assert.match(other.unit, /^crewdeck-[0-9a-f]{8}\.service$/);
  assert.match(servicePlan({ platform: 'darwin', home: '/tmp/x/home', userHome: '/h' }).file, /LaunchAgents\/io\.crewdeck\.server\.[0-9a-f]{8}\.plist$/);
  const p = servicePlan({ platform: 'darwin', home: '/h/.crewdeck', userHome: '/h', node: '/n/bin/node', repo: '/r & co' });
  assert.equal(p.kind, 'launchd');
  assert.equal(p.file, `/h/Library/LaunchAgents/${LABEL}.plist`);
  assert.match(p.text, /<string>\/n\/bin\/node<\/string><string>\/r &amp; co\/src\/cli\.ts<\/string><string>up<\/string>/);
  assert.match(p.text, /<key>CREWDECK_HOME<\/key><string>\/h\/\.crewdeck<\/string>/);
  assert.match(p.text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p.text, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(p.text, /\/h\/\.crewdeck\/logs\/service\.log/);
  const l = servicePlan({ platform: 'linux', home: '/h/.crewdeck', userHome: '/h', node: '/n/bin/node', repo: '/r' });
  assert.equal(l.kind, 'systemd');
  assert.match(l.text, /ExecStart="\/n\/bin\/node" "\/r\/src\/cli\.ts" up/);
  assert.match(l.text, /Restart=on-failure/);
  assert.throws(() => servicePlan({ platform: 'win32' }), /not supported/);
});

test('E4: install writes the file and starts it; uninstall stops it and removes exactly that file', () => {
  const dir = tmp('cds-svc-');
  const plan = { kind: 'launchd' as const, file: join(dir, 'LaunchAgents', `${LABEL}.plist`), text: '<plist/>', label: LABEL, unit: 'crewdeck.service' };
  const calls: string[] = [];
  const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(' ')); return ''; };
  installService({ plan, run });
  assert.equal(readFileSync(plan.file, 'utf8'), '<plist/>');
  assert.ok(calls.some((c) => /^launchctl bootstrap gui\/\d+ /.test(c)));
  calls.length = 0;
  installService({ plan, run });
  assert.ok(/^launchctl bootout gui\/\d+\/io\.crewdeck\.server$/.test(calls[0]), 'a second install reloads');
  uninstallService({ plan, run });
  assert.ok(!existsSync(plan.file));
  assert.match(uninstallService({ plan, run })[0], /not installed/);
});

test('E3: the short address is a loopback-only redirect the person installs with sudo; Crewdeck runs none of it', async () => {
  const p = shortAddressPlan({ port: 4848, name: 'crew.deck', platform: 'darwin', home: '/h/.crewdeck' });
  assert.equal(p.files[0].path, '/h/.crewdeck/system/pf.conf');
  assert.match(p.files[0].text, /^rdr pass on lo0 inet proto tcp from any to 127\.0\.0\.1 port 80 -> 127\.0\.0\.1 port 4848$/m);
  assert.doesNotMatch(p.files[0].text, /\ben0\b|0\.0\.0\.0|any to any/);
  assert.match(p.files[1].text, /<string>-a<\/string><string>com\.apple\/crewdeck<\/string>/);
  assert.ok(p.steps.every((s) => /^(sudo |echo |printf |crewdeck )/.test(s)));
  assert.ok(p.steps.some((s) => /127\.0\.0\.1 crew\.deck # crewdeck' \| sudo tee -a \/etc\/hosts/.test(s)));
  assert.equal(p.steps.at(-1), 'crewdeck address --short --name crew.deck --done');
  // Root loads the copies only after they match what Crewdeck wrote (review #3).
  const boot = p.steps.find((s) => s.includes('launchctl bootstrap'))!;
  assert.match(boot, /^printf .* \| shasum -a 256 -c - && sudo launchctl bootstrap system /);
  const { createHash } = await import('node:crypto');
  for (const f of p.files) assert.ok(boot.includes(createHash('sha256').update(f.text).digest('hex')), f.path);
  const u = shortAddressPlan({ port: 4848, undo: true, platform: 'darwin' });
  assert.ok(u.steps.some((s) => s === 'sudo pfctl -a com.apple/crewdeck -F all'));
  assert.ok(u.steps.some((s) => /sed -i '' '\/# crewdeck\$\/d' \/etc\/hosts/.test(s)));
  assert.throws(() => shortAddressPlan({ port: 4848, name: 'evil.localhost', platform: 'darwin' }));
  assert.throws(() => shortAddressPlan({ port: 4848, name: "a'b", platform: 'darwin' }));
  assert.throws(() => shortAddressPlan({ port: 4848, platform: 'linux' }), /macOS/);
});

test('E8: to-dos are the journal page\'s checkboxes; add goes under "## To do", tick names line and text', () => {
  const vault = tmp('cds-v-');
  const d = '2026-11-20';
  assert.deepEqual(todosOf(vault, d), []);
  addTodo(vault, d, 'Tweet for the day');
  assert.equal(readFileSync(join(vault, 'journal', `${d}.md`), 'utf8'), `# ${d}\n\n## To do\n- [ ] Tweet for the day\n`);
  // A page the person wrote: their lines stay as they are, the new one goes after the last checkbox under the heading.
  writeFileSync(join(vault, 'journal', `${d}.md`), `# ${d}\n\nMorning notes.\n\n## To do\n- [ ] one\n- [x] two\n\n## Log\n- met A\n`);
  addTodo(vault, d, '  three  ');
  assert.equal(readFileSync(join(vault, 'journal', `${d}.md`), 'utf8'), `# ${d}\n\nMorning notes.\n\n## To do\n- [ ] one\n- [x] two\n- [ ] three\n\n## Log\n- met A\n`);
  const list = todosOf(vault, d);
  assert.deepEqual(list.map((t) => [t.text, t.done]), [['one', false], ['two', true], ['three', false]]);
  setTodo(vault, d, list[0].line, 'one', true);
  assert.equal(todosOf(vault, d)[0].done, true);
  assert.throws(() => setTodo(vault, d, list[0].line, 'not one', false), /changed since/);
  assert.throws(() => setTodo(vault, d, 1, '# 2026-11-20', true), /changed since/);
  // A page with no heading gets one at the end.
  writeFileSync(join(vault, 'journal', '2026-11-21.md'), 'Just notes\n');
  addTodo(vault, '2026-11-21', 'x');
  assert.equal(readFileSync(join(vault, 'journal', '2026-11-21.md'), 'utf8'), 'Just notes\n\n## To do\n- [ ] x\n');
  for (const bad of ['', '   ', 'a\nb', 'a\r', 'x'.repeat(301), 5, null]) assert.throws(() => cleanTodo(bad), String(bad));
  assert.throws(() => todosOf(vault, '../../etc/passwd'), /YYYY-MM-DD/);
  assert.match(localDate(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('E9: open tickets from each board, in progress first, done ones left out', () => {
  const repo = tmp('cds-r-');
  mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
  const t = (n: string, id: string, title: string, status: string) => writeFileSync(join(repo, 'backlog', 'tasks', n), `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\n---\n\nbody\n`);
  t('task-1 - a.md', 'TASK-1', 'Write the README', 'To Do');
  t('task-2 - b.md', 'TASK-2', 'Fix login', 'In Progress');
  t('task-3 - c.md', 'TASK-3', 'Ship it', 'Done');
  writeFileSync(join(repo, 'backlog', 'tasks', 'broken.md'), '---\n: : :\n---\n');
  const out = ticketsOf([{ name: 'app', path: repo }, { name: 'none', path: join(repo, 'missing') }]);
  assert.deepEqual(out.tickets.map((x) => [x.id, x.status]), [['TASK-2', 'In Progress'], ['TASK-1', 'To Do']]);
  assert.equal(out.more, 0);
  assert.equal(ticketsOf([{ name: 'app', path: repo }], 1).more, 1);
});

let port = 0;
let server: any;
const vault = tmp('cds-tv-');
type Res = { status: number; body: any };
function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown, host?: string): Promise<Res> {
  return new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers: { host: host ?? `crewdeck.localhost:${port}`, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j: any = b; try { j = JSON.parse(b); } catch {} ok({ status: res.statusCode!, body: j }); });
    });
    r.on('error', bad);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const agent = { 'x-crewdeck-token': TOKEN, 'content-type': 'application/json' };

before(async () => {
  const c: any = { port: 0, vault, silverbullet: { port: 4849 }, projects: [], apps: [], appearance: 'light', jobs: { enabled: false }, address: { short: false, names: [] } };
  server = createShell(c, new Requests(join(tmp('cds-q-'), 'requests.json')), { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.close(); useAddress({}); });

test('E2: the page loads at crewdeck.localhost, and its own origin may post', async () => {
  assert.equal((await call('GET', '/')).status, 200);
  assert.equal((await call('GET', '/api/state', {}, undefined, `evil.example:${port}`)).status, 403);
  const page = { origin: `http://crewdeck.localhost:${port}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  assert.equal((await call('POST', '/api/requests', page, { lane: 'cockpit', text: 'hi' })).status, 200);
  assert.equal((await call('POST', '/api/requests', { ...page, origin: 'http://crewdeck.localhost' }, { lane: 'cockpit', text: 'hi' })).status, 403, 'no port-less origin without the short address');
});

test('E7: the Today endpoints need the token and never a browser', async () => {
  assert.equal((await call('POST', '/api/today', { 'content-type': 'application/json' }, {})).status, 401);
  assert.equal((await call('POST', '/api/today', { ...agent, 'x-crewdeck-token': 'c'.repeat(64) }, {})).status, 401);
  assert.equal((await call('POST', '/api/today', { ...agent, origin: `http://crewdeck.localhost:${port}` }, {})).status, 401, 'a page cannot use the token');
  const r = await call('POST', '/api/today', agent, { date: '2026-11-20' });
  assert.equal(r.status, 200);
  assert.deepEqual({ ...r.body, url: undefined }, { date: '2026-11-20', url: undefined, notes_page: 'journal/2026-11-20', todos: [], jobs: null, tickets: [], more: 0, projects: [] });
  assert.match(r.body.url, /^http:\/\/crewdeck\.localhost:\d+$/);
  const added = await call('POST', '/api/today/todo', agent, { date: '2026-11-20', op: 'add', text: 'Apply for 5 jobs through Crewdeck' });
  assert.deepEqual(added.body.todos, [{ line: 4, done: false, text: 'Apply for 5 jobs through Crewdeck' }]);
  const ticked = await call('POST', '/api/today/todo', agent, { date: '2026-11-20', op: 'set', line: 4, text: 'Apply for 5 jobs through Crewdeck', done: true });
  assert.equal(ticked.body.todos[0].done, true);
  assert.equal((await call('POST', '/api/today/todo', agent, { date: '2026-11-20', op: 'set', line: 4, text: 'other', done: false })).status, 400);
  assert.equal((await call('POST', '/api/today/todo', agent, { date: '2026-11-20', op: 'add', text: 'a\nb' })).status, 400);
  assert.equal((await call('POST', '/api/today/todo', agent, { date: '../x', op: 'add', text: 'a' })).status, 400);
  assert.equal((await call('POST', '/api/today/todo', agent, { op: 'rm' })).status, 400);
  assert.equal((await call('POST', '/api/today', agent, {})).body.date, localDate());
});

test('review #1: one start per home; a lock whose process is gone is taken over', async () => {
  const { takeStartLock } = await import('../src/service.ts');
  const { spawn } = await import('node:child_process');
  const home = tmp('cds-lock-');
  const holder = spawn(process.execPath, ['--input-type=module', '-e',
    `const { takeStartLock } = await import(${JSON.stringify(new URL('../src/service.ts', import.meta.url).href)}); console.log(takeStartLock(${JSON.stringify(home)})); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CREWDECK_HOME: home } });
  const first = await new Promise<string>((r) => holder.stdout!.once('data', (d) => r(String(d).trim())));
  assert.equal(first, 'true');
  assert.equal(takeStartLock(home), false, 'another live process holds the start');
  holder.kill('SIGKILL');
  await new Promise((r) => holder.once('exit', r));
  assert.equal(takeStartLock(home), true, 'a dead holder\'s lock is taken over');
});

test('review: the port-less origin passes the page check only with the short address', async () => {
  const { fromOwnPage } = await import('../src/http.ts');
  const req = (origin: string) => ({ headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, socket: { localPort: 4848 } }) as any;
  useAddress({});
  assert.equal(fromOwnPage(req('http://crewdeck.localhost')), false);
  assert.equal(fromOwnPage(req('http://crewdeck.localhost:4848')), true);
  useAddress({ short: true });
  try { assert.equal(fromOwnPage(req('http://crewdeck.localhost')), true); } finally { useAddress({}); }
});

test('review #6: the systemd unit escapes %, $, quotes and backslashes', () => {
  const l = servicePlan({ platform: 'linux', home: '/h/100%/$x', userHome: '/h', node: '/n/"b"\\node', repo: '/r%1' });
  assert.match(l.text, /ExecStart="\/n\/\\"b\\"\\\\node" "\/r%%1\/src\/cli\.ts" up/);
  assert.match(l.text, /Environment="CREWDECK_HOME=\/h\/100%%\/\$\$x"/);
  assert.match(l.text, /^WorkingDirectory=\/r%%1$/m);
  assert.match(l.text, /^Environment=CREWDECK_SERVICE=1$/m);
  assert.match(servicePlan({ platform: 'darwin', home: '/h/.crewdeck', userHome: '/h' }).text, /<key>CREWDECK_SERVICE<\/key><string>1<\/string>/);
});

test('review #5: a FIFO, symlink or huge file on a board is skipped, never read', async () => {
  const { execFileSync } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const repo = tmp('cds-fifo-');
  const dir = join(repo, 'backlog', 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'task-1.md'), '---\nid: TASK-1\ntitle: Real\nstatus: To Do\n---\n');
  execFileSync('mkfifo', [join(dir, 'task-2.md')]);
  symlinkSync('/etc/hosts', join(dir, 'task-3.md'));
  writeFileSync(join(dir, 'task-4.md'), '---\nid: TASK-4\ntitle: Big\nstatus: To Do\n---\n' + 'x'.repeat(300_000));
  assert.deepEqual(ticketsOf([{ name: 'a', path: repo }]).tickets.map((t) => t.id), ['TASK-1']);
});

test('E11: the jobs session link opens Claude desktop on the jobs folder with a hello, both encoded', async () => {
  const { sessionLink, JOBS_SESSION_PROMPT } = await import('../src/session-link.ts');
  assert.equal(sessionLink('/srv/a b/Crewdeck/jobs', JOBS_SESSION_PROMPT), `claude://code/new?folder=%2Fsrv%2Fa%20b%2FCrewdeck%2Fjobs&q=${encodeURIComponent(JOBS_SESSION_PROMPT)}`);
  assert.equal(sessionLink('/x&q=evil'), 'claude://code/new?folder=%2Fx%26q%3Devil');
  assert.throws(() => sessionLink('~/Crewdeck/jobs'), /absolute/);
});
