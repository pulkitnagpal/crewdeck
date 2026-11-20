// Schema v1 of the notes Claude and the user share (design §7.2–7.6): validators whose messages name the note, the
// field path and the fix; unknown keys are warnings ("did you mean …"), never errors, so users can keep their own
// frontmatter; normalise() gives typed values with defaults.
import { lookupPlace } from './places.ts';
import { CURRENCIES } from './pay.ts';
import { LEVELS_WANTED, MATCH_MODES, type LevelWanted, type MatchMode } from './titles.ts';
import { keyClass } from './form-terms.ts';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
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
  | { t: 'map'; of: Schema; key?: RegExp; keyHint?: string }
  /** One of several shapes, chosen by the value's kind (text or a map: a licence is "RN" or { name: RN, where: Ohio }). */
  | { t: 'alt'; of: Schema[]; hint: string };

const str = (o: Omit<Extract<Schema, { t: 'str' }>, 't'> = {}): Schema => ({ t: 'str', ...o });
const num = (o: Omit<Extract<Schema, { t: 'num' }>, 't'> = {}): Schema => ({ t: 'num', ...o });
const bool = (): Schema => ({ t: 'bool' });
const oneOf = (of: readonly string[]): Schema => ({ t: 'oneOf', of });
const list = (of: Schema): Schema => ({ t: 'list', of });
const obj = (keys: Record<string, Schema>, o: { required?: string[]; open?: boolean } = {}): Schema => ({ t: 'obj', keys, ...o });
const map = (of: Schema, key?: RegExp, keyHint?: string): Schema => ({ t: 'map', of, key, keyHint });
const alt = (hint: string, ...of: Schema[]): Schema => ({ t: 'alt', of, hint });

export const WORKPLACES = ['remote', 'hybrid', 'onsite'] as const;
export const LEVELS = ['basic', 'conversational', 'professional', 'fluent', 'native'] as const;
/** CEFR levels (D31), accepted next to the words; compared through CEFR_LEVEL. */
export const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const CEFR_LEVEL: Record<(typeof CEFR)[number], (typeof LEVELS)[number]> = { A1: 'basic', A2: 'basic', B1: 'conversational', B2: 'professional', C1: 'fluent', C2: 'native' };
export const LANGUAGE_LEVELS = [...LEVELS, ...CEFR] as const;
export const EMPLOYMENT = ['full-time', 'part-time', 'contract', 'freelance', 'per-diem', 'internship', 'apprenticeship', 'temporary', 'fixed-term', 'seasonal'] as const;
/** The lowest travel that rules a job out; off (written none before v0.4, still read) rules none out. */
export const TRAVEL = ['off', 'occasional', 'frequent'] as const;
export const SHIFTS = ['day', 'evening', 'night', 'weekend', 'rotating', 'on-call'] as const;
export const PAY_PERIODS = ['year', 'month', 'week', 'day', 'hour'] as const;
export const COOLDOWN_SCOPES = ['company', 'role'] as const;
/** The opt-in personal block on a resume (D33): values from standard_answers (languages also from jobs/search.md). */
export const PERSONAL = ['date_of_birth', 'place_of_birth', 'nationality', 'marital_status', 'driving_licence', 'languages'] as const;
export const HEADINGS = ['summary', 'experience', 'education', 'skills', 'personal', 'languages'] as const;
const LANG = /^[a-z]{2}$/;
const LANG_HINT = 'a two-letter language code (en, de, es …)';
const MONTH = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
export const SECTION_KINDS = ['summary', 'experience', 'list', 'skills', 'education'] as const;
export const MEMORY_KINDS = ['answer', 'fact', 'preference', 'style', 'avoid', 'company_rule'] as const;
export const RULE_NAMES = ['title_gate', 'title_exclude', 'remote_words', 'hybrid_words', 'onsite_words', 'place_excluded',
  'other_only', 'industry', 'travel_frequent', 'travel_occasional'] as const;
export const PLACE_RULES = new Set(['place_excluded', 'other_only']);
/** SilverBullet's own frontmatter keys: never ours, never warned about. */
const SILVERBULLET_KEYS = new Set(['tags', 'aliases', 'displayName', 'pageDecoration', 'description']);

