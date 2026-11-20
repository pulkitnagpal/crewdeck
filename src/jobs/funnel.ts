// Find's funnel (design §24.7, D28): fetched → dropped by the rules (by first reason) → judged → fits → picked, from
// the tracker, so the page's "Why so few?" card and Claude's close line read the same numbers. Stored with the Find run
// (state/find.json) whenever `candidates --budget` or `pick` runs.
import { type Ctx, notesOf, todayOf } from './ctx.ts';
import { REASON_LABEL, fmt } from './preview.ts';
import { readSourcesState } from './sources.ts';
import { suggestSources } from './suggest.ts';

export const FUNNEL_DAYS = 14;

export type Funnel = {
  at: string; days: number; need: number;
  fetched: number;
  rules: { rule: string; label: string; n: number }[];
  passed_rules: number;
  /** passed_rules = judged + waiting + other (closed or set aside before judging) */
  judged: number; waiting: number; other: number;
  /** judged = fits + no + unclear */
  fits: number; no: number; unclear: number;
  picked: number;
  /** The judge's most common reasons for "no" (when the rules weren't the cause). */
  judge_reasons: { text: string; n: number }[];
  /** Sources that returned nothing on their last fetch, and why. */
  sources: { total: number; empty: number; why: string[] };
  /** The coverage line (D42) when the pool is too small to fill the picks. */
  coverage: string | null;
  line: string; rules_line: string;
};

/** The funnel for a Find that wants `need` picks, from the tracker as it is now. */
export function findFunnel(ctx: Ctx, need: number): Funnel {
  const since = new Date(ctx.clock().getTime() - FUNNEL_DAYS * 86_400_000).toISOString();
  const fetched = Number((ctx.db.prepare('select count(*) n from roles where first_seen >= ?').get(since) as any).n);
  const rules = (ctx.db.prepare(`select substr(status_reason, 1, instr(status_reason, ':') - 1) rule, count(*) n from roles
      where first_seen >= ? and status = 'prefiltered_out' group by 1 order by n desc, rule`).all(since) as any[])
    .map((r) => ({ rule: String(r.rule || 'other'), label: REASON_LABEL[r.rule] ?? String(r.rule || 'other'), n: Number(r.n) }));
  const dropped = rules.reduce((a, r) => a + r.n, 0);
  const e = ctx.db.prepare(`select eligibility, status, count(*) n from roles where first_seen >= ? and status <> 'prefiltered_out' group by 1, 2`).all(since) as any[];
  const sum = (f: (r: any) => boolean) => e.filter(f).reduce((a, r) => a + Number(r.n), 0);
  const fits = sum((r) => r.eligibility === 'yes'), no = sum((r) => r.eligibility === 'no'), unclear = sum((r) => r.eligibility === 'unclear');
  const waiting = sum((r) => r.eligibility === null && r.status === 'new');
  const judged = fits + no + unclear;
  const passed_rules = fetched - dropped;
  const picked = Number((ctx.db.prepare(`select count(*) n from roles where picked_on = ? and source <> 'pasted' and status in ('picked','prepared','applied')`).get(todayOf(ctx)) as any).n);
  const judge_reasons = (ctx.db.prepare(`select e.detail text, count(*) n from events e join roles r on r.id = e.role_id
      where e.kind = 'judge' and r.eligibility = 'no' and r.first_seen >= ? group by e.detail order by n desc, max(e.at) desc limit 3`).all(since) as any[]).map((r) => ({ text: String(r.text).slice(0, 200), n: Number(r.n) }));
  const f: Funnel = {
    at: ctx.clock().toISOString(), days: FUNNEL_DAYS, need, fetched, rules, passed_rules, judged, waiting, other: passed_rules - judged - waiting,
    fits, no, unclear, picked, judge_reasons, sources: sourcesLine(ctx), coverage: null, line: '', rules_line: '',
  };
  if (fetched < need * 4) f.coverage = coverage(ctx);
  f.line = `${fmt(fetched)} fetched → ${fmt(passed_rules)} passed your rules → ${fmt(judged)} judged → ${fmt(fits)} fit${fits === 1 ? 's' : ''}`;
  f.rules_line = rules.length ? `Most went at your rules: ${rules.slice(0, 3).map((r) => `${r.label} ${fmt(r.n)}`).join(' · ')}` : '';
  return f;
}

/** "2 of your 9 sources returned nothing (needs keywords; careers page not readable)". */
function sourcesLine(ctx: Ctx): Funnel['sources'] {
  const items = notesOf(ctx).sources.data.items.filter((it) => it.enabled);
  const st = readSourcesState(ctx.home) as any;
  const byKey = st?.by_key ?? {};
  const why: string[] = [];
  let empty = 0;
  for (const it of items) {
    const k = byKey[it.linkedin ? 'linkedin' : it.key];
    if (!k) continue;
    if (!k.ok || !k.jobs) { empty++; const w = String(k.why ?? k.error ?? 'no postings').split(/[:(]/)[0].trim().slice(0, 60); if (w && !why.includes(w)) why.push(w); }
  }
  return { total: items.length, empty, why: why.slice(0, 3) };
}

/** The coverage line from suggest (D42): never a source the catalog doesn't have. */
function coverage(ctx: Ctx): string | null {
  try { return suggestSources(notesOf(ctx), {}, { linkedinOn: !!ctx.features.linkedin_search }).coverage.line || null; } catch { return null; }
}

/** One line for Claude's close of a Find (jobs-daily-run §5) and the card's header. */
export function funnelSummary(f: Funnel): string {
  return `Find ${f.need} jobs: ${f.picked} picked. ${f.line}.${f.rules_line ? ` ${f.rules_line}.` : ''}`;
}
