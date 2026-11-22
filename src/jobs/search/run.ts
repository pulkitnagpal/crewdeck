// The sources run's embedding step: plain code after the prefilter, never Claude. When the local model is installed, the
// roles still waiting to be judged get a vector (newest first, at most `cap` per run so a first run never stalls the
// fetch), and the profile's vector is made once. Without the model: nothing happens (ranking uses titles and keywords).
import { type Ctx, notesOf } from '../ctx.ts';
import { type Embedder, embedMissing, ensureProfileVector } from './embed.ts';
import { loadInstalledEmbedder, modelStatus } from './model.ts';

export const EMBED_CAP_PER_RUN = 300;
export type EmbedRun = { ran: boolean; why?: string; model?: string; embedded?: number; remaining?: number };

export async function embedNewRoles(ctx: Ctx, o: { cap?: number; embedder?: Embedder } = {}): Promise<EmbedRun> {
  try {
    const emb = o.embedder ?? (modelStatus(ctx.home).installed ? await loadInstalledEmbedder(ctx.home) : null);
    if (!emb) return { ran: false, why: 'model not installed (crewdeck jobs search model install)' };
    await ensureProfileVector(ctx, emb, notesOf(ctx));
    const ids = (ctx.db.prepare(`select id from roles where status in ('new','bench') and eligibility is null`).all() as any[]).map((r) => String(r.id));
    const r = await embedMissing(ctx, emb, { ids, limit: o.cap ?? EMBED_CAP_PER_RUN });
    return { ran: true, model: emb.id, ...r };
  } catch (e: any) { return { ran: false, why: String(e?.message ?? e).slice(0, 300) }; }
}