const SNAKE = /^[a-z][a-z0-9_]*$/;
export const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** A key from a name: lowercase ASCII letters and digits joined by -. */
export const slugOf = (s: string) => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'source';
const SECTION_ID = /^[a-z0-9][a-z0-9_-]*$/;
const FACT_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_.-]*$/;
const emailCheck = (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'is not an email address');
const phoneCheck = (v: string) => (/^\+?[\d\s().-]{5,25}$/.test(v) ? null : 'is not a phone number (digits, spaces, + ( ) - . only)');
const hostCheck = (v: string) => (/^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v) ? null : 'is not a host name (e.g. jobs.example.com)');
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
    // D35: people who agreed to be referees. Other people's details: fill reference questions only, never drafted.
    references: list(obj({ name: str({ required: true }), role: str(), org: str(), email: str({ check: emailCheck }), phone: str({ check: phoneCheck }), relationship: str() }, { required: ['name'] })),
    // Sites whose terms forbid automated filling: Claude shows the answers to copy instead.
    copy_only_hosts: list(str({ required: true, check: hostCheck })),
  }),
  career: obj({
    resume: obj({
      file_name: str({ check: fileNameCheck }), paper: oneOf(['A4', 'Letter']), max_pages: num({ int: true, min: 1, max: 5 }),
      // D33: the language it renders in (facts' approved translations), its headings, an opt-in personal block, and the
      // word the Jobs page uses for it.
      language: str({ pattern: LANG, hint: LANG_HINT }), headings: map(str({ required: true }), new RegExp(`^(${HEADINGS.join('|')})$`), HEADINGS.join(', ')),
      personal: list(oneOf(PERSONAL)), word: oneOf(['resume', 'CV']),
    }),
    // The language the facts are written in (D33): answers in another language cite a fact through its approved translation.
    language: str({ pattern: LANG, hint: LANG_HINT }),
    sections: list(obj({
      id: str({ pattern: SECTION_ID, hint: 'lowercase letters, digits, - and _ (e.g. example-gmbh)' }), kind: oneOf(SECTION_KINDS),
      title: str(), org: str(), where: str(), dates: str(), max_bullets: num({ int: true, min: 1, max: 20 }), required: bool(),
      // A career break (§24.10): an experience entry with no organisation.
      break: bool(),
      // D35: when it started and ended (YYYY-MM; end empty while it goes on), for "Add another employment" blocks.
      start: str({ pattern: MONTH, hint: 'YYYY-MM, e.g. 2019-03' }), end: str({ pattern: MONTH, hint: 'YYYY-MM, e.g. 2023-06 (leave it out while it goes on)' }),
    }, { required: ['id', 'kind'] })),
    facts: list(obj({
      id: str({ pattern: FACT_ID, hint: '<section id>.<slug>, e.g. example-gmbh.dashboards' }), text: str({ required: true }), tags: list(str()),
      // D33 (owner question 5): translations the user approved word for word, by language.
      tr: map(str({ required: true }), LANG, LANG_HINT),
    }, { required: ['id', 'text'] })),
    skills: list(str()),
    // Extra names the citation check treats as claims (tools, certifications) on top of the built-in list.
    terms: obj({ extra: list(str({ required: true })) }),
  }),
  search: obj({
    roles: obj({
      titles: list(str({ required: true })), seniority_prefer: list(str()), exclude_title_words: list(str({ required: true })),
      // v0.4 (§24.5, D26): one target per kind of job: its titles (with variants), fields and skills; matched word by word.
      targets: list(obj({ name: str(), titles: list(str({ required: true })), families: list(str({ check: familyCheck })), skills: list(str({ required: true })) }, { open: true })),
      match: oneOf(MATCH_MODES), level: oneOf(LEVELS_WANTED),
    }),
    workplace: list(oneOf(WORKPLACES)),
    places: obj({
      onsite: list(str({ required: true })), remote_from: list(str({ required: true })), commute_km: num({ min: 0, max: 500 }),
      // D37: cities the user would move to (on-site or hybrid there passes the rules), and the countries where they may
      // work without sponsorship (the judge fails postings that need another country's right to work and won't sponsor).
      relocate_to: list(str({ required: true })), authorized_in: list(str({ required: true })),
    }),
    languages: list(obj({ name: str({ required: true }), level: oneOf(LANGUAGE_LEVELS) }, { required: ['name'] })),
    employment_types: list(oneOf(EMPLOYMENT)),
    // D31: "RN (Ohio)", or { name: RN, where: Ohio }; the judge checks what postings require.
    licenses: list(alt('a licence name, or { name: …, where: … }', str({ required: true }), obj({ name: str({ required: true }), where: str() }, { required: ['name'] }))),
    needs_sponsorship: bool(),
    // D30: how the user can work, for the judge and availability questions. Only what the user said: never inferred.
    work_pattern: obj({
      hours_per_week: obj({ min: num({ min: 0, max: 100 }), max: num({ min: 1, max: 100 }) }),
      shifts: list(oneOf(SHIFTS)), shifts_avoid: list(oneOf(SHIFTS)), term_time_only: bool(),
    }),
    exclude: obj({ companies: list(str()), industries: list(str()), travel: oneOf([...TRAVEL, 'none']) }),
    pay: obj({
      currency: str({ check: currencyCheck }), floor: num({ min: 0 }), period: oneOf(PAY_PERIODS),
      // D29: the hours and days that convert between periods (a day rate, a monthly wage for part-time hours).
      hours_per_week: num({ min: 1, max: 100 }), days_per_week: num({ min: 1, max: 7 }),
      // D29: per word, per project …: the judge's text, never a floor.
      per_unit: str(),
      rule: oneOf(['top_of_range', 'bottom_of_range']), unlisted: oneOf(['keep', 'drop']), locale: str({ check: localeCheck }),
      fx: map(num({ min: 0 }), /^[A-Z]{3}$/, 'a three-letter currency code (USD)'), fx_updated: { t: 'date' },
    }),
    schedule: obj({
      timezone: str({ check: tzCheck }), daily_picks: num({ int: true, min: 0, max: 50 }), cooldown_days: num({ int: true, min: 0, max: 365 }),
      // D36: company (no role at that company) or role (the same title at that company) during the cooldown; and how
      // many roles of one company may be picked or in progress at once.
      cooldown_scope: oneOf(COOLDOWN_SCOPES), per_company: num({ int: true, min: 1, max: 10 }),
    }),
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
    // v2 (design D20): one ordered list, the first is fetched first and ranks first.
    sources: list(obj({
      key: str({ pattern: SOURCE_KEY, hint: 'lowercase letters, digits and - (e.g. example-health)' }), name: str({ required: true }),
      provider: str(), careers_url: str({ check: urlCheck }), url: str({ check: urlCheck }), fetch: oneOf(['auto', 'none']), why: str(),
      employer: bool(), added: { t: 'date' }, enabled: bool(), linkedin: oneOf(['search']),
    }, { required: ['name'], open: true })),
    // v1: still read when sources: is absent; the first save moves them into sources:.
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
      return;
    case 'alt': {
      const pick = altFor(s, v);
      if (!pick) return add('error', path, `should be ${s.hint}, not ${show(v)}`, `write ${s.hint}`);
      return walk(pick, v, path, add);
    }
  }
}

