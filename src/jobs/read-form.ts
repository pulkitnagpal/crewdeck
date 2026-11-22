// Prepare reads the application form before the user is asked anything (design §2.3 step 4): the role's form is opened
// headless through the guard proxy and every question is read (labels, kinds, required marks, options, Yes/No button
// groups, every frame), then stored per role. Nothing is typed, clicked or submitted. Forms that can't be read this way
// (LinkedIn Easy Apply, sign-in walls, forms built only after clicks) come back as `needs`: Claude reads them live in the
// pane and records each question with `crewdeck jobs learn` (P4 skills).
import type { Frame, Page } from 'playwright-core';
import { type Ctx, notesOf } from './ctx.ts';
import { getRole } from './db.ts';
import { detectApplyKind } from './apply-kind.ts';
import { applyUrl, checkRoleUrl, copyOnlyHost, isLinkedinHost, hostOf } from './fields.ts';
import { launchGuarded } from './browser.ts';
import type { NetOptions } from './net/netguard.ts';
import { type FormQuestion, cleanQuestions, storeFormFields } from './kb/questions.ts';
import { setApplyUrl, setFormLang } from './pipeline/roles.ts';

type Raw = { label: string; kind: string; required: boolean; options: string[]; char_limit?: number; section?: string };
type PageRead = { questions: Raw[]; password: boolean; captcha: boolean };

/**
 * Runs inside the page (serialised by Playwright, so it must be self-contained): inputs, selects and textareas as
 * questions, radio/checkbox sets as one question with options, and groups of short option buttons (Yes/No toggles)
 * with the text before them as the question. Hidden, read-only and disabled fields are skipped; submit buttons never
 * count as options.
 */
