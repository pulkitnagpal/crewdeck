// The company directory (design §8.2, ADR-0002): the pinned LastRound AI seed (CC BY 4.0, see
// data/directory/SOURCE.md) plus hand-curated entries (data/directory/curated.yaml), enriched offline. Loading checks
// the seed's SHA-256 against the pin, so the directory only changes through a reviewed commit.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type Confidence, enrich } from './enrich.ts';
import { place } from '../places.ts';

export const DIR = join(import.meta.dirname, '..', 'data', 'directory');
export const SEED_FILE = join(DIR, 'seed.csv');
export const CURATED_FILE = join(DIR, 'curated.yaml');
/** SHA-256 of the shipped seed.csv (SOURCE.md records it and the original download's). */
export const SEED_SHA256 = '5ea6dfb764e57913f9a76272472ea7b1f26216ef8cc354995e2cfb4028f6a0db';
export const SEED_ATTRIBUTION = 'Company directory: "ATS company directory" by LastRound AI (datahub.io/lastroundai-hiring-data), CC BY 4.0; rows withheld by Crewdeck.';

export const ATSES = ['greenhouse', 'lever', 'ashby', 'workday', 'oracle', 'keka', 'darwinbox', 'zoho-recruit', 'phenom'] as const;
export type Ats = (typeof ATSES)[number];
export type Size = 'small' | 'mid' | 'large';

export type Company = {
  /** `<ats>:<board>` */ id: string;
  name: string; ats: Ats; board: string;
  /** The public careers page / board a person can open. */ url: string;
  families: string[]; familyConfidence: Confidence; familyFrom: string[];
  regions: string[]; regionConfidence: Confidence; regionFrom: string[];
  remote: boolean | null; staffing: boolean; size?: Size;
  /** Where it is headquartered (an ISO country code), from a curated entry only (ADR-0008 §8). */ hq?: string;
  origin: 'seed' | 'curated'; curated: boolean;
  /** Only verified, non-quarantined entries are used by default. */ verified: boolean; quarantine: boolean;
  seenAt?: string; evidence?: string; checked?: string; note?: string;
};

export type Directory = { companies: Company[]; byId: Map<string, Company>; seedRows: number; curatedRows: number };

export class SeedHashError extends Error {}

export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export function boardUrl(ats: Ats, board: string): string {
  switch (ats) {
    case 'greenhouse': return `https://boards.greenhouse.io/${board}`;
    case 'lever': return `https://jobs.lever.co/${board}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${board}`;
    case 'keka': return `https://${board}.keka.com/careers`;
    case 'workday': { const [t, wd, site] = board.split('/'); return `https://${t}.${wd}.myworkdayjobs.com/${site}`; }
    default: return '';
  }
}

