// `crewdeck jobs search …`: rank the tracker's roles for the profile (or a query) with the same local hybrid ranking Find
// uses, and manage its parts: the full-text index, the optional embedding model, the on/off switch. No tokens, no
// network except `model install`, which only a person at a keyboard can run and which asks first.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../../config.ts';
import { openCtx, notesOf } from '../ctx.ts';
import { flag } from '../cli.ts';
import { dropVectors, embedMissing, ensureProfileVector, normalise, putVector, queryKey, vectorCounts } from './embed.ts';
import { ftsStatus, rebuildFts } from './fts.ts';
import { type FuseInfo, explainRoles, hybridEnabled } from './hybrid.ts';
import { BGE_SMALL, installModel, loadInstalledEmbedder, modelStatus, removeModel, verifyModel } from './model.ts';

const say = (s: string) => console.log(s);
/** The words that are not flags (--limit and --query-file take a value; --json, --all and --verify do not). */
const words = (a: string[]) => a.filter((x, i) => !x.startsWith('--') && !(i > 0 && ['--limit', '--query-file'].includes(a[i - 1])));

export const SEARCH_USAGE = `usage: crewdeck jobs search <verb>
  "<query>" [--limit 20] [--json] [--all]   rank roles waiting to be judged (--all: every open role) for the query, or for your profile with no query; shows each signal's rank
  reindex [--limit N]                       rebuild the full-text index and make missing embeddings (when the model is installed)
  model status [--verify] | install | remove   the optional local embedding model (install asks y/N in a terminal and never runs by itself)
  hybrid [on|off]                           use the hybrid order in Find (default on); off falls back to the cheap score alone`;

const stateFile = (home: string) => join(home, 'state', 'search.json');
function setHybrid(home: string, on: boolean) {
  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  const f = stateFile(home), tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify({ hybrid: on }), { mode: 0o600 });
  renameSync(tmp, f);
}

const sig = (r: { t?: number; b?: number; e?: number }) => [r.t !== undefined ? `title #${Math.round(r.t)}` : '', r.b !== undefined ? `keywords #${Math.round(r.b)}` : '', r.e !== undefined ? `meaning #${Math.round(r.e)}` : ''].filter(Boolean).join('  ');
export const infoLine = (i: FuseInfo) => `signals: ${i.signals.join(' + ')}${Object.keys(i.skipped).length ? `   (skipped: ${Object.entries(i.skipped).map(([k, v]) => `${k}: ${v}`).join('; ')})` : ''}`;

async function ask(plan: string[]): Promise<boolean> {
  // An agent's shell is not a terminal: a download starts only when a person is at the keyboard.
  if (!process.stdin.isTTY) throw new Error('Only you can install the model: run `crewdeck jobs search model install` yourself in a terminal (it downloads files, so it asks first).');
  for (const l of plan) say(l);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question('Download and install? [y/N] ')).trim()); } finally { rl.close(); }
}

