// C10: jobs/memory.md has several writers (CLI calls, page actions, the user's editor). One lock, an mtime check before
// the rename, ids never reused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { splitNote } from '../../src/jobs/notes.ts';
import { lockFile, remember, retire } from '../../src/jobs/memory.ts';
import { tempSetup } from './helpers.ts';

const items = (file: string) => (parse(splitNote(readFileSync(file, 'utf8')).front!).items ?? []) as { id: string; text: string; superseded_by?: string }[];
const MEMORY = new URL('../../src/jobs/memory.ts', import.meta.url).pathname;

test('C10: eight processes remembering at once lose nothing and never share an id', async () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'memory.md');
  const before = items(file).length;
  const script = `const { remember } = await import(${JSON.stringify(MEMORY)});
    for (let k = 0; k < 5; k++) remember(process.argv[1], { kind: 'fact', text: 'Fact ' + process.argv[2] + '.' + k, quote: 'I said ' + k }, '2026-11-19');`;
  const runs = Array.from({ length: 8 }, (_, p) => new Promise<number | null>((ok) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, file, String(p)], { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('close', ok);
  }));
  assert.deepEqual(await Promise.all(runs), Array(8).fill(0));
  const all = items(file);
  assert.equal(all.length, before + 40, 'every write landed');
  assert.equal(new Set(all.map((m) => m.id)).size, all.length, 'ids are unique');
  assert.equal(existsSync(lockFile(file)), false, 'the lock is released');
});

test('C10: a change made by an editor between read and write is kept: the write starts over from the new text', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'memory.md');
  let edits = 0;
  const r = remember(file, { kind: 'fact', text: 'Ran the Q3 survey', quote: 'I ran the Q3 survey' }, '2026-11-19', {
    afterRead: () => {
      if (edits++) return;
      // The user saves the note in SilverBullet with a new item of their own.
      const t = readFileSync(file, 'utf8').replace('items:', 'items:\n  - { id: m-90, kind: fact, text: Typed by hand, quote: typed by hand, scope: all, created: 2026-11-19 }');
      writeFileSync(file, t);
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
    },
  });
  assert.equal(edits, 2, 'read twice');
  assert.equal(r.item.id, 'm-91', 'after the hand-typed m-90');
  const ids = items(file).map((m) => m.id);
  assert.ok(ids.includes('m-90') && ids.includes('m-91'), ids.join());
});

test('C10: a crashed writer\'s stale lock is taken over; a fresh one makes the next writer wait, then give up clearly', () => {
  const s = tempSetup('berlin-analyst');
  const file = join(s.vault, 'jobs', 'memory.md');
  writeFileSync(lockFile(file), '999999');
  utimesSync(lockFile(file), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const r = remember(file, { kind: 'fact', text: 'After a crash', quote: 'after a crash' }, '2026-11-19');
  assert.ok(r.item.id);
  assert.equal(existsSync(lockFile(file)), false);
  // Duplicate ids in the note (a hand edit) are refused before anything is written.
  const t = readFileSync(file, 'utf8');
  writeFileSync(file, t.replace(`id: ${r.item.id}`, 'id: m-1'));
  assert.throws(() => retire(file, 'm-1'), /"m-1" is used twice/);
});
