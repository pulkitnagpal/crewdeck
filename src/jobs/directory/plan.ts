// The source planner's cold-start table (ADR-0001, design §7.2): field family × country/region × work mode → the
// person's ~10 sources, in order, with a reason each and an honest coverage score. Pure: no fetch, no notes written.
// Source kinds: 'api' (an official-API registry id), 'company-feeds' (a company set from the directory), 'watchlist'
// (the person's own companies), 'careers-pages' (pages they gave), 'manual' (LinkedIn import, done by the person).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { place, within } from '../places.ts';
import { type Directory, type Size, loadDirectory } from './seed.ts';
import { type Pick, type WorkMode, seekerPlaces, selectCompanies } from './select.ts';

export const PLAN_FILE = join(import.meta.dirname, '..', 'data', 'source-plan.yaml');
export const API_IDS = ['usajobs', 'nhs-jobs', 'teaching-vacancies', 'ba-jobsuche', 'reed', 'adzuna', 'jooble', 'himalayas', 'remotive', 'arbeitnow'] as const;
export const MAX_SOURCES = 10;
const COMPANIES_PER_SET = 25;

type Provider = { name: string; countries: string[]; modes: WorkMode[]; families: string[]; note?: string };
type RowSource = { kind?: 'company-feeds' | 'api'; id?: string; planned?: string; note?: string; set?: { label: string; prefer_remote?: boolean; size?: Size } };
export type PlanRow = { id: string; families: string[]; places: string[]; modes: string[]; sources: RowSource[]; coverage: { score: number; note: string } };
export type PlanTable = { providers: Record<string, Provider>; planned: Record<string, string>; rows: PlanRow[] };

export type PlanProfile = {
  families: string[];
  /** Countries/places the person can work in (place ids: 'in', 'in/bengaluru', 'european-union'…). */ countries: string[];
  workModes: WorkMode[];
  titles?: string[];
  watchlist?: { name: string; url?: string }[];
  careersPages?: string[];
  freelance?: boolean;
  size?: Size;
};
export type PlannedSource = { kind: 'api' | 'company-feeds' | 'watchlist' | 'careers-pages' | 'manual'; id: string; params: Record<string, unknown>; reason: string };
export type Plan = { sources: PlannedSource[]; coverage: { score: number; note: string }; rows: string[] };

let cached: PlanTable | null = null;
export function loadPlanTable(file = PLAN_FILE): PlanTable {
  if (file === PLAN_FILE && cached) return cached;
  const y = parse(readFileSync(file, 'utf8'));
  const t: PlanTable = { providers: y.providers ?? {}, planned: y.planned ?? {}, rows: y.rows ?? [] };
  if (file === PLAN_FILE) cached = t;
  return t;
}

/** Problems with the table's shape (a test keeps this empty). */
export function planTableIssues(t = loadPlanTable(), families?: string[]): string[] {
  const out: string[] = [], ids = new Set<string>();
  for (const id of Object.keys(t.providers)) if (!(API_IDS as readonly string[]).includes(id)) out.push(`provider ${id} is not an official-API registry id`);
  for (const p of Object.values(t.providers)) for (const c of p.countries) if (c !== 'world' && !place(c)) out.push(`provider ${p.name}: place ${c}`);
  for (const r of t.rows) {
    if (ids.has(r.id)) out.push(`row ${r.id} listed twice`);
    ids.add(r.id);
    for (const f of r.families) if (f !== 'any' && families && !families.includes(f)) out.push(`row ${r.id}: family ${f}`);
    for (const p of r.places) if (p !== 'any' && !place(p)) out.push(`row ${r.id}: place ${p}`);
    for (const s of r.sources) {
      if (s.planned) { if (!t.planned[s.planned]) out.push(`row ${r.id}: planned ${s.planned} not described`); continue; }
      if (s.kind === 'api' && !t.providers[s.id!]) out.push(`row ${r.id}: api ${s.id} not in providers`);
      if (s.kind === 'company-feeds' && !s.set?.label) out.push(`row ${r.id}: company-feeds needs set.label`);
      if (s.kind !== 'api' && s.kind !== 'company-feeds') out.push(`row ${r.id}: kind ${s.kind}`);
    }
    if (!(r.coverage?.score >= 0 && r.coverage.score <= 1)) out.push(`row ${r.id}: coverage score`);
    if (r.coverage.score < 0.4 && !/add|import|watchlist|not covered|can't|isn't|no public/i.test(r.coverage.note)) out.push(`row ${r.id}: low coverage must say what's missing`);
  }
  if (!t.rows.some((r) => r.families.includes('any') && r.places.includes('any') && r.modes.includes('any'))) out.push('no catch-all row');
  return out;
}

