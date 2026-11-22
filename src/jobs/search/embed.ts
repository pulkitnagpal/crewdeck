// Embeddings for hybrid ranking (signal 3): an Embedder turns texts into unit vectors, the vectors live in the tracker
// (table role_vectors, one float32 blob per role and model) and similarity is a plain dot product in memory (no vector
// database: a few thousand 384-dim vectors are a few MB). The real embedder is a small local sentence model run through
// onnxruntime-web (wasm) and exists only when the user installed it (model.ts, `crewdeck jobs search model install`);
// nothing here downloads anything. Tests use a fake Embedder.
import { createHash } from 'node:crypto';
import type { Ctx } from '../ctx.ts';
import type { Db } from '../db.ts';
import type { JobNotes } from '../notes.ts';
import { clip, plainText } from '../text.ts';
import { profileTerms } from './fts.ts';

/** `queryPrefix`: text some models want in front of a search query (the profile, a typed query) but not a document. */
export interface Embedder { id: string; dims: number; embed(texts: string[]): Promise<Float32Array[]>; queryPrefix?: string }

// ---- vectors ----

export const packVec = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const unpackVec = (b: Uint8Array): Float32Array => {
  const c = new Uint8Array(b.byteLength); c.set(b); // a copy: the blob's offset need not be 4-aligned
  return new Float32Array(c.buffer);
};
export const normalise = (v: Float32Array): Float32Array => {
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
/** Cosine similarity (a dot product when both are unit vectors, which stored ones are). */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

// ---- storage ----

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
/** The keys the profile's and a query's own vectors are stored under (role ids are 12 hex characters: no clash). */
export const profileKey = (text: string, model: string) => `profile:${sha(`${model}\n${text}`)}`;
export const queryKey = (q: string, model: string) => `q:${sha(`${model}\n${q.trim().toLowerCase()}`)}`;

export function putVector(db: Db, key: string, model: string, v: Float32Array) {
  db.prepare('insert into role_vectors(role_id, model, vec) values (?,?,?) on conflict(role_id, model) do update set vec=excluded.vec').run(key, model, packVec(v));
}
export function getVector(db: Db, key: string, model: string): Float32Array | null {
  const r = db.prepare('select vec from role_vectors where role_id=? and model=?').get(key, model) as any;
  return r ? unpackVec(r.vec) : null;
}
/** The stored role vectors of a model (for these ids when given). */
export function loadVectors(db: Db, model: string, ids?: string[]): Map<string, Float32Array> {
  const rows = (ids ? db.prepare('select role_id, vec from role_vectors where model=? and role_id in (select value from json_each(?))').all(model, JSON.stringify(ids))
    : db.prepare(`select role_id, vec from role_vectors where model=? and role_id not like 'profile:%' and role_id not like 'q:%'`).all(model)) as any[];
  return new Map(rows.map((r) => [String(r.role_id), unpackVec(r.vec)]));
}
/** Which models have vectors, and how many role vectors each (the status line). */
export function vectorCounts(db: Db): { model: string; roles: number }[] {
  return (db.prepare(`select model, count(*) n from role_vectors where role_id not like 'profile:%' and role_id not like 'q:%' group by model order by model`).all() as any[]).map((r) => ({ model: String(r.model), roles: Number(r.n) }));
}
export function dropVectors(db: Db, model?: string) {
  if (model) db.prepare('delete from role_vectors where model=?').run(model); else db.exec('delete from role_vectors');
}

// ---- what gets embedded ----

/** A role's text for embedding: title, company and the start of the posting in plain words. */
export const roleText = (r: { title: string; company?: string; description?: string }, chars = 1200): string =>
  `${r.title ?? ''}${r.company ? ` at ${r.company}` : ''}\n${clip(plainText(r.description ?? ''), chars)}`.trim();

/**
 * The person as text: their target kinds of job (with titles), their skills and their summary facts from career.md. Same
 * text, same model → same stored vector (profileKey).
 */
export function profileText(notes: Pick<JobNotes, 'search' | 'career'>, chars = 1500): string {
  const s = notes.search.data, c = notes.career.data;
  const kinds = s.roles.targets.map((t) => `${t.name ? `${t.name}: ` : ''}${t.titles.join(', ')}`).filter((x) => x.trim() && x.trim() !== ':');
  const summary = c.sections.filter((x) => x.kind === 'summary').flatMap((x) => c.facts.filter((f) => f.id.startsWith(`${x.id}.`)).map((f) => f.text.replace(/\*\*/g, '')));
  const skills = profileTerms(notes, 40);
  const parts = [kinds.length ? `Looking for: ${kinds.join('; ')}.` : s.roles.titles.length ? `Looking for: ${s.roles.titles.join(', ')}.` : '', summary.length ? `Summary: ${summary.join(' ')}` : '', c.skills.length ? `Skills: ${c.skills.join(', ')}.` : skills.length ? `Terms: ${skills.join(', ')}.` : ''];
  return clip(parts.filter(Boolean).join('\n'), chars);
}

/**
 * Embed the roles that have no vector yet for this model (newest first), at most `limit` per call, and store them.
 * `ids` restricts it (e.g. just the roles that passed the prefilter). Returns what was done.
 */
export async function embedMissing(ctx: Pick<Ctx, 'db'>, embedder: Embedder, o: { limit?: number; ids?: string[]; batch?: number } = {}): Promise<{ embedded: number; remaining: number }> {
  const limit = o.limit ?? 200, batch = o.batch ?? 16;
  const rows = (o.ids
    ? ctx.db.prepare(`select r.id, r.title, c.name company, r.description from roles r join companies c on c.id=r.company_id where r.id in (select value from json_each(?)) and not exists (select 1 from role_vectors v where v.role_id=r.id and v.model=?) order by r.first_seen desc`).all(JSON.stringify(o.ids), embedder.id)
    : ctx.db.prepare(`select r.id, r.title, c.name company, r.description from roles r join companies c on c.id=r.company_id where r.status not in ('prefiltered_out','expired') and not exists (select 1 from role_vectors v where v.role_id=r.id and v.model=?) order by r.first_seen desc`).all(embedder.id)) as any[];
  const todo = rows.slice(0, limit);
  let embedded = 0;
  for (let i = 0; i < todo.length; i += batch) {
    const part = todo.slice(i, i + batch);
    const vecs = await embedder.embed(part.map((r) => roleText(r)));
    ctx.db.exec('BEGIN IMMEDIATE');
    try { part.forEach((r, k) => putVector(ctx.db, String(r.id), embedder.id, normalise(vecs[k]))); ctx.db.exec('COMMIT'); } catch (e) { ctx.db.exec('ROLLBACK'); throw e; }
    embedded += part.length;
  }
  return { embedded, remaining: rows.length - embedded };
}

/** Embed (and store) the profile's vector; returns its key. Cheap: one text. */
export async function ensureProfileVector(ctx: Pick<Ctx, 'db'>, embedder: Embedder, notes: Pick<JobNotes, 'search' | 'career'>): Promise<string | null> {
  const text = profileText(notes);
  if (!text) return null;
  const key = profileKey(text, embedder.id);
  if (!getVector(ctx.db, key, embedder.id)) {
    const [v] = await embedder.embed([(embedder.queryPrefix ?? '') + text]);
    putVector(ctx.db, key, embedder.id, normalise(v));
  }
  return key;
}

// ---- the real embedder: a BERT-style sentence model through onnxruntime-web ----

export type Pooling = 'cls' | 'mean';
/** The bits of onnxruntime-web used here (so tests can pass a fake). */
export type OrtLike = {
  Tensor: new (type: string, data: any, dims: number[]) => any;
  InferenceSession: { create(model: Uint8Array | string, opts?: any): Promise<{ run(feeds: Record<string, any>): Promise<Record<string, { data: Float32Array | number[]; dims: readonly number[] }>>; inputNames: readonly string[]; outputNames: readonly string[] }> };
  env?: any;
};

/** BERT's basic tokenizer + WordPiece, from the model's vocab.txt (uncased: the models proposed here are). */
export class WordPiece {
  readonly vocab: Map<string, number>;
  private unk: number; private cls: number; private sep: number; private pad: number;
  readonly lower: boolean;
  constructor(vocabText: string, lower = true) {
    this.lower = lower;
    const lines = vocabText.split('\n').map((t) => t.replace(/\r$/, ''));
    if (lines[lines.length - 1] === '') lines.pop();
    this.vocab = new Map(lines.map((t, i) => [t, i]));
    const id = (t: string) => { const v = this.vocab.get(t); if (v === undefined) throw new Error(`vocab.txt has no ${t}`); return v; };
    this.unk = id('[UNK]'); this.cls = id('[CLS]'); this.sep = id('[SEP]'); this.pad = id('[PAD]');
  }
  private basic(text: string): string[] {
    let t = text.normalize('NFC').replace(/[\u0000�]/g, '').replace(/\s+/g, ' ');
    if (this.lower) t = t.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
    // punctuation and CJK characters are tokens of their own
    t = t.replace(/([\p{P}\p{S}]|[一-鿿㐀-䶿])/gu, ' $1 ');
    return t.split(' ').filter(Boolean);
  }
  private piece(word: string): number[] {
    if (word.length > 100) return [this.unk];
    const out: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length, hit: number | undefined;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + word.slice(start, end);
        const v = this.vocab.get(sub);
        if (v !== undefined) { hit = v; break; }
        end--;
      }
      if (hit === undefined) return [this.unk];
      out.push(hit);
      start = end;
    }
    return out;
  }
  /** [CLS] pieces… [SEP], cut to maxLen. */
  encode(text: string, maxLen = 256): number[] {
    const ids: number[] = [];
    for (const w of this.basic(text)) { for (const p of this.piece(w)) ids.push(p); if (ids.length >= maxLen - 2) break; }
    return [this.cls, ...ids.slice(0, maxLen - 2), this.sep];
  }
  get padId() { return this.pad; }
}

