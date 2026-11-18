// Posting text as plain words: tags and entities out, whitespace collapsed; long postings keep their start and end
// (location and eligibility rules often sit at the end).
const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(p|div|li|ul|ol|br|h[1-6]|tr|section)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
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
