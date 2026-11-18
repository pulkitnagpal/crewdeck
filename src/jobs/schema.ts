// Schema v1 of the notes Claude and the user share (design §7.2–7.6): validators whose messages name the note, the
// field path and the fix; unknown keys are warnings ("did you mean …"), never errors, so users can keep their own
// frontmatter; normalise() gives typed values with defaults.
import { lookupPlace } from './places.ts';
import { CURRENCIES } from './pay.ts';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export type Issue = { level: 'error' | 'warning'; note: string; path: string; message: string; fix?: string };

// ---- a small schema language ----
export type Schema =
  | { t: 'str'; pattern?: RegExp; hint?: string; check?: (v: string) => string | null; required?: boolean }
  | { t: 'num'; int?: boolean; min?: number; max?: number }
  | { t: 'bool' }
  | { t: 'oneOf'; of: readonly string[] }
  | { t: 'date' }
  | { t: 'scalar' }
  | { t: 'regex' }
  | { t: 'list'; of: Schema }
  | { t: 'obj'; keys: Record<string, Schema>; required?: string[]; open?: boolean }
  | { t: 'map'; of: Schema; key?: RegExp; keyHint?: string };

const str = (o: Omit<Extract<Schema, { t: 'str' }>, 't'> = {}): Schema => ({ t: 'str', ...o });
const num = (o: Omit<Extract<Schema, { t: 'num' }>, 't'> = {}): Schema => ({ t: 'num', ...o });
const bool = (): Schema => ({ t: 'bool' });
const oneOf = (of: readonly string[]): Schema => ({ t: 'oneOf', of });
const list = (of: Schema): Schema => ({ t: 'list', of });
const obj = (keys: Record<string, Schema>, o: { required?: string[]; open?: boolean } = {}): Schema => ({ t: 'obj', keys, ...o });
const map = (of: Schema, key?: RegExp, keyHint?: string): Schema => ({ t: 'map', of, key, keyHint });

export const WORKPLACES = ['remote', 'hybrid', 'onsite'] as const;
export const LEVELS = ['basic', 'conversational', 'professional', 'fluent', 'native'] as const;
export const EMPLOYMENT = ['full-time', 'part-time', 'contract', 'per-diem', 'internship', 'temporary'] as const;
export const TRAVEL = ['none', 'occasional', 'frequent'] as const;
export const SECTION_KINDS = ['summary', 'experience', 'list', 'skills', 'education'] as const;
export const MEMORY_KINDS = ['answer', 'fact', 'preference', 'style', 'avoid', 'company_rule'] as const;
export const RULE_NAMES = ['title_gate', 'title_exclude', 'remote_words', 'hybrid_words', 'onsite_words', 'place_excluded',
  'other_only', 'industry', 'travel_frequent', 'travel_occasional'] as const;
export const PLACE_RULES = new Set(['place_excluded', 'other_only']);
/** SilverBullet's own frontmatter keys: never ours, never warned about. */
const SILVERBULLET_KEYS = new Set(['tags', 'aliases', 'displayName', 'pageDecoration', 'description']);

const SNAKE = /^[a-z][a-z0-9_]*$/;
const SECTION_ID = /^[a-z0-9][a-z0-9_-]*$/;
const FACT_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_.-]*$/;
const emailCheck = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'is not an email address');
const phoneCheck = (v: string) => (/^\+?[\d\s().-]{5,25}$/.test(v) ? null : 'is not a phone number (digits, spaces, + ( ) - . only)');
const urlCheck = (v: string) => (/^https?:\/\/\S+$/.test(v) ? null : 'is not a web address (http:// or https://)');
const currencyCheck = (v: string) => (/^[A-Z]{3}$/.test(v) ? null : 'is not a three-letter currency code (EUR, USD, INR …)');
function tzCheck(v: string) { try { new Intl.DateTimeFormat('en', { timeZone: v }); return null; } catch { return 'is not a time zone (e.g. Europe/Berlin, America/Chicago)'; } }
function localeCheck(v: string) { try { new Intl.Locale(v); return Intl.NumberFormat.supportedLocalesOf([v]).length ? null : 'is not a known locale'; } catch { return 'is not a locale (e.g. en-US, de-DE)'; } }
const fileNameCheck = (v: string) => {
  if (/[\\/]/.test(v)) return 'must be a file name, not a path';
  const bad = [...v.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).filter((k) => !['first_name', 'last_name', 'preferred_name'].includes(k));
  if (bad.length) return `uses unknown placeholder {${bad[0]}} (use {first_name}, {last_name}, {preferred_name})`;
  return /\.pdf$/i.test(v) ? null : 'must end in .pdf';
};

