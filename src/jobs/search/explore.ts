// Explore (free, no Claude): every role Crewdeck has found that passed the rules, searchable by the person. SQL narrows by
// status, words, age and saved/hidden; the rules' own title fit says which are another occupation and which are a strong
// title match; the "best" order comes from search/hybrid.ts when it loads (a dynamic import: another module owns it), else
// from the same cheap rank Find uses. Saving and hiding are the person's own marks in `saved_roles`.
import { type Ctx, notesOf, nowIso } from '../ctx.ts';
import { type Db, ROLE_ID, tx } from '../db.ts';
import { compileRules, titleFitOf } from '../rules.ts';
import { OTHER_OCCUPATION_FIT } from '../titles.ts';
import { rankScore } from '../pipeline/rank.ts';

export type ExploreGroup = 'all' | 'feeds' | 'accounts';
export type ExploreQuery = {
  q?: string; group?: ExploreGroup; strong?: boolean; days?: number; saved?: boolean; others?: boolean;
  sort?: 'best' | 'newest'; offset?: number; limit?: number;
  /** Statuses added to the default pool (applied, expired, prefiltered_out), when asked for. */
  include?: string[];
};
export type ExploreRow = {
  id: string; title: string; company: string; location: string; workplace: string | null; source_label: string; group: 'feeds' | 'accounts';
  posted_at: string | null; url: string; saved: boolean; status: string;
};
export type ExploreResult = {
  total: number;
  counts: { feeds: number; accounts: number; saved: number; others: number };
  /** Saved roles Claude can still judge (status new or bench): what "Judge these N" is about. */
  judgeable: number;
  rows: ExploreRow[];
};
/** A scorer for the "best" order: id → score, higher first (search/hybrid.ts's `scoreRoles`). */
export type Scorer = (ctx: Ctx, ids: string[], o: { q?: string }) => Map<string, number>;

/** The roles that passed the rules and are still open: everything but applied, skipped, expired and prefiltered out. */
export const POOL_STATUSES = ['new', 'bench', 'picked', 'prepared', 'judged_out'] as const;
const EXTRA_STATUSES = ['applied', 'expired', 'prefiltered_out', 'skipped'];
/** A title fit at or above this is a strong match (the person's own title, any order, or a synonym). */
export const STRONG_FIT = 0.85;
/** About how many tokens judging one role takes (the page's hint). */
export const TOKENS_PER_JUDGED = 1300;
export const MAX_JUDGE = 80;
export const MAX_LIMIT = 200;

export const groupOf = (sourceKey: string | null | undefined): 'feeds' | 'accounts' => (String(sourceKey ?? '').startsWith('portal:') ? 'accounts' : 'feeds');

const likeEscape = (w: string) => w.replace(/[\\%_]/g, (c) => `\\${c}`);
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());

type Raw = { id: string; title: string; company: string; location: string; workplace: string | null; source: string; source_key: string | null; posted_at: string | null; first_seen: string;
  url: string; status: string; description: string; pay_status: string | null; language: string | null; saved: string | null };

/** Names for the keys the roles carry: the person's own sources list (portals as `portal:<id>`, LinkedIn as `linkedin`). */
function sourceNames(ctx: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const it of notesOf(ctx).sources.data.items) out.set(it.linkedin ? 'linkedin' : it.portal ? `portal:${it.portal}` : it.key, it.name);
  } catch { /* broken notes: labels fall back to the key */ }
  return out;
}
const labelOf = (names: Map<string, string>, r: Pick<Raw, 'source' | 'source_key'>) => {
  if (r.source_key && names.has(r.source_key)) return names.get(r.source_key)!;
  if (r.source_key?.startsWith('portal:')) return titleCase(r.source_key.slice(7));
  // Planned sources: "api:himalayas" → Himalayas; "ats:greenhouse:atlan" → Atlan careers.
  if (r.source_key?.startsWith('api:')) return titleCase(r.source_key.slice(4));
  if (r.source_key?.startsWith('ats:')) return `${titleCase(r.source_key.split(':').slice(2).join(' ') || r.source_key.split(':')[1])} careers`;
  if (r.source === 'pasted') return 'Pasted link';
  return titleCase(r.source_key ?? r.source ?? 'Feed') || 'Feed';
};

async function loadScorer(): Promise<Scorer | null> {
  try {
    const m: any = await import('./hybrid.ts');
    return typeof m?.scoreRoles === 'function' ? (m.scoreRoles as Scorer) : null;
  } catch { return null; }
}

