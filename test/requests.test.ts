import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEASE_MS, Requests, laneFor } from '../src/requests.ts';

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

test('jobs lane: typed requests only, deduped while open (payload key order too), payload cleared on close, progress capped', async () => {
  const { MAX_PROGRESS } = await import('../src/requests.ts');
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  assert.throws(() => q.add('jobs', 'apply to everything'), /only requests made by the Jobs page/);
  assert.throws(() => q.add('jobs', 'x', { kind: 'nope' as any }), /unknown request kind/);
  assert.throws(() => q.add('jobs', 'x', { kind: 'apply', ref: '../x' }), /bad request ref/);
  assert.throws(() => q.add('jobs', 'x', { kind: 'link', payload: { url: 'u'.repeat(5000) } }), /too large/);
  const a = q.add('jobs', 'Apply to a role', { kind: 'apply', ref: 'abcdefabcdef', payload: { role: 'abcdefabcdef', x: 1 } });
  assert.equal(q.add('jobs', 'Apply to a role', { kind: 'apply', ref: 'abcdefabcdef', payload: { x: 1, role: 'abcdefabcdef' } }).id, a.id);
  assert.notEqual(q.add('jobs', 'Apply to a role', { kind: 'apply', ref: '123456123456', payload: { role: '123456123456' } }).id, a.id);
  assert.notEqual(q.add('jobs', 'Improve', { kind: 'improve', ref: 'abcdefabcdef', payload: { role: 'abcdefabcdef', x: 1 } }).id, a.id, 'another kind');
  for (let i = 0; i < MAX_PROGRESS + 5; i++) q.progress(a.id, `line ${i}\n  with   spaces`);
  const r = q.get(a.id)!;
  assert.equal(r.progress!.length, MAX_PROGRESS);
  assert.equal(r.progress!.at(-1)!.text, `line ${MAX_PROGRESS + 4} with spaces`);
  assert.throws(() => q.progress(a.id, '   '), /empty/);
  q.finish(a.id, 'needs you: What is your notice period?');
  assert.equal(q.get(a.id)!.payload, undefined);
  assert.equal(q.get(a.id)!.progress!.length, MAX_PROGRESS, 'Claude\'s lines stay');
  assert.throws(() => q.progress(a.id, 'late'), /not open/);
  assert.notEqual(q.add('jobs', 'Apply to a role', { kind: 'apply', ref: 'abcdefabcdef', payload: { role: 'abcdefabcdef', x: 1 } }).id, a.id, 'closed ones are not reused');
  assert.equal(q.latest('jobs', 'apply', 'abcdefabcdef')!.status, 'new');
  // Caps hold for typed requests too, per kind (W10): twenty open finds don't block an Apply.
  for (let i = 0; q.ofLane('jobs', 'find').filter((x) => x.status === 'new').length < 20; i++) q.add('jobs', 'Find jobs', { kind: 'find', payload: { count: (i % 20) + 1 } });
  assert.throws(() => q.add('jobs', 'Find jobs', { kind: 'find', payload: { count: 99 } }), /too many open find requests/);
  assert.ok(q.add('jobs', 'Set up', { kind: 'setup', payload: {} }).id, 'another kind still queues');
  assert.ok(q.add('jobs', 'Apply to a role', { kind: 'apply', ref: 'fedcbafedcba', payload: { role: 'fedcbafedcba' } }).id, 'Apply has its own cap');
});

test('C4: presence is a claim in the last 10 s (a picked request or progress alone is not); a busy claim takes nothing', () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  const a = q.add('jobs', 'Apply', { kind: 'apply', ref: 'aaaaaaaaaaaa', payload: { role: 'aaaaaaaaaaaa' } });
  assert.deepEqual(q.claim('jobs', 's1').map((r) => r.id), [a.id]);
  const b = q.add('jobs', 'Find', { kind: 'find', payload: { count: 3 } });
  (q as any).seen.clear();
  assert.equal(q.presence('jobs').connected, false, 'holding a picked request is not presence');
  q.progress(a.id, 'Step 1 of 3');
  assert.equal(q.presence('jobs').connected, false, 'progress is not presence');
  assert.deepEqual(q.claim('jobs', 's1', false), [], 'a busy session\'s heartbeat takes nothing');
  assert.equal(q.presence('jobs').connected, true);
  assert.equal(q.get(b.id)!.status, 'new');
});

