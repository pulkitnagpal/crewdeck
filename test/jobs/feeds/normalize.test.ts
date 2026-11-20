// Location/remote normalisation tables, employment types, pay, dates and HTML → text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countriesIn, countryCode, employmentType, isoDate, normalisePlace, pay, postedAgo, remoteScope, workplaceWord } from '../../../src/jobs/feeds/normalize.ts';
import { htmlToText } from '../../../src/jobs/feeds/html.ts';

test('remote scope: countries, regions and anywhere', () => {
  const table: [string, string[] | ((r: string[]) => boolean)][] = [
    ['Remote - India', ['IN']],
    ['Remote-USA', ['US']],
    ['Remote- USA', ['US']],
    ['US only', ['US']],
    ['Remote (US only)', ['US']],
    ['Remote, Germany or Poland', ['DE', 'PL']],
    ['Anywhere', ['*']],
    ['Worldwide', ['*']],
    ['Remote - Global', ['*']],
    ['Remote', []],
    ['Remote job', []],
    ['North America', ['CA', 'MX', 'US']],
    ['Remote (APAC)', (r) => ['IN', 'AU', 'SG', 'JP'].every((c) => r.includes(c)) && !r.includes('DE') && !r.includes('US')],
    ['EMEA Remote', (r) => ['DE', 'GB', 'AE', 'ZA'].every((c) => r.includes(c)) && !r.includes('US')],
    ['Remote - Europe', (r) => ['DE', 'FR', 'PL'].every((c) => r.includes(c)) && !r.includes('IN')],
    ['LATAM', (r) => ['BR', 'MX', 'AR'].every((c) => r.includes(c)) && !r.includes('US')],
  ];
  for (const [text, want] of table) {
    const got = remoteScope(text);
    if (typeof want === 'function') assert.ok(want(got), `${text} → ${got.join(',')}`);
    else assert.deepEqual(got, want, text);
  }
});

test('countries in location strings and country names/codes', () => {
  const table: [string, string[]][] = [
    ['US, CA, Santa Clara', ['US']], ['India, Bengaluru', ['IN']], ['Bengaluru, India', ['IN']], ['San Francisco, CA', ['US']],
    ['Barcelona, Spain', ['ES']], ['İstanbul, İstanbul, Türkiye', ['TR']], ['Berlin', ['DE']], ['München', ['DE']], ['Georgia', []], ['APAC', []],
  ];
  for (const [t, want] of table) assert.deepEqual(countriesIn(t), want, t);
  for (const [t, want] of [['United States', 'US'], ['United States of America', 'US'], ['us', 'US'], ['UK', 'GB'], ['Deutschland', 'DE'], ['Türkiye', 'TR'], ['SG', 'SG'], ['XX', ''], ['', '']]) assert.equal(countryCode(t), want, t);
});

test('normalisePlace: structured fields first, text second', () => {
  // Lever: remote + a region + the country field
  assert.deepEqual(normalisePlace({ locations: ['North America'], countries: ['US'], workplace: 'remote' }), { locations: ['North America'], countries: ['US'], workplace: 'remote', remoteCountries: ['CA', 'MX', 'US'] });
  // Ashby: "US - Remote" with office cities
  const a = normalisePlace({ locations: ['US - Remote', 'New York City', 'Seattle'], countries: ['United States'], workplace: 'Remote' });
  assert.deepEqual([a.workplace, a.remoteCountries, a.countries], ['remote', ['US'], ['US']]);
  // remote flag only, no place in the text: the board's country
  assert.deepEqual(normalisePlace({ locations: ['Remote'], countries: ['IN'], remote: true }).remoteCountries, ['IN']);
  // remote, nothing known
  assert.deepEqual(normalisePlace({ locations: ['Remote'] }).remoteCountries, []);
  assert.equal(normalisePlace({ locations: ['Remote'] }).workplace, 'remote');
  // anywhere wins
  assert.deepEqual(normalisePlace({ locations: ['Anywhere', 'Berlin'], remote: true }).remoteCountries, ['*']);
  // workplace words
  assert.equal(normalisePlace({ locations: ['London (Hybrid)'] }).workplace, 'hybrid');
  assert.equal(normalisePlace({ locations: ['Austin, TX'] }).workplace, 'unknown');
  assert.equal(normalisePlace({ locations: ['Austin, TX'], workplace: 'OnSite' }).workplace, 'onsite');
  // hybrid / on-site roles have no remote countries
  assert.deepEqual(normalisePlace({ locations: ['Remote - India'], workplace: 'hybrid' }).remoteCountries, []);
  for (const [w, want] of [['Remote', 'remote'], ['OnSite', 'onsite'], ['on-site', 'onsite'], ['none', 'onsite'], ['fully', 'remote'], ['Hybrid', 'hybrid'], ['unspecified', ''], [null, '']]) assert.equal(workplaceWord(w), want, String(w));
});

test('employment types, pay and dates', () => {
  for (const [v, want] of [['Full-time', 'full_time'], ['FullTime', 'full_time'], ['fulltime_permanent', 'full_time'], ['Part-Time', 'part_time'], ['Intern', 'internship'],
    ['Contract', 'contract'], ['fulltime_fixed_term', 'temporary'], ['Scholarship', 'other'], ['', '']] as const) assert.equal(employmentType(v), want, v);
  assert.deepEqual(pay(207000, 285000, 'usd', '1 YEAR'), { min: 207000, max: 285000, currency: 'USD', period: 'year' });
  assert.deepEqual(pay(null, 40, 'EUR', 'per-hour-wage'), { min: null, max: 40, currency: 'EUR', period: 'hour' });
  assert.equal(pay(null, null, 'INR', 'year'), undefined);
  assert.equal(isoDate('2026-11-18 16:23:32 UTC'), '2026-11-18T16:23:32.000Z');
  assert.equal(isoDate(1786469891368), '2026-08-11T17:38:11.368Z');
  assert.equal(isoDate('Mon, 16 Nov 2026 10:25:07 +0100'), '2026-11-16T09:25:07.000Z');
  assert.equal(isoDate('garbage'), '');
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(postedAgo('Posted Today', now), '2026-11-20T12:00:00.000Z');
  assert.equal(postedAgo('Posted 30+ Days Ago', now), '2026-10-21T12:00:00.000Z');
  assert.equal(postedAgo('?', now), '');
});

test('HTML → text keeps paragraphs and bullets, decodes entities, drops scripts', () => {
  assert.equal(htmlToText('<p>About&nbsp;us</p><ul><li>Ship &amp; learn</li><li><p>Grow</p></li></ul><script>alert(1)</script><p>Bye</p>'), 'About us\n- Ship & learn\n- Grow\nBye');
  assert.equal(htmlToText('&lt;p&gt;Escaped &amp;amp; twice&lt;/p&gt;'), 'Escaped & twice');
  assert.equal(htmlToText('a < b and <unclosed'), 'a < b and <unclosed');
  const long = '<p>' + 'x'.repeat(50_000) + '</p>';
  assert.equal(htmlToText(long).length, 50_000, 'never clipped');
  // linear on hostile input
  const t = Date.now();
  htmlToText('<a'.repeat(200_000));
  assert.ok(Date.now() - t < 2000);
});
