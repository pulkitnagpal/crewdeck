// The search preview (design §24.6, D27): run the rules of the saved notes, or of unsaved changes, over the postings
// already fetched and say what passes, what drops and why, what one change would bring back, and which fixes to offer.
// Read-only: nothing here writes the tracker, the notes or any state (a test hashes them before and after).
import { join } from 'node:path';
import { type Ctx, notesOf, nowIso } from './ctx.ts';
import { overlayChanges, overlayFields } from './edit.ts';
import { type JobNotes, NOTES } from './notes.ts';
import { type Compiled, type Drop, allDrops, compileRules, titleFitOf } from './rules.ts';
import { type Search, normalise } from './schema.ts';
import { FIT, OTHER_OCCUPATION_FIT, abbreviationsFor, closest, fitText, readTitle, wordHit } from './titles.ts';
import { findPlaces, placeName, reducePlaces } from './places.ts';
import { payCheck } from './pay.ts';
import { trackerCheck, trackerRules } from './pipeline/tracker.ts';

export const POOL_MAX = 5000;
export const BUDGET_MS = 1000;

/** How a drop reason reads to the user (by rule), and a group's name. */
export const REASON_LABEL: Record<string, string> = {
  title_gate: 'title', title_exclude: 'title words you excluded', level: 'level', company_excluded: 'company you excluded',
  company_rule: 'company rule', employment_type: 'employment type', workplace_excluded: 'workplace', location_elsewhere: 'place', place_excluded: 'place excluded',
  other_only: 'only for other places', industry: 'industry', travel: 'travel', pay: 'pay', cooldown: 'cooldown', active_pick: 'company already picked',
  other_occupation: 'other occupations',
};
export const GROUP_LABEL: Record<string, string> = { occupation: 'occupation (other occupations)', title: 'title', company: 'company', employment: 'employment type', workplace: 'workplace', place: 'place', industry: 'industry', travel: 'travel', pay: 'pay', tracker: 'cooldown or a pick at that company' };
export const fmt = (n: number) => n.toLocaleString('en-US');

export type PoolRow = { id: string; title: string; company: string; company_id: number; location: string; description: string; pay_text: string | null; language: string | null; employment_type?: string | null; source: string; source_key: string | null; status: string };
/** A change to preview: a form value (`raw`, typed by the schema) or a typed value (from a YAML search file). */
export type PreviewChange = { segs: (string | number)[]; raw: string } | { segs: (string | number)[]; value: unknown };
export type Suggestion = {
  kind: 'variants' | 'broad' | 'workplace' | 'place' | 'pay_unlisted' | 'fx';
  text: string; more: number | null;
  /** Variants: postings that already pass and would rank as one of the user's own titles. */
  raised?: number;
  /** A button's words ("Add 4 title variants: 82 more pass"). */
  label: string;
  /** The change in Preferences' fields (the page fills its form with it). */
  change: Record<string, unknown>;
  /** The same change as `pref set` paths and values (the CLI prints these). */
  pref: { path: string; value: unknown }[];
};
export type Preview = {
  days: number; pool: number; capped: boolean; sources: number;
  /** Eligible (no hard drop) and in the user's occupations (title fit at or above the floor): what the judge may read. */
  pass: number; was: number | null;
  /** Eligible postings in total, and those outside every target (other occupations: ranked last, not judged). */
  eligible: number; other_occupations: number;
  /** Hard drops by first reason (other occupations are not drops: counted apart). */
  drops: { rule: string; label: string; n: number }[];
  single: { group: string; label: string; n: number }[];
  near: { head: string; target: string; n: number; items: { label: string; n: number; single: number; sim: number }[] }[];
  passing: { title: string; company: string; location: string }[];
  dropped: { rule: string; title: string; company: string; reason: string }[];
  by_source: { key: string; name: string; in: number; pass: number }[];
  /** Passing postings per kind of job (the target whose title they match): setup checks each target catches some. */
  by_target: { name: string; pass: number }[];
  broad: number | null;
  suggestions: Suggestion[];
  ms: number; partial: boolean;
};

