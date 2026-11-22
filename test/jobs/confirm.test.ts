// Review W3/C1: a risky switch needs a yes no agent can give. The native dialog (osascript, zenity, kdialog) with a stubbed
// runner, and the terminal fallback's one-time code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Runner, nativeConfirm, issueCode, useCode, CODE_MS } from '../../src/jobs/confirm.ts';
import { confirmText, featureChanges, widens } from '../../src/jobs/features.ts';
import { FEATURE_DEFAULTS } from '../../src/config.ts';

const TOKEN = 'd'.repeat(64);
const calls: { cmd: string; args: string[] }[] = [];
const runner = (out: Awaited<ReturnType<Runner>>): Runner => async (cmd, args) => { calls.push({ cmd, args }); return out; };

test('macOS: osascript with the text as an argument; Switch on is yes, Cancel (-128) or giving up is no, anything else is no dialog', async () => {
  calls.length = 0;
  const yes = nativeConfirm({ platform: 'darwin', runner: runner({ code: 0, stdout: 'button returned:Switch on, gave up:false\n', stderr: '' }) });
  assert.equal(await yes('Crewdeck', 'Switch on "x"? do shell script "rm"'), 'yes');
  assert.equal(calls[0].cmd, '/usr/bin/osascript');
  assert.ok(calls[0].args.includes('Switch on "x"? do shell script "rm"'), 'the text is argv, not script source');
  assert.ok(!calls[0].args.slice(0, 6).some((a) => a.includes('do shell script')), 'never inside the AppleScript');
  assert.match(calls[0].args.join(' '), /default button "Cancel"/, 'Return/Enter is Cancel');
  assert.equal(await nativeConfirm({ platform: 'darwin', runner: runner({ code: 0, stdout: 'button returned:, gave up:true', stderr: '' }) })('t', 'x'), 'no');
  assert.equal(await nativeConfirm({ platform: 'darwin', runner: runner({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }) })('t', 'x'), 'no');
  assert.equal(await nativeConfirm({ platform: 'darwin', runner: runner({ code: 1, stdout: '', stderr: 'No user interaction allowed. (-1713)' }) })('t', 'x'), 'unavailable');
});

test('Linux: zenity, else kdialog, only with a display; none of them is "unavailable"', async () => {
  calls.length = 0;
  const env = { DISPLAY: ':0', PATH: '/usr/bin' };
  assert.equal(await nativeConfirm({ platform: 'linux', env, has: (n) => n === 'zenity', runner: runner({ code: 0, stdout: '', stderr: '' }) })('Crewdeck', 'x'), 'yes');
  assert.equal(calls[0].cmd, 'zenity');
  assert.ok(calls[0].args.includes('--no-markup'));
  assert.equal(await nativeConfirm({ platform: 'linux', env, has: (n) => n === 'zenity', runner: runner({ code: 1, stdout: '', stderr: '' }) })('t', 'x'), 'no');
  assert.equal(await nativeConfirm({ platform: 'linux', env, has: (n) => n === 'kdialog', runner: runner({ code: 0, stdout: '', stderr: '' }) })('t', 'x'), 'yes');
  assert.equal(calls.at(-1)!.cmd, 'kdialog');
  assert.equal(await nativeConfirm({ platform: 'linux', env: { PATH: '/usr/bin' }, has: () => true, runner: runner({ code: 0, stdout: '', stderr: '' }) })('t', 'x'), 'unavailable', 'no display');
  assert.equal(await nativeConfirm({ platform: 'linux', env, has: () => false, runner: runner({ code: 0, stdout: '', stderr: '' }) })('t', 'x'), 'unavailable');
  assert.equal(await nativeConfirm({ platform: 'win32', runner: runner({ code: 0, stdout: '', stderr: '' }) })('t', 'x'), 'unavailable');
});