/** The shape of an alt that fits a value's kind (text, number, true/false, list, map), or undefined. */
function altFor(s: Extract<Schema, { t: 'alt' }>, v: unknown): Schema | undefined {
  const kind = typeof v === 'string' ? ['str', 'oneOf', 'date', 'scalar', 'regex'] : typeof v === 'number' ? ['num', 'scalar'] : typeof v === 'boolean' ? ['bool', 'scalar'] : Array.isArray(v) ? ['list'] : isObj(v) ? ['obj', 'map'] : [];
  return s.of.find((x) => kind.includes(x.t));
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
    // D32: ID, bank and tax numbers are never stored, so never used: the user types them into forms themselves.
    for (const k of Object.keys(o(d.standard_answers))) if (keyClass(k) === 'never_fill') add('error', `standard_answers.${k}`, 'is an ID, bank or tax number: Crewdeck never stores or fills these', 'remove it from me/profile.md and type it into forms yourself');
  },
  career(d, add) {
    const sections = arr(d.sections).filter(isObj);
    const seen = new Set<string>();
    sections.forEach((s, i) => {
      if (typeof s.id === 'string' && seen.has(s.id)) add('error', `sections[${i}].id`, `"${s.id}" is used twice`, 'give each section its own id');
      seen.add(s.id);
      if (s.kind === 'experience') for (const k of s.break === true ? ['title'] : ['title', 'org']) if (!s[k]) add('error', `sections[${i}].${k}`, `is missing (experience sections need a title and org${k === 'org' ? '; a career break is break: true without one' : ''})`, `add ${k}: …`);
      if (s.kind === 'list' && !s.title) add('error', `sections[${i}].title`, 'is missing (list sections need a title)', 'add title: …');
    });
    sections.forEach((s, i) => { if (typeof s.start === 'string' && typeof s.end === 'string' && s.end < s.start) add('error', `sections[${i}].end`, `${s.end} is before the start ${s.start}`, 'check both dates'); });
    const base = typeof d.language === 'string' ? d.language : null, out = typeof o(d.resume).language === 'string' ? o(d.resume).language : null;
    arr(d.facts).filter(isObj).forEach((f, i) => { if (base && isObj(f.tr) && f.tr[base] !== undefined) add('warning', `facts[${i}].tr.${base}`, `is the facts' own language (language: ${base})`, 'remove it'); });
    if (out && base && out !== base) {
      const missing = arr(d.facts).filter((f) => isObj(f) && !(isObj(f.tr) && typeof f.tr[out] === 'string' && f.tr[out])).length;
      if (missing) add('warning', 'resume.language', `${missing} fact${missing === 1 ? ' has' : 's have'} no approved ${out} translation: they render in ${base}`, `approve a translation with the user, then add it as facts[n].tr.${out}`);
    }
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
    if (!arr(roles.titles).length && !arr(roles.targets).some((t) => isObj(t) && arr(t.titles).length)) add('warning', 'roles.titles', 'no target titles: every title passes the title check', 'add the job titles you want, e.g. [data analyst]');
    if (!workplace.length) add('warning', 'workplace', 'no workplace kinds: remote, hybrid and on-site all pass', 'add e.g. [remote] or [onsite, hybrid]');
    if ((workplace.includes('onsite') || workplace.includes('hybrid')) && !arr(places.onsite).length) add('warning', 'places.onsite', 'on-site/hybrid wanted but no cities: location rules are off for those', 'add the cities you can work in');
    if (workplace.includes('remote') && !arr(places.remote_from).length) add('warning', 'places.remote_from', 'remote wanted but no places to work from: location rules are off for remote', 'add countries/regions/states, or worldwide');
    for (const k of ['onsite', 'remote_from', 'relocate_to', 'authorized_in']) arr(places[k]).forEach((p, i) => {
      if (typeof p === 'string' && p && !lookupPlace(p)) add('warning', `places.${k}[${i}]`, `"${p}" is not in Crewdeck's gazetteer: location rules are off for this list`, 'use a known name, or "Town, Country" (e.g. "Potsdam, Germany")');
    });
    const wp = o(d.work_pattern), hours = o(wp.hours_per_week);
    if (typeof hours.min === 'number' && typeof hours.max === 'number' && hours.min > hours.max) add('error', 'work_pattern.hours_per_week', `min ${hours.min} is more than max ${hours.max}`, 'swap them');
    const both = arr(wp.shifts).filter((x) => arr(wp.shifts_avoid).includes(x));
    if (both.length) add('warning', 'work_pattern.shifts_avoid', `${both.join(', ')} is both a shift you can work and one you avoid`, 'keep it in one list');
    if (typeof pay.hours_per_week === 'number' && typeof pay.days_per_week === 'number' && pay.hours_per_week / pay.days_per_week > 24) add('error', 'pay.hours_per_week', `${pay.hours_per_week} hours over ${pay.days_per_week} days is more than 24 hours a day`, 'check both numbers');
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
      if (typeof m.key === 'string' && keyClass(m.key) === 'never_fill' && !m.superseded_by) add('error', `items[${i}]`, 'is an ID, bank or tax number: Crewdeck never stores or fills these', 'retire it (crewdeck jobs remember --retire …) and type it into forms yourself');
      if (m.scope === 'company' && !m.company) add('error', `items[${i}].company`, 'is missing (scope is company)', 'add company: … or set scope: all');
      if (m.kind === 'company_rule' && m.scope !== 'company') add('error', `items[${i}].scope`, 'a company_rule must have scope: company', 'set scope: company and company: …');
      if (m.title_words && m.kind !== 'avoid') add('warning', `items[${i}].title_words`, 'only avoid items use title words', 'remove it');
      if (typeof m.superseded_by === 'string' && m.superseded_by !== 'retired' && (!ids.has(m.superseded_by) || m.superseded_by === m.id)) add('error', `items[${i}].superseded_by`, `"${m.superseded_by}" is not another item`, 'point it at the item that replaced this one, or retired');
    });
  },
  sources(d, add) {
    const v2 = Array.isArray(d.sources);
    if (v2 && (arr(d.boards).length || arr(d.watchlist).length)) add('warning', 'boards', 'boards: and watchlist: are ignored while sources: is there', 'move their entries into sources: (Crewdeck does this on its next change)');
    const lists = v2 ? [['sources', arr(d.sources)] as const] : (['boards', 'watchlist'] as const).map((k) => [k, arr(d[k])] as const);
    const keys = new Map<string, number>();
    let mirrors = 0;
    for (const [k, list] of lists) list.forEach((e, i) => {
      if (!isObj(e)) return;
      const p = `${k}[${i}]`;
      if ('parser' in e) add('error', `${p}.parser`, 'parser entries run local commands and are not allowed', 'remove the entry or use a provider / careers_url');
      if (typeof e.key === 'string' && e.key) {
        if (keys.has(e.key)) add('error', `${p}.key`, `"${e.key}" is used twice`, 'give each source its own key (never reuse one)');
        keys.set(e.key, i);
      } else if (v2) add('warning', `${p}.key`, 'has no key: counts and priority use one made from the name', `add key: ${slugOf(String(e.name ?? e.provider ?? 'source'))}`);
      if (e.linkedin !== undefined) {
        if (++mirrors > 1) add('error', `${p}.linkedin`, 'LinkedIn is listed twice', 'keep one LinkedIn row');
        if ('enabled' in e) add('warning', `${p}.enabled`, 'LinkedIn is switched in Jobs → Settings; this note only orders it', 'remove enabled: from the LinkedIn row');
        if (e.provider || e.careers_url || e.url) add('error', p, 'the LinkedIn row takes no provider, careers_url or url', 'remove them');
        return;
      }
      const targets = ['provider', 'careers_url', 'url'].filter((t) => typeof e[t] === 'string' && e[t]);
      if (!targets.length) add('error', p, 'needs a provider, a careers_url or a url', 'add provider: <id>, careers_url: https://… or url: https://… with fetch: none');
      if (e.url && (e.provider || e.careers_url)) add('error', `${p}.url`, 'url is for a page no provider reads: it goes without provider and careers_url', 'use careers_url: for a careers page');
      if (e.url && e.fetch !== 'none') add('error', `${p}.fetch`, 'a url entry is not fetched', 'add fetch: none (and why:), or use careers_url: for a careers page');
      if (e.fetch === 'none' && !e.why) add('warning', `${p}.why`, 'says why it is not fetched', 'add why: e.g. "no provider reads this site: paste its postings"');
      if (typeof e.provider === 'string' && e.provider) {
        const cat = CATALOG.get(e.provider);
        if (EXCLUDED_PROVIDERS.has(e.provider)) add('error', `${p}.provider`, `"${e.provider}" can't run in Crewdeck: ${cat?.why ?? EXCLUDED_PROVIDERS.get(e.provider)}`, 'remove the entry (or switch it off with enabled: false)');
        else if (!PROVIDERS.has(e.provider)) {
          const near = didYouMean(e.provider, [...PROVIDERS]);
          add('error', `${p}.provider`, `"${e.provider}" is not a known provider`, near ? `did you mean "${near}"?` : 'pick one with crewdeck jobs sources suggest, or from the catalog');
        } else if (cat?.retired) add('warning', `${p}.provider`, `"${e.provider}" no longer works upstream: ${cat.coverage}`, 'remove it');
        else if (cat?.blocked) add('warning', `${p}.provider`, `"${e.provider}" currently refuses automated reads: ${cat.coverage}`, 'switch it off or remove it');
      }
    });
  },
};
// The career-ops providers Crewdeck runs: the pinned manifest's allow-list (design §15). Excluded ones keep their reason.
const MANIFEST = JSON.parse(readFileSync(pathJoin(import.meta.dirname, 'data', 'providers.manifest.json'), 'utf8')) as { providers: string[]; excluded: Record<string, string> };
const PROVIDERS = new Set<string>(MANIFEST.providers);
const CATALOG = new Map((parseYaml(readFileSync(pathJoin(import.meta.dirname, 'data', 'sources-catalog.yaml'), 'utf8')).sources as any[]).map((c) => [c.id as string, c]));
const FAMILY_IDS = Object.keys(parseYaml(readFileSync(pathJoin(import.meta.dirname, 'data', 'sources-catalog.yaml'), 'utf8')).families ?? {});
function familyCheck(v: string) { return FAMILY_IDS.includes(v) ? null : `is not a field Crewdeck knows (${FAMILY_IDS.slice(0, 6).join(', ')}, …)`; }
const EXCLUDED_PROVIDERS = new Map(Object.entries(MANIFEST.excluded).filter(([p]) => /^providers\/[^_/][^/]*\.mjs$/.test(p)).map(([p, why]) => [p.slice(10, -4), why.replace(/^imports .*\((.*)\)$/, '$1')]));

