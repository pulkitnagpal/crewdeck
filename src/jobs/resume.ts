// The tailored resume (design D8): `me/career.md` sections + the facts Claude selected by id for this role + a generic
// template → PDF. Claude selects, never writes: the variant names fact ids per section (checked: they exist, belong to
// that section, respect max_bullets, required sections aren't empty) and skills from the note. The identity header comes
// from `me/profile.md`. Rendered in headless Chromium with JavaScript and the network off; max_pages is enforced.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { ROLE_ID, addEvent, getRole } from './db.ts';
import type { Career, Profile, Section } from './schema.ts';
import { renderPdf } from './browser.ts';
import { resumeFileName } from './views.ts';

export type Variant = { sections: Record<string, string[]>; skills?: string[] };
const FACT_KINDS = ['summary', 'experience', 'list'];
const DIR = join(import.meta.dirname, 'resume');

/** The variant file's shape (values are checked against the notes by validateVariant). */
export function cleanVariant(raw: unknown): Variant {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the variant file must hold { "sections": { "<section id>": ["<fact id>", …] }, "skills"?: [...] }');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !['sections', 'skills'].includes(k));
  if (extra.length) throw new Error(`the variant has unknown keys: ${extra.join(', ')} (only sections and skills)`);
  const s = r.sections;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('variant.sections must map section ids to lists of fact ids');
  const sections: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`variant.sections.${k} must be a list of fact ids`);
    sections[k] = (v as string[]).map((x) => x.trim());
  }
  if (r.skills !== undefined && (!Array.isArray(r.skills) || r.skills.some((x) => typeof x !== 'string'))) throw new Error('variant.skills must be a list of skills from me/career.md');
  return { sections, skills: r.skills === undefined ? undefined : (r.skills as string[]).map((x) => x.trim()) };
}

/** Every problem with a variant against the career note, all at once (empty = valid). */
export function validateVariant(career: Career, v: Variant): string[] {
  const errs: string[] = [];
  const sections = new Map(career.sections.map((s) => [s.id, s]));
  const facts = new Map(career.facts.map((f) => [f.id, f]));
  const used = new Set<string>();
  for (const [sid, ids] of Object.entries(v.sections)) {
    const s = sections.get(sid);
    if (!s) { errs.push(`unknown section "${sid}" (me/career.md has: ${career.sections.map((x) => x.id).join(', ') || 'none'})`); continue; }
    if (!FACT_KINDS.includes(s.kind)) { errs.push(`section "${sid}" is a ${s.kind} section: it takes no facts${s.kind === 'skills' ? ' (choose skills with "skills")' : ' (education comes from me/profile.md)'}`); continue; }
    for (const id of ids) {
      const f = facts.get(id);
      if (!f) { errs.push(`unknown fact "${id}" in section "${sid}"`); continue; }
      const own = id.slice(0, id.indexOf('.'));
      if (own !== sid) errs.push(`fact "${id}" belongs to section "${own}", not "${sid}"`);
      if (used.has(id)) errs.push(`fact "${id}" is selected twice`);
      used.add(id);
    }
    if (s.max_bullets && ids.length > s.max_bullets) errs.push(`section "${sid}" has ${ids.length} facts; its max_bullets is ${s.max_bullets}`);
  }
  for (const s of career.sections) if (s.required && FACT_KINDS.includes(s.kind) && !(v.sections[s.id] ?? []).length) errs.push(`section "${s.id}" is required: select at least one of its facts`);
  if (!used.size && !errs.length) errs.push('the variant selects no facts');
  if (v.skills) {
    const known = new Map(career.skills.map((k) => [k.toLowerCase(), k]));
    const seen = new Set<string>();
    for (const k of v.skills) {
      if (!known.has(k.toLowerCase())) errs.push(`skill "${k}" is not in me/career.md skills`);
      if (seen.has(k.toLowerCase())) errs.push(`skill "${k}" is listed twice`);
      seen.add(k.toLowerCase());
    }
  }
  return errs;
}

