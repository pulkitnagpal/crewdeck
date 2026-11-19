import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type PaySettings, convertAmount, findPayText, parsePay, payCheck, payDrops } from '../../src/jobs/pay.ts';

// [text, currencies, min, max, period]
const cases: [string, string[], number | null, number | null, string | null][] = [
  ['₹40L – ₹1Cr', ['INR'], 4_000_000, 10_000_000, null],
  ['35–70 LPA', ['INR'], 3_500_000, 7_000_000, 'year'],
  ['₹66.2L – ₹96.6L', ['INR'], 6_620_000, 9_660_000, null],
  ['INR 12 lakhs per annum', ['INR'], 1_200_000, 1_200_000, 'year'],
  ['₹1.5 crore', ['INR'], 15_000_000, 15_000_000, null],
  ['$60K–$120K', ['USD'], 60_000, 120_000, null],
  ['US$30/hr', ['USD'], 30, 30, 'hour'],
  ['USD 150000-200000 per year', ['USD'], 150_000, 200_000, 'year'],
  ['$45 - $60 per hour', ['USD'], 45, 60, 'hour'],
  ['€120–200K', ['EUR'], 120_000, 200_000, null],
  ['€55.000 – €70.000 brutto pro Jahr', ['EUR'], 55_000, 70_000, 'year'],
  ['4.500 € /Monat', ['EUR'], 4_500, 4_500, 'month'],
  ['60k-80k EUR', ['EUR'], 60_000, 80_000, null],
  ['€500/day', ['EUR'], 500, 500, 'day'],
  ['£45,000 - £55,000 a year', ['GBP'], 45_000, 55_000, 'year'],
  ['GBP 600 per day', ['GBP'], 600, 600, 'day'],
  ['CHF 120\'000', ['CHF'], 120_000, 120_000, null],
  ['C$95,000–110,000', ['CAD'], 95_000, 110_000, null],
  ['A$140k + super', ['AUD'], 140_000, 140_000, null],
  ['S$8,000 per month', ['SGD'], 8_000, 8_000, 'month'],
  ['¥6,000,000', ['JPY', 'CNY'], 6_000_000, 6_000_000, null],
  ['JPY 8M per year', ['JPY'], 8_000_000, 8_000_000, 'year'],
  ['kr 650 000 per år', ['SEK', 'NOK', 'DKK', 'ISK'], 650_000, 650_000, 'year'],
  ['R$ 12.000 mensais', ['BRL'], 12_000, 12_000, 'month'],
  ['$1,200 per week', ['USD'], 1_200, 1_200, 'week'],
  ['up to 120k USD', ['USD'], null, 120_000, null],
  ['from €60k', ['EUR'], 60_000, null, null],
  ['€1,5 Mio. pro Jahr', ['EUR'], 1_500_000, 1_500_000, 'year'],
];
for (const [text, cur, min, max, period] of cases) {
  test(`parsePay(${JSON.stringify(text)})`, () => {
    const p = parsePay(text)!;
    assert.ok(p, 'parsed');
    assert.deepEqual([p.currencies, p.min, p.max, p.period], [cur, min, max, period]);
  });
}

test('no pay: words, numbers without a currency', () => {
  assert.equal(parsePay('competitive'), null);
  assert.equal(parsePay('5+ years of experience'), null);
  assert.equal(parsePay(''), null);
});

test('a bare $ also reads as the user\'s own dollar currency', () => {
  assert.deepEqual(parsePay('$100k', 'CAD')!.currencies, ['USD', 'CAD']);
  assert.deepEqual(parsePay('$100k', 'EUR')!.currencies, ['USD']);
});

test('findPayText skips funding, bonuses and budgets', () => {
  assert.match(findPayText('We raised $20M in our Series A. Salary: $120,000 - $150,000 per year plus a $5,000 sign-on bonus.')!, /^\$120,000 - \$150,000 per year/);
  assert.equal(findPayText('A $5,000 sign-on bonus.'), undefined);
  assert.equal(findPayText('Join us! $10,000 relocation budget. Base pay $90k-$110k.'), '$90k-$110k');
  assert.equal(findPayText('No numbers here.'), undefined);
});

test('convertAmount: currency by the user\'s fx table, period by hours', () => {
  assert.equal(convertAmount(100, { currency: 'USD', period: 'hour' }, { currency: 'USD', period: 'year' }, {}), 208_000);
  assert.equal(convertAmount(120_000, { currency: 'USD', period: 'year' }, { currency: 'EUR', period: 'month' }, { USD: 0.9 }), 9_000);
  assert.equal(convertAmount(10, { currency: 'GBP', period: 'hour' }, { currency: 'EUR', period: 'hour' }, {}), null);
});

const eurYear: PaySettings = { currency: 'EUR', floor: 55_000, period: 'year', rule: 'top_of_range', unlisted: 'keep', fx: { USD: 0.92, GBP: 1.17 }, locale: 'de-DE' };
const usdHour: PaySettings = { currency: 'USD', floor: 42, period: 'hour', rule: 'bottom_of_range', unlisted: 'keep', fx: {} };
const inrYear: PaySettings = { currency: 'INR', floor: 4_000_000, period: 'year', rule: 'top_of_range', unlisted: 'drop', fx: { USD: 85, EUR: 92 } };

