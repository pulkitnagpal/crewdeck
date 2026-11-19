// netguard (design §14, SSRF): private and local addresses in every form are refused, by literal, by name and after a
// redirect; the decoded body is capped; one deadline covers the body; proxy variables are ignored. Local servers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { NetError, checkHost, guardedFetch, isBlockedAddress } from '../../src/jobs/net/netguard.ts';
import { pages, serve, testHosts } from './net-helpers.ts';

test('the block list covers every private, local and special range, IPv4 and IPv6', () => {
  const blocked = ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.8.9.10', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::127.0.0.1', '::a00:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fd12:3456::1',
    'fe80::1', 'fe80::1%lo0', 'febf::1', 'ff02::1', '64:ff9b::7f00:1', '64:ff9b::808:808', '2002:7f00:1::1', '2002::1', '[::1]',
    'not-an-ip', ''];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  const open = ['8.8.8.8', '93.184.215.14', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.167.1.1', '223.255.255.255',
    '2606:4700:4700::1111', '2a00:1450:4001::1', '2001:4860:4860::8888', '2003::1', '64:ff9c::1'];
  for (const ip of open) assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
});

test('a local server on 127.0.0.1 is refused: by literal, as localhost, through DNS, and in mapped IPv6 form', async (t) => {
  const s = await serve(pages({ '/': 'secret' }));
  t.after(() => s.close());
  for (const url of [s.base(), `http://localhost:${s.port}/`, `http://app.localhost:${s.port}/`, `http://[::1]:${s.port}/`,
    `http://[::ffff:127.0.0.1]:${s.port}/`, `http://2130706433:${s.port}/`, `http://0x7f.1:${s.port}/`, `http://0.0.0.0:${s.port}/`]) {
    await assert.rejects(guardedFetch(url), (e: any) => e instanceof NetError && e.code === 'blocked', url);
  }
  // A name whose DNS answer is private, or mixes a public and a private address.
  const resolve = async (h: string) => (h === 'evil.example' ? [{ address: '93.184.215.14', family: 4 as const }, { address: '127.0.0.1', family: 4 as const }]
    : h === 'mapped.example' ? [{ address: '::ffff:127.0.0.1', family: 6 as const }] : [{ address: '10.1.2.3', family: 4 as const }]);
  for (const host of ['evil.example', 'mapped.example', 'intranet.example']) {
    await assert.rejects(guardedFetch(`http://${host}:${s.port}/`, { resolve }), (e: any) => e.code === 'blocked', host);
  }
  await assert.rejects(checkHost('metadata.example', { resolve: async () => [{ address: '169.254.169.254', family: 4 }] }), /private or local/);
  assert.deepEqual(s.hits, [], 'the local server must never see a request');
});

test('only http and https; no credentials in the address', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'data:text/html,hi', 'javascript:alert(1)', 'http://user:pw@example.com/']) {
    await assert.rejects(guardedFetch(url), (e: any) => e.code === 'scheme', url);
  }
});

test('a fixture "public" host is reached; redirects are followed and each one is checked again', async (t) => {
  const target = await serve(pages({ '/secret': 'internal data' }));
  const s = await serve(pages({
    '/ok': 'hello',
    '/hop': { status: 302, headers: { location: '/ok' } },
    '/to-file': { status: 302, headers: { location: 'file:///etc/passwd' } },
    '/loop': { status: 302, headers: { location: '/loop' } },
  }));
  t.after(async () => { await s.close(); await target.close(); });
  const net = { testHosts: testHosts('jobs.example.test') };
  const base = s.base('jobs.example.test');
  const ok = await guardedFetch(`${base}/hop`, net);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'hello');
  assert.deepEqual(ok.redirects, [`${base}/ok`]);
  // Redirect to the local "intranet" server: refused, and it never sees the request.
  const evil = await serve(pages({ '/go': { status: 302, headers: { location: `${target.base()}/secret` } }, '/go6': { status: 302, headers: { location: `http://[::1]:${target.port}/secret` } }, '/golocal': { status: 302, headers: { location: `http://localhost:${target.port}/secret` } } }));
  t.after(() => evil.close());
  for (const p of ['/go', '/go6', '/golocal']) await assert.rejects(guardedFetch(`${evil.base('jobs.example.test')}${p}`, net), (e: any) => e.code === 'blocked', p);
  assert.deepEqual(target.hits, []);
  await assert.rejects(guardedFetch(`${base}/to-file`, net), (e: any) => e.code === 'scheme');
  await assert.rejects(guardedFetch(`${base}/loop`, net), (e: any) => e.code === 'redirects' && /more than 5/.test(e.message));
  // manual: the 3xx comes back as is (LinkedIn treats it as a stop).
  const manual = await guardedFetch(`${base}/hop`, { ...net, redirect: 'manual' });
  assert.equal(manual.status, 302);
});