/** How specifically `row` fits; null when it doesn't apply. Family beats country beats region beats any. */
function rowFit(row: PlanRow, family: string, places: string[], modes: WorkMode[]): number | null {
  let s = 0;
  if (row.families.includes(family)) s += 3; else if (!row.families.includes('any')) return null;
  if (!row.places.includes('any')) {
    const hit = row.places.find((rp) => places.some((p) => within(p, rp)));
    if (!hit) return null;
    s += place(hit)?.kind === 'country' ? 2 : 1;
  }
  if (!row.modes.includes('any')) { if (!row.modes.some((m) => modes.includes(m as WorkMode))) return null; s += 1; }
  return s;
}

/** The rows that apply to this person, best first (ties keep table order). */
export function matchRows(p: PlanProfile, t = loadPlanTable()): PlanRow[] {
  const places = seekerPlaces(p.countries.length ? p.countries : ['world']);
  const fams = p.families.length ? p.families : ['any'];
  const scored: { row: PlanRow; s: number; i: number; f: number }[] = [];
  t.rows.forEach((row, i) => {
    let best: number | null = null, bf = 0;
    fams.forEach((f, fi) => { const s = rowFit(row, f, places, p.workModes); if (s != null && (best == null || s > best)) { best = s; bf = fi; } });
    if (best != null) scored.push({ row, s: best, i, f: bf });
  });
  // Primary family first, then specificity.
  scored.sort((a, b) => b.s - a.s || a.f - b.f || a.i - b.i);
  return scored.map((x) => x.row);
}

function providerFits(pr: Provider, places: string[], modes: WorkMode[], families: string[]): string[] | null {
  if (!pr.modes.some((m) => modes.includes(m))) return null;
  if (!pr.families.includes('any') && !families.some((f) => pr.families.includes(f))) return null;
  if (pr.countries.includes('world')) return places;
  const cs = pr.countries.filter((c) => places.some((p) => within(p, c) || within(c, p)));
  return cs.length ? cs : null;
}

