// The D41 checks on a page in a real headless Chromium (design §24.13, P9e, P9i): every visible text's computed size and
// its contrast with the first opaque background behind it, controls without a label, and controls the keyboard can't
// reach. Shared by sources-ui.test.ts and a11y-ui.test.ts.
import type { Page } from 'playwright-core';

/** Every visible text in the screen: its computed size and its contrast with the first opaque background behind it. */
export async function audit(page: Page, root = '.srcs') {
  return page.evaluate((root) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bg = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c.slice(0, 3); }
      return [255, 255, 255];
    };
    const out: { text: string; size: number; ratio: number }[] = [];
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      const t = n.textContent!.trim();
      if (!t || el.closest('.sr, option, button:disabled, [disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      const a = lum(rgb(cs.color)), b = lum(bg(el));
      out.push({ text: t.slice(0, 40), size: parseFloat(cs.fontSize), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
    }
    return out;
  }, root);
}


/** Buttons, fields and switches under `root` with no accessible name (aria-label, aria-labelledby, text or a <label>). */
export function unlabelled(page: Page, root: string) {
  return page.evaluate((root) => [...document.querySelectorAll(`${root} button, ${root} input, ${root} select, ${root} textarea, ${root} [role="switch"]`)]
    .filter((e) => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.textContent?.trim() || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label')))
    .map((e) => e.outerHTML.slice(0, 120)), root);
}

/** Visible, enabled controls under `root` that Tab skips (a tabindex below 0); a tab list's own arrow keys excepted. */
export function unreachable(page: Page, root: string) {
  return page.evaluate((root) => {
    const visible = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const controls = [...document.querySelectorAll(`${root} button, ${root} input, ${root} select, ${root} textarea, ${root} a[href], ${root} [role="switch"], ${root} [role="tab"]`)];
    return controls.filter((e) => visible(e) && !(e as HTMLButtonElement).disabled && (e as HTMLElement).tabIndex < 0 && !e.closest('[role="tablist"]')).map((e) => e.outerHTML.slice(0, 120));
  }, root);
}

/** Press Tab from the top of the page until focus comes back round; the controls it passed through, by accessible name. */
export async function tabWalk(page: Page, max = 400): Promise<string[]> {
  // Start from the top: a click on the page's empty corner moves the Tab starting point there.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.click(1, 1);
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; return (e.getAttribute('aria-label') || e.textContent?.trim() || (e as HTMLInputElement).placeholder || e.id || e.tagName).slice(0, 60); });
    if (name === null) { if (seen.length) break; continue; }
    if (seen.length && name === seen[0] && i > 3) break;
    seen.push(name);
  }
  return seen;
}