/** Explore: filters, counts and one page of rows. Read-only (the database is only read). */
export async function exploreRoles(ctx: Ctx, query: ExploreQuery = {}, o: { scorer?: Scorer | null } = {}): Promise<ExploreResult> {
  const group = query.group === 'feeds' || query.group === 'accounts' ? query.group : 'all';
  const sort = query.sort === 'newest' ? 'newest' : 'best';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const statuses = [...POOL_STATUSES, ...(query.include ?? []).filter((s) => EXTRA_STATUSES.includes(s))];
  const words = String(query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map(likeEscape);
  // No days: everything is newer than the empty string.
  const since = query.days !== undefined && Number.isFinite(query.days) && query.days > 0 ? new Date(ctx.clock().getTime() - query.days * 86_400_000).toISOString() : '';
  const rows = ctx.db.prepare(`select r.id, r.title, c.name company, r.location, r.workplace, r.source, r.source_key, r.posted_at, r.first_seen, r.url, r.status,
      r.description, r.pay_status, r.language, s.state saved
    from roles r join companies c on c.id=r.company_id left join saved_roles s on s.role_id=r.id
    where r.status in (select value from json_each(?)) and coalesce(s.state, '') <> 'hidden'
      and coalesce(r.posted_at, r.first_seen) >= ?
      and not exists (select 1 from json_each(?) w where not (lower(r.title) like '%' || w.value || '%' escape '\\'
        or lower(c.name) like '%' || w.value || '%' escape '\\' or lower(r.description) like '%' || w.value || '%' escape '\\'))`)
    .all(JSON.stringify(statuses), since, JSON.stringify(words)) as unknown as Raw[];

  const notes = notesOf(ctx);
  const compiled = compileRules(notes);
  const names = sourceNames(ctx);
  const annotated = rows.map((r) => {
    const fit = titleFitOf(compiled, r).fit;
    return { r, fit, other: fit < OTHER_OCCUPATION_FIT, group: groupOf(r.source_key) };
  });
  // The counts follow the words, the age and the strong filter, never the group or Saved chips they label.
  const base = annotated.filter((a) => !query.strong || a.fit >= STRONG_FIT);
  const inPool = base.filter((a) => query.others || !a.other);
  const counts = {
    feeds: inPool.filter((a) => a.group === 'feeds').length,
    accounts: inPool.filter((a) => a.group === 'accounts').length,
    saved: inPool.filter((a) => a.r.saved === 'saved').length,
    others: base.filter((a) => a.other).length,
  };
  const matched = inPool.filter((a) => (group === 'all' || a.group === group) && (!query.saved || a.r.saved === 'saved'));

  const other = (a: { other: boolean }) => (a.other ? 1 : 0);
  const newest = (a: { r: Raw }) => String(a.r.posted_at ?? a.r.first_seen);
  const tail = (a: { r: Raw }, b: { r: Raw }) => newest(b).localeCompare(newest(a)) || a.r.id.localeCompare(b.r.id);
  if (sort === 'newest') matched.sort((a, b) => tail(a, b));
  else {
    let score: Map<string, number> | null = null;
    const scorer = o.scorer === undefined ? await loadScorer() : o.scorer;
    if (scorer) { try { score = scorer(ctx, matched.map((a) => a.r.id), { q: words.join(' ') || undefined }); } catch { score = null; } }
    if (!score) {
      // The fallback is Find's own cheap rank, from the notes.
      const at = ctx.clock();
      const cached = new Map<string, number>();
      for (const a of matched) cached.set(a.r.id, rankScore(a.r, notes, at));
      score = cached;
    }
    const sc = score;
    matched.sort((a, b) => other(a) - other(b) || (sc.get(b.r.id) ?? 0) - (sc.get(a.r.id) ?? 0) || tail(a, b));
  }

  const judgeable = Number((ctx.db.prepare(`select count(*) n from saved_roles s join roles r on r.id=s.role_id where s.state='saved' and r.status in ('new','bench')`).get() as any).n);
  return {
    total: matched.length, counts, judgeable,
    rows: matched.slice(offset, offset + limit).map(({ r, group: g }) => ({
      id: r.id, title: r.title, company: r.company, location: r.location, workplace: r.workplace ?? null, source_label: labelOf(names, r), group: g,
      posted_at: r.posted_at ?? r.first_seen ?? null, url: r.url, saved: r.saved === 'saved', status: r.status,
    })),
  };
}

/** The Explore tab's number: everything the default view lists (no words, no filters). */
/** Explore's tab number: what its default view lists (other occupations are behind a chip, so not counted). */
export function exploreDefaultCount(ctx: Ctx): number {
  const rows = ctx.db.prepare(`select r.id, r.title, r.description, r.source_key from roles r left join saved_roles s on s.role_id=r.id
    where r.status in (select value from json_each(?)) and coalesce(s.state, '') <> 'hidden'`).all(JSON.stringify(POOL_STATUSES)) as any[];
  const compiled = compileRules(notesOf(ctx));
  return rows.filter((r) => titleFitOf(compiled, r).fit >= OTHER_OCCUPATION_FIT).length;
}

export function exploreCount(db: Db): number {
  return Number((db.prepare(`select count(*) n from roles r left join saved_roles s on s.role_id=r.id
    where r.status in (select value from json_each(?)) and coalesce(s.state, '') <> 'hidden'`).get(JSON.stringify(POOL_STATUSES)) as any).n);
}

// ---- the person's marks ----

export type Mark = 'saved' | 'hidden' | null;
/** Save, hide or clear (null) one role. */
export function markRole(ctx: Ctx, id: string, state: Mark): { changed: boolean } {
  if (!ROLE_ID.test(id) || !ctx.db.prepare('select 1 from roles where id=?').get(id)) throw new Error('unknown role');
  return tx(ctx.db, () => {
    const was = (ctx.db.prepare('select state from saved_roles where role_id=?').get(id) as any)?.state ?? null;
    if (was === state) return { changed: false };
    if (state === null) ctx.db.prepare('delete from saved_roles where role_id=?').run(id);
    else ctx.db.prepare(`insert into saved_roles(role_id, state, at) values (?,?,?) on conflict(role_id) do update set state=excluded.state, at=excluded.at`).run(id, state, nowIso(ctx));
    return { changed: true };
  });
}

/** The saved roles Claude can still judge, in the order they were saved (at most MAX_JUDGE). */
export function judgeableSaved(ctx: Ctx): string[] {
  return (ctx.db.prepare(`select s.role_id id from saved_roles s join roles r on r.id=s.role_id where s.state='saved' and r.status in ('new','bench') order by s.at, s.role_id limit ?`).all(MAX_JUDGE) as any[]).map((x) => String(x.id));
}
