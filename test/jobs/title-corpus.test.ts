// The title corpus (design §24.5, P9c exit check): nine fictional people from the audit, each with the targets and
// variants setup would propose, and ≥ 400 posting titles with the expected outcome of the title rules. Also the v1
// promise: the same words as roles.titles pass everything the old phrase gate passed, never fewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { compileRules, prefilter } from '../../src/jobs/rules.ts';
import { normalise } from '../../src/jobs/schema.ts';
import { plain } from '../../src/jobs/places.ts';
import { REPO } from './helpers.ts';

type Persona = { who: string; search: any; v1: string[]; audit: { passes: string[]; dropped: string[] }; pass: string[]; fail: string[] };
const CORPUS: Record<string, Persona> = parse(readFileSync(join(REPO, 'test', 'fixtures', 'jobs', 'title-corpus.yaml'), 'utf8'));
const TITLE_RULES = ['title_gate', 'title_exclude', 'level'];
const compiled = (search: any) => compileRules({ search: { data: normalise.search(search) } as any, memory: { data: { items: [] } } as any });
const split = (e: string) => { const [title, rule] = e.split(' | '); return { title: title.trim(), rule: rule?.trim() }; };
const all = Object.values(CORPUS).flatMap((p) => [...p.audit.passes, ...p.audit.dropped, ...p.pass, ...p.fail.map((f) => split(f).title)]);

test('the corpus has at least 400 titles across the nine people', () => {
  assert.deepEqual(Object.keys(CORPUS), ['E', 'N', 'A', 'R', 'T', 'G', 'W', 'S', 'F']);
  assert.ok(all.length >= 400, `${all.length} titles`);
});

for (const [key, p] of Object.entries(CORPUS)) {
  test(`${key} (${p.who}): every audit title, every expected pass and every near miss`, () => {
    const c = compiled(p.search);
    const wrong: string[] = [];
    for (const t of [...p.audit.passes, ...p.audit.dropped, ...p.pass]) {
      const v = prefilter({ title: t }, c);
      if (!v.keep) wrong.push(`should pass: "${t}" (${v.rule}: ${v.reason})`);
    }
    for (const e of p.fail) {
      const { title, rule } = split(e);
      const v = prefilter({ title }, c);
      if (v.keep) wrong.push(`should fail: "${title}"`);
      else if (!TITLE_RULES.includes(v.rule) || (rule && v.rule !== rule)) wrong.push(`"${title}" failed on ${v.rule} (${v.reason}), expected ${rule ?? 'a title rule'}`);
    }
    assert.deepEqual(wrong, []);
  });
}

// Today's (v0.3) title gate, as it was: the words adjacent and in order, anchored at a word start, no end boundary.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oldGate = (titles: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${titles.map((s) => plain(s).trim().split(/[\s\-/]+/).filter(Boolean).map(esc).join('[\\s\\-/]+')).join('|')})`, 'iu');

for (const [key, p] of Object.entries(CORPUS)) {
  test(`${key}: v1 roles.titles ${JSON.stringify(p.v1)} pass everything the old phrase gate passed, over the whole corpus`, () => {
    const c = compiled({ roles: { titles: p.v1 }, languages: p.search.languages });
    const old = oldGate(p.v1);
    const lost = all.filter((t) => old.test(plain(t)) && !prefilter({ title: t }, c).keep);
    assert.deepEqual(lost, [], 'never fewer');
    const gained = all.filter((t) => !old.test(plain(t)) && prefilter({ title: t }, c).keep);
    // The audit's point: word order, plurals and gendered forms now pass with the same words.
    if (['E', 'A', 'T'].includes(key)) assert.ok(gained.length > 0, `${key} gains nothing`);
  });
}
