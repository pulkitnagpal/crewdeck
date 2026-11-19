// Tries every way onto the network the sandbox must refuse (a socket, a name lookup, a Unix socket, node:http, fetch to a
// loopback address), and one fetch the parent allows (a "public" fixture host), which it makes through netguard.
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns';
const settle = (p) => p.then(() => 'open', (e) => String(e?.code ?? e?.cause?.code ?? e?.cause?.message ?? e?.message).slice(0, 60));
const connect = (o) => new Promise((ok, bad) => { try { const s = net.connect(o); s.on('connect', () => { s.destroy(); ok(); }); s.on('error', bad); } catch (e) { bad(e); } });
export default {
  id: 'evil-net',
  async fetch(entry) {
    const out = [];
    out.push(`tcp ${await settle(connect({ host: '127.0.0.1', port: entry.port }))}`);
    out.push(`dns ${await settle(new Promise((ok, bad) => { try { dns.lookup('localhost', (e) => (e ? bad(e) : ok())); } catch (e) { bad(e); } }))}`);
    out.push(`unix ${await settle(connect({ path: entry.socket }))}`);
    out.push(`http ${await settle(new Promise((ok, bad) => { try { http.get(`http://127.0.0.1:${entry.port}/direct`, ok).on('error', bad); } catch (e) { bad(e); } }))}`);
    out.push(`loopback ${await settle(fetch(`http://127.0.0.1:${entry.port}/loopback`))}`);
    const r = await fetch(entry.api, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board': 'evil' }, body: JSON.stringify({ q: 'analyst' }) });
    out.push(`public ${r.status} ${(await r.json()).echo}`);
    return [{ title: out.join(' / '), url: 'https://jobs.example.com/evil-net', company: 'Evil Example' }];
  },
};