// ---- model ----
export type Block =
  | { kind: 'summary'; title: string; paragraphs: string[] }
  | { kind: 'experience'; title: string; entries: { title: string; org: string; where: string; dates: string; bullets: string[] }[] }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'skills'; title: string; items: string[] }
  | { kind: 'education'; title: string; items: { what: string; where: string; dates: string }[] };
export type ResumeModel = { name: string; contact: { text: string; href?: string }[]; paper: 'A4' | 'Letter'; blocks: Block[] };

/** A link as people read it: no scheme, no "www.", no trailing slash. */
export const displayLink = (u: string) => u.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

/** What goes on the page, in career.md order. Consecutive experience sections share one "Experience" heading. */
export function resumeModel(career: Career, profile: Profile, v: Variant): ResumeModel {
  const facts = new Map(career.facts.map((f) => [f.id, f.text]));
  const pick = (s: Section) => (v.sections[s.id] ?? []).map((id) => facts.get(id) ?? '').filter(Boolean);
  const id = profile.identity;
  const name = [id.first_name, id.last_name].filter(Boolean).join(' ') || id.preferred_name || 'Resume';
  const contact: ResumeModel['contact'] = [];
  if (id.email) contact.push({ text: id.email, href: `mailto:${id.email}` });
  if (id.phone) contact.push({ text: id.phone });
  const place = [id.city, id.region || id.country].filter(Boolean).join(', ');
  if (place) contact.push({ text: place });
  for (const url of Object.values(id.links)) if (/^https?:\/\//i.test(url)) contact.push({ text: displayLink(url), href: url });
  const blocks: Block[] = [];
  for (const s of career.sections) {
    if (s.kind === 'summary') {
      const p = pick(s);
      if (p.length) blocks.push({ kind: 'summary', title: s.title ?? '', paragraphs: [p.join(' ')] });
    } else if (s.kind === 'experience') {
      const bullets = pick(s);
      if (!bullets.length) continue;
      const entry = { title: s.title ?? '', org: s.org ?? '', where: s.where ?? '', dates: s.dates ?? '', bullets };
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'experience') last.entries.push(entry);
      else blocks.push({ kind: 'experience', title: 'Experience', entries: [entry] });
    } else if (s.kind === 'list') {
      const items = pick(s);
      if (items.length) blocks.push({ kind: 'list', title: s.title ?? '', items });
    } else if (s.kind === 'skills') {
      const items = v.skills ? v.skills.map((k) => career.skills.find((x) => x.toLowerCase() === k.toLowerCase()) ?? k) : career.skills;
      if (items.length) blocks.push({ kind: 'skills', title: s.title ?? 'Skills', items });
    } else if (s.kind === 'education') {
      const items = [...profile.education].sort((a, b) => (b.end_year ?? 0) - (a.end_year ?? 0)).map((e) => ({
        what: [e.degree, e.discipline].filter(Boolean).join(', ') || e.school, where: e.degree || e.discipline ? e.school : '',
        dates: e.start_year && e.end_year ? `${e.start_year} – ${e.end_year}` : String(e.end_year ?? e.start_year ?? ''),
      }));
      if (items.length) blocks.push({ kind: 'education', title: s.title ?? 'Education', items });
    }
  }
  return { name, contact, paper: career.resume.paper, blocks };
}

// ---- HTML ----
const esc = (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Fact text: escaped, with **bold** as the only markup kept. */
export const rich = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h) ? esc(h) : '');

