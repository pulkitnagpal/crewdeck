// The headless browser (design §14): found in the standard places, launched through the guard proxy so loopback and
// private addresses are refused even when a page asks for them, X never opened, PDF render with the network off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserCandidates, findBrowser, installHint, launchGuarded, pdfPageCount, renderPdf } from '../../src/jobs/browser.ts';
import { startGuardProxy } from '../../src/jobs/net/guard-proxy.ts';
import { noBrowser, pages, serve, testHosts } from './net-helpers.ts';

test('auto finds Chrome, Chromium, Brave, Edge in order in the standard places; a path setting must exist', () => {
  const mac = browserCandidates('darwin', '/home/someone');
  assert.deepEqual([...new Set(mac.map((c) => c.name))], ['Google Chrome', 'Chromium', 'Brave', 'Microsoft Edge']);
  assert.ok(mac.some((c) => c.path === '/home/someone/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'));
  const linux = browserCandidates('linux');
  assert.ok(linux.some((c) => c.path === '/usr/bin/chromium'));
  const have = new Set(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']);
  assert.equal(findBrowser('auto', { platform: 'darwin', home: '/home/someone', exists: (p) => have.has(p) })?.name, 'Brave');
  assert.equal(findBrowser('auto', { platform: 'darwin', home: '/home/someone', exists: () => false }), null);
  assert.equal(findBrowser('/opt/custom/chrome', { exists: (p) => p === '/opt/custom/chrome' })?.path, '/opt/custom/chrome');
  assert.equal(findBrowser('/opt/missing/chrome', { exists: () => false }), null);
  assert.match(installHint('linux'), /apt install chromium/);
  assert.match(installHint('darwin'), /jobs\.browser/);
});

test('the guard proxy refuses loopback, private targets and X over HTTP and CONNECT', async (t) => {
  const local = await serve(pages({ '/': 'local secret' }));
  const proxy = await startGuardProxy({ net: { testHosts: testHosts('jobs.example.test') } });
  t.after(async () => { await proxy.close(); await local.close(); });
  const viaProxy = (url: string) => new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    http.request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: u.host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
  });
  const connect = (target: string) => new Promise<number>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target }).on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
  });
  assert.equal(await viaProxy(`${local.base()}/`), 403);
  assert.equal(await viaProxy(`http://localhost:${local.port}/`), 403);
  assert.equal(await viaProxy(`http://[::1]:${local.port}/`), 403);
  assert.equal(await viaProxy('http://x.com/'), 403);
  assert.equal(await viaProxy('http://www.linkedin.com/feed'), 403);
  assert.equal(await connect(`127.0.0.1:${local.port}`), 403);
  assert.equal(await connect(`[::1]:${local.port}`), 403);
  assert.equal(await connect('169.254.169.254:80'), 403);
  assert.equal(await connect('twitter.com:443'), 403);
  // A ws:// upgrade to loopback.
  const upgrade = (url: string) => new Promise<number>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host, connection: 'Upgrade', upgrade: 'websocket' } })
      .on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('upgrade', (_r, socket) => { socket.destroy(); resolve(101); }).on('error', reject).end();
  });
  assert.equal(await upgrade(`http://127.0.0.1:${local.port}/socket`), 403);
  assert.deepEqual(local.hits, [], 'the local server never saw a request');
  // The fixture "public" host goes through.
  assert.equal(await viaProxy(`${local.base('jobs.example.test')}/`), 200);
  assert.equal(await connect(`jobs.example.test:${local.port}`), 200);
  assert.ok(proxy.blocked.some((b) => b.host === 'x.com'));
});

test('headless Chromium through the guard proxy cannot reach loopback, even from a page on an allowed site', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const secret = await serve(pages({ '/secret': 'local secret', '/img.png': 'x' }));
  const site = await serve(pages({
    '/page': `<!doctype html><title>t</title><p id=p>hello</p>
      <img src="http://127.0.0.1:${secret.port}/img.png"><img src="http://localhost:${secret.port}/img.png">
      <script>fetch('http://127.0.0.1:${secret.port}/secret').then(() => document.title = 'leaked', () => document.title = 'refused');</script>`,
  }));
  const g = await launchGuarded({ net: { testHosts: testHosts('jobs.example.test') } });
  t.after(async () => { await g.close(); await secret.close(); await site.close(); });
  const page = await g.context.newPage();
  // Direct navigation to loopback: the proxy answers 403.
  const direct = await page.goto(`${secret.base()}/secret`).catch((e) => e);
  assert.ok(direct instanceof Error || direct.status() === 403, 'loopback navigation refused');
  const named = await page.goto(`http://localhost:${secret.port}/secret`).catch((e) => e);
  assert.ok(named instanceof Error || named.status() === 403, 'localhost navigation refused');
  // An allowed page that reaches for loopback.
  const r = await page.goto(`${site.base('jobs.example.test')}/page`);
  assert.equal(r?.status(), 200);
  assert.equal(await page.textContent('#p'), 'hello');
  await page.waitForFunction(() => document.title === 'refused' || document.title === 'leaked', null, { timeout: 10_000 });
  assert.equal(await page.title(), 'refused');
  assert.deepEqual(secret.hits, [], 'the local server never saw a request from the browser');
  assert.ok(g.proxy.blocked.some((b) => b.host === '127.0.0.1' || b.host === 'localhost'));
});

test('PDF render runs with JavaScript and the network off', { skip: noBrowser, timeout: 60_000 }, async (t) => {
  const s = await serve(pages({ '/beacon.png': 'x', '/style.css': 'body{}' }));
  t.after(() => s.close());
  const dir = mkdtempSync(join(tmpdir(), 'cd-pdf-'));
  const html = join(dir, 'r.html');
  writeFileSync(html, `<!doctype html><html><head><link rel=stylesheet href="${s.base()}/style.css"></head><body><h1 id=h>Static</h1>
    <img src="${s.base('example.com')}/beacon.png"><script>document.getElementById('h').textContent = 'SCRIPT RAN'</script>
    <div style="page-break-before: always">Second page</div></body></html>`);
  const out = join(dir, 'r.pdf');
  const r = await renderPdf(html, out, { paper: 'A4' });
  const pdf = readFileSync(out);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.pages, 2);
  assert.equal(pdfPageCount(pdf), 2);
  assert.ok(!pdf.toString('latin1').includes('SCRIPT RAN'));
  assert.deepEqual(s.hits, [], 'nothing was fetched');
});
