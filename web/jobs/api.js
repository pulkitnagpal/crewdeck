// The Jobs page's calls: reads, actions (same-origin JSON POSTs) and the live refresh stream.
const base = '/api/jobs';

async function call(url, init, retried = false) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  // The tracker was busy for a moment (a CLI command writing): try once more.
  if (r.status === 503 && !retried && body.error === 'busy, retry') {
    await new Promise((ok) => setTimeout(ok, 500));
    return call(url, init, true);
  }
  if (!r.ok) throw new Error(body.error || `Something went wrong (HTTP ${r.status})`);
  return body;
}

export const get = (path) => call(`${base}/${path}`, { headers: { accept: 'application/json' } });
export const act = (name, body = {}) => call(`${base}/action/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Calls back on every change (database, notes, queue, presence); reconnects when the server restarts. */
export function live(onChange) {
  let source = null, stop = false, timer = null;
  const open = () => {
    source = new EventSource(`${base}/events`);
    source.addEventListener('refresh', (e) => { try { onChange(JSON.parse(e.data).topics ?? []); } catch { onChange([]); } });
    source.onerror = () => { source.close(); if (!stop) timer = setTimeout(open, 2000); };
  };
  open();
  return () => { stop = true; clearTimeout(timer); source?.close(); };
}
