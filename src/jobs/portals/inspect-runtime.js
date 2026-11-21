// The in-page half of teaching a portal (ADR-0008, "Teach a portal"): `crewdeck jobs portals inspect-script` prints this
// function, serialised like the page script, and Claude runs it once in a portal's search page with javascript_tool. It
// returns a short summary for writing a reader, never the page: the repeating elements that look like job cards (a
// selector, how many, two samples' lines, links and id-like attributes, React props holding a record), job-link path
// shapes, and whether the page has JSON-LD or __NEXT_DATA__. At most about 4 KB. Plain JavaScript, no imports, no
// closures; comments stay outside the function body (every byte is a token).

/**
 * Candidate card selectors and samples. `G` is the page's global object. Groups are siblings sharing a tag and class
 * signature, five or more, each with some text; ranked by count and how much text they carry.
 */
export function inspectPage(G) {
  const d = G.document, L = G.location;
  const T = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const esc = (c) => (G.CSS && G.CSS.escape ? G.CSS.escape(c) : String(c).replace(/[^\w-]/g, '\\$&'));
  const okClass = (c) => c && c.length <= 40 && !/^(css|sc|jsx|emotion|styled)-|^[a-z]{1,3}[0-9][a-z0-9]{3,}$|\d{4,}/i.test(c);
  const sig = (el) => { const cs = Array.from(el.classList || []).filter(okClass).slice(0, 3); return el.tagName.toLowerCase() + cs.map((c) => '.' + esc(c)).join(''); };
  const lines = (el) => String(el.innerText || el.textContent || '').split('\n').map((x) => T(x, 70)).filter(Boolean);
  const groups = new Map();
  const all = Array.from(d.querySelectorAll('body *')).slice(0, 8000);
  for (const el of all) {
    const p = el.parentElement;
    if (!p || !el.tagName || /^(script|style|svg|path|option|br|img|input)$/i.test(el.tagName)) continue;
    const k = sig(el);
    let g = groups.get(p);
    if (!g) { g = new Map(); groups.set(p, g); }
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(el);
  }
  const cands = [];
  for (const [, g] of groups) for (const [k, els] of g) {
    if (els.length < 5) continue;
    const txt = els.slice(0, 10).map((e) => lines(e).join(' ').length);
    const avg = txt.reduce((a, b) => a + b, 0) / txt.length;
    if (avg < 25 || avg > 1500) continue;
    cands.push({ k, els, score: els.length * Math.min(avg, 300) });
  }
  cands.sort((a, b) => b.score - a.score);
  const reactRec = (el) => {
    const key = Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    let fb = key ? el[key] : null;
    for (let i = 0; fb && i < 8; i++, fb = fb.return) {
      const pr = fb.memoizedProps;
      if (!pr || typeof pr !== 'object') continue;
      for (const n of Object.keys(pr)) {
        const v = pr[n];
        if (v && typeof v === 'object' && !Array.isArray(v) && !v.$$typeof && Object.keys(v).some((x) => /title|jobid|job_id|url|company/i.test(x))) return { prop: n, keys: Object.keys(v).slice(0, 25) };
      }
    }
    return null;
  };
  const sample = (el) => {
    const links = Array.from(el.querySelectorAll('a[href]')).slice(0, 3).map((a) => { try { const u = new URL(a.getAttribute('href'), L.href); return u.host === L.host ? u.pathname.slice(0, 90) : u.host + u.pathname.slice(0, 60); } catch (e) { return ''; } }).filter(Boolean);
    const attrs = [];
    for (const n of [el, ...Array.from(el.querySelectorAll('[data-id],[data-job-id],[data-jobid],[id],[componentkey],[data-entity-urn],[data-occludable-job-id]')).slice(0, 4)]) {
      for (const a of Array.from(n.attributes || [])) if (a.name !== 'class' && a.name !== 'style' && /\d{5,}/.test(a.value) && a.value.length <= 80) attrs.push(a.name + '=' + a.value);
    }
    const ps = Array.from(el.querySelectorAll('p')).length;
    const out = { lines: lines(el).slice(0, 7), links, attrs: [...new Set(attrs)].slice(0, 4), p: ps };
    const r = reactRec(el);
    if (r) out.react = r;
    return out;
  };
  const cards = [];
  const seen = new Set();
  for (const c of cands) {
    if (cards.length >= 4) break;
    if (seen.has(c.k)) continue;
    seen.add(c.k);
    let n = 0;
    try { n = d.querySelectorAll(c.k).length; } catch (e) {}
    cards.push({ selector: c.k, siblings: c.els.length, matches: n, samples: c.els.slice(0, 2).map(sample) });
  }
  const shapes = new Map();
  for (const a of Array.from(d.querySelectorAll('a[href]')).slice(0, 3000)) {
    let u;
    try { u = new URL(a.getAttribute('href'), L.href); } catch (e) { continue; }
    if (u.host !== L.host && !u.host.endsWith('.' + L.host.replace(/^www\./, ''))) continue;
    const shape = u.pathname.replace(/\d{4,}/g, '{n}').replace(/[a-z0-9]+(-[a-z0-9]+){2,}/gi, '{slug}').slice(0, 80);
    shapes.set(shape, (shapes.get(shape) || 0) + 1);
  }
  const links = Array.from(shapes).filter((x) => x[1] >= 5).sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0] + ' ×' + x[1]);
  return {
    url: String(L.href).slice(0, 300), title: T(d.title, 80),
    jsonld: d.querySelectorAll('script[type="application/ld+json"]').length, next_data: !!(G.__NEXT_DATA__ || d.getElementById('__NEXT_DATA__')),
    password: d.querySelectorAll('input[type=password]').length > 0, cards, links,
  };
}
