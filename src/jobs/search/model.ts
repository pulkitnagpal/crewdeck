// The local embedding model: where it lives, what installing it means, and loading it. Nothing here runs unless the
// person runs `crewdeck jobs search model install` themselves (in a terminal, answering y/N after the exact source URLs,
// file names and sizes are printed). Layout, all under jobs.home (0700):
//   models/<id>/model.onnx, vocab.txt, manifest.json     the sentence model (every file checked against a pinned hash)
//   models/runtime/node_modules/onnxruntime-web          the wasm runtime that runs it (npm, scripts off, pinned + integrity-checked)
// Tests never touch the network: install takes injectable fetch / npm / confirm.
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Embedder, type OrtLike, onnxEmbedder } from './embed.ts';

export type ModelFile = { url: string; as: string; bytes: number; /** sha256 of the file (LFS files) */ sha256?: string; /** git blob id (small files) */ gitBlob?: string };
export type ModelSpec = {
  id: string; title: string; license: string; dims: number; pooling: 'cls' | 'mean'; maxLen: number; queryPrefix?: string;
  files: ModelFile[];
  runtime: { package: string; version: string; integrity: string; approxMB: number };
};

const REV = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
const BASE = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${REV}`;
/**
 * BAAI bge-small-en-v1.5 (MIT), the ONNX export by Xenova, int8-quantised: 384 dimensions, ~34 MB, English. Pinned to one
 * revision of the repo and to each file's hash (LFS sha256 from the Hub's file listing; git blob id for the small vocab).
 */
export const BGE_SMALL: ModelSpec = {
  id: 'bge-small-en-v1.5-int8', title: 'bge-small-en-v1.5 (int8 ONNX, Xenova export)', license: 'MIT', dims: 384, pooling: 'cls', maxLen: 256,
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  files: [
    { url: `${BASE}/onnx/model_quantized.onnx`, as: 'model.onnx', bytes: 34_014_426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
    { url: `${BASE}/vocab.txt`, as: 'vocab.txt', bytes: 231_508, gitBlob: 'fb140275c155a9c7c5a3b3e0e77a9e839594a938' },
  ],
  runtime: { package: 'onnxruntime-web', version: '1.22.0', integrity: 'sha512-Ud/+EBo6mhuaQWt/OjaOk0iNWjXqJoeeMFr6xQEERZdIZH2OWpGzuujz7lfuOBjUa6TEE/sc4nb7Da5dNL34fg==', approxMB: 94 },
};

export const modelsRoot = (home: string) => join(home, 'models');
export const modelDir = (home: string, spec: ModelSpec = BGE_SMALL) => join(modelsRoot(home), spec.id);
export const runtimeDir = (home: string) => join(modelsRoot(home), 'runtime');
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const gitBlobId = (b: Uint8Array) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const fileOk = (f: ModelFile, bytes: Uint8Array) => bytes.length === f.bytes && (f.sha256 ? sha256(bytes) === f.sha256 : f.gitBlob ? gitBlobId(bytes) === f.gitBlob : false);

/** What `model install` prints before asking: source, files, sizes, runtime. */
export function installPlan(spec: ModelSpec = BGE_SMALL): string[] {
  const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
  const total = spec.files.reduce((n, f) => n + f.bytes, 0);
  return [
    `Model: ${spec.title}  (license ${spec.license}, ${spec.dims} dimensions)`,
    'Downloads (https, each checked against a pinned hash before it is kept):',
    ...spec.files.map((f) => `  ${f.url}\n    -> models/${spec.id}/${f.as}  (${mb(f.bytes)}, ${f.sha256 ? `sha256 ${f.sha256.slice(0, 12)}…` : `git blob ${f.gitBlob?.slice(0, 12)}…`})`),
    `  total ${mb(total)}`,
    `Runtime: npm package ${spec.runtime.package}@${spec.runtime.version} (about ${spec.runtime.approxMB} MB unpacked; installed with npm scripts off into models/runtime, integrity pinned)`,
    'Everything stays on this machine: the model runs locally; job text is never sent anywhere.',
  ];
}

// ---- status ----

export type ModelStatus = { id: string; installed: boolean; model_files: boolean; runtime: boolean; dir: string; installed_at?: string; message: string };
export function modelStatus(home: string, spec: ModelSpec = BGE_SMALL): ModelStatus {
  const dir = modelDir(home, spec);
  const files = spec.files.every((f) => existsSync(join(dir, f.as))) && existsSync(join(dir, 'manifest.json'));
  const rt = existsSync(join(runtimeDir(home), 'node_modules', spec.runtime.package, 'package.json'));
  let installed_at: string | undefined;
  try { installed_at = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).installed_at; } catch { /* none */ }
  const message = files && rt ? `installed (${spec.id})` : files || rt ? `half installed: ${files ? 'runtime missing' : 'model files missing'}; run: crewdeck jobs search model install` : 'not installed (hybrid ranking uses titles and keywords only); to add meaning-based matching: crewdeck jobs search model install';
  return { id: spec.id, installed: files && rt, model_files: files, runtime: rt, dir, installed_at, message };
}

/** Every installed file against its pinned hash (a re-check; `model status --verify`). */
export function verifyModel(home: string, spec: ModelSpec = BGE_SMALL): { ok: boolean; bad: string[] } {
  const bad: string[] = [];
  for (const f of spec.files) {
    try { if (!fileOk(f, readFileSync(join(modelDir(home, spec), f.as)))) bad.push(`${f.as}: hash mismatch`); } catch { bad.push(`${f.as}: missing`); }
  }
  return { ok: !bad.length, bad };
}

// ---- install / remove ----

export type InstallDeps = {
  /** fetch (Node's by default) */ fetch?: typeof fetch;
  /** installs the runtime npm package into models/runtime (npm by default) */ npmInstall?: (dir: string, spec: ModelSpec['runtime']) => Promise<void>;
  /** a person's yes (only ever true at a keyboard) */ confirm: (plan: string[]) => Promise<boolean>;
  say?: (s: string) => void;
};

async function npmInstall(dir: string, rt: ModelSpec['runtime']): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'crewdeck-search-runtime', private: true, version: '0.0.0', dependencies: { [rt.package]: rt.version } }, null, 2));
  const npm = existsSync(join(dirname(process.execPath), 'npm')) ? join(dirname(process.execPath), 'npm') : 'npm';
  await new Promise<void>((ok, bad) => execFile(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--prefix', dir], { timeout: 600_000, env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` } },
    (e, _o, err) => (e ? bad(new Error(`npm install failed: ${String(err || e.message).slice(0, 300)}`)) : ok())));
  // npm checked the registry's integrity for the package it fetched; this pins the one we expect.
  const lock = JSON.parse(readFileSync(join(dir, 'node_modules', '.package-lock.json'), 'utf8'));
  const got = lock.packages?.[`node_modules/${rt.package}`];
  if (got?.version !== rt.version || got?.integrity !== rt.integrity) throw new Error(`${rt.package}: npm gave ${got?.version} ${String(got?.integrity).slice(0, 20)}…, not the pinned ${rt.version}: refused`);
}

