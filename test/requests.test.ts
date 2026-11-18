import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
