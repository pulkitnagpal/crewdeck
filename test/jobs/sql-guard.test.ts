// Design §14 "SQL injection: prepared statements; grep test for interpolated SQL": every prepare()/exec() in src/jobs
// takes a plain literal (no ${…}, no +), or a migration step's constant SQL. Values always go through parameters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO } from './helpers.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
}

/** The first argument of every .prepare( and every db.exec( (RegExp#exec is not SQL): its literal, or what it is built from. */
export function sqlCalls(src: string): { at: number; problem: string | null }[] {
  const out: { at: number; problem: string | null }[] = [];
  for (const m of src.matchAll(/\.prepare\(\s*|\b(?:db|ctx\.db)\.exec\(\s*/g)) {
    const start = m.index! + m[0].length;
    const q = src[start];
    if (q === '`' || q === "'" || q === '"') {
      let i = start + 1;
      while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
      const lit = src.slice(start + 1, i);
      const after = src.slice(i + 1).trimStart()[0];
      out.push({ at: m.index!, problem: q === '`' && lit.includes('${') ? 'interpolated' : after === '+' ? 'concatenated' : null });
    } else {
      const arg = /^[\w.]+/.exec(src.slice(start))?.[0] ?? '';
      out.push({ at: m.index!, problem: arg === 'step.sql' ? null : `built from ${arg || 'an expression'}` });
    }
  }
  return out;
}

test('no SQL in src/jobs is built from values', () => {
  const bad: string[] = [];
  let n = 0;
  for (const f of files(join(REPO, 'src', 'jobs'))) {
    const src = readFileSync(f, 'utf8');
    for (const c of sqlCalls(src)) {
      n++;
      if (c.problem) bad.push(`${relative(REPO, f)}:${src.slice(0, c.at).split('\n').length}: ${c.problem}`);
    }
  }
  assert.ok(n > 100, `found only ${n} SQL calls: the scan is broken`);
  assert.deepEqual(bad, []);
});

test('the guard itself catches interpolation, concatenation and variables', () => {
  const probe = (s: string) => sqlCalls(s).map((c) => c.problem);
  assert.deepEqual(probe("db.prepare('select ? from t').get(1)"), [null]);
  assert.deepEqual(probe('db.prepare(`select * from ${table}`)'), ['interpolated']);
  assert.deepEqual(probe("db.exec('PRAGMA user_version = ' + n)"), ['concatenated']);
  assert.deepEqual(probe('db.prepare(sql)'), ['built from sql']);
  assert.deepEqual(probe('db.exec(step.sql)'), [null]);
});
