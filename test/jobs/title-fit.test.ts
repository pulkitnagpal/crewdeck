// Title fit (ADR-0003, ADR-0007's first step, jobs v2 §14 P1): titles are a score, never a drop. The occupation
// synonyms and families in data/title-words.yaml match titles across common equivalents in engineering and other
// fields, in the seven languages; a synonym scores a little below the person's own words; a posting that fits none
// of their kinds of job is another occupation (ranked last, never judged, counted apart). Every title is fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIT, OTHER_OCCUPATION_FIT, expandTitle, loadTitleWords, titleFit, titleMatcher } from '../../src/jobs/titles.ts';
import { compileRules, judgeBrief } from '../../src/jobs/rules.ts';
import { normalise } from '../../src/jobs/schema.ts';
import { rankScore } from '../../src/jobs/pipeline/rank.ts';
import { loadJobNotes } from '../../src/jobs/notes.ts';
import { PEOPLE } from './helpers.ts';

const m = (titles: string[], extra: any = {}) => titleMatcher(normalise.search({ roles: { targets: [{ name: titles[0], titles }] }, ...extra }));
const how = (mm: ReturnType<typeof m>, title: string, lang?: string) => titleFit(mm, title, lang).how;

// [the person's titles, posting titles that mean the same job (synonym), same family, adjacent, another occupation]
const CORPUS: [string[], { synonym: string[]; family?: string[]; adjacent?: string[]; other: string[] }][] = [
  [['backend engineer'], {
    synonym: ['Backend Developer', 'Senior Back-End Engineer', 'Server-Side Developer', 'Backend Programmer (Go)', 'Back End Engineer II'],
    family: ['Full Stack Engineer', 'Fullstack Developer', 'Full-Stack Engineer', 'Software Engineer', 'Senior Software Developer', 'Frontend Engineer', 'Tech Lead', 'Mobile Engineer'],
    adjacent: ['SRE', 'Site Reliability Engineer', 'DevOps Engineer', 'Platform Engineer', 'Infrastructure Engineer', 'Data Engineer', 'QA Engineer', 'Security Engineer', 'Solutions Engineer', 'Forward Deployed Engineer'],
    other: ['Product Designer', 'Account Executive', 'Registered Nurse', 'Recruiter', 'Mechanical Engineer'],
  }],
  [['ai engineer'], {
    synonym: ['ML Engineer', 'Machine Learning Engineer', 'MLOps Engineer', 'LLMOps Engineer', 'Senior LLM Engineer', 'Applied AI Engineer'],
    adjacent: ['Data Engineer', 'Data Scientist', 'Software Engineer'],
    other: ['Data Entry Clerk', 'Marketing Manager'],
  }],
  [['platform engineer'], { synonym: ['DevOps Engineer', 'Infrastructure Engineer', 'Senior DevOps Engineer', 'Cloud Engineer'], family: ['SRE', 'Site Reliability Engineer'], other: ['Sales Associate'] }],
  [['site reliability engineer'], { synonym: ['SRE', 'Senior SRE', 'Reliability Engineer'], family: ['DevOps Engineer', 'Platform Engineer'], other: ['Office Manager'] }],
  [['forward deployed engineer'], { synonym: ['FDE', 'Forward Deployed Software Engineer'], family: ['Solutions Engineer', 'Customer Engineer'], other: ['Bookkeeper'] }],
  [['product manager'], { synonym: ['Product Owner', 'Senior PM', 'Produktmanager (m/w/d)', 'Chef de produit (H/F)'], adjacent: ['Project Manager', 'Product Designer'], other: ['Account Manager', 'Store Manager', 'Engineering Manager'] }],
  [['registered nurse'], { synonym: ['RN - ICU', 'Staff Nurse', 'Krankenpfleger (m/w/d)', 'Pflegefachkraft (m/w/d)', 'Infirmier (H/F)', 'Enfermera', 'Verpleegkundige'], family: ['Licensed Practical Nurse', 'Nurse Practitioner', 'Charge Nurse'], adjacent: ['Nursing Assistant', 'Healthcare Assistant'], other: ['Nursery Assistant', 'Pharmacy Technician', 'Data Analyst'] }],
  [['teacher'], { synonym: ['Educator', 'Maths Teacher', 'Lehrer (m/w/d)', 'Lehrkraft Mathematik', 'Profesor de matemáticas', 'Docente di matematica', 'Leraar wiskunde', 'Enseignant (H/F)'], family: ['Lecturer in Mathematics'], adjacent: ['Teaching Assistant', 'Learning Support Assistant'], other: ['Exams Officer'] }],
  [['accountant'], { synonym: ['Senior Accountant', 'Buchhalter (m/w/d)', 'Comptable (H/F)', 'Contador', 'Boekhouder'], adjacent: ['Bookkeeper', 'Accounts Payable Clerk', 'Financial Analyst'], other: ['Cashier', 'Warehouse Associate'] }],
  [['data engineer'], { synonym: ['Big Data Engineer', 'Data Platform Engineer'], family: ['Analytics Engineer'], adjacent: ['Software Engineer', 'ML Engineer'], other: ['Customer Success Manager'] }],
  [['translator'], { synonym: ['Traductor', 'Übersetzer (m/w/d)', 'Traducteur (H/F)', 'Localization Specialist'], family: ['Interpreter', 'Intérprete'], adjacent: ['Copywriter'], other: ['Transportista'] }],
  [['warehouse associate'], { synonym: ['Warehouse Worker', 'Order Picker', 'Package Handler', 'Lagermitarbeiter (m/w/d)', 'Magasinier (H/F)'], adjacent: ['Delivery Driver', 'Truck Driver'], other: ['Baggage Handler', 'Package Designer'] }],
];

