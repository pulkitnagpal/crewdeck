// The Sources screen's model (design §24.3, D23, D42): the user's list in priority order with each source's last fetch,
// the catalog to add from (filterable by region, field and kind; blocked, retired and unrunnable entries never offered),
// what suggest proposes for the notes, and the coverage line. Read-only: every change goes through the `sources` page
// action (sources-note.ts), which the CLI shares.
import { join } from 'node:path';
import { type CatalogEntry, loadCatalog } from './catalog.ts';
import { type Ctx, notesOf } from './ctx.ts';
import { NOTES } from './notes.ts';
import { RISK } from './features.ts';
import { ancestors, placeName } from './places.ts';
import type { ResolveResult } from './resolve.ts';
import { stateFile } from './sources.ts';
import { listSources } from './sources-note.ts';
import { suggestSources } from './suggest.ts';

/** What the page shows for a kind (the catalog's words are for developers). */
export const KIND_LABEL: Record<string, string> = {
  board: 'Job board', aggregator: 'Aggregator', ats: 'Careers system', national: 'Public employment service', field: 'Field board',
  employer: 'Employer', feed: 'Feed', linkedin: 'LinkedIn', custom: 'Web address', 'careers page': 'Careers page', unknown: 'Source',
};

/** A resolve the page started (or its answer), kept in the server's memory for the screen. */
export type ResolveState = { key: string; started?: string; at?: string; result?: ResolveResult; refused?: string };

/** A catalog entry the page may offer: runnable, not retired, not blocked; never Crewdeck's own LinkedIn entry. */
export const offerable = (c: CatalogEntry) => c.runnable && !c.retired && !c.blocked;

export function sourcesScreen(ctx: Ctx, o: { resolving?: Map<string, ResolveState>; results?: Map<string, ResolveState>; notesPage: (f: string) => string }) {
  const notes = notesOf(ctx);
  const cat = loadCatalog();
  const rows = listSources(ctx).map((r) => ({
    ...r,
    kind_label: KIND_LABEL[r.kind] ?? r.kind,
    provider_name: r.provider ? (cat.byId.get(r.provider)?.name ?? r.provider) : undefined,
    region_names: r.regions.slice(0, 4).map((x) => (x === 'world' ? 'worldwide' : placeName(x))),
    resolving: o.resolving?.has(r.key) ? o.resolving.get(r.key)!.started : undefined,
    resolved: o.results?.get(r.key) ?? undefined,
  }));
  const s = suggestSources(notes, {}, { linkedinOn: ctx.features.linkedin_search });
  const have = new Set(notes.sources.data.items.filter((x) => x.provider && !x.careers_url && !x.employer).map((x) => x.provider));
  const entries = cat.sources.filter(offerable);
  // Region filter: the user's countries first, then every region the catalog names; containment comes with each id so
  // the page can filter without the gazetteer ("India" shows boards for India, South Asia and boards inside India).
  const mine = s.profile.countries;
  const regionIds = new Set<string>(entries.flatMap((c) => c.regions));
  const others = [...regionIds].filter((x) => x !== 'world' && !mine.includes(x)).sort((a, b) => placeName(a).localeCompare(placeName(b)));
  const anc = (id: string) => [...ancestors(id)].filter((x) => x !== 'world');
  const regionOpts = [...mine.map((id) => ({ id, name: placeName(id), mine: true })), { id: 'world', name: 'Worldwide (remote boards)', mine: false }, ...others.map((id) => ({ id, name: placeName(id), mine: false }))];
  const within: Record<string, string[]> = {};
  for (const id of new Set([...regionIds, ...mine])) within[id] = anc(id);
  const linkedin = notes.sources.data.items.some((x) => x.linkedin);
  return {
    note: { file: NOTES.sources, page: o.notesPage(NOTES.sources), path: join(ctx.vault, NOTES.sources), exists: notes.sources.exists, source: notes.sources.source,
      // A missing note isn't an error here: the first source added creates it.
      errors: notes.sources.exists ? notes.sources.issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`) : [] },
    state_file: stateFile(ctx.home),
    rows,
    linkedin: { in_list: linkedin, risk: RISK.linkedin_search,
      switches: { linkedin_search: ctx.features.linkedin_search, linkedin_links: ctx.features.linkedin_links, easy_apply: ctx.features.easy_apply } },
    coverage: { line: s.coverage.line, missing: s.coverage.missing, works: s.coverage.works, fits: s.sources.length },
    suggested: s.sources.filter((x) => !have.has(x.id)).slice(0, 8).map((x) => ({ id: x.id, reasons: x.reasons })),
    catalog: entries.map((c) => ({
      id: c.id, name: c.name, kind: c.kind, kind_label: KIND_LABEL[c.kind] ?? c.kind, needs: c.needs, regions: c.regions,
      region_names: c.regions.slice(0, 4).map((x) => (x === 'world' ? 'worldwide' : placeName(x))), families: c.families, coverage: c.coverage,
      verified: c.confidence === 'high', ...(c.note ? { note: c.note } : {}), added: have.has(c.id),
    })),
    filters: {
      regions: regionOpts, within,
      families: Object.entries(cat.families).filter(([k]) => k !== 'any').map(([id, text]) => ({ id, text })),
      kinds: Object.keys(cat.kinds).map((id) => ({ id, label: KIND_LABEL[id] ?? id })),
      mine_families: s.profile.families,
    },
  };
}