async function download(f: ModelFile, to: string, fetchFn: typeof fetch) {
  if (!f.url.startsWith('https://')) throw new Error(`${f.url}: only https`);
  const r = await fetchFn(f.url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`${f.as}: download failed (HTTP ${r.status})`);
  if (r.url && !r.url.startsWith('https://')) throw new Error(`${f.as}: redirected off https: refused`);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > f.bytes + 1_048_576) throw new Error(`${f.as}: server says ${len} bytes, expected ${f.bytes}: refused`);
  let seen = 0;
  const cap = f.bytes + 1_048_576;
  const body = Readable.fromWeb(r.body as any);
  body.on('data', (c: Buffer) => { seen += c.length; if (seen > cap) body.destroy(new Error(`${f.as}: more than the expected ${f.bytes} bytes: refused`)); });
  await pipeline(body, createWriteStream(to, { mode: 0o600 }));
}

/** Install: print the plan, ask, download each file to a temp name, check size and hash, rename; then the runtime. */
export async function installModel(home: string, deps: InstallDeps, spec: ModelSpec = BGE_SMALL): Promise<ModelStatus> {
  if (!MODEL_ID.test(spec.id)) throw new Error('bad model id');
  const say = deps.say ?? (() => {});
  const plan = installPlan(spec);
  if (!(await deps.confirm(plan))) throw new Error('Not installed: nothing was downloaded.');
  const dir = modelDir(home, spec);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fetchFn = deps.fetch ?? fetch;
  for (const f of spec.files) {
    if (existsSync(join(dir, f.as)) && fileOk(f, readFileSync(join(dir, f.as)))) { say(`  ${f.as}: already there and verified`); continue; }
    const tmp = join(dir, `${f.as}.part`);
    say(`  downloading ${f.as} …`);
    try { await download(f, tmp, fetchFn); } catch (e) { rmSync(tmp, { force: true }); throw e; }
    if (!fileOk(f, readFileSync(tmp))) { rmSync(tmp, { force: true }); throw new Error(`${f.as}: size or hash does not match the pinned one: refused, nothing kept`); }
    renameSync(tmp, join(dir, f.as));
    chmodSync(join(dir, f.as), 0o600);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: spec.id, installed_at: new Date().toISOString(), files: spec.files.map((f) => ({ as: f.as, bytes: f.bytes, sha256: f.sha256, gitBlob: f.gitBlob })), source: BASE }, null, 2), { mode: 0o600 });
  if (!existsSync(join(runtimeDir(home), 'node_modules', spec.runtime.package, 'package.json'))) {
    say(`  installing ${spec.runtime.package}@${spec.runtime.version} …`);
    await (deps.npmInstall ?? npmInstall)(runtimeDir(home), spec.runtime);
  }
  return modelStatus(home, spec);
}

/** Remove the model, the runtime and every vector made by it (the caller drops the vectors from the tracker). */
export function removeModel(home: string, spec: ModelSpec = BGE_SMALL): boolean {
  const had = existsSync(modelDir(home, spec)) || existsSync(runtimeDir(home));
  rmSync(modelDir(home, spec), { recursive: true, force: true });
  rmSync(runtimeDir(home), { recursive: true, force: true });
  return had;
}

// ---- loading ----

const loaded = new Map<string, Promise<Embedder>>();
/** The installed model as an Embedder, loaded on first use; null when it isn't installed (never downloads anything). */
export async function loadInstalledEmbedder(home: string, spec: ModelSpec = BGE_SMALL): Promise<Embedder | null> {
  if (!modelStatus(home, spec).installed) return null;
  const key = `${home}\0${spec.id}`;
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      const ort = createRequire(join(runtimeDir(home), 'package.json'))(spec.runtime.package) as OrtLike;
      const dir = modelDir(home, spec);
      return onnxEmbedder(ort, readFileSync(join(dir, 'model.onnx')), readFileSync(join(dir, 'vocab.txt'), 'utf8'), { id: spec.id, dims: spec.dims, pooling: spec.pooling, maxLen: spec.maxLen, queryPrefix: spec.queryPrefix });
    })();
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return p;
}