/** Mean/CLS pooling of a [batch, tokens, dims] output, then unit length. */
export function pool(data: ArrayLike<number>, batch: number, tokens: number, dims: number, mask: number[][], how: Pooling): Float32Array[] {
  const out: Float32Array[] = [];
  for (let b = 0; b < batch; b++) {
    const v = new Float32Array(dims);
    if (how === 'cls') for (let d = 0; d < dims; d++) v[d] = data[b * tokens * dims + d];
    else {
      let n = 0;
      for (let t = 0; t < tokens; t++) if (mask[b][t]) { n++; for (let d = 0; d < dims; d++) v[d] += data[(b * tokens + t) * dims + d]; }
      for (let d = 0; d < dims; d++) v[d] /= n || 1;
    }
    out.push(normalise(v));
  }
  return out;
}

export type OnnxOptions = { id: string; dims: number; pooling: Pooling; maxLen?: number; batch?: number; queryPrefix?: string };

/** An Embedder over an ONNX sentence model (bytes), its vocab.txt and an onnxruntime-web module. Texts are embedded as documents. */
export async function onnxEmbedder(ort: OrtLike, modelBytes: Uint8Array, vocabText: string, o: OnnxOptions): Promise<Embedder> {
  try { if (ort.env?.wasm) { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; } } catch { /* optional */ }
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const tok = new WordPiece(vocabText), maxLen = o.maxLen ?? 256, batchSize = o.batch ?? 8;
  const wantsTypes = session.inputNames.includes('token_type_ids');
  return {
    id: o.id, dims: o.dims, queryPrefix: o.queryPrefix,
    async embed(texts: string[]) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const enc = texts.slice(i, i + batchSize).map((t) => tok.encode(t, maxLen));
        const T = Math.max(...enc.map((e) => e.length)), B = enc.length;
        const ids = new BigInt64Array(B * T).fill(BigInt(tok.padId)), mask = new BigInt64Array(B * T), types = new BigInt64Array(B * T);
        const m: number[][] = [];
        enc.forEach((e, b) => { m.push(Array.from({ length: T }, (_, t) => (t < e.length ? 1 : 0))); e.forEach((x, t) => { ids[b * T + t] = BigInt(x); mask[b * T + t] = 1n; }); });
        const feeds: Record<string, any> = { input_ids: new ort.Tensor('int64', ids, [B, T]), attention_mask: new ort.Tensor('int64', mask, [B, T]) };
        if (wantsTypes) feeds.token_type_ids = new ort.Tensor('int64', types, [B, T]);
        const res = await session.run(feeds);
        const first = res.last_hidden_state ?? res[session.outputNames[0]];
        out.push(...pool(first.data, B, T, o.dims, m, o.pooling));
      }
      return out;
    },
  };
}
