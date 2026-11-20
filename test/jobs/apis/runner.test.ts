// The runner: missing keys are a status not an error; pacing; 5xx retries; 429 back-off; per-run caps; redacted logs;
// one provider failing never stops another; requests go through netguard by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FetchOptions, Fetched } from '../../../src/jobs/net/netguard.ts';
import { NetError } from '../../../src/jobs/net/netguard.ts';
import { retryAfterMs, runApis, type RunOptions } from '../../../src/jobs/apis/runner.ts';

const FIX = resolve(import.meta.dirname, '..', '..', 'fixtures', 'jobs', 'apis');
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8');

const ok = (url: string, body: string, status = 200, headers: Record<string, string> = {}): Fetched => ({ status, url, headers, body, redirects: [] });

/** A fake clock + sleep (sleeping advances the clock) and a transport scripted by host. */
function harness(script: (url: string, opts: FetchOptions, n: number) => Fetched | Promise<Fetched>, keys: Record<string, string> = {}) {
  let t = 1_000_000;
  const sleeps: number[] = [], calls: { url: string; at: number; opts: FetchOptions }[] = [], logs: string[] = [];
  const o: RunOptions = {
    keys: { get: (k) => keys[k], secrets: () => Object.values(keys) },
    transport: async (url, opts) => { calls.push({ url, at: t, opts }); return script(url, opts, calls.length); },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    log: (l) => logs.push(l),
  };
  return { o, sleeps, calls, logs };
}

const q = (titles: string[], country = 'GB') => ({ titles, country });

test('missing key → needs_key with where to get one, no request, no error; keyless providers still run', async () => {
  const h = harness((url) => ok(url, fixture('nhs-search.xml')));
  const r = await runApis([{ provider: 'adzuna', query: q(['nurse']) }, { provider: 'reed', query: q(['nurse']) }, { provider: 'nhs-jobs', query: q(['nurse']) }], h.o);
  const by = Object.fromEntries(r.stats.map((s) => [s.provider, s]));
  assert.equal(by.adzuna.status, 'needs_key');
  assert.deepEqual(by.adzuna.errors, []);
  assert.match(by.adzuna.note!, /developer\.adzuna\.com.*crewdeck jobs keys set adzuna/);
  assert.equal(by.reed.status, 'needs_key');
  assert.equal(by['nhs-jobs'].status, 'ok');
  assert.equal(by['nhs-jobs'].postings, 4);
  assert.ok(h.calls.every((c) => c.url.includes('jobs.nhs.uk')));
  assert.equal(r.postings.length, 4);
  assert.deepEqual(r.entries.filter((e) => e.status === 'needs_key').map((e) => e.provider).sort(), ['adzuna', 'reed']);
});

test('pacing: requests to one provider are spaced by its minimum interval; 20 s deadline and a body cap are passed', async () => {
  const h = harness((url) => ok(url, fixture('nhs-search.xml')));
  await runApis([{ provider: 'nhs-jobs', query: q(['nurse', 'staff nurse', 'midwife']) }], h.o);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls[1].at - h.calls[0].at >= 1000 && h.calls[2].at - h.calls[1].at >= 1000);
  assert.equal(h.calls[0].opts.timeoutMs, 20_000);
  assert.ok(h.calls[0].opts.maxBytes! >= 2_000_000);
  assert.match(h.calls[0].opts.headers!['user-agent'], /^Crewdeck\/0\.8 \(\+https:\/\/github\.com\/pulkitnagpal\/crewdeck\)$/);
});

test('5xx: retried twice, then reported; network errors retried too', async () => {
  const h = harness((url, _o, n) => (n <= 2 ? ok(url, 'busy', 503) : ok(url, fixture('remotive-search.json'))));
  const r = await runApis([{ provider: 'remotive', query: q(['engineer']) }], h.o);
  assert.equal(r.stats[0].status, 'ok');
  assert.equal(r.stats[0].retries, 2);
  assert.equal(r.postings.length, 4);

  const always = harness((url) => ok(url, 'down', 502));
  const bad = await runApis([{ provider: 'himalayas', query: q(['engineer'], 'IN') }], always.o);
  assert.equal(always.calls.length, 3);
  assert.equal(bad.stats[0].status, 'error');
  assert.match(bad.stats[0].errors[0], /HTTP 502/);

  const net = harness((url, _o, n) => { if (n === 1) throw new NetError('network', 'reset'); return ok(url, fixture('himalayas-search.json')); });
  const r2 = await runApis([{ provider: 'himalayas', query: q(['engineer'], 'IN') }], net.o);
  assert.equal(r2.stats[0].status, 'ok');
  assert.equal(r2.stats[0].retries, 1);
});

