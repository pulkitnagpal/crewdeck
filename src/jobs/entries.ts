// The entries "Add another" blocks on application forms ask for (design §24.10, D35): jobs from me/career.md's experience
// sections (with start and end), schools from me/profile.md's education, and the user's referees. Referees are other
// people's details: they fill reference questions only and are never drafted.
import { type Group, groupOf, groupPart, labelKey } from './form-terms.ts';
import type { Career, Profile } from './schema.ts';

export type Entry = Record<string, string>;

/** Every entry the user has for a group, in the order a form lists them (career.md's order; newest school first). */
export function entriesFor(group: Group, career: Pick<Career, 'sections'> | null, profile: Pick<Profile, 'education' | 'references'>): Entry[] {
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
  if (group === 'employment') return (career?.sections ?? []).filter((s) => s.kind === 'experience' && !s.break).map((s) => clean({ org: s.org, title: s.title, where: s.where, start: s.start, end: s.end, dates: s.dates }));
  if (group === 'education') return [...profile.education].sort((a, b) => (b.end_year ?? 0) - (a.end_year ?? 0)).map((e) => clean({ school: e.school, degree: e.degree, discipline: e.discipline, start_year: e.start_year, end_year: e.end_year }));
  return profile.references.map((r) => clean({ ...r }));
}

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, erste: 0, erster: 0, zweite: 1, zweiter: 1, dritte: 2, primera: 0, primer: 0, segunda: 1, segundo: 1, premiere: 0, premier: 0, deuxieme: 1, primeira: 0, primeiro: 0, prima: 0, primo: 0, seconda: 1, eerste: 0, tweede: 1 };
const GROUP_WORDS = /\b(?:referees?|references?|referenz(?:en)?|referencias?|referencia|references?|referenties?|referentie|referenze|referência|referências|employment|employer|job|education)\b/g;

/**
 * Which entry and part a field is: from the fill plan's own `group`/`index` (Claude marks repeated blocks), else from a
 * label that names its block ("Reference 2 email", "Name of first referee"). Null when it isn't part of a block.
 */
export function blockField(label: string, f: { group?: string; index?: number }): { group: Group; index: number; part: string } | null {
  const group = (['employment', 'education', 'reference'] as const).find((g) => g === f.group) ?? (groupOf(label) === 'reference' ? 'reference' : null);
  if (!group) return null;
  const k = labelKey(label);
  const num = /(?:^|\D)(\d{1,2})(?:\D|$)/.exec(k);
  const ord = Object.keys(ORDINALS).find((w) => new RegExp(`\\b${w}\\b`).test(k));
  const index = Number.isInteger(f.index) && f.index! >= 0 ? f.index! : num ? Math.max(0, Number(num[1]) - 1) : ord ? ORDINALS[ord] : 0;
  const rest = k.replace(GROUP_WORDS, ' ').replace(/\b\d{1,2}\b/g, ' ').replace(new RegExp(`\\b(?:${Object.keys(ORDINALS).join('|')})\\b`, 'g'), ' ')
    .replace(/'s\b/g, ' ').replace(/[#:–—()-]/g, ' ').replace(/\b(?:of|the|your|de|der|des|del|do|da|di|van)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const part = groupPart(group, rest) ?? groupPart(group, k);
  return part ? { group, index, part } : null;
}