test('the body cap counts decoded bytes while streaming (gzip and brotli bombs, plain oversize)', async (t) => {
  const big = Buffer.alloc(3_000_000, 'a');
  const s = await serve((req, res) => {
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(big)); return; }
    if (req.url === '/br') { res.writeHead(200, { 'content-encoding': 'br' }).end(brotliCompressSync(big)); return; }
    if (req.url === '/small-gzip') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' }).end(gzipSync('<p>Grüße</p>')); return; }
    res.writeHead(200);
    // Plain: streamed in chunks, never all at once.
    let n = 0;
    const tick = () => { if (n++ > 40) return res.end(); res.write(Buffer.alloc(100_000, 'b')); setImmediate(tick); };
    tick();
  });
  t.after(() => s.close());
  const net = { testHosts: testHosts('jobs.example.test') };
  assert.ok(gzipSync(big).length < 10_000, 'the compressed bomb is tiny');
  for (const p of ['/gzip', '/br', '/plain']) await assert.rejects(guardedFetch(`${s.base('jobs.example.test')}${p}`, net), (e: any) => e.code === 'too_large', p);
  const ok = await guardedFetch(`${s.base('jobs.example.test')}/small-gzip`, net);
  assert.equal(ok.body, '<p>Grüße</p>');
  const capped = await guardedFetch(`${s.base('jobs.example.test')}/small-gzip`, { ...net, maxBytes: 5 }).catch((e) => e);
  assert.equal(capped.code, 'too_large');
});

test('one deadline covers the body: a server that trickles forever times out', async (t) => {
  const s = await serve((req, res) => {
    res.writeHead(200);
    const iv = setInterval(() => res.write('.'), 50);
    res.on('close', () => clearInterval(iv));
  });
  t.after(() => s.close());
  const started = Date.now();
  await assert.rejects(guardedFetch(`${s.base('jobs.example.test')}/`, { testHosts: testHosts('jobs.example.test'), timeoutMs: 400 }), (e: any) => e.code === 'timeout');
  assert.ok(Date.now() - started < 3000);
  // No answer at all (headers never sent) times out too.
  const silent = await serve(() => {});
  t.after(() => silent.close());
  await assert.rejects(guardedFetch(`${silent.base('jobs.example.test')}/`, { testHosts: testHosts('jobs.example.test'), timeoutMs: 300 }), (e: any) => e.code === 'timeout');
});

test('proxy environment variables are ignored', async (t) => {
  const proxy = await serve(pages({}));
  const s = await serve(pages({ '/': 'direct' }));
  t.after(async () => { await proxy.close(); await s.close(); });
  const saved = { ...process.env };
  process.env.HTTP_PROXY = proxy.base(); process.env.http_proxy = proxy.base(); process.env.HTTPS_PROXY = proxy.base();
  try {
    const r = await guardedFetch(`${s.base('jobs.example.test')}/`, { testHosts: testHosts('jobs.example.test') });
    assert.equal(r.body, 'direct');
    assert.deepEqual(proxy.hits, []);
  } finally { for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});

test('E8: NAT64 local-use, IPv4-translated, benchmarking, IETF protocol and documentation ranges are blocked too', () => {
  for (const ip of ['64:ff9b:1::7f00:1', '64:ff9b:1:ffff::1', '::ffff:0:7f00:1', '::ffff:0:a00:1', '198.18.0.1', '198.19.255.254', '192.0.0.1', '192.0.0.170',
    '192.0.2.1', '198.51.100.7', '203.0.113.9', '2001:db8::1']) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);
  for (const ip of ['198.17.255.255', '198.20.0.1', '192.0.1.1', '64:ff9b:2::1']) assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
});
