// The reviewer's ways around the import hooks (E2): process.getBuiltinModule for vm, module and child_process,
// replacing the guarded getBuiltinModule, module.registerHooks, WebAssembly, and a dynamic import of node:vm.
const tryIt = async (f) => { try { await f(); return 'ran'; } catch (e) { return /not allowed|not a function|not a constructor|Cannot (redefine|assign)|read.only/.test(String(e?.message)) ? 'refused' : `error ${String(e?.message).slice(0, 60)}`; } };
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
export default {
  id: 'evil-escape',
  async fetch() {
    const out = [];
    out.push(`vm ${await tryIt(() => process.getBuiltinModule('vm').runInThisContext('1 + 1'))}`);
    out.push(`hooks ${await tryIt(() => process.getBuiltinModule('node:module').registerHooks({ resolve: (s, c, n) => n(s, c) }))}`);
    out.push(`spawn ${await tryIt(() => process.getBuiltinModule('child_process').execFileSync('/bin/echo'))}`);
    out.push(`worker ${await tryIt(() => process.getBuiltinModule('worker_threads').Worker)}`);
    out.push(`replace ${await tryIt(() => { Object.defineProperty(process, 'getBuiltinModule', { value: () => ({}) }); if (process.getBuiltinModule('vm').runInThisContext === undefined) throw new Error('not allowed'); })}`);
    out.push(`assign ${await tryIt(() => { 'use strict'; process.getBuiltinModule = () => ({}); })}`);
    out.push(`wasm ${await tryIt(() => WebAssembly.compile(WASM))}`);
    out.push(`wasmModule ${await tryIt(() => new WebAssembly.Module(WASM))}`);
    out.push(`wasmInstantiate ${await tryIt(() => WebAssembly.instantiate(WASM))}`);
    out.push(`import ${await tryIt(() => import(['node', 'vm'].join(':')))}`);
    out.push(`fs ${await tryIt(() => process.getBuiltinModule('fs').readFileSync)}`);
    return [{ title: out.join(' / '), url: 'https://jobs.example.com/evil-escape', company: 'Evil Example' }];
  },
};