export const SCHEMAS: Record<string, Schema> = {
  profile: obj({
    identity: obj({
      first_name: str(), last_name: str(), preferred_name: str(), email: str({ check: emailCheck }), phone: str({ check: phoneCheck }),
      city: str(), region: str(), country: str(), links: map(str({ check: urlCheck })),
    }),
    standard_answers: map({ t: 'scalar' }, SNAKE, 'lowercase words joined by _ (e.g. notice_period)'),
    education: list(obj({ school: str(), degree: str(), discipline: str(), start_year: num({ int: true, min: 1900, max: 2100 }), end_year: num({ int: true, min: 1900, max: 2100 }) }, { required: ['school'] })),
  }),
  career: obj({
    resume: obj({ file_name: str({ check: fileNameCheck }), paper: oneOf(['A4', 'Letter']), max_pages: num({ int: true, min: 1, max: 5 }) }),
    sections: list(obj({
      id: str({ pattern: SECTION_ID, hint: 'lowercase letters, digits, - and _ (e.g. example-gmbh)' }), kind: oneOf(SECTION_KINDS),
      title: str(), org: str(), where: str(), dates: str(), max_bullets: num({ int: true, min: 1, max: 20 }), required: bool(),
    }, { required: ['id', 'kind'] })),
    facts: list(obj({ id: str({ pattern: FACT_ID, hint: '<section id>.<slug>, e.g. example-gmbh.dashboards' }), text: str({ required: true }), tags: list(str()) }, { required: ['id', 'text'] })),
    skills: list(str()),
  }),
  search: obj({
    roles: obj({ titles: list(str({ required: true })), seniority_prefer: list(str()), exclude_title_words: list(str({ required: true })) }),
    workplace: list(oneOf(WORKPLACES)),
    places: obj({ onsite: list(str({ required: true })), remote_from: list(str({ required: true })), commute_km: num({ min: 0, max: 500 }) }),
    languages: list(obj({ name: str({ required: true }), level: oneOf(LEVELS) }, { required: ['name'] })),
    employment_types: list(oneOf(EMPLOYMENT)),
    licenses: list(str()),
    needs_sponsorship: bool(),
    exclude: obj({ companies: list(str()), industries: list(str()), travel: oneOf(TRAVEL) }),
    pay: obj({
      currency: str({ check: currencyCheck }), floor: num({ min: 0 }), period: oneOf(['year', 'month', 'hour']),
      rule: oneOf(['top_of_range', 'bottom_of_range']), unlisted: oneOf(['keep', 'drop']), locale: str({ check: localeCheck }),
      fx: map(num({ min: 0 }), /^[A-Z]{3}$/, 'a three-letter currency code (USD)'), fx_updated: { t: 'date' },
    }),
    schedule: obj({ timezone: str({ check: tzCheck }), daily_picks: num({ int: true, min: 0, max: 50 }), cooldown_days: num({ int: true, min: 0, max: 365 }) }),
    judge_notes: str(),
    rules: map({ t: 'regex' }),
  }),
  memory: obj({
    items: list(obj({
      id: str({ pattern: /^m-\d+$/, hint: 'm-<number>' }), kind: oneOf(MEMORY_KINDS), key: str({ pattern: SNAKE, hint: 'lowercase words joined by _' }),
      text: str({ required: true }), quote: str({ required: true }), scope: oneOf(['all', 'company']), company: str(), created: { t: 'date' },
      superseded_by: str({ pattern: /^(m-\d+|retired)$/, hint: 'm-<number> or retired' }), title_words: list(str({ required: true })),
    }, { required: ['id', 'kind', 'text', 'quote', 'scope', 'created'] })),
  }),
  sources: obj({
    boards: list(obj({ name: str({ required: true }), provider: str(), careers_url: str({ check: urlCheck }), enabled: bool() }, { required: ['name'], open: true })),
    watchlist: list(obj({ name: str({ required: true }), provider: str(), careers_url: str({ check: urlCheck }), enabled: bool() }, { required: ['name'], open: true })),
  }),
};