// ---- typed, defaulted values ----
export type Workplace = (typeof WORKPLACES)[number];
export type Profile = {
  identity: { first_name: string; last_name: string; preferred_name: string; email: string; phone: string; city: string; region: string; country: string; links: Record<string, string> };
  standard_answers: Record<string, string>;
  education: { school: string; degree?: string; discipline?: string; start_year?: number; end_year?: number }[];
  copy_only_hosts: string[];
  references: Reference[];
};
export type Reference = { name: string; role?: string; org?: string; email?: string; phone?: string; relationship?: string };
export type Section = { id: string; kind: (typeof SECTION_KINDS)[number]; title?: string; org?: string; where?: string; dates?: string; max_bullets?: number; required?: boolean; break?: boolean; start?: string; end?: string };
export type Fact = { id: string; text: string; tags: string[]; tr: Record<string, string> };
export type Career = {
  resume: { file_name: string; paper: 'A4' | 'Letter'; max_pages: number; language: string; headings: Record<string, string>; personal: (typeof PERSONAL)[number][]; word: 'resume' | 'CV' };
  /** The facts' own language ('' when not said). */ language: string;
  sections: Section[]; facts: Fact[]; skills: string[]; terms: { extra: string[] };
};
export type Licence = { name: string; where?: string };
export type Shift = (typeof SHIFTS)[number];
export type Search = {
  roles: { titles: string[]; seniority_prefer: string[]; exclude_title_words: string[]; targets: { name: string; titles: string[]; families: string[]; skills: string[] }[]; match: MatchMode; level: LevelWanted };
  workplace: Workplace[];
  places: { onsite: string[]; remote_from: string[]; commute_km: number; relocate_to: string[]; authorized_in: string[] };
  languages: { name: string; level?: (typeof LANGUAGE_LEVELS)[number] }[];
  employment_types: string[];
  /** Each licence as text ("RN (Ohio)"), for briefs and matching. */ licenses: string[];
  /** Each licence as written: a name and, when given, where it holds. */ licences: Licence[];
  needs_sponsorship: boolean | null;
  work_pattern: { hours_per_week: { min: number | null; max: number | null }; shifts: Shift[]; shifts_avoid: Shift[]; term_time_only: boolean };
  exclude: { companies: string[]; industries: string[]; travel: (typeof TRAVEL)[number] };
  pay: {
    currency: string; floor: number; period: (typeof PAY_PERIODS)[number]; hours_per_week: number | null; days_per_week: number | null; per_unit: string;
    rule: 'top_of_range' | 'bottom_of_range'; unlisted: 'keep' | 'drop'; locale: string; fx: Record<string, number>; fx_updated: string;
  } | null;
  schedule: { timezone: string; daily_picks: number; cooldown_days: number; cooldown_scope: (typeof COOLDOWN_SCOPES)[number]; per_company: number };
  judge_notes: string;
  rules: Record<string, string[]>;
};
export type MemoryItem = {
  id: string; kind: (typeof MEMORY_KINDS)[number]; key?: string; text: string; quote: string; scope: 'all' | 'company';
  company?: string; created: string; superseded_by?: string; title_words?: string[];
};
export type Memory = { items: MemoryItem[] };
export type SourceEntry = { name: string; provider?: string; careers_url?: string; enabled?: boolean; [k: string]: unknown };
/** One row of the user's list, in priority order (v1 boards then watchlist when sources: is absent). */
export type SourceItem = {
  key: string; name: string; provider?: string; careers_url?: string; url?: string; fetch: 'auto' | 'none'; why?: string;
  employer: boolean; enabled: boolean; linkedin: boolean; added?: string;
  /** The entry as written (provider option blocks included). */ entry: SourceEntry;
};
export type Sources = { items: SourceItem[]; version: 1 | 2 };