test('429: backs off (Retry-After when given), then succeeds; three 429s → rate limited error, other providers unaffected', async () => {
  const h = harness((url, _o, n) => (n === 1 ? ok(url, '', 429, { 'retry-after': '7' }) : ok(url, fixture('nhs-search.xml'))));
  const r = await runApis([{ provider: 'nhs-jobs', query: q(['nurse']) }], h.o);
  assert.equal(r.stats[0].status, 'ok');
  assert.equal(r.stats[0].rateLimited, 1);
  assert.ok(h.sleeps.includes(7000), String(h.sleeps));
  assert.ok(h.logs.some((l) => /rate limited, waiting 7 s/.test(l)));

  const limited = harness((url) => (url.includes('himalayas') ? ok(url, '', 429) : ok(url, fixture('nhs-search.xml'))));
  const r2 = await runApis([{ provider: 'himalayas', query: q(['engineer'], 'IN') }, { provider: 'nhs-jobs', query: q(['nurse']) }], limited.o);
  const by = Object.fromEntries(r2.stats.map((s) => [s.provider, s]));
  assert.equal(by.himalayas.status, 'error');
  assert.equal(by.himalayas.rateLimited, 3);
  assert.match(by.himalayas.errors[0], /rate limited/);
  assert.ok(limited.sleeps.includes(5000) && limited.sleeps.includes(10000), 'exponential back-off without Retry-After');
  assert.equal(by['nhs-jobs'].status, 'ok');
});

test('retryAfterMs: seconds or an HTTP date', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(retryAfterMs(undefined), undefined);
});

test('keys never reach logs or errors (Adzuna query keys, Jooble path key); a refused key stops further titles', async () => {
  const keys = { adzuna: 'myappid:SUPERSECRETKEY123', jooble: 'JOOBLESECRET9876' };
  const h = harness((url) => ok(url, 'nope', 401), keys);
  const r = await runApis([{ provider: 'adzuna', query: q(['nurse', 'midwife']) }, { provider: 'jooble', query: q(['nurse'], 'IN') }], h.o);
  const all = JSON.stringify(r) + h.logs.join('\n');
  for (const s of ['SUPERSECRETKEY123', 'myappid', 'JOOBLESECRET9876']) assert.ok(!all.includes(s), `${s} leaked`);
  assert.ok(h.logs.some((l) => l.includes('app_key=***')) && h.logs.some((l) => l.includes('jooble.org/api/***')));
  assert.equal(h.calls.filter((c) => c.url.includes('adzuna')).length, 1, 'a 401 stops the other titles');
  assert.match(r.stats.find((s) => s.provider === 'adzuna')!.errors[0], /key was refused/);
});

test('per-run cap (Remotive asks for few fetches) and country coverage (skipped, not an error)', async () => {
  const h = harness((url) => ok(url, fixture('remotive-search.json')));
  const r = await runApis([{ provider: 'remotive', query: q(['a', 'b', 'c']) }, { provider: 'remotive', query: q(['d']) }, { provider: 'usajobs', query: q(['nurse'], 'GB') }], { ...h.o, keys: { get: (k) => (k === 'usajobs' ? 'me@example.com:k123456789' : undefined) } });
  const by = Object.fromEntries(r.stats.map((s) => [s.provider, s]));
  assert.equal(by.remotive.requests, 3);
  assert.match(by.remotive.errors.join(' '), /stopped at 3 requests this run/);
  assert.equal(by.remotive.status, 'partial');
  assert.equal(by.usajobs.status, 'skipped');
  assert.equal(by.usajobs.requests, 0);
  assert.deepEqual(by.usajobs.errors, []);
  assert.equal(r.postings.filter((p) => p.sourceKey === 'remotive').length, 4, 'deduped across searches');
});

test('by default every request goes through netguard: a private address is refused', async () => {
  const r = await runApis([{ provider: 'nhs-jobs', query: q(['nurse']) }], {
    keys: { get: () => undefined },
    transport: async (url, opts) => (await import('../../../src/jobs/net/netguard.ts')).guardedFetch(url, { ...opts, resolve: async () => [{ address: '10.0.0.5', family: 4 }] }),
    sleep: async () => {},
  });
  assert.equal(r.stats[0].status, 'error');
  assert.match(r.stats[0].errors.join(' '), /private or local address/);
});
