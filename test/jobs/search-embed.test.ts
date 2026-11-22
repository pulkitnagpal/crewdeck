// Embeddings and the model install: fake embedder, fake fetch, fake npm, fake onnxruntime. Nothing downloads, ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notesOf } from '../../src/jobs/ctx.ts';
import { type OrtLike, WordPiece, cosine, dropVectors, embedMissing, ensureProfileVector, getVector, loadVectors, normalise, onnxEmbedder, packVec, pool, profileKey, profileText, putVector, roleText, unpackVec, vectorCounts } from '../../src/jobs/search/embed.ts';
import { BGE_SMALL, type ModelSpec, installModel, installPlan, loadInstalledEmbedder, modelStatus, removeModel, verifyModel } from '../../src/jobs/search/model.ts';
import { embedNewRoles } from '../../src/jobs/search/run.ts';
import { jobs, tempSetup } from './helpers.ts';
import { engineerWorld, fakeEmbedder, role } from './search-helpers.ts';

test('vectors: pack/unpack round trip (unaligned blobs too), cosine, normalise', () => {
  const v = normalise(new Float32Array([3, 4, 0]));
  assert.deepEqual([...unpackVec(packVec(v))], [...v]);
  const shifted = new Uint8Array(packVec(v).length + 1); shifted.set(packVec(v), 1);
  assert.deepEqual([...unpackVec(shifted.subarray(1))], [...v], 'a blob at an odd offset');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(cosine(new Float32Array(2), v), 0);
});

test('embedMissing: newest first, capped per call, only the ids asked for, never twice; vectors per model', async () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: 'Go and Kubernetes' });
  const b = role(w.ctx, { company: 'B Co', title: 'Android Engineer', description: 'Kotlin' });
  const c = role(w.ctx, { company: 'C Co', title: 'Designer', description: 'Figma' });
  w.ctx.db.prepare(`update roles set first_seen=? where id=?`).run('2026-11-10T00:00:00.000Z', a);
  w.ctx.db.prepare(`update roles set first_seen=? where id=?`).run('2026-11-12T00:00:00.000Z', b);
  w.ctx.db.prepare(`update roles set first_seen=? where id=?`).run('2026-11-11T00:00:00.000Z', c);
  const e = fakeEmbedder();
  assert.deepEqual(await embedMissing(w.ctx, e, { limit: 2 }), { embedded: 2, remaining: 1 });
  assert.deepEqual([...loadVectors(w.ctx.db, e.id)].map(([id]) => id).sort(), [b, c].sort(), 'the two newest');
  assert.deepEqual(await embedMissing(w.ctx, e, { ids: [a, b] }), { embedded: 1, remaining: 0 });
  assert.deepEqual(await embedMissing(w.ctx, e), { embedded: 0, remaining: 0 });
  assert.deepEqual(vectorCounts(w.ctx.db), [{ model: e.id, roles: 3 }]);
  const other = fakeEmbedder('other-model');
  await embedMissing(w.ctx, other, { ids: [a] });
  assert.equal(loadVectors(w.ctx.db, other.id).size, 1, 'a second model keeps its own vectors');
  dropVectors(w.ctx.db, e.id);
  assert.deepEqual(vectorCounts(w.ctx.db), [{ model: 'other-model', roles: 1 }]);
  assert.match(roleText({ title: 'T', company: 'C', description: '<p>x &amp; y</p>' }), /^T at C\nx & y$/);
});

test('the profile vector: made once from career.md + targets, keyed by its text and the model, never listed as a role', async () => {
  const w = engineerWorld();
  const notes = notesOf(w.ctx), e = fakeEmbedder();
  const text = profileText(notes);
  assert.match(text, /backend engineer, platform engineer, ai engineer/);
  assert.match(text, /Kubernetes clusters/, 'the summary fact from career.md');
  const key = await ensureProfileVector(w.ctx, e, notes);
  assert.equal(key, profileKey(text, e.id));
  assert.equal(getVector(w.ctx.db, key!, e.id)!.length, e.dims);
  await ensureProfileVector(w.ctx, e, notes);
  assert.equal(e.calls.length, 1, 'not embedded twice');
  assert.equal(loadVectors(w.ctx.db, e.id).size, 0);
  assert.deepEqual(vectorCounts(w.ctx.db), []);
});

