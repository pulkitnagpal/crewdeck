// Jobs v2 (docs/architecture/designs/jobs-v2.md §7, ADR-0001/0002): the person's planned sources, fetched.
//
// The notes say who the person is and where they can work (profileOf); the source plan picks their ~10 sources (official
// APIs, company job feeds chosen by field × region, their watchlist); the feeds and API runners fetch them through
// netguard and write roles into the pool that the rules, the judge and Today already use. Plain code, no tokens.
import type { Ctx } from './ctx.ts';
import { notesOf } from './ctx.ts';
import { profileOf } from './suggest.ts';
import { planSources, type Plan, type PlanProfile } from './directory/plan.ts';
import type { WorkMode } from './directory/plan.ts';
import type { NetOptions } from './net/netguard.ts';

export type PlannedRunResult = {
  plan: { coverage: Plan['coverage']; sources: { kind: string; id: string; reason: string }[] };
  apis: { provider: string; status: string; postings: number; error?: string }[];
  feeds: { boards: number; fetched: number; new: number; notModified: number; errors: number };
  stored: number;
};

/** A field for titles when the notes name none (v1 notes have titles but no targets): keyword families. */
const FAMILY_WORDS: [string, RegExp][] = [
  ['engineering-it', /\b(engineer|developer|programmer|sre|devops|architect|full[- ]?stack|backend|frontend|software|platform|infrastructure|forward[- ]deployed|qa|tester)\b/i],
  ['data', /\b(data|machine learning|ml|ai|analytics|scientist|analyst)\b/i],
  ['product', /\b(product (manager|owner|lead)|pm)\b/i],
  ['design', /\b(designer|ux|ui)\b/i],
  ['healthcare', /\b(nurse|rn|doctor|physician|pharmac|therapist|medical|clinical|caregiver|midwife)\b/i],
  ['education', /\b(teacher|educator|tutor|lecturer|professor|teaching)\b/i],
  ['finance', /\b(accountant|bookkeeper|finance|auditor|controller|tax)\b/i],
  ['sales', /\b(sales|account executive|business development)\b/i],
  ['operations', /\b(warehouse|logistics|driver|operations|supply chain|picker|packer|forklift)\b/i],
];
export const familiesFromTitles = (titles: string[]) => [...new Set(titles.flatMap((t) => FAMILY_WORDS.filter(([, re]) => re.test(t)).map(([f]) => f)))];

/** What the plan needs from the notes. */
export function planProfile(ctx: Ctx): PlanProfile {
  const notes = notesOf(ctx);
  const p = profileOf(notes);
  const s = notes.search.data;
  const modes = (p.workplace.filter((w) => w === 'remote' || w === 'hybrid' || w === 'onsite') as WorkMode[]);
  const watch = notes.sources.data.items.filter((it) => it.employer && it.enabled).map((it) => ({ name: it.name, url: it.careers_url ?? it.url }));
  return {
    families: p.families.length ? p.families : familiesFromTitles(p.titles),
    countries: [...new Set([...p.countries, ...p.remote])],
    workModes: modes,
    titles: p.titles,
    watchlist: watch,
    careersPages: watch.map((w) => w.url).filter((u): u is string => !!u),
    freelance: (s.employment_types ?? []).some((t: string) => /freelance|contract/i.test(t)),
    companyCountries: s.companies?.countries,
  };
}

const iso2 = (placeId: string) => placeId.split('/')[0].toLowerCase();

/** Fetch the planned sources and store their postings as roles. Each source fails alone; nothing here throws. */
export async function runPlanned(ctx: Ctx, o: { net?: NetOptions; maxBoards?: number; plan?: Plan } = {}): Promise<PlannedRunResult> {
  const profile = planProfile(ctx);
  const plan = o.plan ?? planSources(profile);
  const out: PlannedRunResult = {
    plan: { coverage: plan.coverage, sources: plan.sources.map((s) => ({ kind: s.kind, id: s.id, reason: s.reason })) },
    apis: [], feeds: { boards: 0, fetched: 0, new: 0, notModified: 0, errors: 0 }, stored: 0,
  };

  // Official / public APIs: one query per country the plan names, the person's titles as keywords.
  const apiEntries = plan.sources.filter((s) => s.kind === 'api').flatMap((s) => {
    const countries = ((s.params.countries as string[] | undefined) ?? ['world']).map(iso2).filter((c) => /^[a-z]{2}$/.test(c));
    const titles = ((s.params.keywords as string[] | undefined) ?? profile.titles ?? []).slice(0, 3);
    if (!titles.length) return [];
    return (countries.length ? countries : ['']).map((country) => ({ provider: s.id, query: { titles, country, remote: s.params.remote === 'only' || s.params.remote === 'include' ? true : undefined } }));
  });
  if (apiEntries.length) {
    try {
      const [{ runApis }, { KeyStore }, { postingToRole }, { upsertRole }] = await Promise.all([
        import('./apis/runner.ts'), import('./apis/keys.ts'), import('./feeds/store.ts'), import('./db.ts'),
      ]);
      const r = await runApis(apiEntries as any, { keys: new KeyStore() } as any);
      for (const st of r.stats as any[]) out.apis.push({ provider: st.provider, status: st.status, postings: st.postings ?? 0, ...(st.error ? { error: String(st.error).slice(0, 200) } : {}) });
      for (const p of r.postings as any[]) {
        if (!p.url || !p.title) continue;
        const role = postingToRole({ ...p, ats: p.sourceKey, board: p.sourceKey, atsJobId: p.sourceJobId, locations: p.locations ?? [], remoteCountries: p.remoteCountries ?? [] } as any);
        role.source_key = `api:${p.sourceKey}`;
        if (upsertRole(ctx.db, role).isNew) out.stored++;
      }
    } catch (e: any) { out.apis.push({ provider: 'apis', status: 'error', postings: 0, error: String(e?.message ?? e).slice(0, 200) }); }
  }

  // Company job feeds: the plan's company sets, verified boards only, capped.
  const boards = plan.sources.filter((s) => s.kind === 'company-feeds').flatMap((s) => ((s.params.companies as any[]) ?? []))
    .filter((c) => c.ats && c.board).map((c) => ({ ats: c.ats, slug: c.board, company: c.name }))
    .slice(0, o.maxBoards ?? 300);
  if (boards.length) {
    try {
      const { runFeeds } = await import('./feeds/run.ts');
      const stats = await runFeeds(boards as any, { db: ctx.db, net: o.net });
      out.feeds.boards = stats.length;
      for (const b of stats as any[]) {
        out.feeds.fetched += b.fetched ?? 0; out.feeds.new += b.new ?? 0;
        out.feeds.notModified += b.notModified ? 1 : 0; out.feeds.errors += (b.errors?.length ?? 0) > 0 ? 1 : 0;
      }
      out.stored += out.feeds.new;
    } catch (e: any) { out.feeds.errors++; }
  }
  return out;
}