for (const [titles, want] of CORPUS) {
  test(`title fit for ${titles.join(', ')}: synonyms, family, adjacent, other occupations`, () => {
    const mm = m(titles);
    const wrong: string[] = [];
    for (const [kind, list] of Object.entries(want) as [string, string[]][]) for (const t of list) {
      const h = how(mm, t);
      const ok = kind === 'synonym' ? h === 'synonym' || h === 'exact' || h === 'words' : kind === 'other' ? titleFit(mm, t).fit < OTHER_OCCUPATION_FIT : h === kind;
      if (!ok) wrong.push(`${t}: ${h}, expected ${kind}`);
    }
    assert.deepEqual(wrong, []);
  });
}

test('scores: the person\'s own words > any order > a synonym > the family > a bare head word > adjacent > a shared head word only', () => {
  assert.ok(FIT.exact > FIT.words && FIT.words > FIT.synonym && FIT.synonym > FIT.family && FIT.family > FIT.generic && FIT.generic > FIT.adjacent && FIT.adjacent > FIT.head);
  assert.ok(FIT.adjacent >= OTHER_OCCUPATION_FIT && FIT.head < OTHER_OCCUPATION_FIT, 'a shared head word alone is another occupation');
  const mm = m(['backend engineer']);
  assert.deepEqual(['Backend Engineer', 'Engineer, Backend', 'Backend Developer', 'Software Engineer', 'Senior Engineer', 'Platform Engineer', 'Mechanical Engineer', 'Product Designer'].map((t) => how(mm, t)),
    ['exact', 'words', 'synonym', 'family', 'generic', 'adjacent', 'head', 'none']);
  // Rank follows: a synonym ranks a little below the person's own title, above the family.
  const notes = loadJobNotes(PEOPLE.template, null);
  const n = { ...notes, search: { ...notes.search, data: normalise.search({ roles: { targets: [{ name: 'B', titles: ['backend engineer'] }] } }) } } as any;
  const at = new Date('2026-11-19T10:00:00Z');
  const s = (title: string) => rankScore({ title, description: '', posted_at: '2026-11-18T10:00:00Z', source: 'board' }, n, at);
  assert.ok(s('Backend Engineer') > s('Backend Developer') && s('Backend Developer') > s('Software Engineer') && s('Software Engineer') > s('Platform Engineer') && s('Platform Engineer') > s('Product Designer'));
});

test('synonym wordings are data, in every language that has them; a bare word is never rewritten', () => {
  assert.deepEqual(expandTitle('backend engineer').slice(0, 3), ['backend developer', 'backend programmer', 'back end engineer']);
  assert.ok(expandTitle('full stack developer').includes('fullstack engineer'));
  assert.deepEqual(expandTitle('developer'), [], 'one word: too wide to rewrite');
  const tw = loadTitleWords();
  assert.ok(tw.synonyms.length >= 20 && tw.occupations.size >= 25);
  for (const lang of ['de', 'fr', 'es', 'pt', 'it', 'nl']) assert.ok(expandTitle(({ de: 'backend entwickler', fr: 'enseignant de maths', es: 'profesor de ingles', pt: 'desenvolvedor backend', it: 'sviluppatore backend', nl: 'leraar wiskunde' } as any)[lang]).length > 0, lang);
  // Every family's adjacent ids exist.
  for (const o of tw.occupations.values()) for (const a of o.adjacent) assert.ok(tw.occupations.has(a), `${o.id} → ${a}`);
});

test('no targets, or roles.match: off: every title fits (nothing is set aside)', () => {
  assert.equal(titleFit(titleMatcher(normalise.search({})), 'Anything').how, 'any');
  assert.equal(titleFit(m(['backend engineer'], {}), 'x').how, 'none');
  assert.equal(titleFit(titleMatcher(normalise.search({ roles: { targets: [{ name: 'B', titles: ['backend engineer'] }], match: 'off' } })), 'Chef').how, 'any');
});

test('the judge brief: soft preferences and the user\'s notes are scoring guidance, never eligibility; yes | no | unclear', () => {
  const notes = loadJobNotes(PEOPLE.template, null);
  const data = normalise.search({ roles: { targets: [{ name: 'B', titles: ['backend engineer'] }] }, judge_notes: 'skip big tech, prefer startups' });
  const brief = judgeBrief({ ...notes, search: { ...notes.search, data } } as any);
  assert.match(brief, /Eligibility is the only reason to answer "no"/);
  assert.match(brief, /never answer "no" because of a title, a preference or a note/);
  assert.match(brief, /own notes for you \(soft preferences .* they move the score, never make a posting "no"\): "skip big tech, prefer startups"/);
  assert.match(brief, /eligible \(yes \| no \| unclear\)/);
  assert.doesNotMatch(brief, /pass \| fail/);
  // Scoring comes after eligibility, never inside it.
  assert.ok(brief.indexOf('skip big tech') > brief.indexOf('## Scoring'));
  // The rules know nothing of soft preferences: compiled rules have no judge_notes drop.
  assert.ok(!JSON.stringify(compileRules({ search: { data } as any, memory: { data: { items: [] } } as any }).regex).includes('big tech'));
});
