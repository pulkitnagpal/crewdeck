// A person's portal readers (ADR-0008, "Teach a portal"): <jobs.home>/portals/readers.yaml (0600) overlays the shipped
// catalog by id with the parts that read a portal's search page: the search URL template and its parameters, the job-URL
// pattern, the card and JSON adapters, the sign-in wall, the signed-in check and the limits. A `teach: true` catalog
// entry (only who it is and where it lives) becomes scannable once Claude has taught it in the pane and the person's
// reader passes the catalog's own validator. A reader that no longer validates (a catalog change) is ignored, with its
// problems listed, and the catalog entry stays as shipped.
//
// The same file keeps the portals the person added themselves (a `portal_add` proposal they approved): `teach: true`
// entries under `added:`, validated like the catalog's own, never overriding a catalog id.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ensureHome } from '../../config.ts';
import { type Portal, type PortalCatalog, loadPortals, normalise, portalIssues } from './catalog.ts';

/** The keys a reader may set; everything else (id, name, hosts, countries, risk) stays the catalog's. */
export const READER_KEYS = ['search', 'job_url', 'cards', 'json', 'sign_in_wall', 'signed_in', 'limits', 'headful', 'login_url', 'signup_url', 'cdn_hosts'] as const;
export type Reader = Partial<Record<(typeof READER_KEYS)[number], unknown>>;
export const MAX_READER_BYTES = 32 * 1024;

export const readersFile = (home: string) => join(home, 'portals', 'readers.yaml');

type ReadersFile = { readers: Record<string, Reader>; added: Record<string, any>[] };

function readFile(home: string): ReadersFile {
  try {
    const y = parse(readFileSync(readersFile(home), 'utf8')) ?? {};
    const r = y && typeof y.readers === 'object' && !Array.isArray(y.readers) ? y.readers : {};
    return {
      readers: Object.fromEntries(Object.entries(r).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) as Record<string, Reader>,
      added: Array.isArray(y?.added) ? y.added.filter((x: unknown) => x && typeof x === 'object' && !Array.isArray(x)) : [],
    };
  } catch { return { readers: {}, added: [] }; }
}

/** The person's readers by portal id (an unreadable file: none). */
export const readReaders = (home: string): Record<string, Reader> => readFile(home).readers;
/** The portals the person added (teach entries), as written. */
export const addedPortals = (home: string): Record<string, any>[] => readFile(home).added;

function writeFile(home: string, f: ReadersFile) {
  ensureHome(join(home, 'portals'));
  const file = readersFile(home), tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const head = '# Your portal readers (Crewdeck, ADR-0008): how Claude reads each portal\'s search page. Written by\n# `crewdeck jobs portals teach <id> --save`; `crewdeck jobs portals reader <id> --reset` removes one.\n# added: portals you added yourself (an approved proposal); Undo on the proposal removes one.\n';
  writeFileSync(tmp, head + stringify({ readers: f.readers, added: f.added }, { lineWidth: 0 }), { mode: 0o600 });
  renameSync(tmp, file);
}
const writeReaders = (home: string, readers: Record<string, Reader>) => writeFile(home, { ...readFile(home), readers });

/** A reader as given (a JSON object): only the reader keys, nothing else. */
export function checkReader(raw: unknown): Reader {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a reader is a JSON object { search, job_url, cards?, json?, sign_in_wall?, signed_in?, limits? }');
  const out: Reader = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(READER_KEYS as readonly string[]).includes(k)) throw new Error(`unknown reader key "${k.slice(0, 40)}" (use ${READER_KEYS.join(', ')})`);
    out[k as keyof Reader] = v;
  }
  if (JSON.stringify(out).length > MAX_READER_BYTES) throw new Error(`a reader is at most ${MAX_READER_BYTES / 1024} KB`);
  return out;
}

/** The catalog entry with a reader laid over it, and every problem the catalog's validator finds in the result. */
export function overlay(cat: PortalCatalog, id: string, reader: Reader): { portal: Portal; problems: string[] } {
  const base = cat.raw?.byId.get(id) ?? cat.added?.get(id);
  if (!base) throw new Error(`no portal "${id}" in the catalog (crewdeck jobs portals list shows them)`);
  const portal: Portal = { ...normalise({ ...base, ...reader, teach: false }, cat.raw?.defaults ?? {}), reader: true, ...(cat.added?.has(id) ? { added: true } : {}) };
  // A taught entry keeps the catalog's facts about it (kind, access); the reader decides only how it is read.
  return { portal, problems: portalIssues(portal) };
}