export const NOTE_FILES: Record<string, string> = { profile: 'me/profile.md', career: 'me/career.md', search: 'jobs/search.md', memory: 'jobs/memory.md', sources: 'jobs/sources.md' };

// ---- did you mean ----
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function didYouMean(word: string, options: readonly string[]): string | null {
  const w = word.toLowerCase();
  let best: [string, number] | null = null;
  for (const o of options) {
    const ol = o.toLowerCase();
    const score = ol.startsWith(w) || w.startsWith(ol) ? Math.min(1, distance(w, ol)) : distance(w, ol);
    if (score <= Math.max(2, Math.floor(o.length / 3)) && (!best || score < best[1])) best = [o, score];
  }
  return best?.[0] ?? null;
}

// ---- validation ----
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : Array.isArray(v) ? 'a list' : isObj(v) ? 'a map' : String(v));
const join = (path: string, k: string | number) => (typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k);

function walk(s: Schema, v: unknown, path: string, add: (level: Issue['level'], path: string, message: string, fix?: string) => void) {
  if (v === null || v === undefined) return;
  switch (s.t) {
    case 'str':
      if (typeof v !== 'string') return add('error', path, `should be text, not ${show(v)}`, 'write it as text, in quotes if it looks like a number or date');
      if (v === '') return s.required ? add('error', path, 'is empty', 'remove the entry or fill it in') : undefined;
      if (s.pattern && !s.pattern.test(v)) return add('error', path, `${show(v)} has the wrong form`, `use ${s.hint ?? s.pattern.source}`);
      if (s.check) { const why = s.check(v); if (why) add('error', path, `${show(v)} ${why}`, 'correct it or clear it ("")'); }
      return;
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) return add('error', path, `should be a number, not ${show(v)}`, 'write digits only, e.g. 55000');
      if (s.int && !Number.isInteger(v)) return add('error', path, `${v} should be a whole number`, 'drop the decimals');
      if (s.min !== undefined && v < s.min) return add('error', path, `${v} is below ${s.min}`, `use ${s.min} or more`);
      if (s.max !== undefined && v > s.max) return add('error', path, `${v} is above ${s.max}`, `use at most ${s.max}`);
      return;
    case 'bool':
      if (typeof v !== 'boolean') add('error', path, `should be true or false, not ${show(v)}`, 'write true or false');
      return;
    case 'oneOf':
      if (typeof v !== 'string' || !s.of.includes(v)) {
        const near = typeof v === 'string' ? didYouMean(v, s.of) : null;
        add('error', path, `${show(v)} is not one of: ${s.of.join(', ')}`, near ? `did you mean "${near}"?` : `use one of ${s.of.join(' | ')}`);
      }
      return;
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) add('error', path, `${show(v)} is not a date`, 'write YYYY-MM-DD');
      return;
    case 'scalar':
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') add('error', path, `should be text, not ${show(v)}`, 'write one line of text');
      return;
    case 'regex': {
      const pats = typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
      if (!pats) return add('error', path, 'should be a regular expression or a list of them', "write it in single quotes, e.g. '\\bfoo\\b'");
      for (const p of pats) { const why = regexProblem(p, path.split('.').pop()!); if (why) add('error', path, why, 'fix the expression or remove the override'); }
      return;
    }
    case 'list':
      if (!Array.isArray(v)) return add('error', path, `should be a list, not ${show(v)}`, 'write [a, b] or one "- item" per line');
      v.forEach((x, i) => { if (x === null || x === undefined) add('error', join(path, i), 'is empty', 'remove the empty entry'); else walk(s.of, x, join(path, i), add); });
      return;
    case 'obj':
      if (!isObj(v)) return add('error', path, `should be a map of keys, not ${show(v)}`, 'write key: value lines under it');
      for (const [k, x] of Object.entries(v)) {
        if (s.keys[k]) walk(s.keys[k], x, join(path, k), add);
        else if (!s.open && !(path === '' && SILVERBULLET_KEYS.has(k))) {
          const near = didYouMean(k, Object.keys(s.keys));
          add('warning', join(path, k), 'unknown key, ignored by Crewdeck', near ? `did you mean "${near}"?` : `known keys: ${Object.keys(s.keys).join(', ')}`);
        }
      }
      for (const r of s.required ?? []) if (v[r] === undefined || v[r] === null || v[r] === '') add('error', join(path, r), 'is missing', `add ${r}: …`);
      return;
    case 'map':
      if (!isObj(v)) return add('error', path, `should be a map of keys, not ${show(v)}`, 'write key: value lines under it');
      for (const [k, x] of Object.entries(v)) {
        if (s.key && !s.key.test(k)) add('error', join(path, k), `key "${k}" has the wrong form`, `use ${s.keyHint ?? s.key.source}`);
        walk(s.of, x, join(path, k), add);
      }
  }
}