function readPage(): PageRead {
  const textOf = (n: Element | null | undefined): string => {
    if (!n) return '';
    const c = n.cloneNode(true) as Element;
    c.querySelectorAll('input,select,textarea,option,script,style').forEach((x) => x.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const visible = (el: Element) => {
    if (!(el as HTMLElement).getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const byIds = (ids: string | null) => (ids || '').split(/\s+/).map((id) => textOf(document.getElementById(id))).filter(Boolean).join(' ');
  const out: Raw[] = [];
  const els = [...document.querySelectorAll('input, textarea, select')] as (HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement)[];
  const seenGroups = new Set<string>();
  let password = false;
  for (const el of els) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(type)) continue;
    if (type === 'password') { if (visible(el)) password = true; continue; }
    if (type !== 'file' && !visible(el)) continue;
    if (el.disabled || (el as HTMLInputElement).readOnly) continue;
    const sectionBox = el.closest('section, fieldset');
    const section = textOf(sectionBox?.querySelector('h2, h3, h4, legend')) || undefined;
    const marked = (s: string) => /[*✱]/.test(s);
    if (type === 'radio' || type === 'checkbox') {
      const group = el.name || el.id;
      const members = group ? els.filter((x) => (x.name || x.id) === group && x.type === el.type) : [el];
      if (group && seenGroups.has(group)) continue;
      if (group) seenGroups.add(group);
      const fs = el.closest('fieldset, [role=radiogroup], [role=group]');
      const optionText = (m: HTMLInputElement) => textOf(m.labels?.[0]) || m.getAttribute('aria-label') || m.value;
      if (type === 'checkbox' && members.length === 1 && !fs?.querySelector('legend')) {
        // A lone checkbox ("I agree to …") is a yes/no question in its own right.
        const label = optionText(el);
        out.push({ label: label.replace(/\s*[*✱]\s*$/, ''), kind: 'checkbox', required: el.required || marked(label), options: [], section });
        continue;
      }
      // No fieldset: climb to the smallest box holding every option, then take the first text in it that isn't an option.
      const titleNear = () => {
        const optionLabels = members.flatMap((m) => [...(m.labels ?? [])]);
        let box: Element | null = el.parentElement;
        while (box && !members.every((m) => box!.contains(m))) box = box.parentElement;
        for (let up = box; up && up !== document.body; up = up.parentElement) {
          const walker = document.createTreeWalker(up, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = (n.textContent || '').trim();
            const host = n.parentElement;
            if (!t || !host || optionLabels.some((l) => l.contains(host)) || host.closest('option, script, style')) continue;
            return t;
          }
        }
        return '';
      };
      const label = textOf(fs?.querySelector('legend')) || fs?.getAttribute('aria-label') || byIds(fs?.getAttribute('aria-labelledby') ?? null) || titleNear() || group;
      out.push({ label: label.replace(/\s*[*✱]\s*$/, ''), kind: type, required: members.some((m) => m.required || m.getAttribute('aria-required') === 'true') || marked(label), options: members.map(optionText), section: fs ? undefined : section });
      continue;
    }
    const wrapping = el.closest('label');
    const label = textOf(el.labels?.[0]) || byIds(el.getAttribute('aria-labelledby')) || el.getAttribute('aria-label') || textOf(wrapping) || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '';
    const combobox = el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete');
    const kind = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : type === 'file' ? 'file' : combobox ? 'combobox' : 'text';
    const options = el.tagName === 'SELECT' ? [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|please select)\b.*(\.\.\.|…)?$/i.test(t) && t !== '--') : [];
    const max = (el as HTMLInputElement).maxLength;
    out.push({ label: label.replace(/\s*[*✱]\s*$/, ''), kind, required: !!el.required || el.getAttribute('aria-required') === 'true' || marked(label), options, char_limit: max > 0 && max < 100000 ? max : undefined, section });
  }
  // Groups of 2+ short option buttons (Yes/No toggles) with the question title before them.
  const seen = new Set<Element>();
  for (const b of document.querySelectorAll('button, [role=radio], [role=option]')) {
    const box = b.parentElement;
    if (!box || seen.has(box)) continue;
    const kids = [...box.children].filter((k) => k.matches('button, [role=radio], [role=option]'));
    if (kids.length < 2 || kids.length !== box.children.length) continue;
    if (!visible(box) || box.closest('[role=listbox], [role=menu], nav, header, footer')) continue;
    if (kids.some((k) => (k.tagName === 'BUTTON' && ((k as HTMLButtonElement).type === 'submit' || !!k.closest('form') && !k.getAttribute('type'))) || textOf(k).length > 24 || !textOf(k))) continue;
    seen.add(box);
    let title = '';
    for (let up: Element | null = box; !title && up && up !== document.body; up = up.parentElement) {
      const w = document.createTreeWalker(up, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        const s = (t.textContent || '').trim();
        if (s && t.parentElement && !box.contains(t.parentElement) && !t.parentElement.closest('script, style')) { title = s; break; }
      }
    }
    const clean = title.replace(/\s*[*✱]\s*$/, '');
    if (!clean || out.some((q) => q.label === clean)) continue;
    out.push({ label: clean, kind: 'radio', required: /[*✱]/.test(textOf(box.parentElement)), options: kids.map((k) => textOf(k)) });
  }
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile');
  return { questions: out, password, captcha };
}

/** Every frame's questions, the main frame first; a label seen twice is kept once. */
export async function readQuestions(page: Page): Promise<PageRead> {
  const all: PageRead = { questions: [], password: false, captcha: false };
  const labels = new Set<string>();
  for (const f of [page.mainFrame(), ...page.frames().filter((x) => x !== page.mainFrame())] as Frame[]) {
    const r = await f.evaluate(readPage).catch(() => null);
    if (!r) continue;
    all.password ||= r.password;
    all.captcha ||= r.captcha;
    for (const q of r.questions) {
      const key = q.label.trim().toLowerCase();
      if (!key || labels.has(key)) continue;
      labels.add(key);
      all.questions.push(q);
    }
  }
  return all;
}

export type FormRead = { role: string; url: string; stored: number; questions: FormQuestion[]; notes: string[]; blocked: string[]; needs?: string; /** the page's lang (D33) */ lang?: string };
export type ReadOptions = { url?: string; net?: NetOptions; browser?: string; timeoutMs?: number };

const LIVE = 'Read it live instead: open it in a background tab of the browser pane, step through the pages (Next only, never Review or Submit), record each question with `crewdeck jobs learn <role> --label-file …`, then close the tab.';

/** Read a role's application form headlessly and store its questions. `url` (the form's own address) is stored too. */
export async function readForm(ctx: Ctx, roleId: string, o: ReadOptions = {}): Promise<FormRead> {
  const r = getRole(ctx.db, roleId);
  const url = o.url ? setApplyUrl(ctx, roleId, o.url) : r.apply_url ? checkRoleUrl(r.apply_url, ctx.features, 'apply URL') : applyUrl(r.url);
  const base: FormRead = { role: roleId, url, stored: 0, questions: [], notes: [], blocked: [] };
  const profile = notesOf(ctx).profile.data;
  if (isLinkedinHost(hostOf(url)) || detectApplyKind(r).kind === 'linkedin_easy') return { ...base, needs: `LinkedIn forms are read in the user's own signed-in browser, not headless. ${LIVE}` };
  // Naukri's Apply sends the person's Naukri profile in one click: there is no form before it to read, and any recruiter
  // questions appear only after the person clicks it (the Apply playbook fills those then).
  if (detectApplyKind(r).kind === 'naukri') return { ...base, needs: 'Naukri applies in one click with the user\'s Naukri profile: there is no form to read before it. Prepare the summary (why it fits, profile gaps to fix on Naukri first) and the answers to likely recruiter questions; never click its Apply.' };
  const copy = copyOnlyHost(url, profile.copy_only_hosts);
  if (copy) return { ...base, needs: `${copy} forbids automated use: the user fills it by hand with the answers to copy. Ask the user for the questions, or record the ones they read out with crewdeck jobs learn.` };
  const g = await launchGuarded({ setting: o.browser, net: o.net });
  try {
    const page = await g.context.newPage();
    let res;
    try { res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs ?? 30_000 }); }
    catch (e: any) {
      const why = /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(e.message) ? 'it answered with an HTTP error' : String(e.message).split('\n')[0].replace(/^page\.goto: /, '');
      return { ...base, blocked: [...new Set(g.proxy.blocked.map((b) => b.host))], needs: `the form could not be opened (${why}). ${LIVE}` };
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    base.blocked = [...new Set(g.proxy.blocked.map((b) => b.host))];
    const status = res?.status() ?? 0;
    if (status === 403 && base.blocked.length) return { ...base, needs: `the form's address was refused (${g.proxy.blocked[0].reason})` };
    if (status >= 400) return { ...base, needs: `the form answered HTTP ${status}. ${LIVE}` };
    const read = await readQuestions(page);
    base.blocked = [...new Set(g.proxy.blocked.map((b) => b.host))];
    if (read.captcha) base.notes.push('the form has a CAPTCHA: the user solves it when applying');
    if (read.password) return { ...base, needs: `the page asks for a password (sign-in or account creation): only the user signs in. ${LIVE}` };
    const questions = cleanQuestions(read.questions);
    if (!questions.filter((q) => q.kind !== 'file').length) return { ...base, questions, needs: `no questions could be read headlessly (the form may be built by clicks or behind "Apply"). ${LIVE}` };
    const stored = storeFormFields(ctx.db, roleId, profile, questions);
    // The form's language from the page (D33): answers are drafted in it. Claude sets it from the labels otherwise.
    const lang = (/^([a-z]{2})(?:[-_]|$)/.exec(String(await page.evaluate(() => document.documentElement.lang || '').catch(() => '')).trim().toLowerCase()) ?? [])[1] ?? '';
    if (/^[a-z]{2}$/.test(lang)) setFormLang(ctx, roleId, lang);
    const left = questions.filter((q) => q.kind !== 'file').length - stored;
    if (left > 0) base.notes.push(`${left} ID, bank or tax number question${left === 1 ? '' : 's'} not stored: the user types ${left === 1 ? 'it' : 'them'} in the form`);
    return { ...base, stored, questions, ...(/^[a-z]{2}$/.test(lang) ? { lang } : {}) };
  } finally { await g.close(); }
}