test('the one-time code: only for that change, once, for 10 minutes, three tries; the file never holds the code', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cdcode-')), 'feature-code.json');
  const { code } = issueCode(TOKEN, 'easy_apply', true, file);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(!readFileSync(file, 'utf8').includes(code.replace('-', '')), 'stored as an HMAC under the token');
  assert.equal(useCode(TOKEN, 'linkedin_search', true, code, file), false, 'another switch');
  assert.equal(useCode(TOKEN, 'easy_apply', true, code.toLowerCase(), file), true, 'case and dash do not matter');
  assert.equal(useCode(TOKEN, 'easy_apply', true, code, file), false, 'used once');
  assert.ok(!existsSync(file));

  const b = issueCode(TOKEN, 'daily_quick_apply', 10, file);
  assert.equal(useCode(TOKEN, 'daily_quick_apply', 11, b.code, file), false, 'another value');
  assert.equal(useCode('e'.repeat(64), 'daily_quick_apply', 10, b.code, file), false, 'another token (Crewdeck restarted)');
  assert.equal(useCode(TOKEN, 'daily_quick_apply', 10, 'AAAA-AAAA', file), false);
  assert.ok(!existsSync(file), 'spent after three wrong tries');

  const c = issueCode(TOKEN, 'easy_apply', true, file, Date.now() - CODE_MS - 1);
  assert.equal(useCode(TOKEN, 'easy_apply', true, c.code, file), false, 'expired');
});

test('what needs a yes: switching on and raising a number; off and lower never; on with its number at 0 gets a default (C11)', () => {
  const cur = { ...FEATURE_DEFAULTS };
  assert.deepEqual(featureChanges('easy_apply', true, cur), [{ name: 'easy_apply', value: true }, { name: 'daily_quick_apply', value: 5 }]);
  assert.deepEqual(featureChanges('easy_apply', true, { ...cur, daily_quick_apply: 3 }), [{ name: 'easy_apply', value: true }]);
  assert.equal(widens(featureChanges('easy_apply', true, cur), cur), true);
  assert.equal(widens([{ name: 'easy_apply', value: false }], { ...cur, easy_apply: true }), false);
  assert.equal(widens([{ name: 'daily_quick_apply', value: 2 }], { ...cur, daily_quick_apply: 5 }), false);
  assert.equal(widens([{ name: 'daily_quick_apply', value: 6 }], { ...cur, daily_quick_apply: 5 }), true);
  assert.match(confirmText(featureChanges('easy_apply', true, cur)), /Switch on Easy Apply filling\?[\s\S]*against LinkedIn's terms[\s\S]*5 a day/);
});

/** Drives a command in a pseudo-terminal (as an agent could with script/expect): answers each prompt in turn. */
const PTY = `
import os, pty, sys, time, select, json
answers = json.loads(sys.argv[1]); cmd = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
out = b''; deadline = time.time() + 20
prompts = [b'switch it on: ', b'Jobs page: ']
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if not r: continue
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    out += chunk
    if answers and prompts and prompts[0] in out:
        out = out.replace(prompts[0], prompts[0].rstrip() + b' [answered] ', 1)
        os.write(fd, (answers.pop(0) + chr(10)).encode()); prompts.pop(0)
os.waitpid(pid, 0)
sys.stdout.write(out.decode('utf8', 'replace'))
`;

test('C1: a faked terminal is not enough: with no dialog, the CLI asks for the code the Jobs page showed', { skip: process.platform === 'win32' ? 'no pty here' : false }, async () => {
  const { tempSetup, REPO } = await import('./helpers.ts');
  const { spawnSync } = await import('node:child_process');
  const { home } = tempSetup('berlin-analyst');
  writeFileSync(join(home, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  const cli = join(REPO, 'src', 'cli.ts');
  // NODE_TEST_CONTEXT (inherited) keeps real dialogs away: the CLI sees "no dialog here".
  const run = (answers: string[]) => {
    const r = spawnSync('python3', ['-I', '-c', PTY, JSON.stringify(answers), process.execPath, cli, 'jobs', 'features', 'linkedin_links', 'on'], { encoding: 'utf8', env: { ...process.env, CREWDECK_HOME: home }, timeout: 30_000 });
    if (r.error) return null;
    return { out: r.stdout + r.stderr, cfg: readFileSync(join(home, 'config.yaml'), 'utf8') };
  };
  const forged = run(['yes', 'AAAA-AAAA']);
  if (!forged) return; // no python3: nothing to drive the pty with
  assert.match(forged.out, /No confirmation dialog on this system/);
  assert.match(forged.out, /Unchanged: that is not the code/);
  assert.doesNotMatch(forged.cfg, /linkedin_links: true/);
  const { code } = issueCode(TOKEN, 'linkedin_links', true, join(home, 'feature-code.json'));
  const real = run(['yes', code])!;
  assert.match(real.out, /linkedin_links: on/);
  assert.match(real.cfg, /linkedin_links: true/);
});