/** A licence as one line: "RN (Ohio)". */
export const licenceText = (l: Licence) => (l.where ? `${l.name} (${l.where})` : l.name);
/** A language level in the words the rules compare ("C1" → fluent). */
export const levelWord = (l: string | undefined) => (l && (CEFR as readonly string[]).includes(l) ? CEFR_LEVEL[l as (typeof CEFR)[number]] : l);
const strs = (v: unknown) => arr(v).filter((x) => typeof x === 'string' && x.trim()).map((x: string) => x.trim());
const s_ = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

export const normalise = {
  profile(d: unknown): Profile {
    const x = o(d), id = o(x.identity);
    return {
      identity: { first_name: s_(id.first_name), last_name: s_(id.last_name), preferred_name: s_(id.preferred_name), email: s_(id.email), phone: s_(id.phone), city: s_(id.city), region: s_(id.region), country: s_(id.country), links: Object.fromEntries(Object.entries(o(id.links)).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string> },
      standard_answers: Object.fromEntries(Object.entries(o(x.standard_answers)).filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, String(v)])),
      education: arr(x.education).filter(isObj) as Profile['education'],
      copy_only_hosts: strs(x.copy_only_hosts).map((h) => h.toLowerCase()),
      references: arr(x.references).filter((r) => isObj(r) && typeof r.name === 'string' && r.name.trim()).map((r) => Object.fromEntries(['name', 'role', 'org', 'email', 'phone', 'relationship'].filter((k) => typeof r[k] === 'string' && r[k].trim()).map((k) => [k, r[k].trim()])) as Reference),
    };
  },
  career(d: unknown): Career {
    const x = o(d), r = o(x.resume);
    const word = r.word === 'CV' ? 'CV' : 'resume';
    const lang = (v: unknown) => (typeof v === 'string' && LANG.test(v) ? v : '');
    return {
      resume: {
        file_name: s_(r.file_name, `{first_name} {last_name} ${word === 'CV' ? 'CV' : 'Resume'}.pdf`), paper: r.paper === 'Letter' ? 'Letter' : 'A4', max_pages: typeof r.max_pages === 'number' ? r.max_pages : 2,
        language: lang(r.language), headings: Object.fromEntries(Object.entries(o(r.headings)).filter(([k, v]) => (HEADINGS as readonly string[]).includes(k) && typeof v === 'string' && v.trim())) as Record<string, string>,
        personal: strs(r.personal).filter((p): p is (typeof PERSONAL)[number] => (PERSONAL as readonly string[]).includes(p)), word,
      },
      language: lang(x.language),
      sections: arr(x.sections).filter(isObj) as Section[],
      facts: arr(x.facts).filter(isObj).map((f) => ({ id: String(f.id), text: String(f.text ?? ''), tags: strs(f.tags), tr: Object.fromEntries(Object.entries(o(f.tr)).filter(([k, v]) => LANG.test(k) && typeof v === 'string' && v.trim())) as Record<string, string> })),
      skills: strs(x.skills),
      terms: { extra: strs(o(x.terms).extra) },
    };
  },
  search(d: unknown): Search {
    const x = o(d), roles = o(x.roles), places = o(x.places), ex = o(x.exclude), pay = o(x.pay), sch = o(x.schedule), wp = o(x.work_pattern), hrs = o(wp.hours_per_week);
    const n_ = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    const shifts = (v: unknown) => strs(v).filter((z): z is Shift => (SHIFTS as readonly string[]).includes(z));
    const licences: Licence[] = arr(x.licenses).flatMap((l): Licence[] => (typeof l === 'string' && l.trim() ? [{ name: l.trim() }] : isObj(l) && typeof l.name === 'string' && l.name.trim() ? [{ name: l.name.trim(), ...(typeof l.where === 'string' && l.where.trim() ? { where: l.where.trim() } : {}) }] : []));
    const p = pay.currency && typeof pay.currency === 'string' ? {
      currency: pay.currency, floor: typeof pay.floor === 'number' ? pay.floor : 0, period: ((PAY_PERIODS as readonly string[]).includes(pay.period) ? pay.period : 'year') as 'year',
      hours_per_week: n_(pay.hours_per_week), days_per_week: n_(pay.days_per_week), per_unit: s_(pay.per_unit).trim(),
      rule: (pay.rule === 'bottom_of_range' ? 'bottom_of_range' : 'top_of_range') as 'top_of_range', unlisted: (pay.unlisted === 'drop' ? 'drop' : 'keep') as 'keep',
      locale: s_(pay.locale), fx: Object.fromEntries(Object.entries(o(pay.fx)).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>, fx_updated: s_(pay.fx_updated),
    } : null;
    return {
      roles: {
        titles: strs(roles.titles), seniority_prefer: strs(roles.seniority_prefer), exclude_title_words: strs(roles.exclude_title_words),
        targets: arr(roles.targets).filter(isObj).map((t) => ({ name: s_(t.name), titles: strs(t.titles), families: strs(t.families), skills: strs(t.skills) })),
        match: (MATCH_MODES as readonly string[]).includes(roles.match) ? roles.match : 'words', level: (LEVELS_WANTED as readonly string[]).includes(roles.level) ? roles.level : 'any',
      },
      workplace: strs(x.workplace).filter((w): w is Workplace => (WORKPLACES as readonly string[]).includes(w)),
      places: {
        onsite: strs(places.onsite), remote_from: strs(places.remote_from), commute_km: typeof places.commute_km === 'number' ? places.commute_km : 50,
        relocate_to: strs(places.relocate_to), authorized_in: strs(places.authorized_in),
      },
      languages: arr(x.languages).filter((l) => isObj(l) && typeof l.name === 'string' && l.name) as Search['languages'],
      employment_types: strs(x.employment_types), licenses: licences.map(licenceText), licences,
      needs_sponsorship: typeof x.needs_sponsorship === 'boolean' ? x.needs_sponsorship : null,
      work_pattern: { hours_per_week: { min: n_(hrs.min), max: n_(hrs.max) }, shifts: shifts(wp.shifts), shifts_avoid: shifts(wp.shifts_avoid), term_time_only: wp.term_time_only === true },
      // v1's travel: none meant "no travel rules a job out": off.
      exclude: { companies: strs(ex.companies), industries: strs(ex.industries), travel: (TRAVEL as readonly string[]).includes(ex.travel) ? ex.travel : 'off' },
      pay: p,
      schedule: {
        timezone: s_(sch.timezone), daily_picks: typeof sch.daily_picks === 'number' ? sch.daily_picks : 5, cooldown_days: typeof sch.cooldown_days === 'number' ? sch.cooldown_days : 60,
        cooldown_scope: sch.cooldown_scope === 'role' ? 'role' : 'company', per_company: typeof sch.per_company === 'number' && sch.per_company >= 1 ? Math.floor(sch.per_company) : 1,
      },
      judge_notes: s_(x.judge_notes),
      rules: Object.fromEntries(Object.entries(o(x.rules)).map(([k, v]) => [k, typeof v === 'string' ? [v] : strs(v)])),
    };
  },
  memory(d: unknown): Memory {
    return { items: arr(o(d).items).filter((m) => isObj(m) && typeof m.id === 'string') as MemoryItem[] };
  },
  sources(d: unknown): Sources {
    return sourceItems(d);
  },
};

