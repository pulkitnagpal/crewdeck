// Company-set selector (ADR-0001/0002): verified boards only by default, field × place fit, remote-friendly first for
// remote seekers, deterministic order, a reason on every pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCompanies } from '../../../src/jobs/directory/select.ts';

test('India on-site tech: India employers, verified only, each with reasons', () => {
  const s = selectCompanies({ families: ['engineering-it'], countries: ['in/bengaluru'], workModes: ['onsite'], limit: 15 });
  assert.equal(s.picks.length, 15);
  const names = s.picks.map((p) => p.name);
  for (const n of ['Groww', 'Razorpay', 'CRED', 'Meesho']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('PhonePe'), 'quarantined board left out');
  assert.ok(s.picks.every((p) => p.reasons.length && p.reasons.some((r) => r.startsWith('hires in in'))), 'every pick hires in India');
  assert.deepEqual(s, selectCompanies({ families: ['engineering-it'], countries: ['in/bengaluru'], workModes: ['onsite'], limit: 15 }), 'deterministic');
});

test('quarantined entries only when asked', () => {
  const q = { families: ['engineering-it'], countries: ['in'], workModes: ['onsite' as const], limit: 100 };
  assert.ok(!selectCompanies(q).picks.some((p) => p.id === 'greenhouse:phonepe'));
  const withQ = selectCompanies({ ...q, includeQuarantine: true }).picks.find((p) => p.id === 'greenhouse:phonepe')!;
  assert.ok(withQ.reasons.some((r) => r.startsWith('quarantined')));
});

test('remote seeker: remote-friendly employers come first', () => {
  const s = selectCompanies({ families: ['engineering-it'], countries: ['in'], workModes: ['remote'], limit: 10 });
  const firstNonRemote = s.picks.findIndex((p) => p.remote !== true);
  const remoteCount = s.picks.filter((p) => p.remote === true).length;
  assert.ok(remoteCount >= 5, `${remoteCount} remote-friendly`);
  assert.ok(firstNonRemote === -1 || s.picks.slice(firstNonRemote).every((p) => p.remote !== true));
  for (const n of ['GitLab', 'Automattic']) assert.ok(s.picks.some((p) => p.name === n), n);
});

test('US nurse: verified hospital systems lead; no tech-only boards', () => {
  const s = selectCompanies({ families: ['healthcare'], countries: ['us'], workModes: ['onsite'], size: 'large', limit: 10 });
  assert.deepEqual(s.picks.slice(0, 4).map((p) => p.name).sort(), ["Children's Hospital of Philadelphia", 'Mass General Brigham', 'Providence', 'The Ohio State University (incl. Wexner Medical Center)']);
  assert.ok(!s.picks.some((p) => /Cleveland Clinic|Sutter/.test(p.name)), 'unverified tenants stay out');
  assert.ok(s.picks.every((p) => p.reasons.some((r) => /healthcare/.test(r))));
});

test('a field and place the directory barely knows says so', () => {
  const s = selectCompanies({ families: ['healthcare'], countries: ['in'], workModes: ['onsite'], limit: 10 });
  assert.ok(s.picks.length < 10);
  assert.match(s.note, /strong matches|no directory company/);
});