test('floor rules: top_of_range, bottom_of_range, conversion, unlisted keep/drop, no rate, unclear periods', () => {
  const status = (t: string | null, s: PaySettings) => payCheck(t, '', s).status;
  assert.equal(status('€50.000 – €60.000', eurYear), 'ok', 'top reaches the floor');
  assert.equal(status('€40.000 – €50.000', eurYear), 'unclear', 'no period: below as a year, above as a month');
  assert.equal(status('€40.000 – €50.000 pro Jahr', eurYear), 'below_floor');
  assert.equal(status('$55,000 - $65,000 per year', eurYear), 'ok', '65k USD = 59.8k EUR');
  assert.equal(status('$45,000 - $55,000 per year', eurYear), 'below_floor');
  assert.equal(status('£3,500 per month', eurYear), 'below_floor', '3,500 × 12 × 1.17 = 49,140 EUR');
  assert.equal(status('£4,000 per month', eurYear), 'ok', '56,160 EUR');
  assert.equal(status('CHF 90,000', eurYear), 'no_rate');
  assert.equal(status('€4.000', eurYear), 'unclear', 'small amount, no period');
  assert.equal(status(null, eurYear), 'unlisted');
  assert.equal(status('up to €50k a year', eurYear), 'below_floor', 'even the top is below');
  assert.equal(status('up to €50k', eurYear), 'unclear', 'no period');
  assert.equal(status('from €50k', eurYear), 'ok', 'no top: never dropped by top_of_range');
  assert.equal(status('$40 - $50 per hour', usdHour), 'below_floor', 'bottom below');
  assert.equal(status('$42 - $50 per hour', usdHour), 'ok');
  assert.equal(status('up to $60/hr', usdHour), 'ok', 'no bottom: kept');
  assert.equal(status('$80,000 per year', usdHour), 'below_floor', '80,000 / 2080 = 38.46 an hour');
  assert.equal(status('$95,000 per year', usdHour), 'ok', '45.67 an hour');
  assert.equal(status('35–70 LPA', inrYear), 'ok');
  assert.equal(status('₹20–35L per annum', inrYear), 'below_floor');
  assert.equal(status('$40k–$45k a year', inrYear), 'below_floor', '45k USD = 38.25L INR');
  assert.equal(status('$40k–$45k', inrYear), 'unclear', 'no period: 45k a month is above');
  assert.ok(payDrops(payCheck(null, 'no pay mentioned', inrYear), inrYear), 'unlisted: drop');
  assert.ok(!payDrops(payCheck(null, 'no pay mentioned', eurYear), eurYear), 'unlisted: keep');
});

test('ambiguous currency: dropped only when every reading is below the floor', () => {
  const cad: PaySettings = { currency: 'CAD', floor: 100_000, period: 'year', rule: 'top_of_range', unlisted: 'keep', fx: { USD: 1.37 } };
  assert.equal(payCheck('$90,000 per year', '', cad).status, 'ok', 'as USD it is 123k CAD');
  assert.equal(payCheck('$60,000 per year', '', cad).status, 'below_floor');
  const jpy: PaySettings = { currency: 'EUR', floor: 40_000, period: 'year', rule: 'top_of_range', unlisted: 'keep', fx: { JPY: 0.0062 } };
  assert.equal(payCheck('¥6,000,000', '', jpy).status, 'no_rate', 'CNY reading has no rate');
});

test('pay found in the description when no pay field: shown and ranked, never a hard drop (C5)', () => {
  const r = payCheck(null, 'Great team. Salary range: €45.000 - €50.000 per year. Apply now.', eurYear);
  assert.equal(r.status, 'below_floor');
  assert.match(r.reason, /below your floor/);
  assert.equal(payDrops(r, eurYear), false, 'description text can be a bonus, a range for another role or a typo: the judge decides');
  assert.equal(payDrops(payCheck('€45.000 - €50.000 per year', '', eurYear), eurYear), true, 'the pay field still drops');
});

test('C5: shift differentials and premiums are not the pay; no period drops only when every reading (year and month) is below', () => {
  assert.equal(findPayText('Night RN. $4/hr shift differential for nights. Pay: $45 - $55 per hour.'), '$45 - $55 per hour');
  assert.equal(findPayText('Weekend premium $6/hour; base rate $48/hr.'), '$48/hr');
  assert.equal(findPayText('Differential: $3.50/hr. Starting at $41/hr.'), '$41/hr');
  assert.equal(findPayText('$4/hr shift diff'), undefined);
  const r = payCheck(null, 'Nights earn a $4/hr differential. Pay $45 - $55 per hour.', usdHour);
  assert.equal(r.status, 'ok', r.reason);
  const high: PaySettings = { ...eurYear, floor: 200_000 };
  assert.equal(payCheck('€12.000 – €15.000', '', high).status, 'below_floor', '15k a year and 180k a year (as a month) are both below 200k');
  assert.equal(payCheck('€12.000 – €20.000', '', high).status, 'unclear', '20k a month would be 240k a year');
  assert.equal(payCheck('€90.000', '', eurYear).status, 'ok', 'above as a year and as a month');
});