/** The schema at a field path (["pay", "floor"], ["education", 0, "school"]), or null when the path isn't ours. */
export function schemaAt(name: string, path: (string | number)[]): Schema | null {
  let s: Schema | undefined = SCHEMAS[name];
  for (const k of path) {
    if (!s) return null;
    // Inside an alt, a key path is into its map shape.
    if (s.t === 'alt') s = s.of.find((x) => x.t === 'obj' || x.t === 'map');
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

/**
 * The user's sources in priority order: v2's `sources:`, else v1's boards then watchlist (watchlist entries are
 * employers). Entries without a key get one from their name, stable for the same note, deduplicated in order.
 */
export function sourceItems(d: unknown): Sources {
  const x = o(d);
  const v2 = Array.isArray(x.sources);
  const raw: [Record<string, any>, boolean][] = v2 ? arr(x.sources).filter(isObj).map((e) => [e, false]) : [...arr(x.boards).filter(isObj).map((e): [Record<string, any>, boolean] => [e, false]), ...arr(x.watchlist).filter(isObj).map((e): [Record<string, any>, boolean] => [e, true])];
  const taken = new Set(raw.map(([e]) => e.key).filter((k) => typeof k === 'string' && SOURCE_KEY.test(k)));
  const items: SourceItem[] = [];
  for (const [e, watch] of raw) {
    const linkedin = e.linkedin !== undefined;
    let key = typeof e.key === 'string' && SOURCE_KEY.test(e.key) ? e.key : '';
    if (!key) {
      const base = linkedin ? 'linkedin' : slugOf(String(e.name || e.provider || hostOf(e.careers_url ?? e.url) || 'source'));
      key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
      taken.add(key);
    }
    const t = (k: string) => (typeof e[k] === 'string' && e[k] ? e[k] as string : undefined);
    items.push({
      key, name: String(e.name ?? (linkedin ? 'LinkedIn' : key)), provider: linkedin ? undefined : t('provider'), careers_url: linkedin ? undefined : t('careers_url'),
      url: linkedin ? undefined : t('url'), fetch: e.fetch === 'none' || (!!t('url') && !t('careers_url') && !t('provider')) ? 'none' : 'auto', why: t('why'),
      employer: e.employer === true || (watch && e.employer !== false), enabled: linkedin ? true : e.enabled !== false, linkedin, added: t('added'), entry: e as SourceEntry,
    });
  }
  return { items, version: v2 ? 2 : 1 };
}
function hostOf(u: unknown): string { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
