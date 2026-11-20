// A minimal transport with the career-ops ctx shape (the tests point it at a local server).
import { clean } from '../lib/clean.mjs';
export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
    fetchText: async (url) => clean(await (await fetch(url)).text()),
  };
}
