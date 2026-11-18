import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Requests, laneFor } from '../src/requests.ts';

test('requests: claimed once per lane, closed once, put back, failed after 3 tries', () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  const a = q.add('project:myapp', 'take TASK-3');
  q.add('cockpit', 'plan my week');
  assert.throws(() => q.add('project:../x', 'nope'), /bad lane/);
  assert.throws(() => q.add('cockpit', '  '), /empty/);
  assert.deepEqual(q.claim('project:myapp', 's1').map((r) => r.id), [a.id]);
  assert.equal(q.claim('project:myapp', 's2').length, 0); // never twice
  assert.deepEqual(q.requeue([a.id], 's2'), []); // only the session that took it can put it back
  assert.deepEqual(q.requeue([a.id], 's1'), [a.id]);
  q.claim('project:myapp', 's1'); q.requeue([a.id], 's1');
  q.claim('project:myapp', 's1'); q.requeue([a.id], 's1');
  assert.equal(q.list().find((r) => r.id === a.id)!.status, 'failed');
  const b = q.add('cockpit', 'x'); q.claim('cockpit', 's1');
  assert.equal(q.finish(b.id, 'done!').status, 'done');
  assert.throws(() => q.finish(b.id, 'again'), /not open/);
});

test('lanes: a project folder or its worktrees → that project; anything else → cockpit', () => {
  const c: any = { projects: [{ name: 'myapp', path: '/code/myapp' }] };
  assert.equal(laneFor(c, '/code/myapp'), 'project:myapp');
  assert.equal(laneFor(c, '/code/myapp/.claude/worktrees/t-12'), 'project:myapp');
  assert.equal(laneFor(c, '/code/myappdeck'), 'cockpit');
  assert.equal(laneFor(c, '/Users/me'), 'cockpit');
});

test('requests: open ones per lane are capped, adds are rate-limited, and saving never drops an open request', async () => {
  const { MAX_OPEN_PER_LANE } = await import('../src/requests.ts');
  const file = join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json');
  const q = new Requests(file);
  for (let i = 0; i < MAX_OPEN_PER_LANE; i++) q.add('cockpit', `r${i}`);
  assert.throws(() => q.add('cockpit', 'one more'), /too many open/);
  q.add('project:a', 'other lanes are separate');
  // Old closed requests go; open ones stay however old.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw[0].updated = raw[0].created = '2020-01-01T00:00:00.000Z';
  raw[1].status = 'done'; raw[1].updated = '2020-01-01T00:00:00.000Z';
  writeFileSync(file, JSON.stringify(raw));
  const q2 = new Requests(file);
  q2.add('project:b', 'triggers a save');
  const ids = q2.list(100).map((r) => r.id);
  assert.ok(ids.includes(raw[0].id), 'an old open request is kept');
  assert.ok(!ids.includes(raw[1].id), 'an old closed request is dropped');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const q3 = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'r.json'));
  for (let i = 0; i < 30; i++) { const r = q3.add('project:c', `x${i}`); q3.finish(r.id, 'ok'); }
  assert.throws(() => q3.add('project:c', 'flood'), /in a minute/);
});
