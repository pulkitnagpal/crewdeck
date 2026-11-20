// Posting HTML → plain text that keeps paragraphs and list items as lines, and small XML helpers for the RSS/XML
// feeds. Feed bodies are untrusted: every scan is linear (indexOf, no backtracking regex over tags).
import { elements } from '../text.ts';

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç',
};

/** Decode HTML/XML character references (named, decimal, hex). */
export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,30});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'blockquote', 'pre', 'hr', 'dd', 'dt', 'figure', 'header', 'footer']);
const DROP = new Set(['script', 'style', 'noscript', 'template']);

/**
 * Plain text of an HTML fragment: block elements become line breaks, list items get "- ", script/style are dropped,
 * entities decoded, spaces collapsed within lines, no blank lines. HTML that arrives escaped once
 * more (Greenhouse `content`, RSS descriptions: "&lt;p&gt;") is unescaped first.
 */
export function htmlToText(html: string, max = 1_000_000): string {
  let s = String(html ?? '');
  if (s.length > max) s = s.slice(0, max);
  if (!s.includes('<') && /&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('<', i);
    if (a < 0) break;
    out.push(s.slice(i, a));
    if (s.startsWith('<!--', a)) { const c = s.indexOf('-->', a + 4); i = c < 0 ? s.length : c + 3; continue; }
    const b = s.indexOf('>', a + 1);
    if (b < 0) { out.push(s.slice(a)); i = s.length; break; }
    const m = /^<\/?\s*([a-z][a-z0-9-]*)/i.exec(s.slice(a, Math.min(b + 1, a + 40)));
    const name = m?.[1]?.toLowerCase() ?? '';
    const closing = s[a + 1] === '/';
    if (!closing && DROP.has(name)) {
      const end = s.toLowerCase().indexOf(`</${name}`, b + 1);
      const gt = end < 0 ? -1 : s.indexOf('>', end);
      i = gt < 0 ? s.length : gt + 1;
      continue;
    }
    if (name === 'li' && !closing) out.push('\n- ');
    else if (BLOCK.has(name)) out.push('\n');
    else if (name === 'td' || name === 'th') out.push(' ');
    i = b + 1;
  }
  out.push(s.slice(i));
  const lines = decodeEntities(out.join('')).split('\n').map((l) => l.replace(/[ \t\r\f\v ​]+/g, ' ').trim());
  const kept: string[] = [];
  let bullet = false;
  for (const l of lines) {
    if (l === '-') { bullet = true; continue; } // an <li> whose text sits in a nested block
    if (!l) continue; // one line per block; no blank lines
    kept.push(bullet && !l.startsWith('- ') ? `- ${l}` : l);
    bullet = false;
  }
  return kept.join('\n').trim();
}

/** The text inside the first `<name>` of an XML fragment (CDATA unwrapped, entities decoded), or ''. */
export function xmlText(xml: string, name: string): string {
  for (const e of elements(xml, name)) return unwrapCdata(e.inner);
  return '';
}

/** Every `<name>` element's raw inner XML. */
export function xmlAll(xml: string, name: string): string[] {
  return [...elements(xml, name)].map((e) => e.inner);
}

/** CDATA sections unwrapped (their text verbatim); the rest entity-decoded. */
export function unwrapCdata(s: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('<![CDATA[', i);
    if (a < 0) break;
    out.push(decodeEntities(s.slice(i, a)));
    const b = s.indexOf(']]>', a + 9);
    if (b < 0) { out.push(s.slice(a + 9)); i = s.length; break; }
    out.push(s.slice(a + 9, b));
    i = b + 3;
  }
  out.push(decodeEntities(s.slice(i)));
  return out.join('').trim();
}
