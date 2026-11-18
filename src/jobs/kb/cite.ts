// The citation check (design §13 "no invented experience"): every claim in an answer cites sources (career facts,
// memory items in the user's words, profile values, or the posting for claims about the company), and no number or
// named term (technology, tool, certification, clinical or analytics term) may appear that its sources don't contain.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { MemoryItem } from '../schema.ts';

export type Claim = { text: string; about: 'me' | 'company'; fact_ids: string[] };
export type Fact = { id: string; text: string };
export type CiteContext = { facts: Fact[]; memory: MemoryItem[]; postingText: string; profile: Record<string, string>; terms?: Term[] };
export type CiteResult = { ok: true } | { ok: false; reason: string };
export type Term = { name: string; res: RegExp[] };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CITABLE = new Set(['answer', 'fact', 'preference']);

/** One term: its names ("Go|Golang"); names of two letters or fewer, and every name when caseSensitive, match as written. */
function term(spec: string, caseSensitive: boolean): Term {
  const names = spec.split('|').map((n) => n.trim()).filter(Boolean);
  return {
    name: names[0],
    res: names.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, caseSensitive || n.length <= 2 ? 'u' : 'iu')),
  };
}

let builtIn: Term[] | null = null;
/** The built-in terms (src/jobs/data/terms.yaml) plus the user's own (career.md → terms.extra). */
export function termsFor(extra: string[] = []): Term[] {
  if (!builtIn) {
    const y = parse(readFileSync(join(import.meta.dirname, '..', 'data', 'terms.yaml'), 'utf8')) ?? {};
    builtIn = [...(y.case_insensitive ?? []).map((n: string) => term(n, false)), ...(y.case_sensitive ?? []).map((n: string) => term(n, true))];
  }
  return [...builtIn, ...extra.map((n) => term(n, false))];
}

/** Numbers in a claim, normalised: "5,000+" → "5000", "50K" → "50k", "p99" → "99". */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,.]*\s*[kKmM]?/g)].map((m) => m[0].replace(/[,\s]/g, '').toLowerCase().replace(/\.$/, ''));
}
const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|my|me|mine|myself)\b/i;

function unsupported(text: string, pool: string, terms: Term[]): string | null {
  const have = new Set(numbersIn(pool));
  for (const n of numbersIn(text)) if (!have.has(n)) return `"${n}"`;
  for (const t of terms) if (t.res.some((r) => r.test(text)) && !t.res.some((r) => r.test(pool))) return `"${t.name}"`;
  return null;
}

export function checkAnswer(a: { text: string; claims: Claim[] }, ctx: CiteContext): CiteResult {
  const terms = ctx.terms ?? termsFor();
  const claims = Array.isArray(a.claims) ? a.claims : [];
  if (a.text.trim() && !claims.length) return { ok: false, reason: 'answer has no cited claims' };
  const facts = new Map(ctx.facts.map((f) => [f.id, f.text.replace(/\*\*/g, '')]));
  const mem = new Map(ctx.memory.map((m) => [m.id, m]));
  const meSources: string[] = [], allSources: string[] = [];
  for (const c of claims) {
    if (!c || typeof c.text !== 'string' || !Array.isArray(c.fact_ids) || !['me', 'company'].includes(c.about)) return { ok: false, reason: 'a claim needs text, about (me | company) and fact_ids' };
    const sources: string[] = [];
    for (const id of c.fact_ids) {
      if (id === 'posting') {
        if (c.about !== 'company') return { ok: false, reason: `a claim about the user can't cite the posting: "${c.text}"` };
        sources.push(ctx.postingText);
        continue;
      }
      if (typeof id === 'string' && id.startsWith('profile:')) {
        const v = Object.hasOwn(ctx.profile, id.slice(8)) ? ctx.profile[id.slice(8)] : undefined;
        if (v == null) return { ok: false, reason: `unknown profile field ${id}` };
        sources.push(v);
        continue;
      }
      if (facts.has(id)) { sources.push(facts.get(id)!); continue; }
      const m = mem.get(id);
      if (!m) return { ok: false, reason: `unknown source ${id}` };
      if (m.superseded_by) return { ok: false, reason: `source ${id} was replaced` };
      if (!CITABLE.has(m.kind)) return { ok: false, reason: `${id} is a ${m.kind} item, not a fact about the user` };
      sources.push(`${m.text} ${m.quote}`);
    }
    if (!sources.length) return { ok: false, reason: `no source for: "${c.text}"` };
    if (c.about === 'company' && FIRST_PERSON.test(c.text)) return { ok: false, reason: `a claim about the user can't cite the posting: "${c.text}"` };
    const bad = unsupported(c.text, sources.join('\n'), terms);
    if (bad) return { ok: false, reason: `${bad} isn't in the cited sources for: "${c.text}"` };
    (c.about === 'me' ? meSources : allSources).push(...sources);
  }
  // The whole answer, not just the listed claims: sentences about the user need their sources; the rest may use the posting.
  for (const sentence of a.text.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim())) {
    const pool = FIRST_PERSON.test(sentence) ? meSources.join('\n') : [...meSources, ...allSources].join('\n');
    const bad = unsupported(sentence, pool, terms);
    if (bad) return { ok: false, reason: `${bad} isn't in any source you cited: "${sentence.trim()}"` };
  }
  return { ok: true };
}
