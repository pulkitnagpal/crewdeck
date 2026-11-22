// The owner's case as a fictional fixture (design §24.12 `in-backend-remote`, P9d exit check): a senior backend/AI
// engineer in India who wants remote work, and a pool shaped like his first real run: 1,480 postings from 9 sources,
// where the v0.3 phrase gate passed exactly 1, dropped 1,375 on title (281 of them engineering titles) and 92 as only
// for other places. Companies, titles and people are generated and fictional.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tx, upsertRole } from '../../src/jobs/db.ts';
import type { Ctx } from '../../src/jobs/ctx.ts';

export const OWNER_SEARCH = `---
tags: jobs
roles:
  titles: [backend engineer, ai engineer]
  seniority_prefer: [senior, staff, lead]
  exclude_title_words: [intern]
workplace: [remote]
places:
  onsite: []
  remote_from: [India]
languages: [{ name: English, level: fluent }, { name: Hindi, level: native }]
employment_types: [full-time, contract]
licenses: []
exclude: { companies: [], industries: [], travel: none }
schedule: { timezone: Asia/Kolkata, daily_picks: 5, cooldown_days: 60 }
---
# Job search

## Changes
- 2026-11-18: created during setup.
`;

export const SOURCES = [
  ['linkedin', 'LinkedIn'], ['remotive', 'Remotive'], ['weworkremotely', 'We Work Remotely'], ['himalayas', 'Himalayas'], ['jobicy', 'Jobicy'],
  ['remoteok', 'Remote OK'], ['workingnomads', 'Working Nomads'], ['4dayweek', '4 Day Week'], ['nodesk', 'NoDesk'],
] as const;

export const OWNER_SOURCES = `---
tags: jobs
sources:
  - { key: linkedin, name: LinkedIn, linkedin: search }
${SOURCES.slice(1).map(([k, n]) => `  - { key: ${k}, name: ${n}, provider: ${k} }`).join('\n')}
---
# Job sources
`;

/** Today's (v0.3) gate as a user regex: the words adjacent and in order from a word start, as compileRules made it. */
export const OLD_GATE = { rules: { title_gate: ['(?<![\\p{L}\\p{N}])(?:backend[\\s\\-/]+engineer|ai[\\s\\-/]+engineer)'] } };

// Engineering titles the phrase gate dropped: [title forms, how many, how many also limited to another country].
export const ENGINEERING: [string[], number, number][] = [
  [['Full Stack Engineer', 'Senior Full Stack Engineer', 'Full-Stack Engineer'], 40, 6],
  [['Software Engineer', 'Senior Software Engineer', 'Staff Software Engineer', 'Software Engineer II'], 40, 8],
  [['Senior Engineer', 'Staff Engineer', 'Engineer III', 'Principal Engineer'], 28, 6],
  [['Platform Engineer', 'Senior Platform Engineer'], 25, 5],
  [['SRE', 'Senior SRE'], 12, 3],
  [['Data Engineer', 'Senior Data Engineer'], 12, 2],
  [['DevOps Engineer', 'Senior DevOps Engineer'], 18, 4],
  [['Frontend Engineer', 'Senior Frontend Engineer'], 15, 3],
  [['ML Engineer', 'Senior ML Engineer'], 14, 3],
  [['Software Engineer, Backend', 'Senior Software Engineer, Backend'], 12, 2],
  [['Engineer II, Backend Services'], 6, 1],
  [['QA Engineer'], 10, 2],
  [['Sales Engineer'], 8, 2],
  [['Solutions Engineer'], 8, 2],
  [['Mobile Engineer'], 7, 2],
  [['Security Engineer'], 8, 2],
  [['Tech Lead', 'Tech Lead - Platform'], 8, 2],
  [['Backend Developer', 'Senior Backend Developer'], 10, 2],
];
const OTHER = ['Product Designer', 'Account Executive', 'Customer Success Manager', 'Marketing Manager', 'Recruiter', 'Data Analyst',
  'Product Manager', 'Sales Development Representative', 'Support Specialist', 'Content Writer', 'HR Generalist', 'Financial Analyst',
  'Operations Manager', 'Office Manager', 'Sales Manager', 'Copywriter', 'UX Researcher', 'Business Analyst', 'Project Manager',
  'Community Manager', 'Executive Assistant', 'Growth Marketer', 'Technical Recruiter', 'Customer Support Agent', 'Bookkeeper',
  'Legal Counsel', 'Partnerships Lead', 'Brand Designer', 'Video Editor', 'Social Media Manager', 'Account Manager', 'Scrum Master'];