test('embedNewRoles (the sources run step): only roles still waiting, capped, a no-op without a model, never throws', async () => {
  const w = engineerWorld();
  const a = role(w.ctx, { company: 'A Co', title: 'Backend Engineer', description: 'Go' });
  const b = role(w.ctx, { company: 'B Co', title: 'Platform Engineer', description: 'Kubernetes' });
  role(w.ctx, { company: 'C Co', title: 'Dropped', description: 'x' }, 'prefiltered_out');
  const none = await embedNewRoles(w.ctx);
  assert.equal(none.ran, false);
  assert.match(none.why!, /not installed/);
  const e = fakeEmbedder();
  const r = await embedNewRoles(w.ctx, { embedder: e, cap: 1 });
  assert.deepEqual([r.ran, r.embedded, r.remaining], [true, 1, 1]);
  assert.equal(loadVectors(w.ctx.db, e.id).size, 1);
  await embedNewRoles(w.ctx, { embedder: e });
  assert.deepEqual([...loadVectors(w.ctx.db, e.id).keys()].sort(), [a, b].sort(), 'prefiltered-out roles get none');
  const broken = await embedNewRoles(w.ctx, { embedder: { id: 'boom', dims: 1, embed: async () => { throw new Error('model crashed'); } } });
  assert.deepEqual([broken.ran, broken.why], [false, 'model crashed']);
});

// ---- the real embedder's parts, against a tiny vocab and a fake onnxruntime ----

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'back', '##end', 'engineer', 'go', ',', '(', ')', 'zurich', 'un', '##aff', '##able'].join('\n') + '\n';

test('WordPiece: lower-casing, accents, punctuation as tokens, greedy word pieces, unknown words, truncation', () => {
  const t = new WordPiece(VOCAB);
  const piece = (s: string, n = 256) => t.encode(s, n).map((i) => [...t.vocab].find(([, v]) => v === i)![0]);
  assert.deepEqual(piece('Backend Engineer'), ['[CLS]', 'back', '##end', 'engineer', '[SEP]']);
  assert.deepEqual(piece('Zürich, Go (ENGINEER)'), ['[CLS]', 'zurich', ',', 'go', '(', 'engineer', ')', '[SEP]']);
  assert.deepEqual(piece('unaffable'), ['[CLS]', 'un', '##aff', '##able', '[SEP]']);
  assert.deepEqual(piece('kubernetes'), ['[CLS]', '[UNK]', '[SEP]']);
  assert.equal(t.encode('go '.repeat(500), 16).length, 16);
  assert.equal(t.encode('', 16).length, 2);
  assert.throws(() => new WordPiece('a\nb\n'), /no \[UNK\]/);
});

test('pool: CLS or masked mean, unit length', () => {
  // batch 2, tokens 3, dims 2; the second text has one padded token
  const data = [1, 0, 0, 1, 9, 9, /**/ 0, 2, 2, 0, 7, 7];
  const mask = [[1, 1, 1], [1, 1, 0]];
  const cls = pool(data, 2, 3, 2, mask, 'cls');
  assert.deepEqual([...cls[0]], [1, 0]);
  assert.deepEqual([...cls[1]], [0, 1]);
  const mean = pool(data, 2, 3, 2, mask, 'mean');
  assert.ok(Math.abs(mean[1][0] - Math.SQRT1_2) < 1e-6 && Math.abs(mean[1][1] - Math.SQRT1_2) < 1e-6, 'the padded token is ignored');
});