export async function searchCmd(args: string[]) {
  const c = loadConfig();
  const [verb, sub] = words(args);
  if (verb === 'model') {
    if (sub === 'status' || sub === undefined) {
      const s = modelStatus(c.jobs.home);
      say(`${s.id}: ${s.message}`);
      if (s.installed && args.includes('--verify')) { const v = verifyModel(c.jobs.home); say(v.ok ? 'files match their pinned hashes' : `PROBLEM: ${v.bad.join(', ')}`); if (!v.ok) process.exitCode = 1; }
      return;
    }
    if (sub === 'install') {
      const s = await installModel(c.jobs.home, { confirm: ask, say });
      say(s.installed ? `Installed ${s.id}. Next: crewdeck jobs search reindex` : s.message);
      return;
    }
    if (sub === 'remove') {
      const ctx = openCtx(c);
      const had = removeModel(c.jobs.home);
      dropVectors(ctx.db, BGE_SMALL.id);
      say(had ? `Removed ${BGE_SMALL.id}, its runtime and its vectors. Ranking uses titles and keywords only.` : 'Nothing was installed.');
      return;
    }
    throw new Error('usage: crewdeck jobs search model status [--verify] | install | remove');
  }
  if (verb === 'hybrid') {
    if (sub === 'on' || sub === 'off') { setHybrid(c.jobs.home, sub === 'on'); say(`hybrid ranking: ${sub}`); return; }
    const ctx = openCtx(c);
    say(`hybrid ranking: ${hybridEnabled(ctx) ? 'on' : 'off'}${process.env.CREWDECK_HYBRID_RANK === 'off' ? ' (CREWDECK_HYBRID_RANK=off)' : ''}`);
    return;
  }
  if (verb === 'reindex') {
    const ctx = openCtx(c);
    const limit = flag(args, 'limit') === undefined ? 5000 : Number(flag(args, 'limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('--limit must be a whole number from 1 to 20000');
    const f = rebuildFts(ctx.db);
    say(f.available ? `keyword index: ${f.rows} roles` : 'keyword index: not available (this SQLite has no FTS5); ranking uses titles and the model only');
    const emb = await loadInstalledEmbedder(c.jobs.home);
    if (!emb) { say(`embeddings: ${modelStatus(c.jobs.home).message}`); return; }
    const key = await ensureProfileVector(ctx, emb, notesOf(ctx));
    const r = await embedMissing(ctx, emb, { limit });
    say(`embeddings (${emb.id}): ${r.embedded} roles embedded, ${r.remaining} left${key ? ', profile vector ready' : ', no profile text yet (add target titles in jobs/search.md)'}`);
    return;
  }
  // search "<query>"
  const q = (verb === 'status' ? '' : (flag(args, 'query-file') ? readFileSync(flag(args, 'query-file')!, 'utf8') : verb ?? '')).trim();
  const limit = flag(args, 'limit') === undefined ? 20 : Number(flag(args, 'limit'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be a whole number from 1 to 200');
  const ctx = openCtx(c);
  const ids = (args.includes('--all')
    ? ctx.db.prepare(`select r.id from roles r where r.status not in ('prefiltered_out','expired')`).all()
    : ctx.db.prepare(`select r.id from roles r where r.status = 'new' and r.eligibility is null`).all() as any[]).map((r: any) => String(r.id));
  // A typed query is embedded now (one short text) when the model is installed, and kept for the page's sort.
  let qvec: { model: string; vec: Float32Array } | undefined;
  const emb = q && vectorCounts(ctx.db).length ? await loadInstalledEmbedder(c.jobs.home) : null;
  if (emb && q) { const [v] = await emb.embed([(emb.queryPrefix ?? '') + q]); qvec = { model: emb.id, vec: normalise(v) }; putVector(ctx.db, queryKey(q, emb.id), emb.id, qvec.vec); }
  const { by, info, rows } = explainRoles(ctx, ids, { q: q || undefined, qvec });
  const out = rows.map((r) => ({ id: r.id, title: r.title, company: r.company, score: Math.round(by.get(r.id)!.score * 10) / 10, ranks: by.get(r.id)!.ranks, learned: by.get(r.id)!.learned, fit: by.get(r.id)!.fit }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  if (args.includes('--json')) return say(JSON.stringify({ query: q || null, pool: ids.length, signals: info.signals, skipped: info.skipped, roles: out }, null, 1));
  say(`${q ? `"${q}"` : 'your profile'}: ${ids.length} roles, best ${out.length}`);
  say(infoLine(info));
  for (const r of out) say(`${String(r.score.toFixed(1)).padStart(5)}  ${r.id}  ${r.title} · ${r.company}\n         ${sig({ t: r.ranks.title, b: r.ranks.bm25, e: r.ranks.embed })}${r.learned ? `  learned ${r.learned > 0 ? '+' : ''}${r.learned}` : ''}`);
  const fts = ftsStatus(ctx.db);
  if (!fts.ready) say(`note: no keyword index (${fts.available ? 'run crewdeck jobs search reindex' : 'this SQLite has no FTS5'})`);
}