/** Plan this person's sources: ~10 entries in order, each with params and a reason, and an honest coverage score. */
export function planSources(p: PlanProfile, opts: { table?: PlanTable; directory?: Directory } = {}): Plan {
  const t = opts.table ?? loadPlanTable();
  const dir = opts.directory ?? loadDirectory();
  const rows = matchRows(p, t);
  const places = seekerPlaces(p.countries.length ? p.countries : ['world']);
  const modes: WorkMode[] = p.workModes.length ? p.workModes : ['onsite', 'hybrid', 'remote'];
  const remote = modes.includes('remote');
  const keywords = (p.titles ?? []).slice(0, 3);
  const fixed = 2 + (p.careersPages?.length ? 1 : 0); // watchlist + linkedin (+ careers pages)
  const out: PlannedSource[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  let weakCompanies = false;
  const used: string[] = [];

  const taken = new Set<string>();
  for (const row of rows) {
    // The catch-all row only fills in when nothing more specific produced a source.
    if (row.families.includes('any') && row.places.includes('any') && out.length) continue;
    let added = false;
    for (const s of row.sources) {
      if (out.length >= MAX_SOURCES - fixed) break;
      if (s.planned) { if (!missing.includes(s.planned)) missing.push(s.planned); continue; }
      if (s.kind === 'api') {
        const pr = t.providers[s.id!];
        const where = pr && providerFits(pr, places, modes, p.families);
        if (!where || seen.has(`api:${s.id}`)) continue;
        seen.add(`api:${s.id}`);
        const params: Record<string, unknown> = { countries: where.slice(0, 3) };
        if (keywords.length) params.keywords = keywords;
        if (remote) params.remote = modes.length === 1 ? 'only' : 'include';
        out.push({ kind: 'api', id: s.id!, params, reason: `${pr.name}: ${s.note ?? pr.note ?? ''}`.trim() });
        added = true;
      } else if (s.kind === 'company-feeds') {
        const preferRemote = !!s.set?.prefer_remote;
        const key = `company-feeds:${preferRemote ? 'remote' : 'local'}`;
        if (seen.has(key)) continue;
        // A remote-friendly set looks worldwide; a local set looks only where the person can work on site/hybrid.
        const sel = selectCompanies({
          families: p.families, countries: preferRemote ? p.countries : p.countries,
          workModes: preferRemote ? ['remote'] : (modes.filter((m) => m !== 'remote').length ? modes.filter((m) => m !== 'remote') : ['hybrid']),
          size: s.set?.size ?? p.size, limit: COMPANIES_PER_SET,
        }, dir);
        const picks: Pick[] = sel.picks.filter((c) => !taken.has(c.id) && (!preferRemote || c.remote === true || c.reasons.some((r) => r.startsWith('hires in'))));
        for (const c of picks) taken.add(c.id);
        if (!picks.length) { weakCompanies = true; continue; }
        seen.add(key);
        const strong = picks.filter((c) => c.score >= 4).length;
        if (strong < 3) weakCompanies = true;
        out.push({
          kind: 'company-feeds', id: `company-feeds:${s.set!.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
          params: { label: s.set!.label, companies: picks.map((c) => ({ id: c.id, name: c.name, ats: c.ats, board: c.board, url: c.url, reasons: c.reasons })), strong },
          reason: `${s.note ?? 'employers\' own feeds'} — ${picks.length} companies (${strong} strong: ${picks.slice(0, 3).map((c) => c.name).join(', ')}…)`,
        });
        added = true;
      }
    }
    if (added) used.push(row.id);
    if (out.length >= MAX_SOURCES - fixed) break;
  }

  const wl = p.watchlist ?? [];
  out.push({ kind: 'watchlist', id: 'watchlist', params: { companies: wl }, reason: wl.length ? `your watchlist: ${wl.length} companies you named` : 'your watchlist (empty): add employers you want, by name or careers page' });
  if (p.careersPages?.length) out.push({ kind: 'careers-pages', id: 'careers-pages', params: { urls: p.careersPages }, reason: `${p.careersPages.length} careers pages you gave` });
  out.push({ kind: 'manual', id: 'linkedin-import', params: {}, reason: 'LinkedIn: open a LinkedIn search or post in the browser pane and import it yourself (Crewdeck never browses LinkedIn on its own)' });

  const best = rows[0];
  let score = best?.coverage.score ?? 0.3;
  const notes = [best?.coverage.note ?? 'no plan row matched'];
  if (weakCompanies && best?.sources.some((s) => s.kind === 'company-feeds')) { score *= 0.85; notes.push('the company directory has few verified employers for this field and place'); }
  if (p.freelance) { score = Math.min(score, 0.3); if (!/freelance/i.test(notes[0])) notes.push('freelance gigs mostly live on marketplaces and agency portals, not job feeds'); }
  const plannedNames = missing.map((m) => t.planned[m]?.split(' — ')[0] ?? m);
  if (plannedNames.length) notes.push(`not available yet: ${plannedNames.join(', ')}`);
  return { sources: out, coverage: { score: Math.round(score * 100) / 100, note: notes.join('; ') }, rows: used };
}
