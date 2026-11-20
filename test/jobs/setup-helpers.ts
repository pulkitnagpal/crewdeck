// The commands the jobs-setup skill runs, as helpers for scripted setups on a temp home (setup v2, P9f) and the persona
// journeys (P9i): values and the user's words always come from files, like the skill's <T>. Everything is fictional.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { jobs, tempSetup, textFile } from './helpers.ts';
import { splitNote } from '../../src/jobs/notes.ts';

export type Persona = ReturnType<typeof tempSetup> & { n: number };

export function start(): Persona { return { ...tempSetup('template'), n: 0 }; }
/** One command as the skill runs it; values and the user's words come from files. */
export function ok(p: Persona, args: string[]) {
  const r = jobs(p.home, args);
  assert.equal(r.code, 0, `crewdeck jobs ${args.join(' ')}\n${r.err}${r.out}`);
  return r.out;
}
export const file = (p: Persona, text: string) => textFile(p.root, `v${++p.n}.txt`, text);
export const me = (p: Persona, path: string, value: string) => ok(p, ['me', 'set', path, '--value-file', file(p, value)]);
export const pref = (p: Persona, path: string, value: string, words: string) => ok(p, ['pref', 'set', path, '--value-file', file(p, value), '--because-file', file(p, words)]);
/** A pasted posting (add-role); returns its role id. */
export function posting(p: Persona, r: { title: string; company: string; location: string; pay_text?: string; description?: string }): string {
  const f = textFile(p.root, `role${++p.n}.json`, JSON.stringify({ url: `https://jobs.example.com/${encodeURIComponent(r.company)}/${p.n}`, source: 'pasted', description: '', ...r }));
  return /: ([a-f0-9]{12})$/m.exec(ok(p, ['add-role', '--role-file', f]))![1];
}
export const preview = (p: Persona, change?: string) => JSON.parse(ok(p, ['preview', '--json', ...(change ? ['--search-file', file(p, change)] : [])]));
export const search = (p: Persona) => parse(splitNote(readFileSync(join(p.vault, 'jobs', 'search.md'), 'utf8')).front!);
export const sources = (p: Persona) => readFileSync(join(p.vault, 'jobs', 'sources.md'), 'utf8');

/** The end of every setup: a clean check and each target passing at least one posting. */
export function finish(p: Persona, targets: string[]) {
  const check = jobs(p.home, ['check']);
  assert.equal(check.code, 0, check.out + check.err);
  assert.doesNotMatch(check.out, /✗/, check.out);
  assert.match(check.out, /^0 errors, 0 warnings$/m, check.out);
  const pv = preview(p);
  assert.deepEqual(pv.by_target.map((t: any) => t.name), targets);
  for (const t of pv.by_target) assert.ok(t.pass >= 1, `${t.name}: ${t.pass} pass\n${JSON.stringify(pv, null, 1)}`);
  return pv;
}

/** Setup's fetch step on a fresh home: it says plainly why nothing ran (no providers, or Node < 25), never crashes. */
export function fetchOnce(p: Persona) {
  const r = jobs(p.home, ['source', '--only-new-sources']);
  assert.ok(r.code === 0 || r.code === 1, r.err);
  assert.match(r.out + r.err, /not installed|Node 25|no new sources|LinkedIn search is off/i);
}
