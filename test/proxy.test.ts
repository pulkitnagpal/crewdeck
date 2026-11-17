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
    assert.match(html, /<style>#t\{\}<\/style><\/head>/);
    assert.equal(await (await fetch(`http://127.0.0.1:${p}/api`)).text(), '{"ok":true}');
    // fetch() drops a custom Host header, so send a raw request as a DNS-rebinding page would.
    const status = await new Promise<number>((r) => request({ host: '127.0.0.1', port: p, path: '/', headers: { host: 'evil.example' } }, (res) => { res.resume(); r(res.statusCode!); }).end());
    assert.equal(status, 403);
  } finally { proxy.close(); upstream.close(); }
});
