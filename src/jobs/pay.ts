// Pay in postings: any common currency, units (k, M, lakh, crore), ranges and periods, converted with the user's own
// fx table to their currency and period (jobs/search.md → pay). A posting is dropped only when every reading of its
// pay is below the floor; anything unclear is kept for the judge. Pay read from the description (not the posting's pay
// field) is shown and ranked but never drops a posting on its own: it may be a differential, a bonus or another role's.
import { plain } from './places.ts';

export type Period = 'year' | 'month' | 'week' | 'day' | 'hour';
export type UserPeriod = 'year' | 'month' | 'hour';
export type PaySettings = {
  currency: string; floor: number; period: UserPeriod; rule: 'top_of_range' | 'bottom_of_range';
  unlisted: 'keep' | 'drop'; fx: Record<string, number>; locale?: string;
};
/** Pay as written: amounts in the posting's currency (one or more readings when the symbol is ambiguous). */
export type ParsedPay = { currencies: string[]; min: number | null; max: number | null; period: Period | null; text: string };
export type PayStatus = 'ok' | 'below_floor' | 'unlisted' | 'unclear' | 'no_rate';
export type PayResult = { status: PayStatus; reason: string; min?: number | null; max?: number | null; currency?: string; text?: string; /** where the text came from */ from?: 'pay_text' | 'description' };

/** Hours in each period (40 h weeks, 52 weeks, 260 working days). */
export const HOURS: Record<Period, number> = { year: 2080, month: 2080 / 12, week: 40, day: 8, hour: 1 };

/** ISO codes recognised in postings. */
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN',
  'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'ILS', 'AED', 'SAR', 'QAR', 'KRW', 'TWD', 'PHP', 'VND', 'IDR', 'MYR', 'THB', 'ZAR',
  'NGN', 'KES', 'EGP', 'PKR', 'BDT', 'LKR', 'NPR', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'UYU', 'UAH', 'RUB',
] as const;
const DOLLARS = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN', 'TWD', 'ARS', 'CLP', 'COP', 'UYU']);

