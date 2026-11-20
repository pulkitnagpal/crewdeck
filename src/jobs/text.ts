// Posting text as plain words: tags and entities out, whitespace collapsed; long postings keep their start and end
// (location and eligibility rules often sit at the end).
//
// Pages are hostile input (E6): every scan here is linear. Tags are found with indexOf, never with a lazy `[\s\S]*?`
// or `[^>]*` that restarts at each `<`, and input is capped at HTML_MAX characters first.
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** The most of a page any text scan reads (≈400 KB): postings put their text, JSON-LD and meta tags well before it. */
export const HTML_MAX = 400_000;

/**
 * The end of the element opened at `from` (just after its open tag's name): the index after `</name>`, or -1 when it is
 * never closed. One regex search from `from`, so a page with thousands of unclosed tags stays linear.
 */
export function closeOf(s: string, name: string, from: number): { start: number; end: number } | null {
  const re = new RegExp(`</${name}\\s*>`, 'gi');
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Each `<name …>…</name>` element in order: its open tag's text and its inner text. Linear in the page's length. */
export function* elements(s: string, name: string): Generator<{ tag: string; inner: string; index: number }> {
  const open = new RegExp(`<${name}\\b`, 'gi');
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(s);
    if (!m) return;
    const gt = s.indexOf('>', m.index);
    if (gt < 0) return; // no '>' anywhere after: no later tag can close either
    const close = closeOf(s, name, gt + 1);
    if (!close) return;
    yield { tag: s.slice(m.index, gt + 1), inner: s.slice(gt + 1, close.start), index: m.index };
    from = close.end;
  }
}

/** The inner HTML after the first `marker` (an attribute or class name) up to `</close>`: `marker[^>]*>(.*?)</close>`, linearly. */
export function after(s: string, marker: string, close: string): string | undefined {
  const at = s.indexOf(marker);
  if (at < 0) return undefined;
  const gt = s.indexOf('>', at + marker.length);
  if (gt < 0) return undefined;
  const c = new RegExp(`</(?:${close})>`, 'g');
  c.lastIndex = gt + 1;
  const m = c.exec(s);
  return m ? s.slice(gt + 1, m.index) : undefined;
}

/** Text without tags: each tag becomes a space (an unclosed `<` and what follows it stay text). */
function stripTags(s: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('<', i);
    if (a < 0) break;
    const b = s.indexOf('>', a + 1);
    if (b < 0) break;
    if (b === a + 1) { out.push(s.slice(i, b + 1)); i = b + 1; continue; } // "<>" is text
    out.push(s.slice(i, a), ' ');
    i = b + 1;
  }
  out.push(s.slice(i));
  return out.join('');
}

/** Script and style blocks out (an unclosed one takes the rest of the page, as in a browser). */
function stripBlocks(s: string): string {
  const out: string[] = [];
  const open = /<(script|style)\b/gi;
  let i = 0;
  for (;;) {
    open.lastIndex = i;
    const m = open.exec(s);
    if (!m) break;
    out.push(s.slice(i, m.index), ' ');
    const close = closeOf(s, m[1], m.index + m[0].length);
    i = close ? close.end : s.length;
    if (!close) break;
  }
  out.push(s.slice(i));
  return out.join('');
}

export function plainText(html: string, max = HTML_MAX): string {
  let s = String(html ?? '');
  if (s.length > max) s = s.slice(0, max);
  return stripTags(stripBlocks(s))
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z0-9]{1,31});/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}

/** At most `max` characters: the start (5/8) and the end. */
export function clip(t: string, max = 4000): string {
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.625), tail = max - head - 3;
  return `${t.slice(0, head)} … ${t.slice(-tail)}`;
}
