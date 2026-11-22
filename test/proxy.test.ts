import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createProxy } from '../src/proxy.ts';

const listen = (s: any) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

test('proxy injects the theme into HTML only, and refuses non-local hosts', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/api') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>x</title></head><body>hi</body></html>');
  });
  const up = await listen(upstream);
  const proxy = createProxy({ target: { host: '127.0.0.1', port: up }, injectHead: '<style>#t{}</style>' });
  const p = await listen(proxy);
  try {
    const html = await (await fetch(`http://127.0.0.1:${p}/`)).text();
    // Injected first in <head>, so it runs before the tool's own scripts (Backlog.md reads its theme early).
    assert.match(html, /<head><style>#t\{\}<\/style><title>/);
    assert.equal(await (await fetch(`http://127.0.0.1:${p}/api`)).text(), '{"ok":true}');
    // fetch() drops a custom Host header, so send a raw request as a DNS-rebinding page would.
    const status = await new Promise<number>((r) => request({ host: '127.0.0.1', port: p, path: '/', headers: { host: 'evil.example' } }, (res) => { res.resume(); r(res.statusCode!); }).end());
    assert.equal(status, 403);
  } finally { proxy.close(); upstream.close(); }
});

test('proxy: changes and WebSockets only from its own origin or a non-browser client', async () => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(req.method); });
  upstream.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\n\r\n'); socket.end(); });
  const up = await listen(upstream);
  const proxy = createProxy({ target: { host: '127.0.0.1', port: up } });
  const p = await listen(proxy);
  const send = (method: string, origin?: string) => new Promise<number>((r) => {
    const req = request({ host: '127.0.0.1', port: p, method, path: '/x', headers: { host: `localhost:${p}`, ...(origin ? { origin } : {}) } }, (res) => { res.resume(); r(res.statusCode!); });
    req.on('error', () => r(0)); req.end();
  });
  const upgrade = (origin?: string) => new Promise<string>((r) => {
    const req = request({ host: '127.0.0.1', port: p, path: '/ws', headers: { host: `localhost:${p}`, connection: 'upgrade', upgrade: 'websocket', ...(origin ? { origin } : {}) } });
    req.on('upgrade', () => r('upgraded')); req.on('error', () => r('refused')); req.on('response', () => r('response')); req.end();
  });
  try {
    assert.equal(await send('GET', 'https://evil.example'), 200, 'reads are harmless: no CORS, so other sites cannot read them');
    assert.equal(await send('POST', 'https://evil.example'), 403);
    assert.equal(await send('POST', 'http://localhost:4848'), 403, 'another local port is another origin');
    assert.equal(await send('POST', `http://localhost:${p}`), 200);
    assert.equal(await send('POST'), 200, 'no Origin: a CLI or tool');
    assert.equal(await upgrade('https://evil.example'), 'refused');
    assert.equal(await upgrade(`http://127.0.0.1:${p}`), 'upgraded');
  } finally { proxy.close(); upstream.close(); }
});
