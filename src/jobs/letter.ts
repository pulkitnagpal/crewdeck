// `crewdeck jobs letter` (design §24.10, D35): a cover letter or supporting statement for one role, written by Claude,
// held to the citation check like any answer (in the letter's language, facts through their approved translations),
// and printed with the resume's template: the same identity header, JavaScript and the network off, at most two pages.
// The fill plan offers it for upload fields labelled cover letter, Anschreiben or supporting statement.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { ROLE_ID, addEvent, getRole } from './db.ts';
import { renderPdf } from './browser.ts';
import { type Claim, checkAnswer } from './kb/cite.ts';
import { citeContext } from './kb/ops.ts';
import { resumeHtml, resumeModel, rich } from './resume.ts';
import { documentWords, languageName, LANG_CODE } from './form-terms.ts';
import { letterLang, letterPath } from './letter-path.ts';

export const LETTER_MAX_PAGES = 2;
const MAX_CHARS = 8000;

/** The letter's text and claims, checked (nothing is printed when a claim isn't supported). */
export function checkLetter(ctx: Ctx, roleId: string, text: string, claims: Claim[], lang?: string | null) {
  if (!ROLE_ID.test(roleId)) throw new Error(`"${roleId}" is not a role id`);
  getRole(ctx.db, roleId);
  if (lang && !LANG_CODE.test(lang)) throw new Error('--lang must be a two-letter language code (en, de, es …)');
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('the letter is empty');
  if (body.length > MAX_CHARS) throw new Error(`the letter is longer than ${MAX_CHARS} characters`);
  const notes = notesOf(ctx);
  const l = letterLang(ctx, roleId, notes, lang);
  const check = checkAnswer({ text: body, claims: Array.isArray(claims) ? claims : [] }, { ...citeContext(ctx, roleId, notes), lang: l });
  if (!check.ok) throw new Error(`the letter was not rendered: ${check.reason}`);
  return { notes, lang: l, body };
}

/** Render a role's letter to <jobs.home>/out/<role>/<name> <Cover Letter|Anschreiben|…>.pdf. */
export async function renderLetter(ctx: Ctx, roleId: string, text: string, claims: Claim[], o: { browser?: string; lang?: string | null } = {}) {
  const { notes, lang, body } = checkLetter(ctx, roleId, text, claims, o.lang);
  const career = notes.career.data, profile = notes.profile.data;
  const model = { ...resumeModel(career, profile, { sections: {} }), lang };
  const words = documentWords(lang);
  let date: string;
  try { date = new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(ctx.clock()); } catch { date = ctx.clock().toISOString().slice(0, 10); }
  const paragraphs = body.split(/\n\s*\n/).map((p) => `<p class="par">${rich(p.replace(/\n/g, ' '))}</p>`).join('\n');
  const html = resumeHtml(model, { title: `${model.name} ${words.letter}`, body: `<section class="letter"><p class="date">${rich(date)}</p>\n${paragraphs}</section>` });
  const pdf = letterPath(ctx, roleId, notes, lang);
  const dir = dirname(pdf);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, 'letter.html');
  writeFileSync(file, html, { mode: 0o600 });
  const tmp = join(dir, `.letter-${randomBytes(6).toString('hex')}.pdf`);
  try {
    const r = await renderPdf(file, tmp, { setting: o.browser, paper: career.resume.paper });
    if (r.pages > LETTER_MAX_PAGES) throw new Error(`the letter is ${r.pages} pages; at most ${LETTER_MAX_PAGES}: shorten it`);
    chmodSync(tmp, 0o600);
    renameSync(tmp, pdf);
    addEvent(ctx.db, roleId, 'letter', `${r.pages} page${r.pages > 1 ? 's' : ''}, ${languageName(lang)}`, nowIso(ctx));
    return { pdf, pages: r.pages, lang, html: file };
  } finally { rmSync(tmp, { force: true }); }
}
