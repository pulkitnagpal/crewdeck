import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familiesFromTitles } from '../../src/jobs/planned-run.ts';

test('familiesFromTitles: a field from old title lists', () => {
  assert.deepEqual(familiesFromTitles(['Backend Engineer', 'AI Engineer']).sort(), ['data', 'engineering-it']);
  assert.deepEqual(familiesFromTitles(['Registered Nurse']), ['healthcare']);
  assert.deepEqual(familiesFromTitles(['Product Manager']), ['product']);
  assert.deepEqual(familiesFromTitles(['Chef']), []);
});