/** One CSV line with RFC 4180 quoting. */
export function csvLine(line: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Read the seed, refusing a file whose hash isn't the pin. */
export function loadSeed(file = SEED_FILE, pin = SEED_SHA256): { ats: Ats; name: string; board: string; seenAt: string }[] {
  const buf = readFileSync(file);
  const got = sha256(buf);
  if (got !== pin) throw new SeedHashError(`company directory seed ${file} has SHA-256 ${got}, expected ${pin}: the file changed without updating the pin (see data/directory/SOURCE.md)`);
  const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  const head = csvLine(lines[0]).join(',');
  if (head !== 'ats_vendor,company_name,board_slug,last_crawled') throw new Error(`company directory seed: unexpected header ${head}`);
  return lines.slice(1).map((l) => { const [ats, name, board, seenAt] = csvLine(l); return { ats: ats as Ats, name: name.trim(), board, seenAt }; });
}

type CuratedRow = { ats: Ats; board: string; name: string; url?: string; regions?: string[]; hq?: string; families?: string[]; remote?: boolean; size?: Size; status: 'verified' | 'quarantine'; evidence?: string; checked?: string | Date; note?: string };

export function loadCurated(file = CURATED_FILE): CuratedRow[] {
  return ((parse(readFileSync(file, 'utf8'))?.companies ?? []) as CuratedRow[]).map((r) => ({ ...r, checked: r.checked instanceof Date ? r.checked.toISOString().slice(0, 10) : r.checked == null ? undefined : String(r.checked) }));
}

/** Problems with curated.yaml's shape (a test keeps this empty). */
export function curatedIssues(rows = loadCurated()): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const r of rows) {
    const at = `curated ${r.ats}:${r.board}`;
    if (!(ATSES as readonly string[]).includes(r.ats)) out.push(`${at}: unknown ats`);
    if (!r.name) out.push(`${at}: no name`);
    if (seen.has(`${r.ats}:${r.board}`)) out.push(`${at}: listed twice`);
    seen.add(`${r.ats}:${r.board}`);
    if (r.status !== 'verified' && r.status !== 'quarantine') out.push(`${at}: status ${r.status}`);
    if (r.status === 'verified' && (!r.evidence || !r.checked)) out.push(`${at}: verified needs evidence and checked`);
    if (r.status === 'quarantine' && !r.note) out.push(`${at}: quarantine needs a note saying why`);
    if (r.ats === 'workday' && r.board.split('/').length !== 3) out.push(`${at}: workday board is tenant/wdN/site`);
    if (r.status === 'verified' && !boardUrl(r.ats, r.board) && !r.url) out.push(`${at}: verified needs a url`);
    if (r.hq !== undefined && !(typeof r.hq === 'string' && /^[a-z]{2}$/.test(r.hq) && place(r.hq)?.kind === 'country')) out.push(`${at}: hq ${r.hq} is not a country code (in, us, de …)`);
  }
  return out;
}

let cached: Directory | null = null;

/**
 * The whole directory: seed rows (verified by the dataset's crawl, regions/families from name heuristics) with curated
 * overlays applied, plus curated additions. Seed rows are not quarantined by default: their feed adapter validates each
 * board before use (staleness is real: see SOURCE.md).
 */
export function loadDirectory(opts: { seedFile?: string; pin?: string; curatedFile?: string } = {}): Directory {
  const isDefault = !opts.seedFile && !opts.pin && !opts.curatedFile;
  if (isDefault && cached) return cached;
  const seed = loadSeed(opts.seedFile, opts.pin);
  const curated = loadCurated(opts.curatedFile);
  const byId = new Map<string, Company>();
  for (const r of seed) {
    const id = `${r.ats}:${r.board}`;
    if (byId.has(id)) continue;
    const e = enrich(r.name, r.board);
    byId.set(id, { id, name: r.name, ats: r.ats, board: r.board, url: boardUrl(r.ats, r.board), ...e, origin: 'seed', curated: false, verified: true, quarantine: false, seenAt: r.seenAt });
  }
  for (const c of curated) {
    const id = `${c.ats}:${c.board}`;
    const base = byId.get(id);
    const e = enrich(c.name, '');
    const merged: Company = {
      id, name: c.name, ats: c.ats, board: c.board, url: c.url ?? boardUrl(c.ats, c.board),
      families: c.families?.length ? c.families : base?.families ?? e.families,
      familyConfidence: c.families?.length ? 'medium' : base?.familyConfidence ?? e.familyConfidence,
      familyFrom: c.families?.length ? ['curated'] : base?.familyFrom ?? e.familyFrom,
      regions: c.regions?.length ? c.regions : base?.regions ?? e.regions,
      regionConfidence: c.regions?.length ? 'medium' : base?.regionConfidence ?? e.regionConfidence,
      regionFrom: c.regions?.length ? ['curated'] : base?.regionFrom ?? e.regionFrom,
      remote: c.remote ?? base?.remote ?? e.remote, staffing: base?.staffing ?? e.staffing, size: c.size, ...(c.hq ? { hq: c.hq } : {}),
      origin: base ? 'seed' : 'curated', curated: true,
      verified: c.status === 'verified', quarantine: c.status !== 'verified',
      seenAt: base?.seenAt, evidence: c.evidence, checked: c.checked as string | undefined, note: c.note,
    };
    byId.set(id, merged);
  }
  const dir: Directory = { companies: [...byId.values()], byId, seedRows: seed.length, curatedRows: curated.length };
  if (isDefault) cached = dir;
  return dir;
}
