// ADR-0008: `crewdeck jobs portals …` in a child process with a temp CREWDECK_HOME (no browser is opened here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobs, tempSetup } from './helpers.ts';
import { JOBS_COMMANDS } from '../../src/jobs/cli.ts';
import { updatePortal } from '../../src/jobs/portals/state.ts';

test('portals is a jobs command with list, connect, disconnect, test, on and off', () => {
  assert.ok(JOBS_COMMANDS.includes('portals'));
  const s = tempSetup('example');
  const h = jobs(s.home, ['portals', '--help']);
  assert.equal(h.code, 0);
  for (const v of ['list', 'connect <id> [--signup]', 'disconnect <id>', 'test <id>', 'on <id> | off <id>']) assert.ok(h.out.includes(v), v);
  assert.match(jobs(s.home, ['help']).out, /portals list\|connect <id> \[--signup\]/);
});

test('portals list: every portal and where it stands (text and JSON)', () => {
  const s = tempSetup('example');
  const r = jobs(s.home, ['portals', 'list', '--json']);
  assert.equal(r.code, 0, r.err);
  const v = JSON.parse(r.out);
  assert.ok(v.portals.some((p: any) => p.id === 'naukri' && p.state === 'not_connected' && p.risk && p.login_url.startsWith('https://')));
  updatePortal(s.jobsHome, 'cutshort', () => ({ connected: true, last_scan: '2026-11-21T08:00:00.000Z', last_found: 7 }));
  const t = jobs(s.home, ['portals', 'list']);
  assert.match(t.out, /^cutshort\s+Cutshort\s+connected, last scan 2026-11-21 08:00 \(7 found\)/m);
  assert.match(t.out, /^naukri\s+Naukri\s+not connected\s+\[in\]\s+\(URLs unverified\)/m);
});

test('portals on/off: only a connected portal is switched on; the note gets the row and a Changes line', () => {
  const s = tempSetup('example');
  const no = jobs(s.home, ['portals', 'on', 'naukri']);
  assert.equal(no.code, 1);
  assert.match(no.err, /Connect Naukri first \(crewdeck jobs portals connect naukri\)/);
  updatePortal(s.jobsHome, 'naukri', () => ({ connected: true }));
  const on = jobs(s.home, ['portals', 'on', 'naukri']);
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /jobs\/sources\.md: added the portal Naukri/);
  const note = readFileSync(join(s.vault, 'jobs', 'sources.md'), 'utf8');
  assert.match(note, /\{ key: portal-naukri, name: Naukri, portal: naukri, added: \d{4}-\d{2}-\d{2} \}/);
  assert.match(note, /Naukri\*\*: signed-in portal, on/);
  assert.match(jobs(s.home, ['portals', 'on', 'naukri']).out, /already on/);
  assert.match(jobs(s.home, ['portals', 'off', 'naukri']).out, /switched off Naukri/);
  // The note stays valid, and the providers' plan doesn't treat the row as a board.
  const chk = jobs(s.home, ['check']);
  assert.doesNotMatch(chk.out, /portal/i);
  assert.match(jobs(s.home, ['sources', 'list']).out, /Naukri/);
});

test('portals: unknown ids and verbs are refused before anything opens', () => {
  const s = tempSetup('example');
  for (const args of [['connect', 'nope'], ['test', 'NAUKRI'], ['disconnect'], ['frobnicate', 'naukri']]) {
    const r = jobs(s.home, ['portals', ...args]);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /no portal|give a portal id|unknown verb/);
  }
});
