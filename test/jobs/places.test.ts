import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, compatible, findPlaces, lookupPlace, reducePlaces, within } from '../../src/jobs/places.ts';

const named = (s: string) => reducePlaces(findPlaces(s));

test('aliases and other names resolve to the same place', () => {
  for (const n of ['USA', 'US', 'United States', 'U.S.', 'United States of America']) assert.deepEqual(lookupPlace(n), ['us'], n);
  for (const n of ['UK', 'United Kingdom', 'Great Britain', 'England']) assert.deepEqual(lookupPlace(n), ['gb'], n);
  assert.deepEqual(lookupPlace('München'), ['de/munich']);
  assert.deepEqual(lookupPlace('Bangalore'), ['in/bengaluru']);
  assert.deepEqual(lookupPlace('worldwide'), ['world']);
  assert.deepEqual(lookupPlace('Anywhere'), ['world']);
  assert.deepEqual(lookupPlace('Georgia')?.sort(), ['ge', 'us-ga']);
  assert.equal(lookupPlace('Springfield'), null);
});

test('containment: city ⊂ state/country ⊂ regions', () => {
  assert.ok(within('de/berlin', 'european-union'));
  for (const r of ['de', 'dach', 'european-union', 'eea', 'europe', 'emea', 'world']) assert.ok(ancestors('de/berlin').has(r), r);
  assert.ok(within('us/austin', 'us-tx') && within('us/austin', 'north-america') && within('us/austin', 'americas'));
  assert.ok(within('ca/toronto', 'ca-on') && within('ca-on', 'ca'));
  assert.ok(within('in/pune', 'south-asia') && within('in/pune', 'apac') && !within('in/pune', 'emea'));
  assert.ok(within('sg', 'southeast-asia') && within('au/sydney', 'oceania') && within('br/sao-paulo', 'latam'));
  assert.ok(within('no', 'nordics') && within('no', 'eea') && !within('no', 'european-union'));
  assert.ok(within('ae/dubai', 'middle-east') && within('ae', 'mena') && within('eg', 'africa'));
  assert.ok(within('ch/zurich', 'dach') && !within('ch', 'european-union'));
  assert.ok(within('mx', 'latam') && within('mx', 'north-america'));
});

test('finding places: codes only in capitals, state codes after a comma, most specific wins', () => {
  assert.deepEqual(named('Remote, US only'), [['us']]);
  assert.deepEqual(named('tell us about yourself'), []);
  assert.deepEqual(named('Munich, Germany'), [['de/munich']]);
  assert.deepEqual(named('Austin, TX'), [['us/austin']]);
  assert.deepEqual(named('Cambridge, MA'), [['us/cambridge-ma']]);
  assert.deepEqual(named('Washington, DC'), [['us/washington-dc']]);
  assert.deepEqual(named('Zürich or Köln'), [['ch/zurich'], ['de/cologne']]);
  assert.deepEqual(named('Tel-Aviv'), [['il/tel-aviv']]);
  assert.deepEqual(named('Unter einem Dach arbeiten'), [], '"Dach" is a word; DACH a region');
  assert.deepEqual(named('Remote (DACH)'), [['dach']]);
  assert.deepEqual(named('Remote - Worldwide'), [['world']]);
  assert.deepEqual(named('OR, we could'), [], 'abbreviations only after a comma');
});

test('compatibility: either contains the other, or cities within commuting distance', () => {
  assert.ok(compatible('de/berlin', 'european-union'));
  assert.ok(compatible('de', 'de/berlin'));
  assert.ok(compatible('de/berlin', 'de/potsdam', 50));
  assert.ok(!compatible('de/berlin', 'de/munich', 50));
  assert.ok(!compatible('de/berlin', 'us'));
  assert.ok(compatible('us-tx', 'us') && compatible('us-tx', 'us/dallas'));
  assert.ok(!compatible('us-tx', 'us-az'));
  assert.ok(compatible('pt/lisbon', 'world'));
  const custom = lookupPlace('Smalltown, Germany')!;
  assert.ok(compatible(custom[0], 'de/berlin'), 'a town without coordinates in the same country: left to the judge');
  assert.ok(!compatible(custom[0], 'fr/paris'));
});