/** Why a rule override can't be used, or null. */
export function regexProblem(p: string, name: string): string | null {
  try { new RegExp(p, 'iu'); } catch (e: any) { return `is not a valid regular expression: ${e.message}`; }
  if (PLACE_RULES.has(name) && !p.includes('(?<places>')) return 'needs a (?<places>…) group around the place names';
  return null;
}

/** Validate one note's frontmatter data. */
export function validate(name: string, data: unknown): Issue[] {
  const note = NOTE_FILES[name] ?? name;
  const issues: Issue[] = [];
  const add = (level: Issue['level'], path: string, message: string, fix?: string) => issues.push({ level, note, path: path || '(frontmatter)', message, fix });
  if (data === null || data === undefined) data = {};
  walk(SCHEMAS[name], data, '', add);
  if (isObj(data) && !issues.some((i) => i.level === 'error' && i.path === '(frontmatter)')) CROSS[name]?.(data, add);
  return issues;
}

type Add = (level: Issue['level'], path: string, message: string, fix?: string) => void;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const o = (v: unknown): Record<string, any> => (isObj(v) ? v : {});

const CROSS: Record<string, (d: Record<string, any>, add: Add) => void> = {
  profile(d, add) {
    const country = o(d.identity).country;
    if (typeof country === 'string' && country && !lookupPlace(country)) add('warning', 'identity.country', `"${country}" is not a country Crewdeck knows`, 'write its English name, e.g. Germany');
  },
  career(d, add) {
    const sections = arr(d.sections).filter(isObj);
    const seen = new Set<string>();
    sections.forEach((s, i) => {
      if (typeof s.id === 'string' && seen.has(s.id)) add('error', `sections[${i}].id`, `"${s.id}" is used twice`, 'give each section its own id');
      seen.add(s.id);
      if (s.kind === 'experience') for (const k of ['title', 'org']) if (!s[k]) add('error', `sections[${i}].${k}`, `is missing (experience sections need a title and org)`, `add ${k}: …`);
      if (s.kind === 'list' && !s.title) add('error', `sections[${i}].title`, 'is missing (list sections need a title)', 'add title: …');
    });
    const citable = sections.filter((s) => ['summary', 'experience', 'list'].includes(s.kind)).map((s) => s.id);
    const facts = new Set<string>();
    arr(d.facts).filter(isObj).forEach((f, i) => {
      if (typeof f.id !== 'string') return;
      if (facts.has(f.id)) add('error', `facts[${i}].id`, `"${f.id}" is used twice`, 'give each fact its own id');
      facts.add(f.id);
      const prefix = f.id.split('.')[0];
      if (FACT_ID.test(f.id) && !citable.includes(prefix)) {
        add('error', `facts[${i}].id`, `"${prefix}" is not a summary, experience or list section`, citable.length ? `start the id with one of: ${citable.join(', ')}` : 'add the section under sections: first');
      }
    });
  },
  search(d, add) {
    const roles = o(d.roles), places = o(d.places), pay = o(d.pay);
    const workplace = arr(d.workplace);
    if (!arr(roles.titles).length) add('warning', 'roles.titles', 'no target titles: every title passes the title check', 'add the job titles you want, e.g. [data analyst]');
    if (!workplace.length) add('warning', 'workplace', 'no workplace kinds: remote, hybrid and on-site all pass', 'add e.g. [remote] or [onsite, hybrid]');
    if ((workplace.includes('onsite') || workplace.includes('hybrid')) && !arr(places.onsite).length) add('warning', 'places.onsite', 'on-site/hybrid wanted but no cities: location rules are off for those', 'add the cities you can work in');
    if (workplace.includes('remote') && !arr(places.remote_from).length) add('warning', 'places.remote_from', 'remote wanted but no places to work from: location rules are off for remote', 'add countries/regions/states, or worldwide');
    for (const k of ['onsite', 'remote_from']) arr(places[k]).forEach((p, i) => {
      if (typeof p === 'string' && p && !lookupPlace(p)) add('warning', `places.${k}[${i}]`, `"${p}" is not in Crewdeck's gazetteer: location rules are off for this list`, 'use a known name, or "Town, Country" (e.g. "Potsdam, Germany")');
    });
    if (typeof pay.floor === 'number' && pay.floor > 0 && !pay.currency) add('error', 'pay.currency', 'is missing (a floor needs a currency)', 'add currency: EUR (your currency code)');
    if (typeof pay.currency === 'string' && /^[A-Z]{3}$/.test(pay.currency) && !(CURRENCIES as readonly string[]).includes(pay.currency)) add('warning', 'pay.currency', `${pay.currency} is not recognised in postings`, `pay rules only read ${CURRENCIES.slice(0, 8).join(', ')}, …`);
    for (const k of Object.keys(o(pay.fx))) {
      if (k === pay.currency) add('warning', `pay.fx.${k}`, 'is your own currency (always 1)', 'remove it');
      else if (/^[A-Z]{3}$/.test(k) && !(CURRENCIES as readonly string[]).includes(k)) add('warning', `pay.fx.${k}`, `${k} is not recognised in postings`, 'remove it or check the code');
    }
    for (const k of Object.keys(o(d.rules))) if (!(RULE_NAMES as readonly string[]).includes(k)) {
      const near = didYouMean(k, RULE_NAMES);
      add('error', `rules.${k}`, 'is not a rule name', near ? `did you mean "${near}"?` : `use one of ${RULE_NAMES.join(', ')}`);
    }
  },
  memory(d, add) {
    const items = arr(d.items).filter(isObj);
    const ids = new Set<string>();
    items.forEach((m, i) => {
      if (typeof m.id === 'string') { if (ids.has(m.id)) add('error', `items[${i}].id`, `"${m.id}" is used twice`, 'give each item its own id (never reuse one)'); ids.add(m.id); }
    });
    items.forEach((m, i) => {
      if (m.kind === 'answer' && !m.key) add('error', `items[${i}].key`, 'is missing (answers need the question key)', 'add key: e.g. notice_period');
      if (m.scope === 'company' && !m.company) add('error', `items[${i}].company`, 'is missing (scope is company)', 'add company: … or set scope: all');
      if (m.kind === 'company_rule' && m.scope !== 'company') add('error', `items[${i}].scope`, 'a company_rule must have scope: company', 'set scope: company and company: …');
      if (m.title_words && m.kind !== 'avoid') add('warning', `items[${i}].title_words`, 'only avoid items use title words', 'remove it');
      if (typeof m.superseded_by === 'string' && m.superseded_by !== 'retired' && (!ids.has(m.superseded_by) || m.superseded_by === m.id)) add('error', `items[${i}].superseded_by`, `"${m.superseded_by}" is not another item`, 'point it at the item that replaced this one, or retired');
    });
  },
  sources(d, add) {
    for (const k of ['boards', 'watchlist']) arr(d[k]).forEach((e, i) => {
      if (!isObj(e)) return;
      const p = `${k}[${i}]`;
      if ('parser' in e) add('error', `${p}.parser`, 'parser entries run local commands and are not allowed', 'remove the entry or use a provider / careers_url');
      if (!e.provider && !e.careers_url) add('error', p, 'needs a provider or a careers_url', 'add provider: <id> or careers_url: https://…');
      if (typeof e.provider === 'string' && e.provider && !PROVIDERS.has(e.provider)) {
        const near = didYouMean(e.provider, [...PROVIDERS]);
        add('error', `${p}.provider`, `"${e.provider}" is not a known provider`, near ? `did you mean "${near}"?` : 'use a provider id from the career-ops list');
      }
    });
  },
};
// career-ops provider ids (P5 replaces this with the manifest's allow-list). local-parser runs commands: never.
const PROVIDERS = new Set<string>((JSON.parse(readFileSync(pathJoin(import.meta.dirname, 'data', 'provider-ids.json'), 'utf8')) as string[]).filter((p) => p !== 'local-parser'));

