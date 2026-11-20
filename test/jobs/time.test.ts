import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayBounds, dayIn, daysBetween, zoneOf } from '../../src/jobs/time.ts';

test('the same instant is a different local day on each side of a UTC midnight', () => {
  const late = '2026-11-19T23:30:00Z';
  assert.equal(dayIn('Europe/Berlin', late), '2026-11-20');
  assert.equal(dayIn('America/Chicago', late), '2026-11-19');
  assert.equal(dayIn('Asia/Tokyo', '2026-11-19T14:59:59Z'), '2026-11-19');
  assert.equal(dayIn('Asia/Tokyo', '2026-11-19T15:00:00Z'), '2026-11-20');
});

test('day bounds are the local midnights in UTC (winter, summer, half-hour zones, DST days)', () => {
  assert.deepEqual(dayBounds('Europe/Berlin', '2026-11-20'), ['2026-11-19T23:00:00.000Z', '2026-11-20T23:00:00.000Z']);
  assert.deepEqual(dayBounds('America/Chicago', '2026-11-19'), ['2026-11-19T06:00:00.000Z', '2026-11-20T06:00:00.000Z']);
  assert.deepEqual(dayBounds('Europe/Berlin', '2026-07-01'), ['2026-06-30T22:00:00.000Z', '2026-07-01T22:00:00.000Z']);
  assert.deepEqual(dayBounds('Asia/Kathmandu', '2026-11-19'), ['2026-11-18T18:15:00.000Z', '2026-11-19T18:15:00.000Z']);
  // The day Chicago leaves summer time has 25 hours.
  const [s, e] = dayBounds('America/Chicago', '2026-11-01');
  assert.equal((Date.parse(e) - Date.parse(s)) / 3_600_000, 25);
});

test('helpers: next day, days between, unknown zones fall back to the system zone', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(daysBetween('2026-11-13', '2026-11-17'), 4);
  assert.equal(zoneOf('Not/AZone'), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(zoneOf('Europe/Berlin'), 'Europe/Berlin');
});
