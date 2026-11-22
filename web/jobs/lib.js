// Small helpers every screen shares. Screens are pure (data and callbacks in, markup out), so they also render in Node
// for tests; nothing here touches the page at import time.
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
export const noop = () => {};
export const cls = (...a) => a.filter(Boolean).join(' ');
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Only http(s) links from data (postings, profile links) ever become an href. */
export function safeHref(u) {
  try { const x = new URL(String(u ?? '')); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}

/** "14:05" for an ISO time, in the viewer's clock. */
export const clock = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

/** "2 min ago" for an ISO time. */
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** The address of a note page in Notes (SilverBullet on its own port, same host as this page). */
export function notesUrl(port, page) {
  const loc = globalThis.location;
  const host = loc ? `${loc.protocol}//${loc.hostname}` : 'http://localhost';
  return `${host}:${port}/${page ? page.split('/').map(encodeURIComponent).join('/') : ''}`;
}

/** Icons as Preact elements, like everything else on the page. */
const paths = {
  briefcase: html`<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7M3 12.5h18"/>`,
  search: html`<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>`,
  sparkle: html`<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>`,
  check: html`<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  link: html`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  note: html`<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>`,
  copy: html`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>`,
  // The two kinds of source: a feed (automatic, free) and an account (a site you sign in to).
  feed: html`<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.5"/>`,
  person: html`<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>`,
  bookmark: html`<path d="M6 3h12v18l-6-4-6 4z"/>`,
  close: html`<path d="M6 6l12 12M18 6L6 18"/>`,
  dots: html`<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>`,
  eyeoff: html`<path d="M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 4.2 9.5 6a12 12 0 0 1-2.6 3.2M6.5 7.6A12 12 0 0 0 2.5 12c1 1.8 4.5 6 9.5 6 1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
};
/** `fill` paints the shape in the current colour (a saved bookmark). */
export const Icon = ({ name, size = 16, fill = false }) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true" focusable="false" fill=${fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
/** The mark on every action that spends Claude's tokens (Find, Apply, Prepare, Judge, Quick apply); free actions never carry it. */
export const Spark = ({ size = 16 }) => html`<span class="spark"><${Icon} name="sparkle" size=${size} /></span>`;
/** "21 h", "3 d" for how long ago an ISO time was (a posting's age); '' when unknown. */
export function age(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const h = Math.max(0, (now - t) / 3_600_000);
  return h < 1 ? 'now' : h < 48 ? `${Math.round(h)} h` : h < 24 * 60 ? `${Math.round(h / 24)} d` : `${Math.round(h / (24 * 30))} mo`;
}
/** "posted 21 h ago", "posted just now". */
export const postedText = (iso, now = Date.now()) => { const a = age(iso, now); return !a ? '' : a === 'now' ? 'posted just now' : `posted ${a} ago`; };

/** A Copy button for a value (a folder, a command, an answer). */
export function CopyButton({ text, label = 'Copy', onCopied = noop }) {
  const copy = async () => {
    try { await globalThis.navigator.clipboard.writeText(text); onCopied('Copied'); }
    catch { onCopied('Copy did not work here: select the text instead', true); }
  };
  return html`<button type="button" class="btn small" onClick=${copy} aria-label=${`${label}: ${text}`}>${label}</button>`;
}

/**
 * Progressive disclosure (the UX pass): a one-line summary that opens to the details. A native <details>, so it is
 * keyboard- and screen-reader-accessible with no script, and printable. Use it for "how it works", "why", long help.
 */
export function More({ summary = 'Details', children, open = false }) {
  return html`<details class="more" open=${open}><summary>${summary}</summary><div class="more-body">${children}</div></details>`;
}
