// The title matcher (design §24.5, D26): reading a title, word-level matching, modes, level, rank and LinkedIn terms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abbreviationsFor, cleanTitle, matchTitle, readTitle, searchTerms, titleMatcher } from '../../src/jobs/titles.ts';
import { compileRules, describeRules, judgeBrief, prefilter } from '../../src/jobs/rules.ts';
import { normalise, validate } from '../../src/jobs/schema.ts';
import { rankScore } from '../../src/jobs/pipeline/rank.ts';
import { searchPlan } from '../../src/jobs/linkedin.ts';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { PEOPLE } from './helpers.ts';

const search = (roles: any, extra: any = {}) => normalise.search({ roles, ...extra });
const rules = (roles: any, extra: any = {}) => compileRules({ search: { data: search(roles, extra) } as any, memory: { data: { items: [] } } as any });
const keeps = (c: ReturnType<typeof rules>, title: string, language?: string) => prefilter({ title, language }, c).keep;

test('reading a title: gender markers go, words split, seniority set apart, ids dropped', () => {
  assert.equal(cleanTitle('Buchhalter (m/w/d)').trim(), 'Buchhalter');
  assert.equal(cleanTitle('Bilanzbuchhalter*in'), 'Bilanzbuchhalter');
  assert.equal(cleanTitle('Lehrer:in Mathe'), 'Lehrer Mathe');
  assert.equal(cleanTitle('Traductor/a jurado/a'), 'Traductor jurado');
  assert.equal(cleanTitle('Assistant(e) de direction (H/F)').trim(), 'Assistant de direction');
  assert.equal(cleanTitle('Engineer (AI/ML)'), 'Engineer (AI/ML)', 'two-letter words in brackets are not gender markers');
  const r = readTitle('Sr. Software Engineer II, Backend - REQ-20931');
  assert.deepEqual(r.words.map((w) => w.w), ['senior', 'software', 'engineer', 'level 2', 'backend', 'req']);
  assert.deepEqual(r.role, ['software', 'engineer', 'backend', 'req']);
  assert.deepEqual(r.seniority.map((s) => s.cls), ['senior', 'none']);
  assert.equal(r.label, 'Software Engineer');
  assert.equal(readTitle('Teacher of Maths - Maternity Cover').label, 'Teacher of Maths');
  assert.deepEqual(readTitle('Tech Lead').role, ['tech', 'lead'], '"lead" at the end is the role');
  assert.deepEqual(readTitle('Lead Engineer').role, ['engineer']);
  assert.deepEqual(readTitle('Entry-Level Analyst').seniority.map((s) => s.canon), ['entry level']);
});

test('word matching: any order, plurals and gendered endings, never a longer word', () => {
  const c = rules({ targets: [{ name: 'Nurse', titles: ['staff nurse', 'registered nurse', 'RN'] }, { name: 'Teacher', titles: ['maths teacher'] }] });
  for (const t of ['Nurse, Registered - Nights', 'Registered Nurses', 'Teacher of Maths', 'Maths Teachers', 'RN - Night Shift', 'RNs wanted']) assert.ok(keeps(c, t), t);
  for (const t of ['Nursery Assistant', 'Nursery Staff', 'Head of Maths', 'Learning Support Assistant', 'Burns Unit Clerk']) assert.ok(!keeps(c, t), t);
});

test('vowel swaps and French/Spanish forms; abbreviations only as whole words', () => {
  const c = rules({ targets: [{ name: 'T', titles: ['enfermero', 'traducteur', 'vendeur', 'SRE'] }] });
  for (const t of ['Enfermera', 'Enfermeros de noche', 'Traductrice', 'Vendeuse (H/F)', 'Senior SRE', 'SREs']) assert.ok(keeps(c, t), t);
  for (const t of ['Enfermería', 'Sresh Analyst', 'Traduction']) assert.ok(!keeps(c, t), t);
});

test('compound tails only for languages that compound: the posting\'s or the user\'s', () => {
  const plainUser = rules({ targets: [{ name: 'A', titles: ['buchhalter'] }] });
  assert.ok(!keeps(plainUser, 'Finanzbuchhalter'), 'no compounding language anywhere');
  assert.ok(keeps(plainUser, 'Finanzbuchhalter', 'de'), 'the posting is German');
  const german = rules({ targets: [{ name: 'A', titles: ['buchhalter'] }] }, { languages: [{ name: 'Deutsch' }] });
  assert.ok(keeps(german, 'Kreditorenbuchhalterin'));
  assert.ok(!keeps(german, 'Buchhaltung'), 'a different word, not a tail');
  const dutch = rules({ targets: [{ name: 'N', titles: ['verpleegkundige'] }] }, { languages: [{ name: 'Dutch' }] });
  assert.ok(keeps(dutch, 'Wijkverpleegkundige'));
});

test('modes: broad keeps a shared head word and ranks it below; off keeps every title', () => {
  const words = rules({ titles: [], targets: [{ name: 'B', titles: ['backend engineer'] }] });
  const broad = rules({ targets: [{ name: 'B', titles: ['backend engineer'] }], match: 'broad' });
  const off = rules({ targets: [{ name: 'B', titles: ['backend engineer'] }], match: 'off' });
  assert.ok(!keeps(words, 'Full Stack Engineer') && keeps(broad, 'Full Stack Engineer') && keeps(off, 'Full Stack Engineer'));
  assert.ok(!keeps(broad, 'Product Designer') && keeps(off, 'Product Designer'));
  assert.equal(matchTitle(broad.titles, 'Full Stack Engineer')?.how, 'broad');
  assert.equal(matchTitle(broad.titles, 'Backend Engineer')?.how, 'exact');
  assert.equal(matchTitle(broad.titles, 'Engineer, Backend')?.how, 'words');
  assert.match(describeRules(off), /title_gate\s+off/);
});

