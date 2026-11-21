// `crewdeck jobs portals script <id>` (ADR-0008, pane mode): the self-contained JavaScript expression Claude runs in a
// portal's search page with the browser pane's javascript_tool. It is page-runtime.js's functions, serialised, with the
// portal's catalog entry embedded: an IIFE with no imports that returns a Promise of
//   { url, signals: { sign_in_wall, challenge, empty }, jobs: [{ url, title, company, location, posted_at?, workplace?, company_country? }] }
// (at most 60 jobs, about 8 KB at most). Deterministic: the same catalog entry gives the same text.
import type { Portal } from './catalog.ts';
import { RX, canonUrl, hostIn, pathValue, scanPage, workplaceOf } from './page-runtime.js';

export type PaneJob = { url: string; title: string; company: string; location: string; posted_at?: string; workplace?: 'remote' | 'hybrid' | 'onsite'; company_country?: string };
export type PageOutput = { url: string; signals: { sign_in_wall: boolean; challenge: boolean; empty: boolean }; jobs: PaneJob[] };

/** The most jobs one page returns, and the soft size of the answer (characters of JSON). */
export const PAGE_JOBS = 60;
export const PAGE_BUDGET = 8_000;

/** What the in-page code needs from the catalog entry (nothing else of the portal reaches the page). */
export function pageConfig(p: Portal, o: { settleMs?: number } = {}) {
  return {
    hosts: p.hosts,
    job: { pattern: p.job_url.pattern, ...(p.job_url.keep_params?.length ? { keep_params: p.job_url.keep_params } : {}), ...(p.job_url.canonical ? { canonical: p.job_url.canonical } : {}) },
    json: p.json.map((j) => ({ ...(j.url ? { url: j.url } : {}), ...(j.state ? { state: j.state } : {}), list: j.list, fields: j.fields, ...(j.where ? { where: j.where } : {}), ...(j.url_template ? { url_template: j.url_template } : {}) })),
    ...(p.cards ? { cards: p.cards } : {}),
    wall: p.sign_in_wall,
    max: PAGE_JOBS, budget: PAGE_BUDGET, settle_ms: o.settleMs ?? 1000,
  };
}

const IDENT = /[A-Za-z0-9_$]/;
/** After these (or a keyword below), a `/` starts a regex literal; otherwise it divides. */
const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_KEYWORDS = /(^|[^A-Za-z0-9_$])(return|typeof|case|in|of|new|delete|void|throw)$/;

/**
 * Whitespace out of JavaScript source, never out of a string or a regex literal: line breaks stay (no semicolon rules
 * change), runs of spaces go, and a space stays only between two identifier characters. Every byte Claude sends is a
 * token. Only for page-runtime.js's own code: no template literals, no comments inside the functions.
 */
export function minify(src: string): string {
  let out = '';
  let i = 0;
  const last = () => out.replace(/[ \n]+$/, '').slice(-1);
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && (BEFORE_REGEX.has(last()) || last() === '' || REGEX_KEYWORDS.test(out.trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < src.length && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      out += src.slice(i, j); i = j; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      let j = i, nl = false;
      while (j < src.length && /\s/.test(src[j]!)) { if (src[j] === '\n') nl = true; j++; }
      const prev = out.slice(-1), next = src[j] ?? '';
      if (nl) out += '\n';
      else if (IDENT.test(prev) && IDENT.test(next)) out += ' ';
      i = j; continue;
    }
    out += c; i++;
  }
  return out.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** A function's source, minified (full-line comments go first). */
const compact = (f: (...a: any[]) => unknown) => minify(f.toString().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));

/** The script for one portal: `(()=>{…; return scanPage(C, globalThis)})()`. */
export function pageScript(p: Portal, o: { settleMs?: number } = {}): string {
  const rx = Object.fromEntries(Object.entries(RX).map(([k, r]) => [k, [r.source, r.flags]]));
  return [
    '(()=>{',
    `const RX=Object.fromEntries(Object.entries(${JSON.stringify(rx)}).map(([k,v])=>[k,new RegExp(v[0],v[1])]));`,
    ...[hostIn, pathValue, canonUrl, workplaceOf, scanPage].map(compact),
    `return scanPage(${JSON.stringify(pageConfig(p, o))},globalThis);`,
    '})()',
  ].join('\n');
}
