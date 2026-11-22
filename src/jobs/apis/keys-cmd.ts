// crewdeck jobs keys set|remove|list [<provider>]: the person's own API keys. A key is read from stdin (a pipe, or typed
// without echo in a terminal), never from the command line (argv lands in shell history and process lists), and is
// printed only masked.
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { KeyStore, mask } from './keys.ts';
import { keyedProviders, provider } from './registry.ts';

export const KEYS_USAGE = `usage: crewdeck jobs keys <command>
  list [<provider>]          which providers have a key (masked) and where to get one
  set <provider>             store a key read from stdin (e.g. pbpaste | crewdeck jobs keys set adzuna)
  remove <provider>          forget a key`;

async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  // A terminal: ask without echoing what is typed or pasted.
  const mute = new Writable({ write(_c, _e, cb) { cb(); } });
  process.stdout.write('Paste the key, then press Enter: ');
  const rl = createInterface({ input: process.stdin, output: mute, terminal: true });
  try { return (await rl.question('')).trim(); } finally { rl.close(); process.stdout.write('\n'); }
}

function known(id: string | undefined) {
  if (!id) throw new Error(`name a provider: ${keyedProviders().map((p) => p.id).join(', ')}`);
  const p = provider(id);
  if (!p) throw new Error(`unknown provider "${id}" (with keys: ${keyedProviders().map((x) => x.id).join(', ')})`);
  if (!p.needsKey) throw new Error(`${p.name} needs no key`);
  return p;
}

export async function keysCmd(args: string[], say: (s: string) => void = (s) => console.log(s)) {
  const [verb, id, ...extra] = args.filter((a) => !a.startsWith('--'));
  if (verb === 'set') {
    const p = known(id);
    if (extra.length) throw new Error('a key is never given on the command line: pipe it in (pbpaste | crewdeck jobs keys set ' + p.id + ') or type it when asked');
    const value = await readKey();
    if (!value) throw new Error(`no key on stdin. Expected: ${p.needsKey!.format}`);
    if (/:/.test(p.needsKey!.format) && !/^[^:\s]+:[^:\s]+$/.test(value)) throw new Error(`${p.name} expects ${p.needsKey!.format}`);
    const store = new KeyStore();
    store.set(p.id, value);
    return say(`${p.name}: key saved (${mask(value)}) in ${store.path}`);
  }
  if (verb === 'remove') {
    const p = known(id);
    const removed = new KeyStore().remove(p.id);
    return say(removed ? `${p.name}: key removed` : `${p.name}: no key was saved`);
  }
  if (verb === 'list' || verb === undefined) {
    const store = new KeyStore();
    const list = id ? [known(id)] : keyedProviders();
    for (const p of list) {
      const v = store.get(p.id);
      say(`${p.id.padEnd(10)} ${v ? mask(v) : '(not set)'}${v ? '' : `  get one: ${p.needsKey!.signupUrl}`}`);
    }
    return;
  }
  say(KEYS_USAGE);
  process.exitCode = 1;
}