// Symbols and prefixed forms → currencies (ambiguous ones list every reading).
const SYMBOLS: [string, string[]][] = [
  ['US$', ['USD']], ['C$', ['CAD']], ['CA$', ['CAD']], ['CAN$', ['CAD']], ['A$', ['AUD']], ['AU$', ['AUD']], ['NZ$', ['NZD']],
  ['S$', ['SGD']], ['SG$', ['SGD']], ['HK$', ['HKD']], ['MX$', ['MXN']], ['R$', ['BRL']], ['NT$', ['TWD']], ['CN¥', ['CNY']],
  ['RMB', ['CNY']], ['€', ['EUR']], ['£', ['GBP']], ['₹', ['INR']], ['Rs.', ['INR', 'PKR', 'LKR', 'NPR']],
  ['Rs', ['INR', 'PKR', 'LKR', 'NPR']], ['¥', ['JPY', 'CNY']], ['￥', ['JPY', 'CNY']], ['Fr.', ['CHF']], ['SFr.', ['CHF']],
  ['kr.', ['SEK', 'NOK', 'DKK', 'ISK']], ['kr', ['SEK', 'NOK', 'DKK', 'ISK']], ['zł', ['PLN']], ['Kč', ['CZK']], ['Ft', ['HUF']],
  ['lei', ['RON']], ['₺', ['TRY']], ['₪', ['ILS']], ['₩', ['KRW']], ['₱', ['PHP']], ['₫', ['VND']], ['Rp', ['IDR']],
  ['RM', ['MYR']], ['฿', ['THB']], ['₦', ['NGN']], ['KSh', ['KES']], ['₴', ['UAH']], ['₽', ['RUB']], ['$', ['USD']],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SYM_ALT = SYMBOLS.map(([s]) => s).sort((a, b) => b.length - a.length).map((s) => `${/^[A-Za-z]/.test(s) ? '(?<![A-Za-z])' : ''}${esc(s)}${/[A-Za-z]$/.test(s) ? '(?![A-Za-z])' : ''}`).join('|');
const CUR = `(?:${SYM_ALT}|(?<![A-Za-z])(?:${CURRENCIES.join('|')})(?![A-Za-z]))`;
const NUM = `\\d{1,3}(?:[,.'\\u2019 \\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?(?!\\d)|\\d+(?:[.,]\\d+)?`;
const UNIT = `(?:[kK](?![a-zA-Z])|[tT]sd\\.?|[tT]housand|[mM]io\\.?|[mM]illion|[mM]n(?![a-zA-Z])|[mM](?![a-zA-Z])|[lL]akhs?|[lL]acs?|LPA|L(?![a-zA-Z])|[cC]rores?|[cC]r(?![a-zA-Z]))`;
const AMOUNT = `(?:${CUR}\\s?)?(?:${NUM})(?:\\s?${UNIT})?(?:\\s?${CUR})?`;
const DASH = `\\s*(?:-|–|—|to|bis|a|à|and)\\s*`;
const MONEY = new RegExp(`(?:(?:up to|upto|max(?:imum)?|bis zu|from|starting at|ab|min(?:imum)?)\\s+)?${AMOUNT}(?:${DASH}${AMOUNT})?\\+?`, 'g');

const PERIODS: [Period, RegExp][] = [
  ['hour', /(?:\bper\s+|\ban?\s+|\beach\s+)(?:hour|hr)\b|\/\s*(?:hour|hr|h)\b|\bhourly\b|\bp\/h\b|\bpro stunde\b|\/\s*stunde\b|\bde l'heure\b|\bpor hora\b|\/\s*heure\b/],
  ['day', /(?:\bper\s+|\ba\s+)day\b|\/\s*d(?:ay)?\b|\bdaily rate\b|\bday rate\b|\bpro tag\b|\/\s*tag\b|\bpar jour\b|\bpor dia\b/],
  ['week', /(?:\bper\s+|\ba\s+)(?:week|wk)\b|\/\s*(?:week|wk|w)\b|\bweekly\b|\bpro woche\b|\bpar semaine\b/],
  ['month', /(?:\bper\s+|\ba\s+)(?:month|mth)\b|\/\s*(?:month|mo|mth|m)\b|\bmonthly\b|\bp\.m\.|\bpcm\b|\bpro monat\b|\bmonatlich|\/\s*monat\b|\bmensuel|\bpar mois\b|\bal mes\b|\bmensual|\bmensais\b|\bpor mes\b|\bper manad\b|\bi manaden\b|\/\s*mes\b/],
  ['year', /(?:\bper\s+|\ba\s+)(?:year|annum)\b|\/\s*(?:year|yr|y)\b|\bper yr\b|\bp\.?\s?a\.?(?![a-z])|\bannual(?:ly)?\b|\byearly\b|\blpa\b|\bpro jahr\b|\bjahrlich|\/\s*jahr\b|\bjahresgehalt|\bpar an\b|\bal ano\b|\banual\b|\bannuel|\bpor ano\b|\banuais\b|\bper ar\b|\bom aret\b/],
];

function numberOf(s: string): number {
  const t = s.replace(/[\s  '’]/g, '');
  // "55.000", "1,500,000", "120'000": separators before groups of three; a trailing 1-2 digit group is a decimal.
  if (/^\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{1,2})?$/.test(t)) {
    const m = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(t)!;
    return Number(m[1].replace(/[,.]/g, '') + (m[2] ? `.${m[2]}` : ''));
  }
  return Number(t.replace(',', '.'));
}

function unitFactor(u: string | undefined, inr: boolean): number {
  if (!u) return 1;
  const x = u.toLowerCase().replace(/\.$/, '');
  if (x === 'k' || x === 'tsd' || x === 'thousand') return 1e3;
  if (x === 'm' || x === 'mn' || x === 'mio' || x === 'million') return 1e6;
  if (/^(lakhs?|lacs?|lpa)$/.test(x) || (x === 'l' && inr)) return 1e5;
  if (/^(crores?|cr)$/.test(x) && inr) return 1e7;
  return 1;
}

function currenciesIn(s: string, dollar: string[]): string[] | null {
  const m = new RegExp(CUR).exec(s);
  if (!m) return /\b(lpa|lakhs?|lacs?|crores?)\b/i.test(s) ? ['INR'] : null;
  const tok = m[0];
  if (tok === '$') return dollar;
  const sym = SYMBOLS.find(([k]) => k === tok);
  return sym ? [...sym[1]] : [tok.toUpperCase()];
}

/** The period a pay text states, or null. */
export function periodIn(s: string): Period | null {
  const t = plain(s).toLowerCase();
  let best: [Period, number] | null = null;
  for (const [p, re] of PERIODS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best[1])) best = [p, m.index];
  }
  return best?.[0] ?? null;
}

/**
 * Parse pay text ("€55.000 – €70.000 brutto pro Jahr", "$45 - $60 per hour", "35–70 LPA", "up to 120k USD").
 * `userCurrency` makes a bare "$" also read as the user's own dollar currency.
 */
export function parsePay(text: string | null | undefined, userCurrency?: string): ParsedPay | null {
  if (!text) return null;
  const t = plain(text);
  const dollar = ['USD', ...(userCurrency && userCurrency !== 'USD' && DOLLARS.has(userCurrency) ? [userCurrency] : [])];
  for (const m of t.matchAll(MONEY)) {
    const s = m[0];
    const cur = currenciesIn(s, dollar);
    if (!cur) continue;
    const inr = cur.includes('INR');
    const nums = [...s.matchAll(new RegExp(`(${NUM})(?:\\s?(${UNIT}))?`, 'g'))].map((x) => ({ n: numberOf(x[1]), u: x[2] }));
    if (!nums.length || nums.some((x) => !Number.isFinite(x.n))) continue;
    // "60–80k", "35–70 LPA": a unit on the second number applies to the first.
    if (nums.length === 2 && !nums[0].u && nums[1].u && nums[0].n < nums[1].n) nums[0].u = nums[1].u;
    const vals = nums.slice(0, 2).map((x) => x.n * unitFactor(x.u, inr));
    const tail = t.slice(m.index! + s.length, m.index! + s.length + 40);
    let period = periodIn(s + tail);
    if (!period && /\blpa\b/i.test(s)) period = 'year';
    let min: number | null = Math.min(...vals), max: number | null = Math.max(...vals);
    if (vals.length === 1) {
      if (/^(?:up to|upto|max|maximum|bis zu)\b/i.test(s)) min = null;
      else if (/^(?:from|starting at|ab|min|minimum)\b/i.test(s) || /\+\s*$/.test(s)) max = null;
    }
    return { currencies: cur, min, max, period, text: (s + tail.split(/[.;\n]/)[0]).trim() };
  }
  return null;
}

// Money near these words isn't pay: bonuses, budgets, funding, company size, and the extras on top of a base rate
// (a "$4/hr shift differential" or "weekend premium" is not what the job pays).
const NOT_PAY = /\b(bonus|sign[- ]?on|signing|relocation|stipend|allowance|budget|reimburs|equity|stock|referral|funding|funded|raised|revenue|arr|valuation|series [a-e]|grant|per diem allowance|tuition|differentials?|diffs?|premiums?|uplift)\b/i;

/** The first pay-looking text in a job description, skipping bonuses, budgets and funding. */
export function findPayText(description: string | null | undefined): string | undefined {
  if (!description) return undefined;
  const t = plain(description);
  for (const m of t.matchAll(MONEY)) {
    if (!currenciesIn(m[0], ['USD']) || !/\d/.test(m[0])) continue;
    const start = m.index!, end = start + m[0].length;
    // Context: the words right around the amount, within its sentence and before the next amount.
    const before = t.slice(Math.max(0, start - 30), start).split(/[.!?;]\s|\n|\d/).pop()!;
    const after = t.slice(end, end + 30).split(/[.!?;]\s|\n|\d|[$€£₹¥]/)[0];
    if (NOT_PAY.test(before) || NOT_PAY.test(after)) continue;
    const tail = t.slice(end, end + 40).split(/[.;\n]/)[0];
    return (m[0] + tail).trim();
  }
  return undefined;
}

/** Convert an amount between currencies and periods with the user's fx table (1 unit of X = fx[X] of theirs). */
export function convertAmount(n: number, from: { currency: string; period: Period }, to: { currency: string; period: Period }, fx: Record<string, number>): number | null {
  const rate = from.currency === to.currency ? 1 : fx[from.currency];
  if (!rate) return null;
  return (n * rate * HOURS[to.period]) / HOURS[from.period];
}

const money = (n: number, s: PaySettings) => {
  try { return new Intl.NumberFormat(s.locale || 'en', { maximumFractionDigits: n < 1000 ? 2 : 0 }).format(n); } catch { return String(Math.round(n)); }
};

/**
 * Pay against the user's floor. below_floor only when every reading (currency) is below it, judged by the user's
 * rule: top_of_range compares the top, bottom_of_range the bottom. A missing end ("up to", "from") never drops.
 */
export function payCheck(payText: string | null | undefined, description: string | null | undefined, s: PaySettings): PayResult {
  const from = payText ? 'pay_text' : 'description';
  const text = payText || findPayText(description);
  const p = parsePay(text, s.currency);
  const unit = `${s.currency}/${s.period}`;
  if (!p) return { status: 'unlisted', reason: 'no pay listed' };
  // No period: small numbers may be hourly, daily or weekly (unclear); a salary-sized one is read both as a year and
  // as a month, and only a drop under both readings counts.
  const periods: Period[] = p.period ? [p.period] : (p.max ?? p.min ?? 0) >= 10_000 ? ['year', 'month'] : [];
  if (!periods.length) return { status: 'unclear', reason: `pay "${p.text}" has no period`, text: p.text, from };
  const readings = p.currencies.flatMap((c) => periods.map((period) => {
    const conv = (n: number | null) => (n == null ? null : convertAmount(n, { currency: c, period }, { currency: s.currency, period: s.period }, s.fx));
    return { c, min: conv(p.min), max: conv(p.max), ok: c === s.currency || !!s.fx[c] };
  }));
  if (readings.some((r) => !r.ok)) {
    const missing = readings.filter((r) => !r.ok).map((r) => r.c).join(', ');
    return { status: 'no_rate', reason: `no fx rate for ${missing} in jobs/search.md pay.fx`, text: p.text, from };
  }
  // The most favourable reading decides what is shown.
  const best = readings.reduce((a, b) => ((b.max ?? b.min ?? 0) > (a.max ?? a.min ?? 0) ? b : a));
  const base = { min: best.min, max: best.max, currency: s.currency, text: p.text, from };
  if (s.floor <= 0) return { status: 'ok', reason: 'no floor', ...base };
  const isBelow = (r: (typeof readings)[number]) => {
    if (s.rule === 'top_of_range') return r.max != null && r.max < s.floor;
    return (r.min ?? r.max) != null && (r.min != null ? r.min < s.floor : r.max! < s.floor);
  };
  const shown = s.rule === 'top_of_range' ? best.max : best.min ?? best.max;
  if (readings.every(isBelow)) return { status: 'below_floor', reason: `pay below your floor: ${money(shown!, s)} ${unit} (${s.rule === 'top_of_range' ? 'top' : 'bottom'} of "${p.text}"${p.period ? '' : ', as a year or a month'}) < ${money(s.floor, s)} ${unit}`, ...base };
  if (!p.period && readings.some(isBelow)) return { status: 'unclear', reason: `pay "${p.text}" has no period: below your floor as a year, not as a month`, ...base };
  return { status: 'ok', reason: `pay ${p.text}`, ...base };
}

/** Whether a pay result drops the posting: only pay from the posting's pay field, or no pay at all when unlisted drops. */
export const payDrops = (r: PayResult, s: PaySettings) => (r.status === 'below_floor' && r.from !== 'description') || (r.status === 'unlisted' && s.unlisted === 'drop');