const PLACE_LIMITS: [string, string][] = [
  ['Remote', 'This role is US only.'], ['Remote', 'Candidates must reside in the United States.'], ['Remote', 'Open to EU residents only.'],
  ['Remote', 'We can only hire in Canada.'], ['Remote', 'Applicants must be located in the United Kingdom.'],
];
const OK_PLACES = ['Remote - India', 'Remote (India)', 'Remote', 'Remote - Worldwide', 'Anywhere'];

const COMPANY_A = ['Example', 'Sample', 'Demo', 'Placeholder', 'Fictional', 'Imaginary'];
const COMPANY_B = ['Labs', 'Cloud', 'Ledger', 'Health', 'Studio', 'Systems', 'Works', 'Analytics', 'Robotics', 'Payments', 'Logistics', 'Media'];
const company = (i: number) => `${COMPANY_A[i % COMPANY_A.length]} ${COMPANY_B[Math.floor(i / COMPANY_A.length) % COMPANY_B.length]} ${Math.floor(i / 72) + 1}`;

export type OwnerRole = { title: string; location: string; description: string; kind: 'pass' | 'place' | 'workplace' | 'exclude' | 'engineering' | 'other'; limited: boolean };

/** The 1,480 postings, in a fixed order. */
export function ownerRoles(): OwnerRole[] {
  const out: OwnerRole[] = [];
  const d = (extra = '') => `We build software for teams around the world. ${extra}`.trim();
  out.push({ title: 'Senior Backend Engineer', location: 'Remote - India', description: d('Work from anywhere in India.'), kind: 'pass', limited: false });
  const passing = ['Backend Engineer', 'Senior Backend Engineer', 'AI Engineer', 'Staff AI Engineer', 'Backend Engineer - Payments'];
  for (let i = 0; i < 92; i++) { const [loc, why] = PLACE_LIMITS[i % PLACE_LIMITS.length]; out.push({ title: passing[i % passing.length], location: loc, description: d(why), kind: 'place', limited: true }); }
  for (let i = 0; i < 9; i++) out.push({ title: passing[i % passing.length], location: 'Onsite - Bengaluru, India', description: d(), kind: 'workplace', limited: false });
  for (let i = 0; i < 3; i++) out.push({ title: 'Backend Engineer Intern', location: 'Remote - India', description: d(), kind: 'exclude', limited: false });
  let n = 0;
  for (const [forms, count, limited] of ENGINEERING) {
    for (let i = 0; i < count; i++, n++) {
      const lim = i < limited;
      const [loc, why] = lim ? PLACE_LIMITS[n % PLACE_LIMITS.length] : [OK_PLACES[n % OK_PLACES.length], ''];
      out.push({ title: forms[i % forms.length], location: loc, description: d(why), kind: 'engineering', limited: lim });
    }
  }
  for (let i = 0; out.length < 1480; i++) {
    const lim = i % 10 === 0;
    const [loc, why] = lim ? PLACE_LIMITS[i % PLACE_LIMITS.length] : [OK_PLACES[i % OK_PLACES.length], ''];
    out.push({ title: OTHER[i % OTHER.length], location: loc, description: d(why), kind: 'other', limited: lim });
  }
  return out;
}

/** Write the owner's notes into a temp vault and his pool into the tracker (first seen over the last 10 days). */
export function seedOwner(ctx: Ctx, vault: string, now = new Date('2026-11-19T10:00:00Z')): { ids: string[]; roles: OwnerRole[] } {
  writeFileSync(join(vault, 'jobs', 'search.md'), OWNER_SEARCH);
  writeFileSync(join(vault, 'jobs', 'sources.md'), OWNER_SOURCES);
  return seedOwnerPool(ctx, now);
}

/**
 * Only the pool, as nine sources' fetches would store it (each row with its source key): for a journey whose notes come
 * from the setup interview instead (P9i's acceptance re-run).
 */
export function seedOwnerPool(ctx: Ctx, now = new Date('2026-11-19T10:00:00Z')): { ids: string[]; roles: OwnerRole[] } {
  const roles = ownerRoles();
  const ids: string[] = [];
  const insert = ctx.db.prepare('update roles set first_seen=?, updated_at=? where id=?');
  tx(ctx.db, () => roles.forEach((r, i) => {
    const [key] = SOURCES[i % SOURCES.length];
    const { id } = upsertRole(ctx.db, { url: `https://jobs.example.com/owner/${i}`, title: r.title, company: company(i), location: r.location, description: r.description, source: key === 'linkedin' ? 'linkedin' : 'board', source_key: key });
    const at = new Date(now.getTime() - (i % 10) * 86_400_000 - 3_600_000).toISOString();
    insert.run(at, at, id);
    ids.push(id);
  }));
  return { ids, roles };
}
