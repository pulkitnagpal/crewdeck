// The key store (0600, created on first write, under CREWDECK_HOME), masking, redaction, and the keys CLI (stdin only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { KeyStore, keysPath, mask, redact, redactUrl } from '../../../src/jobs/apis/keys.ts';
import { REPO } from '../helpers.ts';

const TMP = realpathSync(tmpdir());
const tempHome = () => join(mkdtempSync(join(TMP, 'cd-keys-')), 'crewdeck');

test('keysPath follows CREWDECK_HOME', () => {
  assert.equal(keysPath('/x/cd-home'), '/x/cd-home/keys.json');
  const prev = process.env.CREWDECK_HOME;
  process.env.CREWDECK_HOME = '/y/cd-home';
  try { assert.equal(keysPath(), '/y/cd-home/keys.json'); } finally { if (prev === undefined) delete process.env.CREWDECK_HOME; else process.env.CREWDECK_HOME = prev; }
});

test('KeyStore: nothing on disk until the first write; then 0600 in a 0700 home; get/set/remove; loose perms tightened', () => {
  const home = tempHome();
  const s = new KeyStore(keysPath(home));
  assert.equal(existsSync(s.path), false);
  assert.equal(s.get('reed'), undefined);
  s.set('reed', '  reed-secret-0123456789\n');
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(new KeyStore(s.path).get('reed'), 'reed-secret-0123456789');
  s.set('adzuna', 'appid:appkey-abcdefghij');
  assert.deepEqual(new KeyStore(s.path).providers(), ['adzuna', 'reed']);
  assert.equal(s.remove('reed'), true);
  assert.equal(s.remove('reed'), false);
  assert.equal(new KeyStore(s.path).get('reed'), undefined);
  chmodSync(s.path, 0o644);
  new KeyStore(s.path);
  assert.equal(statSync(s.path).mode & 0o777, 0o600);
  assert.throws(() => s.set('reed', 'two words'), /spaces/);
  assert.throws(() => s.set('../etc', 'k'), /not a provider id/);
});

test('KeyStore never shows a value: inspect, JSON, string', () => {
  const s = new KeyStore(keysPath(tempHome()));
  s.set('jooble', 'jooble-secret-value-xyz');
  for (const out of [inspect(s), JSON.stringify(s), String(s)]) assert.ok(!out.includes('jooble-secret'), out);
  assert.deepEqual(s.secrets().sort(), ['jooble-secret-value-xyz']);
});

test('mask: last 4 of a long key, nothing of a short one; id:key shows only the key\'s tail', () => {
  assert.equal(mask('abcdefghijklmnop'), '••••••••mnop');
  assert.equal(mask('short'), '••••••••');
  assert.equal(mask('myappid:abcdefghijkl1234'), '••••••••1234');
  assert.equal(mask(undefined), '(not set)');
});

test('redactUrl: Adzuna query keys, Jooble path key, user info; redact: known secrets anywhere', () => {
  assert.equal(redactUrl('https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=abc123&app_key=SECRETKEY&what=nurse'),
    'https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=***&app_key=***&what=nurse');
  assert.equal(redactUrl('https://jooble.org/api/SECRET-JOOBLE-KEY'), 'https://jooble.org/api/***');
  assert.equal(redactUrl('https://user:pw@example.com/a?api_key=k'), 'https://example.com/a?api_key=***');
  assert.equal(redactUrl('POST https://jooble.org/api/SECRET → 500'), 'POST https://jooble.org/api/*** → 500');
  assert.equal(redactUrl('https://himalayas.app/api/search?q=x'), 'https://himalayas.app/api/search?q=x');
  assert.equal(redact('auth failed for reed-secret-0123 (Basic cmVlZA==)', ['reed-secret-0123']), 'auth failed for *** (Basic cmVlZA==)');
});

/** `crewdeck jobs keys …` in a child with a temp CREWDECK_HOME, stdin piped. */
const keys = (home: string, args: string[], input = '') => {
  const r = spawnSync(process.execPath, [join(REPO, 'src', 'cli.ts'), 'jobs', 'keys', ...args], { env: { ...process.env, CREWDECK_HOME: home }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('CLI: keys set reads stdin, stores 0600, prints only the mask; never takes a key from argv; list and remove', () => {
  const home = tempHome();
  const set = keys(home, ['set', 'reed'], 'reed-cli-secret-98765\n');
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /Reed: key saved \(••••••••8765\)/);
  assert.ok(!set.out.includes('reed-cli-secret') && !set.err.includes('reed-cli-secret'));
  assert.equal(statSync(join(home, 'keys.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).keys.reed.value, 'reed-cli-secret-98765');

  const argv = keys(home, ['set', 'jooble', 'secret-on-argv'], '');
  assert.notEqual(argv.code, 0);
  assert.match(argv.err, /never given on the command line/);
  assert.equal(new KeyStore(join(home, 'keys.json')).get('jooble'), undefined);

  const pair = keys(home, ['set', 'adzuna'], 'justonevalue\n');
  assert.notEqual(pair.code, 0);
  assert.match(pair.err, /<app_id>:<app_key>/);
  assert.equal(keys(home, ['set', 'adzuna'], 'myid:mykey-1234567890\n').code, 0);

  const list = keys(home, ['list']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /reed\s+••••••••8765/);
  assert.match(list.out, /adzuna\s+••••••••7890/);
  assert.match(list.out, /usajobs\s+\(not set\)\s+get one: https:\/\/developer\.usajobs\.gov/);
  assert.ok(!list.out.includes('reed-cli-secret') && !list.out.includes('mykey'));

  assert.match(keys(home, ['remove', 'reed']).out, /Reed: key removed/);
  assert.match(keys(home, ['list', 'reed']).out, /reed\s+\(not set\)/);
  assert.notEqual(keys(home, ['set', 'himalayas'], 'x\n').code, 0);
  assert.notEqual(keys(home, ['set', 'nope'], 'x\n').code, 0);
});
