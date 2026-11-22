// A minimal transport with the career-ops ctx shape (the journey tests point it at a local server).
export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson: async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); },
    fetchText: async (url) => (await fetch(url)).text(),
  };
}
