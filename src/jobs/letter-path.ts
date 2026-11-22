// Where a role's cover letter PDF lives (P9h): next to its resume, named in the letter's language
// ("Ada Example Anschreiben.pdf"). Kept apart from letter.ts so the fill plan can ask without loading the renderer.
import { join } from 'node:path';
import type { Ctx } from './ctx.ts';
import { getRole } from './db.ts';
import type { JobNotes } from './notes.ts';
import { documentWords } from './form-terms.ts';

/** The letter's language: the form's, else the resume's, else the facts', else English. */
export function letterLang(ctx: Ctx, roleId: string, notes: Pick<JobNotes, 'career'>, lang?: string | null): string {
  const r = getRole(ctx.db, roleId);
  return lang || r.form_lang || notes.career.data.resume.language || notes.career.data.language || 'en';
}

export function letterFileName(notes: Pick<JobNotes, 'profile'>, lang: string): string {
  const id = notes.profile.data.identity;
  const name = [id.first_name, id.last_name].filter(Boolean).join(' ').replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim();
  return `${name ? `${name} ` : ''}${documentWords(lang).letter}.pdf`.slice(0, 120);
}

export const letterPath = (ctx: Ctx, roleId: string, notes: Pick<JobNotes, 'career' | 'profile'>, lang?: string | null) =>
  join(ctx.home, 'out', roleId, letterFileName(notes, letterLang(ctx, roleId, notes, lang)));
