// Learning from what the person does (Jobs v2 P5, the learning loop's ranking part): plain code, no Claude, no tokens.
// The person's own actions nudge the order Find reads candidates in, never the rules or eligibility:
//   applied           → that company, the title's words and the role's source rank a little higher;
//   not interested    → that company and the title's words a little lower (their reason is already remembered);
//   set aside         → a pick they moved to judged_out themselves (`crewdeck jobs status <role> judged_out`), a little lower;
//   ignored           → a pick left untouched for 7 days, slightly lower.
// Claude's own verdicts (judge, including a "no" at Prepare) never count: only the person's actions do. Every adjustment
// is small and capped (LEARN_CAPS), so it can reorder candidates but never lift another occupation above the person's
// own, never pass a rule and never touch eligibility. The result is kept in the tracker (table `learned`) so the page and
// `crewdeck jobs learn` show the same thing.
import { type Ctx, nowIso, todayOf } from '../ctx.ts';
import { fold } from '../places.ts';

export type LearnKind = 'company' | 'word' | 'source';
export type Signal = 'applied' | 'not_interested' | 'set_aside' | 'ignored';
export type LearnedRow = { kind: LearnKind; key: string; label: string; delta: number; counts: Record<Signal, number> };
export type Learned = { companies: Map<string, number>; words: Map<string, number>; sources: Map<string, number>; rows: LearnedRow[] };

/** Points per action, by what it says about. Sources learn only from applications (a source's picks they applied to). */
export const LEARN_POINTS: Record<LearnKind, Partial<Record<Signal, number>>> = {
  company: { applied: 4, not_interested: -3, set_aside: -2, ignored: -1 },
  word: { applied: 2, not_interested: -2, set_aside: -1, ignored: -1 },
  source: { applied: 2 },
};
/** The caps: per company, per word, all title words together, per source, and the whole adjustment of one role. */
export const LEARN_CAPS = { company: 8, word: 4, words: 8, source: 6, total: 15 } as const;
/** A title word counts only after this many of the person's actions mention it (one role says little). */
export const MIN_WORD_ACTIONS = 2;
export const IGNORED_DAYS = 7;

const STOP = new Set(['and', 'the', 'for', 'with', 'from', 'all', 'job', 'jobs', 'role', 'remote', 'hybrid', 'onsite', 'site', 'full', 'time', 'part', 'contract', 'permanent', 'india', 'new', 'urgent', 'hiring', 'opening', 'level']);
const clamp = (x: number, c: number) => Math.max(-c, Math.min(c, x));