/** The pool: roles first seen in the last `days`, any status but applied, newest first, at most 5,000. */
export function previewPool(ctx: Ctx, days: number, source?: string): { rows: PoolRow[]; capped: boolean } {
  const since = new Date(ctx.clock().getTime() - days * 86_400_000).toISOString();
  const rows = (source
    ? ctx.db.prepare(`select r.id, r.title, c.name company, r.company_id, coalesce(r.location,'') location, coalesce(r.description,'') description, r.pay_text,
        r.language, r.employment_type, r.source, r.source_key, r.status from roles r join companies c on c.id=r.company_id
        where r.first_seen >= ? and r.status <> 'applied' and r.source_key = ? order by r.first_seen desc, r.id limit ?`).all(since, source, POOL_MAX + 1)
    : ctx.db.prepare(`select r.id, r.title, c.name company, r.company_id, coalesce(r.location,'') location, coalesce(r.description,'') description, r.pay_text,
        r.language, r.employment_type, r.source, r.source_key, r.status from roles r join companies c on c.id=r.company_id
        where r.first_seen >= ? and r.status <> 'applied' order by r.first_seen desc, r.id limit ?`).all(since, POOL_MAX + 1)) as PoolRow[];
  return { rows: rows.slice(0, POOL_MAX), capped: rows.length > POOL_MAX };
}

/** The tracker's own drops (cooldown, a role already picked at the company), read once for the whole pool. */
export function trackerDrops(ctx: Ctx, rows: PoolRow[], search: Search = notesOf(ctx).search.data): Map<string, Drop> {
  const t = trackerCheck(ctx.db, trackerRules(search), nowIso(ctx));
  const out = new Map<string, Drop>();
  for (const r of rows) { const d = t.check(r); if (d) out.set(r.id, { ...d, group: 'tracker' }); }
  return out;
}

const post = (r: PoolRow) => ({ title: r.title, company: r.company, location: r.location, description: r.description, pay_text: r.pay_text, language: r.language, employment_type: r.employment_type });
/** The soft "drop" the preview counts apart: a posting outside every target (ranked last and never judged, not dropped). */
export const OTHER_OCCUPATION = 'other_occupation';
/**
 * Every group that drops each role (rules, then the tracker), and last, when its title fits no target, the
 * `occupation` group: not a drop (ADR-0003) but what keeps it from the judge, so the preview's pass is "eligible and in
 * your occupations".
 */
export function evaluate(rows: PoolRow[], c: Compiled, tracker: Map<string, Drop>): Drop[][] {
  return rows.map((r) => {
    const d = allDrops(post(r), c); const t = tracker.get(r.id);
    const all = t ? [...d, t] : d;
    const f = titleFitOf(c, r);
    if (f.fit < OTHER_OCCUPATION_FIT) all.push({ rule: OTHER_OCCUPATION, reason: fitText(f), group: 'occupation' });
    return all;
  });
}
const hard = (d: Drop[]) => d.filter((x) => x.rule !== OTHER_OCCUPATION);

/** The search note's data with changes applied and validated like `pref set` (throws with the field errors). */
export function overlaySearch(ctx: Ctx, changes: PreviewChange[]): Search {
  if (!changes.length) return notesOf(ctx).search.data;
  return normalise.search(overlayFields(join(ctx.vault, NOTES.search), 'search', changes));
}
/** A `--search-file`'s YAML as changes. */
export const searchFileChanges = (data: unknown): PreviewChange[] => overlayChanges('search', data);

const rulesFor = (notes: JobNotes, search: Search) => compileRules({ search: { ...notes.search, data: search }, memory: notes.memory });