export type EffectiveCatalog = PortalCatalog & { readerProblems: Record<string, string[]> };

/** The person's added portals as teach entries: valid ones only, never a catalog id. */
function withAdded(home: string, cat: PortalCatalog, problems: Record<string, string[]>): PortalCatalog {
  const added = new Map<string, any>();
  const portals = [...cat.portals];
  for (const e of addedPortals(home)) {
    const p = { ...normalise({ ...e, teach: true }, cat.raw?.defaults ?? {}), added: true } as Portal;
    if (cat.byId.has(p.id) || added.has(p.id)) continue;
    const bad = portalIssues(p);
    if (bad.length) { problems[p.id || '(no id)'] = bad; continue; }
    added.set(p.id, { ...e, teach: true });
    portals.push(p);
  }
  return { ...cat, portals, byId: new Map(portals.map((p) => [p.id, p])), added };
}

/** The catalog as this person sees it: their added portals too, each portal with their reader laid over it when valid. */
export function effectivePortals(home: string, shipped: PortalCatalog = loadPortals()): EffectiveCatalog {
  const readers = readReaders(home);
  const readerProblems: Record<string, string[]> = {};
  const cat = withAdded(home, shipped, readerProblems);
  const portals = cat.portals.map((p) => {
    const r = readers[p.id];
    if (!r) return p;
    try {
      const o = overlay(cat, p.id, checkReader(r));
      if (!o.problems.length) return o.portal;
      readerProblems[p.id] = o.problems;
    } catch (e: any) { readerProblems[p.id] = [String(e?.message ?? e)]; }
    return p;
  });
  return { portals, byId: new Map(portals.map((p) => [p.id, p])), raw: cat.raw, added: cat.added, readerProblems };
}

/** Keep a checked reader (the CLI's `teach --save`, after the dry run found jobs). */
export function saveReader(home: string, id: string, reader: Reader, cat: PortalCatalog = effectivePortals(home)): Portal {
  const o = overlay(cat, id, checkReader(reader));
  if (o.problems.length) throw new Error(o.problems.join('; '));
  writeReaders(home, { ...readReaders(home), [id]: reader });
  return o.portal;
}

/** Remove a reader; true when there was one. */
export function resetReader(home: string, id: string): boolean {
  const all = readReaders(home);
  if (!all[id]) return false;
  delete all[id];
  writeReaders(home, all);
  return true;
}

/** What a person-added portal holds: who it is and where it lives (a `portal_add` proposal, approved). */
export type AddedPortal = { id: string; name: string; home_url: string; countries: string[]; fields: string[]; kind?: string; access?: string };

/** Add a teach entry for a portal the person named; its id is made from the host when not given. */
export function addPortal(home: string, a: AddedPortal, cat: PortalCatalog = loadPortals()): Portal {
  const entry = {
    id: a.id, name: a.name, home_url: a.home_url, countries: a.countries.length ? a.countries : ['world'], fields: a.fields.length ? a.fields : ['any'],
    kind: a.kind ?? 'portal', access: a.access ?? 'signed-in', importance: 2, teach: true,
    risk: `${a.name} may not allow automated reading; Crewdeck reads a few of its pages slowly, as you, and your account carries the risk.`,
    notes: 'Added by you (an approved proposal); its reader is taught by Claude on first connect.',
  };
  const f = readFile(home);
  if (cat.byId.has(entry.id) || f.added.some((x) => x.id === entry.id)) throw new Error(`a portal "${entry.id}" is already there (crewdeck jobs portals list)`);
  const p = normalise(entry, cat.raw?.defaults ?? {});
  const bad = portalIssues(p);
  if (bad.length) throw new Error(bad.join('; '));
  writeFile(home, { ...f, added: [...f.added, entry] });
  return p;
}

/** Remove a person-added portal and its reader (Undo of the proposal); true when it was there. */
export function removeAddedPortal(home: string, id: string): boolean {
  const f = readFile(home);
  const left = f.added.filter((x) => x.id !== id);
  if (left.length === f.added.length) return false;
  const readers = { ...f.readers };
  delete readers[id];
  writeFile(home, { readers, added: left });
  return true;
}

/** An id for a portal from its address: the host's name without www and the top-level domain (jobs.example.co.in → example). */
export function idFromUrl(url: string): string {
  const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  const sld = parts.length >= 3 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2] ?? parts[0];
  const id = sld.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return /^[a-z]/.test(id) && id.length >= 2 ? id : `p-${id}`.slice(0, 30);
}