test('level: entry drops senior words, experienced drops internships, senior drops both; words the user wrote never drop', () => {
  const t = (level: string, titles = ['marketing associate', 'marketing manager']) => rules({ targets: [{ name: 'M', titles }], level });
  assert.equal(prefilter({ title: 'Senior Marketing Manager' }, t('entry')).keep, false);
  assert.equal((prefilter({ title: 'Senior Marketing Manager' }, t('entry')) as any).rule, 'level');
  assert.ok(keeps(t('entry'), 'Marketing Associate (Fresh Grad)'));
  assert.ok(!keeps(t('experienced'), 'Marketing Associate Intern') && keeps(t('experienced'), 'Junior Marketing Associate'));
  assert.ok(!keeps(t('senior'), 'Junior Marketing Associate') && keeps(t('senior'), 'Senior Marketing Manager'));
  assert.ok(keeps(t('any'), 'Marketing Associate Intern'));
  assert.ok(keeps(t('entry', ['senior accountant']), 'Senior Accountant'), 'the user asked for senior');
  assert.ok(keeps(t('entry', ['team lead']), 'Team Lead'), '"lead" at the end is a role');
});

test('a title drop names the closest target word', () => {
  const c = rules({ targets: [{ name: 'Backend engineer', titles: ['backend engineer'] }] });
  const v = prefilter({ title: 'Full Stack Engineer' }, c);
  assert.equal(v.keep, false);
  assert.match((v as any).reason, /"Full Stack Engineer" is not one of your titles \(close to engineer: Backend engineer\)/);
  assert.doesNotMatch((prefilter({ title: 'Product Designer' }, c) as any).reason, /close to/);
});

test('the user\'s own rules.title_gate regex still replaces the matcher', () => {
  const c = rules({ titles: ['backend engineer'] }, { rules: { title_gate: '(?:platform)' } });
  assert.ok(keeps(c, 'Platform Lead') && !keeps(c, 'Backend Engineer'));
  assert.match(describeRules(c), /your regex/);
});

test('schema: targets take skills; match and level are checked; defaults words and any', () => {
  const ok = validate('search', { roles: { targets: [{ name: 'X', titles: ['a b'], skills: ['Figma'] }], match: 'broad', level: 'entry' } });
  assert.deepEqual(ok.filter((i) => i.level === 'error'), []);
  const bad = validate('search', { roles: { match: 'fuzzy', level: 'mid' } });
  assert.ok(bad.some((i) => i.path === 'roles.match') && bad.some((i) => i.path === 'roles.level'));
  const s = search({ titles: ['x'] });
  assert.equal(s.roles.match, 'words');
  assert.equal(s.roles.level, 'any');
});

test('rank: the matched target\'s skills count; an in-order match above any order above broad', () => {
  const notes = loadJobNotes(PEOPLE.template, null);
  const n = (roles: any) => ({ ...notes, search: { ...notes.search, data: search(roles) } });
  const at = new Date('2026-11-19T10:00:00Z');
  const base = { title: 'UX Designer', description: 'Figma prototypes and usability testing every week.', posted_at: '2026-11-18T10:00:00Z', source: 'board' };
  const withSkills = rankScore(base, n({ targets: [{ name: 'UX', titles: ['ux designer'], skills: ['Figma', 'usability testing'] }] }) as any, at);
  const without = rankScore(base, n({ targets: [{ name: 'UX', titles: ['ux designer'] }] }) as any, at);
  assert.ok(withSkills > without, 'per-target skills rank');
  const r = n({ targets: [{ name: 'B', titles: ['backend engineer'] }], match: 'broad' }) as any;
  const s = (title: string) => rankScore({ ...base, title, description: '' }, r, at);
  assert.ok(s('Backend Engineer') > s('Engineer, Backend') && s('Engineer, Backend') > s('Full Stack Engineer'));
});

test('LinkedIn terms: each target\'s first three titles, then roles.titles (one list, from the matcher)', () => {
  const s = search({ titles: ['data analyst'], targets: [{ name: 'A', titles: ['a1', 'a2', 'a3', 'a4'] }, { name: 'B', titles: ['b1'] }] });
  assert.deepEqual(searchTerms(s), ['a1', 'a2', 'a3', 'b1', 'data analyst']);
  assert.deepEqual(searchPlan({ search: { data: s } } as any).terms, searchTerms(s));
});

test('abbreviations a target could add: RN for registered nurse, SRE for site reliability engineer', () => {
  const m = titleMatcher(search({ targets: [{ name: 'N', titles: ['registered nurse'] }, { name: 'S', titles: ['site reliability engineer', 'SRE'] }] }));
  assert.deepEqual(abbreviationsFor(m, 0).map((a) => a.abbr), ['rn']);
  assert.deepEqual(abbreviationsFor(m, 1), [], 'already listed');
});

test('the judge brief names each target', () => {
  const notes = loadJobNotes(PEOPLE.template, null);
  const brief = judgeBrief({ ...notes, search: { ...notes.search, data: search({ targets: [{ name: 'Backend engineer', titles: ['backend engineer', 'SRE'] }], level: 'senior' }) } } as any);
  assert.match(brief, /Title fit: Backend engineer: backend engineer, SRE\. Level: senior\./);
});