// ---- typed, defaulted values ----
export type Workplace = (typeof WORKPLACES)[number];
export type Profile = {
  identity: { first_name: string; last_name: string; preferred_name: string; email: string; phone: string; city: string; region: string; country: string; links: Record<string, string> };
  standard_answers: Record<string, string>;
  education: { school: string; degree?: string; discipline?: string; start_year?: number; end_year?: number }[];
};
export type Section = { id: string; kind: (typeof SECTION_KINDS)[number]; title?: string; org?: string; where?: string; dates?: string; max_bullets?: number; required?: boolean };
export type Career = { resume: { file_name: string; paper: 'A4' | 'Letter'; max_pages: number }; sections: Section[]; facts: { id: string; text: string; tags: string[] }[]; skills: string[] };
export type Search = {
  roles: { titles: string[]; seniority_prefer: string[]; exclude_title_words: string[] };
  workplace: Workplace[];
  places: { onsite: string[]; remote_from: string[]; commute_km: number };
  languages: { name: string; level?: (typeof LEVELS)[number] }[];
  employment_types: string[]; licenses: string[]; needs_sponsorship: boolean | null;
  exclude: { companies: string[]; industries: string[]; travel: (typeof TRAVEL)[number] };
  pay: { currency: string; floor: number; period: 'year' | 'month' | 'hour'; rule: 'top_of_range' | 'bottom_of_range'; unlisted: 'keep' | 'drop'; locale: string; fx: Record<string, number>; fx_updated: string } | null;
  schedule: { timezone: string; daily_picks: number; cooldown_days: number };
  judge_notes: string;
  rules: Record<string, string[]>;
};
export type MemoryItem = {
  id: string; kind: (typeof MEMORY_KINDS)[number]; key?: string; text: string; quote: string; scope: 'all' | 'company';
  company?: string; created: string; superseded_by?: string; title_words?: string[];
};
export type Memory = { items: MemoryItem[] };
export type SourceEntry = { name: string; provider?: string; careers_url?: string; enabled?: boolean; [k: string]: unknown };
export type Sources = { boards: SourceEntry[]; watchlist: SourceEntry[] };