test('C4: a lease: picked with no word from its session for 15 min goes back (tries + 1, failed after 3); heartbeats and progress renew it', () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  const a = q.add('jobs', 'Apply', { kind: 'apply', ref: 'aaaaaaaaaaaa', payload: { role: 'aaaaaaaaaaaa' } });
  const t0 = Date.now();
  q.claim('jobs', 's1');
  assert.deepEqual(q.expire(t0 + LEASE_MS - 1000), [], 'still within the lease');
  q.claim('jobs', 's1', false); // heard from, now
  assert.deepEqual(q.expire(Date.now() + LEASE_MS - 1000), []);
  assert.deepEqual(q.expire(Date.now() + LEASE_MS + 1000), [a.id], 'the session went quiet: back to the queue');
  assert.equal(q.get(a.id)!.status, 'new');
  assert.equal(q.get(a.id)!.tries, 1);
  q.claim('jobs', 's2'); q.expire(Date.now() + LEASE_MS + 1000);
  q.claim('jobs', 's3'); q.expire(Date.now() + LEASE_MS + 1000);
  assert.equal(q.get(a.id)!.status, 'failed', 'after three tries it fails instead of looping');
  assert.match(q.get(a.id)!.result!, /stopped answering/);
  assert.equal(q.get(a.id)!.payload, undefined);
});

test('C4: Cancel closes an open request of its lane as failed; nothing else', () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  const a = q.add('jobs', 'Apply', { kind: 'apply', ref: 'aaaaaaaaaaaa', payload: { role: 'aaaaaaaaaaaa' } });
  const p = q.add('project:x', 'do a thing');
  q.claim('jobs', 's1');
  assert.throws(() => q.cancel(p.id, 'jobs'), /not open/, 'another lane');
  assert.equal(q.cancel(a.id, 'jobs').status, 'failed');
  assert.equal(q.get(a.id)!.result, 'Cancelled on the page');
  assert.equal(q.get(a.id)!.payload, undefined);
  assert.throws(() => q.cancel(a.id, 'jobs'), /not open/);
  assert.throws(() => q.finish(a.id, 'done late'), /not open/, 'Claude closing it afterwards is refused');
});

test('presence: a claim in the last 10 s; reconcile closes applied/skipped roles', () => {
  const q = new Requests(join(mkdtempSync(join(tmpdir(), 'cdq-')), 'requests.json'));
  assert.deepEqual(q.presence('jobs'), { connected: false, seen: null });
  q.claim('jobs', 's1');
  assert.equal(q.presence('jobs').connected, true);
  assert.equal(q.presence('cockpit').connected, false, 'per lane');
  const a = q.add('jobs', 'Apply', { kind: 'apply', ref: 'aaaaaaaaaaaa', payload: { role: 'aaaaaaaaaaaa' } });
  const b = q.add('jobs', 'Improve', { kind: 'improve', ref: 'bbbbbbbbbbbb', payload: { role: 'bbbbbbbbbbbb', field_id: 1 } });
  const c = q.add('jobs', 'Apply', { kind: 'apply', ref: 'cccccccccccc', payload: { role: 'cccccccccccc' } });
  const f = q.add('jobs', 'Find', { kind: 'find', payload: { count: 3 } });
  let changes = 0;
  q.onChange(() => changes++);
  const closed = q.reconcile((ref) => ({ aaaaaaaaaaaa: 'applied', bbbbbbbbbbbb: 'skipped', cccccccccccc: 'picked' } as Record<string, string>)[ref]);
  assert.deepEqual(closed, [a.id, b.id]);
  assert.match(q.get(a.id)!.result!, /already applied/);
  assert.match(q.get(b.id)!.result!, /already skipped/);
  assert.equal(q.get(a.id)!.payload, undefined);
  assert.equal(q.get(c.id)!.status, 'new');
  assert.equal(q.get(f.id)!.status, 'new', 'requests with no role stay');
  assert.equal(changes, 1);
  assert.deepEqual(q.reconcile(() => 'applied').length, 1, 'only c is left with a role');
});

test('lanes: the jobs workspace is checked before projects, and only when Jobs is on', () => {
  const c: any = { projects: [{ name: 'myapp', path: '/code/myapp' }], jobs: { enabled: true, workspace: '/code/myapp/jobs' } };
  assert.equal(laneFor(c, '/code/myapp/jobs'), 'jobs');
  assert.equal(laneFor(c, '/code/myapp/jobs/sub'), 'jobs');
  assert.equal(laneFor(c, '/code/myapp/jobsx'), 'project:myapp');
  assert.equal(laneFor({ ...c, jobs: { ...c.jobs, enabled: false } }, '/code/myapp/jobs'), 'project:myapp');
});