export function runPreview(ctx: Ctx, o: { days?: number; source?: string; changes?: PreviewChange[]; budgetMs?: number } = {}): Preview {
  const started = Date.now();
  const days = o.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be from 1 to 90');
  const notes = notesOf(ctx);
  const search = overlaySearch(ctx, o.changes ?? []);
  const c = rulesFor(notes, search);
  const { rows, capped } = previewPool(ctx, days, o.source);
  const tracker = trackerDrops(ctx, rows, search);
  const drops = evaluate(rows, c, tracker);
  const pass = drops.filter((d) => !d.length).length;
  const was = o.changes?.length ? evaluate(rows, compileRules(notes), tracker).filter((d) => !d.length).length : null;

  const count = <K extends string>(keys: K[]) => { const m = new Map<K, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const first = drops.map(hard).filter((d) => d.length).map((d) => d[0]);
  const singles = drops.filter((d) => d.length === 1).map((d) => d[0]);
  const eligible = drops.filter((d) => !hard(d).length).length;
  const out: Preview = {
    days, pool: rows.length, capped, sources: new Set(rows.map((r) => r.source_key ?? r.source)).size, pass, was, eligible, other_occupations: eligible - pass,
    drops: count(first.map((d) => d.rule)).map(([rule, n]) => ({ rule, label: REASON_LABEL[rule] ?? rule, n })),
    single: count(singles.map((d) => d.group)).map(([group, n]) => ({ group, label: GROUP_LABEL[group] ?? group, n })),
    near: [], passing: [], dropped: [], by_source: [], by_target: c.titles.targets.map((t) => ({ name: t.name, pass: 0 })), broad: null, suggestions: [], ms: 0, partial: false,
  };
  if (c.titles.targets.length) rows.forEach((r, i) => { if (drops[i].length) return; const f = titleFitOf(c, r); if (f.target !== null && out.by_target[f.target]) out.by_target[f.target].pass++; });
  rows.forEach((r, i) => { if (!drops[i].length && out.passing.length < 5) out.passing.push({ title: r.title, company: r.company, location: r.location }); });
  for (const d of out.drops.slice(0, 3)) {
    rows.forEach((r, i) => { if (drops[i][0]?.rule === d.rule && out.dropped.filter((x) => x.rule === d.rule).length < 2) out.dropped.push({ rule: d.rule, title: r.title, company: r.company, reason: drops[i][0].reason }); });
  }
  out.by_source = sourceCounts(notes, rows, drops);

  // ---- near misses on title (the dropped titles that share a target's head word, words or abbreviation) ----
  const clusters = nearMisses(c, rows, drops);
  const byHead = new Map<string, Preview['near'][number]>();
  for (const k of clusters.values()) {
    const key = `${k.target}|${k.head}`;
    const g = byHead.get(key) ?? { head: k.head, target: c.titles.targets[k.target].name, n: 0, items: [] };
    g.n += k.n; g.items.push({ label: k.label, n: k.n, single: k.single, sim: k.sim });
    byHead.set(key, g);
  }
  // Most like the user's own titles first (a synonym, the same family, an adjacent one, a shared head word), then by count.
  out.near = [...byHead.values()].map((g) => ({ ...g, items: g.items.sort((a, b) => b.sim - a.sim || b.n - a.n).slice(0, 8) })).sort((a, b) => b.n - a.n).slice(0, 5);

  // ---- fixes, each counted on the roles that only its group blocks ----
  const budget = o.budgetMs ?? BUDGET_MS;
  const onlyIn = (groups: string[]) => rows.map((r, i) => ({ r, d: drops[i] })).filter((x) => x.d.length && x.d.every((d) => groups.includes(d.group)));
  const more = (cands: { r: PoolRow }[], s: Search) => { const c2 = rulesFor(notes, s); return cands.filter((x) => !allDrops(post(x.r), c2).length && !tracker.has(x.r.id) && titleFitOf(c2, x.r).fit >= OTHER_OCCUPATION_FIT).length; };
  const late = () => Date.now() - started > budget;
  const titleOnly = onlyIn(['occupation']);

  // Variant fix: the titles most like the user's own first (a synonym, then the same family, then an adjacent one), at
  // least two postings each, added to the target they came from. Never a bare head word ("manager").
  const top = [...clusters.values()].filter((k) => k.n >= 2).sort((a, b) => b.sim - a.sim || b.n - a.n).slice(0, 5);
  if (top.length && !late()) {
    const next = structuredClone(search);
    const added: string[] = [];
    for (const k of top) {
      const t = c.titles.targets[k.target];
      const list = t.legacy ? next.roles.titles : next.roles.targets[Number(/\[(\d+)\]/.exec(t.path)![1])].titles;
      if (!list.some((x) => x.toLowerCase() === k.variant.toLowerCase())) { list.push(k.variant); added.push(k.variant); }
    }
    if (added.length) {
      const n = more(titleOnly, next);
      const c2 = rulesFor(notes, next);
      const own = (f: { how: string }) => f.how === 'exact' || f.how === 'words';
      const raised = rows.filter((r, i) => !drops[i].length && !own(titleFitOf(c, r)) && own(titleFitOf(c2, r))).length;
      const what = `Add ${added.length} title variant${added.length === 1 ? '' : 's'}`;
      const gain = n > 0 ? `${fmt(n)} more pass` : `${fmt(raised)} rank higher`;
      if (n > 0 || raised > 0) out.suggestions.push({ kind: 'variants', more: n, raised, label: `${what}: ${gain}`, text: `${what} (${added.join(', ')}): ${n > 0 ? `${gain}${raised > 0 ? `, ${fmt(raised)} rank higher` : ''}` : `${fmt(raised)} postings that already pass rank as your own titles`}`, ...titleChange(search, next) });
    }
  }
  if (search.roles.match === 'words' && c.titleGate && !late()) {
    out.broad = more(titleOnly, { ...search, roles: { ...search.roles, match: 'broad' } });
    if (out.broad > 0) out.suggestions.push({ kind: 'broad', more: out.broad, label: `Match titles broadly: ${fmt(out.broad)} more pass`, text: `Match titles broadly (a shared head word such as "${c.titles.targets[0]?.heads[0] ?? 'engineer'}"): ${fmt(out.broad)} more pass, ranked below exact matches, and more to judge`, change: { 'roles.match': 'broad' }, pref: [{ path: 'roles.match', value: 'broad' }] });
  }
  // Workplace: a kind the user didn't tick that single-blocked postings state.
  const wp = onlyIn(['workplace']);
  if (wp.length >= 2 && !late()) {
    const kinds = count(wp.flatMap((x) => (/^([a-z/]+) \(/.exec(x.d[0].reason)?.[1] ?? '').split('/').filter(Boolean)))[0]?.[0];
    if (kinds) {
      const workplace = [...new Set([...(search.workplace.length ? search.workplace : []), kinds])] as Search['workplace'];
      const n = more(wp, { ...search, workplace });
      if (n > 0) out.suggestions.push({ kind: 'workplace', more: n, label: `Also accept ${kinds}: ${fmt(n)} more pass`, text: `Also accept ${kinds} roles: ${fmt(n)} more pass`, change: { workplace }, pref: [{ path: 'workplace', value: workplace }] });
    }
  }
  // Place: an on-site place many single-blocked postings name (shown as an offer, never applied).
  const pl = onlyIn(['place']).filter((x) => x.d[0].rule === 'location_elsewhere');
  if (pl.length >= 2 && !late()) {
    const name = count(pl.flatMap((x) => reducePlaces(findPlaces(x.r.location)).map((ids) => placeName(ids[0]))))[0];
    if (name && name[1] >= 2) {
      const onsite = [...search.places.onsite, name[0]];
      const n = more(pl, { ...search, places: { ...search.places, onsite } });
      if (n > 0) out.suggestions.push({ kind: 'place', more: n, label: `Add ${name[0]}: ${fmt(n)} more pass`, text: `${name[0]} is named by ${fmt(name[1])} postings outside your places: add it if you could work there (${fmt(n)} more pass)`, change: { 'places.onsite': onsite }, pref: [{ path: 'places.onsite', value: onsite }] });
    }
  }
  // Pay: postings without pay that `unlisted: drop` removes.
  const unlisted = onlyIn(['pay']).filter((x) => /^no pay listed/.test(x.d[0].reason));
  if (unlisted.length && search.pay && !late()) out.suggestions.push({ kind: 'pay_unlisted', more: unlisted.length, label: `Keep postings without pay: ${fmt(unlisted.length)} more pass`, text: `Keep postings that list no pay (the judge reads them): ${fmt(unlisted.length)} more pass`, change: { 'pay.unlisted': 'keep' }, pref: [{ path: 'pay.unlisted', value: 'keep' }] });
  // fx: currencies the floor can't check without a rate (no_rate never drops: information only).
  if (c.pay && !late()) {
    const missing = count(rows.map((r) => payCheck(r.pay_text, r.description, c.pay!)).filter((p) => p.status === 'no_rate').map((p) => /for ([A-Z]{3})/.exec(p.reason ?? '')?.[1] ?? '').filter(Boolean));
    for (const [cur, n] of missing.slice(0, 2)) out.suggestions.push({ kind: 'fx', more: null, label: `Add a rate for ${cur}`, text: `${fmt(n)} postings list pay in ${cur} with no rate: add pay.fx.${cur} (1 ${cur} in ${c.pay.currency}) so your floor can check them`, change: {}, pref: [{ path: `pay.fx.${cur}`, value: '<rate>' }] });
  }
  out.ms = Date.now() - started;
  out.partial = late();
  return out;
}

/** The variants fix as Preferences fields and `pref set` paths: whole lists, so one Save writes them. */
function titleChange(before: Search, after: Search): Pick<Suggestion, 'change' | 'pref'> {
  const change: Record<string, unknown> = {}, pref: Suggestion['pref'] = [];
  if (JSON.stringify(before.roles.titles) !== JSON.stringify(after.roles.titles)) { change['roles.titles'] = after.roles.titles; pref.push({ path: 'roles.titles', value: after.roles.titles }); }
  after.roles.targets.forEach((t, i) => {
    if (JSON.stringify(t.titles) === JSON.stringify(before.roles.targets[i]?.titles)) return;
    change['roles.targets'] = after.roles.targets;
    pref.push({ path: `roles.targets[${i}].titles`, value: t.titles });
  });
  return { change, pref };
}

type Cluster = { target: number; head: string; label: string; variant: string; n: number; single: number; /** title fit of the cluster: most like the user's own first */ sim: number };
/**
 * Eligible titles that aren't one of the user's own but are near a target (a synonym, the same or an adjacent family,
 * a shared head word, an abbreviation), keyed by their main words without seniority ("Senior Data Engineer" → "Data
 * Engineer"). A bare head word ("Manager", "Senior Engineer") is never a cluster: too wide to add as a title.
 */
function nearMisses(c: Compiled, rows: PoolRow[], drops: Drop[][]): Map<string, Cluster> {
  const m = c.titles, out = new Map<string, Cluster>();
  if (!m.targets.length || c.regex.title_gate || m.mode === 'off') return out;
  const abbrs = m.targets.map((_, ti) => abbreviationsFor(m, ti));
  rows.forEach((r, i) => {
    if (hard(drops[i]).length) return;
    const f = titleFitOf(c, r);
    if (f.how === 'exact' || f.how === 'words' || f.how === 'any' || f.how === 'generic') return;
    const read = readTitle(r.title, m.tw);
    const key = read.key.split(' ').filter(Boolean);
    if (!key.length || (key.length === 1 && m.headWords.has(key[0]))) return;
    let sim = FIT[f.how];
    let hit: { target: number; head: string; label: string; variant: string } | null = null;
    // An abbreviation for (part of) a target title, or one whose long form ends in a target's head word.
    for (const w of read.words) {
      const ti = abbrs.findIndex((a) => a.some((x) => x.abbr === w.f || `${x.abbr}s` === w.f));
      if (ti >= 0) { sim = Math.max(sim, FIT.synonym); hit = { target: ti, head: m.targets[ti].heads[0] ?? w.f, label: w.raw.toUpperCase(), variant: w.raw.toUpperCase() }; break; }
      const longs = m.tw.abbreviations.get(w.f);
      const tj = longs ? m.targets.findIndex((t) => longs.some((l) => t.heads.includes(l.split(' ').at(-1)!))) : -1;
      if (tj >= 0) { hit = { target: tj, head: longs!.map((l) => l.split(' ').at(-1)!).find((h) => m.targets[tj].heads.includes(h))!, label: w.raw.toUpperCase(), variant: w.raw.toUpperCase() }; break; }
    }
    if (!hit && f.target !== null) {
      const near = closest(m, read, r.language);
      hit = { target: f.target, head: near?.head ?? f.family ?? m.targets[f.target].heads[0] ?? '', label: read.label, variant: read.label.toLowerCase() };
    }
    if (!hit) {
      // 2 of a 3+-word title's words.
      for (let ti = 0; ti < m.targets.length && !hit; ti++) for (const v of m.targets[ti].variants) {
        if (v.words.length < 3) continue;
        const shared = v.words.filter((x) => read.words.some((p) => wordHit(x, p.f, false, m.tw))).length;
        if (shared >= 2) { hit = { target: ti, head: v.head ?? '', label: read.label, variant: read.label.toLowerCase() }; sim = 0.3; break; }
      }
    }
    if (!hit || !hit.label) return;
    const k_ = `${hit.target}|${hit.label.toLowerCase()}`;
    const k = out.get(k_) ?? { ...hit, n: 0, single: 0, sim };
    k.n++;
    if (drops[i].length <= 1) k.single++;
    out.set(k_, k);
  });
  return out;
}

function sourceCounts(notes: JobNotes, rows: PoolRow[], drops: Drop[][]): Preview['by_source'] {
  const names = new Map(notes.sources.data.items.map((it) => [it.linkedin ? 'linkedin' : it.key, it.name]));
  const by = new Map<string, { key: string; name: string; in: number; pass: number }>();
  rows.forEach((r, i) => {
    const key = r.source_key ?? (r.source === 'linkedin' ? 'linkedin' : r.source);
    const name = names.get(key) ?? (key === 'linkedin' ? 'LinkedIn' : key === 'pasted' ? 'Pasted links' : key === 'manual' || key === 'alert' ? 'Added by hand' : key);
    const b = by.get(key) ?? { key, name, in: 0, pass: 0 };
    b.in++;
    if (!drops[i].length) b.pass++;
    by.set(key, b);
  });
  return [...by.values()].sort((a, b) => b.in - a.in);
}

/** The preview as text (the CLI; Claude reads it in setup). Posting text is data: printed, never a command. */
export function previewLines(p: Preview): string[] {
  if (!p.pool) return [`No postings in the last ${p.days} days to preview. Fetch first: crewdeck jobs source (or Refresh sources on the Jobs page).`];
  const L: string[] = [];
  L.push(`${fmt(p.pool)} postings from ${p.sources} source${p.sources === 1 ? '' : 's'} (last ${p.days} days${p.capped ? `, the ${fmt(p.pool)} newest` : ''})`);
  L.push(`Pass your rules, in your occupations: ${fmt(p.pass)}${p.was !== null ? `   (was ${fmt(p.was)} with your saved notes)` : ''}`);
  if (p.drops.length) L.push(`Dropped, by first reason: ${p.drops.map((d) => `${d.label} ${fmt(d.n)}`).join(' · ')}`);
  if (p.other_occupations) L.push(`Other occupations (not dropped: ranked last and not judged): ${fmt(p.other_occupations)} of the ${fmt(p.eligible)} that meet your rules`);
  if (p.single.length) L.push(`Only one thing stops them: ${p.single.map((d) => `${d.label} ${fmt(d.n)}`).join(' · ')}`);
  if (p.near.length) L.push(`Near your titles (most alike first): ${p.near.map((g) => `${g.head} → ${g.items.map((x) => `${x.label} (${fmt(x.n)})`).join(', ')}`).join('; ')}`);
  if (p.passing.length) L.push(`Passing, e.g.: ${p.passing.map((x) => `${x.title} — ${x.company}${x.location ? ` (${x.location})` : ''}`).join(' · ')}`);
  for (const d of [...new Set(p.dropped.map((x) => x.rule))]) L.push(`Dropped, e.g. (${REASON_LABEL[d] ?? d}): ${p.dropped.filter((x) => x.rule === d).map((x) => `${x.title} — ${x.company}`).join(' · ')}`);
  if (p.by_target.length > 1 || p.by_target.some((t) => !t.pass)) L.push(`By kind of job: ${p.by_target.map((t) => `${t.name} ${fmt(t.pass)}`).join(' · ')}`);
  if (p.by_source.length) L.push(`By source: ${p.by_source.map((s) => `${s.name} ${fmt(s.in)} → ${fmt(s.pass)}`).join(' · ')}`);
  if (p.suggestions.length) {
    L.push('Suggested (each is offered to the user, never applied without their yes):');
    for (const s of p.suggestions) {
      L.push(`  - ${s.text}`);
      for (const x of s.pref) L.push(`      crewdeck jobs pref set ${x.path} --value-file <f> --because-file <f>   (the file holds: ${JSON.stringify(x.value)})`);
    }
  }
  if (p.partial) L.push(`(stopped the suggestions at the ${BUDGET_MS} ms budget)`);
  return L;
}
