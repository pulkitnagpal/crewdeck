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
};
export const Icon = ({ name, size = 16 }) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;

/** A Copy button for a value (a folder, a command, an answer). */
export function CopyButton({ text, label = 'Copy', onCopied = noop }) {
  const copy = async () => {
    try { await globalThis.navigator.clipboard.writeText(text); onCopied('Copied'); }
    catch { onCopied('Copy did not work here: select the text instead', true); }
  };
  return html`<button type="button" class="btn small" onClick=${copy} aria-label=${`${label}: ${text}`}>${label}</button>`;
}