test('onnxEmbedder: int64 inputs padded per batch, token_type_ids only when the model has them, pooled to unit vectors', async () => {
  const seen: any[] = [];
  class Tensor { type: string; data: any; dims: number[]; constructor(type: string, data: any, dims: number[]) { this.type = type; this.data = data; this.dims = dims; } }
  const ort: OrtLike = {
    Tensor: Tensor as any,
    InferenceSession: { create: async () => ({ inputNames: ['input_ids', 'attention_mask', 'token_type_ids'], outputNames: ['last_hidden_state'],
      run: async (feeds: any) => { seen.push(feeds); const [B, T] = feeds.input_ids.dims; return { last_hidden_state: { data: new Float32Array(B * T * 2).map((_, i) => (i % 2 ? 1 : 3)), dims: [B, T, 2] } }; } }) },
  };
  const e = await onnxEmbedder(ort, new Uint8Array(1), VOCAB, { id: 'tiny', dims: 2, pooling: 'cls', batch: 2, queryPrefix: 'q: ' });
  const out = await e.embed(['Backend Engineer', 'go', 'Go Go Go']);
  assert.equal(out.length, 3);
  assert.equal(seen.length, 2, 'batches of two');
  assert.deepEqual(seen[0].input_ids.dims, [2, 5], 'padded to the longest text in the batch');
  assert.ok(seen[0].input_ids.data instanceof BigInt64Array);
  assert.deepEqual([...seen[0].attention_mask.data].map(Number), [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  assert.ok(seen[0].token_type_ids);
  assert.ok(Math.abs(cosine(out[0], out[0]) - 1) < 1e-6);
  assert.equal(e.queryPrefix, 'q: ');
});

// ---- install: the plan, the consent, the checks (no network: fetch and npm are fakes) ----

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const MODEL_BYTES = Buffer.from('not a real model, 24 bytes');
const VOCAB_BYTES = Buffer.from(VOCAB);
const blob = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const SPEC: ModelSpec = {
  ...BGE_SMALL, id: 'fake-model-int8', dims: 2, pooling: 'cls',
  files: [{ url: 'https://models.example.test/m/model.onnx', as: 'model.onnx', bytes: MODEL_BYTES.length, sha256: sha(MODEL_BYTES) }, { url: 'https://models.example.test/m/vocab.txt', as: 'vocab.txt', bytes: VOCAB_BYTES.length, gitBlob: blob(VOCAB_BYTES) }],
};
const fakeFetch = (bodies: Record<string, Buffer>, log: string[] = []) => (async (url: any) => {
  log.push(String(url));
  const b = bodies[String(url)];
  return b ? new Response(b, { status: 200, headers: { 'content-length': String(b.length) } }) : new Response('nope', { status: 404 });
}) as typeof fetch;
const homeDir = () => mkdtempSync(join(tmpdir(), 'cd-model-'));

test('the real model: pinned source, files with sizes and hashes, a plan that says what will happen', () => {
  assert.equal(BGE_SMALL.files[0].bytes, 34_014_426);
  assert.match(BGE_SMALL.files[0].url, /^https:\/\/huggingface\.co\/Xenova\/bge-small-en-v1\.5\/resolve\/[0-9a-f]{40}\/onnx\/model_quantized\.onnx$/, 'pinned to one revision');
  assert.match(BGE_SMALL.files[0].sha256!, /^[0-9a-f]{64}$/);
  assert.match(BGE_SMALL.runtime.integrity, /^sha512-/);
  assert.equal(BGE_SMALL.runtime.version, '1.22.0');
  const plan = installPlan().join('\n');
  for (const must of [BGE_SMALL.files[0].url, BGE_SMALL.files[1].url, '32.4 MB', 'onnxruntime-web@1.22.0', 'never sent anywhere']) assert.ok(plan.includes(must), must);
});

test('install: refused without a yes (nothing fetched, nothing written); then downloads, checks every hash, records, installs the runtime', async () => {
  const home = homeDir();
  const log: string[] = [];
  const f = fakeFetch({ [SPEC.files[0].url]: MODEL_BYTES, [SPEC.files[1].url]: VOCAB_BYTES }, log);
  await assert.rejects(installModel(home, { fetch: f, confirm: async () => false, npmInstall: async () => { throw new Error('no'); } }, SPEC), /Not installed: nothing was downloaded/);
  assert.deepEqual(log, []);
  assert.equal(existsSync(join(home, 'models')), false);
  let npm = 0;
  const shown: string[][] = [];
  const st = await installModel(home, { fetch: f, confirm: async (p) => { shown.push(p); return true; },
    npmInstall: async (dir, rt) => { npm++; mkdirSync(join(dir, 'node_modules', rt.package), { recursive: true }); writeFileSync(join(dir, 'node_modules', rt.package, 'package.json'), '{}'); } }, SPEC);
  assert.equal(shown.length, 1);
  assert.ok(shown[0].join('\n').includes('https://models.example.test/m/model.onnx'));
  assert.deepEqual([st.installed, st.model_files, st.runtime, npm], [true, true, true, 1]);
  assert.deepEqual(log, SPEC.files.map((x) => x.url));
  assert.equal(modelStatus(home, SPEC).installed, true);
  assert.deepEqual(verifyModel(home, SPEC), { ok: true, bad: [] });
  // a second install finds the verified files and the runtime, and fetches nothing
  await installModel(home, { fetch: f, confirm: async () => true, npmInstall: async () => { throw new Error('again'); } }, SPEC);
  assert.equal(log.length, 2);
  // tampering is caught by verify
  writeFileSync(join(home, 'models', SPEC.id, 'vocab.txt'), 'changed');
  assert.deepEqual(verifyModel(home, SPEC), { ok: false, bad: ['vocab.txt: hash mismatch'] });
});

test('install refuses a file whose hash or size is not the pinned one, an http URL, a redirect off https; keeps nothing', async () => {
  const home = homeDir();
  const bad = Buffer.from('not a real model, 24 BYTES');
  const deps = (fetch: typeof globalThis.fetch) => ({ fetch, confirm: async () => true, npmInstall: async () => { throw new Error('runtime must not install after a refusal'); } });
  await assert.rejects(installModel(home, deps(fakeFetch({ [SPEC.files[0].url]: bad, [SPEC.files[1].url]: VOCAB_BYTES })), SPEC), /model\.onnx: size or hash does not match the pinned one/);
  assert.equal(existsSync(join(home, 'models', SPEC.id, 'model.onnx')), false);
  assert.equal(existsSync(join(home, 'models', SPEC.id, 'model.onnx.part')), false);
  assert.equal(modelStatus(home, SPEC).installed, false);
  await assert.rejects(installModel(home, deps(fakeFetch({ [SPEC.files[0].url]: Buffer.concat([MODEL_BYTES, Buffer.alloc(2_000_000)]) })), SPEC), /expected|more than/);
  await assert.rejects(installModel(home, deps(fakeFetch({})), SPEC), /HTTP 404/);
  const httpSpec = { ...SPEC, files: [{ ...SPEC.files[0], url: 'http://models.example.test/m/model.onnx' }, SPEC.files[1]] };
  await assert.rejects(installModel(home, deps(fakeFetch({})), httpSpec), /only https/);
  const redirected = (async () => Object.defineProperty(new Response(MODEL_BYTES), 'url', { value: 'http://evil.example.test/x' })) as unknown as typeof fetch;
  await assert.rejects(installModel(home, deps(redirected), SPEC), /redirected off https/);
});

test('remove deletes the model, the runtime and (with the caller) the vectors; the embedder loads only when installed', async () => {
  const home = homeDir();
  assert.equal(await loadInstalledEmbedder(home, SPEC), null, 'not installed: null, no download');
  mkdirSync(join(home, 'models', SPEC.id), { recursive: true });
  writeFileSync(join(home, 'models', SPEC.id, 'model.onnx'), MODEL_BYTES);
  assert.equal(modelStatus(home, SPEC).installed, false);
  assert.match(modelStatus(home, SPEC).message, /not installed|half installed/);
  assert.equal(removeModel(home, SPEC), true);
  assert.equal(removeModel(home, SPEC), false);
  assert.equal(existsSync(join(home, 'models', SPEC.id)), false);
});

test('CLI: model install from an agent shell (no terminal) is refused before anything is fetched; status and hybrid work', () => {
  const s = tempSetup('berlin-analyst');
  const r = jobs(s.home, ['search', 'model', 'install'], 'y\n');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Only you can install the model/);
  assert.equal(existsSync(join(s.jobsHome, 'models')), false, 'nothing was created');
  const st = jobs(s.home, ['search', 'model', 'status']);
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /bge-small-en-v1\.5-int8: not installed/);
  assert.match(jobs(s.home, ['search', 'hybrid']).out, /hybrid ranking: (on|off)/);
  assert.match(jobs(s.home, ['search', 'hybrid', 'off']).out, /off/);
  assert.equal(JSON.parse(readFileSync(join(s.jobsHome, 'state', 'search.json'), 'utf8')).hybrid, false);
  assert.match(jobs(s.home, ['search', 'model', 'remove']).out, /Nothing was installed/);
});