/** A title's words as learning keys: folded, letters only, three or more letters, no filler. */
export function titleWords(title: string): string[] {
  return [...new Set(fold(title ?? '').split(/[^\p{L}\p{N}+#]+/u).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
}

type Act = { signal: Signal; company_id: number; company: string; title: string; source_key: string | null };

/** The person's actions, from the tracker (status, picks and their not-interested events): never Claude's verdicts. */
export function personActions(ctx: Ctx): Act[] {
  const cutoff = new Date(Date.parse(`${todayOf(ctx)}T00:00:00Z`) - IGNORED_DAYS * 86_400_000).toISOString().slice(0, 10);
  // applied; not interested (their skip event); set aside by hand after being picked (the latest status event is theirs,
  // not judge's "at prepare" verdict); a pick left untouched since the cutoff day.
  return (ctx.db.prepare(`select * from (select r.company_id, c.name company, r.title, r.source_key, case
      when r.status='applied' then 'applied'
      when r.status='skipped' and exists (select 1 from events e where e.role_id=r.id and e.kind='skip') then 'not_interested'
      when r.status='judged_out' and r.picked_on is not null and coalesce((select e.detail from events e where e.role_id=r.id and e.kind='status' order by e.id desc limit 1), '') not like 'judged_out: at prepare:%' then 'set_aside'
      when r.status in ('picked','prepared') and r.source<>'pasted' and r.picked_on is not null and r.picked_on <= ? then 'ignored'
      end signal from roles r join companies c on c.id=r.company_id) where signal is not null order by signal, company_id`).all(cutoff) as any[])
    .map((r) => ({ signal: r.signal, company_id: Number(r.company_id), company: String(r.company), title: String(r.title), source_key: r.source_key ?? null }));
}

const zero = (): Record<Signal, number> => ({ applied: 0, not_interested: 0, set_aside: 0, ignored: 0 });

/** What the actions add up to, capped, without storing anything. */
export function computeLearned(acts: Act[]): Learned {
  const acc = new Map<string, { kind: LearnKind; key: string; label: string; counts: Record<Signal, number> }>();
  const add = (kind: LearnKind, key: string, label: string, s: Signal) => {
    if (LEARN_POINTS[kind][s] === undefined) return;
    const k = `${kind}\u0000${key}`;
    const e = acc.get(k) ?? { kind, key, label, counts: zero() };
    e.counts[s]++;
    acc.set(k, e);
  };
  for (const a of acts) {
    add('company', String(a.company_id), a.company, a.signal);
    for (const w of titleWords(a.title)) add('word', w, w, a.signal);
    if (a.source_key) add('source', a.source_key, a.source_key, a.signal);
  }
  const rows: LearnedRow[] = [];
  for (const e of acc.values()) {
    const n = Object.values(e.counts).reduce((x, y) => x + y, 0);
    if (e.kind === 'word' && n < MIN_WORD_ACTIONS) continue;
    const raw = (Object.keys(e.counts) as Signal[]).reduce((x, s) => x + e.counts[s] * (LEARN_POINTS[e.kind][s] ?? 0), 0);
    const delta = clamp(raw, LEARN_CAPS[e.kind]);
    if (delta) rows.push({ kind: e.kind, key: e.key, label: e.label, delta, counts: e.counts });
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || Math.abs(b.delta) - Math.abs(a.delta) || a.label.localeCompare(b.label));
  const by = (k: LearnKind) => new Map(rows.filter((r) => r.kind === k).map((r) => [r.key, r.delta]));
  return { companies: by('company'), words: by('word'), sources: by('source'), rows };
}

/** Recompute from the person's actions and keep the result in the tracker (best effort: a read-only open still ranks). */
export function refreshLearned(ctx: Ctx): Learned {
  const l = computeLearned(personActions(ctx));
  try {
    const at = nowIso(ctx);
    ctx.db.exec('BEGIN IMMEDIATE');
    try {
      ctx.db.prepare('delete from learned').run();
      const ins = ctx.db.prepare('insert into learned(kind, key, label, delta, counts_json, updated) values (?,?,?,?,?,?)');
      for (const r of l.rows) ins.run(r.kind, r.key, r.label, r.delta, JSON.stringify(r.counts), at);
      ctx.db.exec('COMMIT');
    } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
  } catch { /* nested in a caller's transaction, or read-only: the numbers still apply */ }
  return l;
}

/** What was kept by the last refresh (the page reads this; no recompute). */
export function storedLearned(ctx: Ctx): LearnedRow[] {
  try {
    return (ctx.db.prepare('select kind, key, label, delta, counts_json from learned order by kind, abs(delta) desc, label').all() as any[])
      .map((r) => ({ kind: r.kind, key: r.key, label: r.label, delta: Number(r.delta), counts: JSON.parse(r.counts_json) }));
  } catch { return []; }
}

/** One role's adjustment: its company, its title's words (together capped), its source; the whole capped too. */
export function learnedDelta(row: { company_id: number | string; title: string; source_key?: string | null }, l: Pick<Learned, 'companies' | 'words' | 'sources'>): number {
  const c = l.companies.get(String(row.company_id)) ?? 0;
  const w = clamp(titleWords(row.title).reduce((x, k) => x + (l.words.get(k) ?? 0), 0), LEARN_CAPS.words);
  const s = row.source_key ? l.sources.get(row.source_key) ?? 0 : 0;
  return clamp(c + w + s, LEARN_CAPS.total);
}

/** One line a person reads: "Ranks Example Co higher (+4): you applied to 1 role there". */
export function learnedLine(r: LearnedRow): string {
  const what = r.kind === 'company' ? r.label : r.kind === 'word' ? `titles with "${r.label}"` : `roles from ${r.label}`;
  const parts = ([['applied', 'applied'], ['not_interested', 'not interested'], ['set_aside', 'set aside'], ['ignored', 'picks left for a week']] as [Signal, string][])
    .filter(([s]) => r.counts[s]).map(([s, w]) => `${w} ${r.counts[s]}`);
  return `Ranks ${what} ${r.delta > 0 ? 'higher' : 'lower'} (${r.delta > 0 ? '+' : ''}${r.delta}): ${parts.join(', ')}`;
}
