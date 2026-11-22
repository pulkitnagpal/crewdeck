// Company-set selector (ADR-0001: one 'company feeds' source carries a company set chosen by field × region × size).
// Picks the best N boards from the directory for a person: verified only (unless asked), matching their field families
// and countries, remote-friendly employers first for remote seekers. Every pick says why.
import { countryOf, place, within } from '../places.ts';
import { TECH_BOARD_PRIOR } from './enrich.ts';
import { type Company, type Directory, type Size, loadDirectory } from './seed.ts';

export type WorkMode = 'remote' | 'hybrid' | 'onsite';
export type SelectQuery = {
  families: string[];
  /** Countries (or places inside them, e.g. in/bengaluru) the person can work in. */ countries: string[];
  workModes: WorkMode[];
  size?: Size | Size[];
  limit: number;
  /** Also consider quarantined (unverified) entries. Off by default. */ includeQuarantine?: boolean;
  /** Restrict to these ATSes (e.g. only those a feed adapter exists for). */ atses?: string[];
};
export type Pick = { id: string; name: string; ats: string; board: string; url: string; score: number; remote: boolean | null; reasons: string[] };
export type Selection = { picks: Pick[]; considered: number; matched: number; note: string };

const TECH_ATS = new Set(['greenhouse', 'lever', 'ashby']);

/** A person's place ids → country ids (cities and states fold to their country; regions stay as given). */
export function seekerPlaces(ids: string[]): string[] {
  return [...new Set(ids.map((id) => (place(id)?.kind === 'country' ? id : countryOf(id) ?? id)))];
}

function regionHit(c: Company, places: string[]): string | null {
  for (const r of c.regions) {
    if (r === 'world') continue;
    for (const p of places) if (within(p, r) || within(r, p)) return r;
  }
  return null;
}

function familyScore(c: Company, families: string[]): { score: number; why?: string } {
  const hit = c.families.filter((f) => families.includes(f));
  if (hit.length) {
    if (c.familyConfidence === 'medium' || c.familyConfidence === 'high') return { score: 4, why: `hires for ${hit.join(', ')} (curated)` };
    return { score: 2, why: `name suggests ${hit.join(', ')} (${c.familyFrom.slice(0, 2).join(', ')})` };
  }
  if (!c.families.length && TECH_ATS.has(c.ats) && families.some((f) => TECH_BOARD_PRIOR.includes(f))) return { score: 1, why: `typical ${c.ats} employer (tech roles likely; field not known)` };
  return { score: 0 };
}

/** Score one company for the query; null when it doesn't fit at all. */
export function scoreCompany(c: Company, q: SelectQuery, places = seekerPlaces(q.countries)): { score: number; reasons: string[] } | null {
  if (c.quarantine && !q.includeQuarantine) return null;
  if (q.atses && !q.atses.includes(c.ats)) return null;
  const reasons: string[] = [];
  const fam = familyScore(c, q.families);
  if (!fam.score) return null;
  let score = fam.score;
  reasons.push(fam.why!);
  const remoteSeeker = q.workModes.includes('remote');
  const onlyRemote = remoteSeeker && q.workModes.length === 1;
  const hit = regionHit(c, places);
  if (hit) {
    if (onlyRemote && !c.remote) { score += 1; reasons.push(`based in ${hit}: remote roles there may or may not be open`); }
    else { const strong = c.regionConfidence === 'medium' || c.regionConfidence === 'high'; score += strong ? 4 : 2; reasons.push(`hires in ${hit}${strong ? '' : ' (guessed from the legal name)'}`); }
  } else if (remoteSeeker && c.remote) {
    // A remote-first employer elsewhere: plausible; each posting's remote countries decide.
  } else if (remoteSeeker && !c.regions.length) {
    reasons.push('region unknown: each posting\'s remote countries decide');
  } else return null;
  if (remoteSeeker && c.remote) { score += 3; reasons.push(c.regions.includes('world') ? 'remote-first, hires worldwide' : 'remote-friendly'); }
  if (c.staffing) { score -= 1; reasons.push('staffing agency'); }
  const sizes = q.size ? (Array.isArray(q.size) ? q.size : [q.size]) : [];
  if (sizes.length && c.size && sizes.includes(c.size)) { score += 1; reasons.push(`${c.size} employer`); }
  if (c.curated && c.verified) { score += 1; reasons.push(c.checked ? `verified ${c.checked}` : 'verified'); }
  if (c.quarantine) { score -= 2; reasons.push(`quarantined: ${c.note ?? 'unverified'}`); }
  return { score, reasons };
}

const LISTING_NAME = /\b(jobs?|roles?|positions?|openings?|vacanc(y|ies)|referrals?|board|opportunit(y|ies)|hiring)\b/i;

/** The best `limit` boards for this person, with reasons; remote-friendly first for remote seekers. */
export function selectCompanies(q: SelectQuery, dir: Directory = loadDirectory()): Selection {
  const places = seekerPlaces(q.countries);
  const remoteSeeker = q.workModes.includes('remote');
  const scored: (Pick & { curated: boolean })[] = [];
  const seen = new Set<string>();
  for (const c of dir.companies) {
    // A board named like a job listing ("Remote Jobs At …", "… Therapist Roles", "Referral Board") isn't an employer.
    if (LISTING_NAME.test(c.name)) continue;
    // An unchecked name with "remote" in it is nearly always a remote-job board, not an employer (curated ones stay).
    if (!c.curated && /\bremote\b/i.test(c.name)) continue;
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    const s = scoreCompany(c, q, places);
    if (!s) continue;
    seen.add(key);
    scored.push({ id: c.id, name: c.name, ats: c.ats, board: c.board, url: c.url, score: s.score, remote: c.remote, reasons: s.reasons, curated: c.curated });
  }
  scored.sort((a, b) =>
    // Remote-first only where the directory knows it (curated); a name with "remote" in it is a guess, ranked by score.
    (remoteSeeker ? Number(b.remote === true && b.curated) - Number(a.remote === true && a.curated) : 0)
    || b.score - a.score || Number(b.curated) - Number(a.curated) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const picks = scored.slice(0, Math.max(0, q.limit)).map(({ curated: _c, ...p }) => p);
  const strong = scored.filter((p) => p.score >= 4).length;
  const note = !scored.length ? 'no directory company matches this field and place'
    : strong < Math.min(q.limit, 10) ? `only ${strong} strong matches (field and place both known); the rest are guesses from company names or typical ATS customers`
    : `${strong} strong matches`;
  return { picks, considered: dir.companies.length, matched: scored.length, note };
}