function blockHtml(b: Block): string {
  const h2 = b.title ? `<h2>${esc(b.title)}</h2>` : '';
  if (b.kind === 'summary') return `<section class="block summary">${h2}${b.paragraphs.map((p) => `<p class="summary">${rich(p)}</p>`).join('')}</section>`;
  if (b.kind === 'experience') return `<section class="block experience">${h2}${b.entries.map((e) => `
<div class="entry"><div class="head"><div class="line"><h3>${esc(e.title)}</h3><span class="dates">${esc(e.dates)}</span></div>
${e.org || e.where ? `<div class="org">${esc([e.org, e.where].filter(Boolean).join(' · '))}</div>` : ''}</div>
<ul class="bullets">${e.bullets.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></div>`).join('')}</section>`;
  if (b.kind === 'list') return `<section class="block list">${h2}<ul class="bullets">${b.items.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></section>`;
  if (b.kind === 'skills') return `<section class="block skills">${h2}<p class="skills">${b.items.map((x) => `<span>${esc(x)}</span>`).join('')}</p></section>`;
  return `<section class="block education">${h2}${b.items.map((e) => `<div class="edu"><div><span class="what">${esc(e.what)}</span>${e.where ? ` <span class="where">— ${esc(e.where)}</span>` : ''}</div><span class="dates">${esc(e.dates)}</span></div>`).join('')}</section>`;
}

export function resumeHtml(m: ResumeModel): string {
  const header = `<header class="identity"><h1>${esc(m.name)}</h1>${m.contact.length ? `<div class="contact">${m.contact.map((c) => {
    const href = c.href ? safeHref(c.href) : '';
    return `<span>${href ? `<a href="${href}">${esc(c.text)}</a>` : esc(c.text)}</span>`;
  }).join('')}</div>` : ''}</header>`;
  const fill: Record<string, string> = {
    TITLE: esc(`${m.name} Resume`), PAGE_SIZE: m.paper, PAGE_MARGIN: m.paper === 'Letter' ? '0.6in 0.7in' : '15mm 17mm',
    STYLE: readFileSync(join(DIR, 'style.css'), 'utf8'), HEADER: header, BODY: m.blocks.map(blockHtml).join('\n'),
  };
  return readFileSync(join(DIR, 'template.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (all, k) => fill[k] ?? all);
}

export type Rendered = { pdf: string; pages: number; facts: string[]; html: string };

/**
 * Render the tailored resume for a role into <jobs.home>/out/<role>/: validated first, then printed offline. A PDF
 * longer than max_pages is deleted and the call fails, so an overflowing resume is never offered for upload.
 */
export async function renderResume(ctx: Ctx, roleId: string, raw: unknown, o: { browser?: string } = {}): Promise<Rendered> {
  if (!ROLE_ID.test(roleId)) throw new Error(`"${roleId}" is not a role id`);
  getRole(ctx.db, roleId);
  const notes = notesOf(ctx);
  const career = notes.career.data, profile = notes.profile.data;
  const v = cleanVariant(raw);
  const errs = validateVariant(career, v);
  if (errs.length) throw new Error(`the variant was not rendered:\n- ${errs.join('\n- ')}`);
  const out = join(ctx.home, 'out');
  const dir = join(out, roleId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  chmodSync(dir, 0o700);
  const html = join(dir, 'resume.html');
  writeFileSync(html, resumeHtml(resumeModel(career, profile, v)), { mode: 0o600 });
  chmodSync(html, 0o600);
  const pdf = join(dir, resumeFileName(career, profile));
  const tmp = join(dir, `.resume-${randomBytes(6).toString('hex')}.pdf`);
  try {
    const r = await renderPdf(html, tmp, { setting: o.browser, paper: career.resume.paper });
    if (r.pages > career.resume.max_pages) throw new Error(`the resume is ${r.pages} pages; max_pages in me/career.md is ${career.resume.max_pages}: select fewer facts`);
    chmodSync(tmp, 0o600);
    renameSync(tmp, pdf);
    const facts = Object.values(v.sections).flat();
    addEvent(ctx.db, roleId, 'resume', `${r.pages} page${r.pages > 1 ? 's' : ''}, ${facts.length} facts`, nowIso(ctx));
    return { pdf, pages: r.pages, facts, html };
  } finally { rmSync(tmp, { force: true }); }
}