const strs = (v: unknown) => arr(v).filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
const s_ = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

export const normalise = {
  profile(d: unknown): Profile {
    const x = o(d), id = o(x.identity);
    return {
      identity: { first_name: s_(id.first_name), last_name: s_(id.last_name), preferred_name: s_(id.preferred_name), email: s_(id.email), phone: s_(id.phone), city: s_(id.city), region: s_(id.region), country: s_(id.country), links: Object.fromEntries(Object.entries(o(id.links)).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string> },
      standard_answers: Object.fromEntries(Object.entries(o(x.standard_answers)).filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, String(v)])),
      education: arr(x.education).filter(isObj) as Profile['education'],
    };
  },
  career(d: unknown): Career {
    const x = o(d), r = o(x.resume);
    return {
      resume: { file_name: s_(r.file_name, '{first_name} {last_name} Resume.pdf'), paper: r.paper === 'Letter' ? 'Letter' : 'A4', max_pages: typeof r.max_pages === 'number' ? r.max_pages : 2 },
      sections: arr(x.sections).filter(isObj) as Section[],
      facts: arr(x.facts).filter(isObj).map((f) => ({ id: String(f.id), text: String(f.text ?? ''), tags: strs(f.tags) })),
      skills: strs(x.skills),
    };
  },
  search(d: unknown): Search {
    const x = o(d), roles = o(x.roles), places = o(x.places), ex = o(x.exclude), pay = o(x.pay), sch = o(x.schedule);
    const p = pay.currency && typeof pay.currency === 'string' ? {
      currency: pay.currency, floor: typeof pay.floor === 'number' ? pay.floor : 0, period: (['year', 'month', 'hour'].includes(pay.period) ? pay.period : 'year') as 'year',
      rule: (pay.rule === 'bottom_of_range' ? 'bottom_of_range' : 'top_of_range') as 'top_of_range', unlisted: (pay.unlisted === 'drop' ? 'drop' : 'keep') as 'keep',
      locale: s_(pay.locale), fx: Object.fromEntries(Object.entries(o(pay.fx)).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>, fx_updated: s_(pay.fx_updated),
    } : null;
    return {
      roles: { titles: strs(roles.titles), seniority_prefer: strs(roles.seniority_prefer), exclude_title_words: strs(roles.exclude_title_words) },
      workplace: strs(x.workplace).filter((w): w is Workplace => (WORKPLACES as readonly string[]).includes(w)),
      places: { onsite: strs(places.onsite), remote_from: strs(places.remote_from), commute_km: typeof places.commute_km === 'number' ? places.commute_km : 50 },
      languages: arr(x.languages).filter((l) => isObj(l) && typeof l.name === 'string' && l.name) as Search['languages'],
      employment_types: strs(x.employment_types), licenses: strs(x.licenses),
      needs_sponsorship: typeof x.needs_sponsorship === 'boolean' ? x.needs_sponsorship : null,
      exclude: { companies: strs(ex.companies), industries: strs(ex.industries), travel: (TRAVEL as readonly string[]).includes(ex.travel) ? ex.travel : 'none' },
      pay: p,
      schedule: { timezone: s_(sch.timezone), daily_picks: typeof sch.daily_picks === 'number' ? sch.daily_picks : 5, cooldown_days: typeof sch.cooldown_days === 'number' ? sch.cooldown_days : 60 },
      judge_notes: s_(x.judge_notes),
      rules: Object.fromEntries(Object.entries(o(x.rules)).map(([k, v]) => [k, typeof v === 'string' ? [v] : strs(v)])),
    };
  },
  memory(d: unknown): Memory {
    return { items: arr(o(d).items).filter((m) => isObj(m) && typeof m.id === 'string') as MemoryItem[] };
  },
  sources(d: unknown): Sources {
    const x = o(d);
    return { boards: arr(x.boards).filter(isObj) as SourceEntry[], watchlist: arr(x.watchlist).filter(isObj) as SourceEntry[] };
  },
};

/** The schema at a field path (["pay", "floor"], ["education", 0, "school"]), or null when the path isn't ours. */
export function schemaAt(name: string, path: (string | number)[]): Schema | null {
  let s: Schema | undefined = SCHEMAS[name];
  for (const k of path) {
    if (!s) return null;
    if (s.t === 'obj') s = typeof k === 'string' ? s.keys[k] : undefined;
    else if (s.t === 'list') s = typeof k === 'number' ? s.of : undefined;
    else if (s.t === 'map') s = typeof k === 'string' ? s.of : undefined;
    else return null;
  }
  return s ?? null;
}

/** Keys at a path, for "did you mean" on unknown command paths. */
export function keysAt(name: string, path: (string | number)[]): string[] {
  const s = schemaAt(name, path);
  return s?.t === 'obj' ? Object.keys(s.keys) : [];
}
