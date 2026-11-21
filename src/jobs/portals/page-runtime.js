// The in-page half of pane-mode portal scanning (ADR-0008, "Pane mode"). Claude runs `crewdeck jobs portals script <id>`
// in a portal's search page through the browser pane's javascript_tool; that script is these functions, serialised with
// Function.prototype.toString into one IIFE with the portal's catalog entry embedded (page-script.ts). Plain JavaScript,
// no imports and no closures over this module except each other and RX, so the same code runs in Node (extract.ts
// shares pathValue, canonUrl, workplaceOf and RX; the tests run the real script with `new Function`) and in the page.
//
// Comments live outside the function bodies: the script builder drops nothing else, and every byte is a token.

/** Card-text rules shared with extract.ts (the profile engine's link layer). */
export const RX = {
  button: /^(apply( now)?|easy apply|quick apply|save|saved|view( job| details)?|details|more|share|see more|know more|read more|new|promoted|featured)$/i,
  time: /\b(ago|today|yesterday|just now|posted|hours?|days?|weeks?|months?)\b/i,
  noise: /^(\d+(\.\d+)?\s*(-|to|–)\s*\d+(\.\d+)?\s*(yrs?|years?|lpa|lakhs?)|₹|\$|£|€|\d+\+? (applicants?|reviews?)|actively hiring|be an early applicant|\d(\.\d)?★?)/i,
  where: /^(remote|hybrid|work from home|on-?site)\b/i,
  human: /verify (that )?you are (a )?human|are you a robot|unusual traffic from your/i,
  block: /^\s*(just a moment|attention required|access denied)/i,
};

/** A host on the list or under one of its hosts (the netguard's rule). */
export function hostIn(host, list) {
  const h = String(host == null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  return !!h && list.some((x) => { const a = String(x).toLowerCase(); return h === a || h.endsWith('.' + a); });
}

/** A value at a path: `a.b.c`, `list[type=location].label`, and an optional ` ~ regex` keeping its first group. */
export function pathValue(obj, path) {
  const [p, re] = String(path).split(/\s+~\s+/, 2);
  let cur = obj;
  for (const seg of p.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^[\]]+)(?:\[([^=\]]+)=([^\]]*)\])?$/.exec(seg);
    if (!m) return undefined;
    cur = /^\d+$/.test(m[1]) && Array.isArray(cur) ? cur[Number(m[1])] : cur[m[1]];
    if (m[2] !== undefined) cur = Array.isArray(cur) ? cur.find((x) => x && String(x[m[2]]) === m[3]) : undefined;
  }
  if (re === undefined) return cur;
  if (typeof cur !== 'string') return undefined;
  try { const g = new RegExp(re).exec(cur.slice(0, 2000)); return g ? g[1] : undefined; } catch (e) { return undefined; }
}

/**
 * A posting's address as Crewdeck keeps it: on the portal's hosts, matching its job-URL pattern, with only the query
 * parameters that identify the posting (or the catalog's canonical form). `job` = { pattern, keep_params, canonical }.
 */
export function canonUrl(raw, base, job, hosts) {
  let u;
  try { u = new URL(String(raw == null ? '' : raw).trim(), base); } catch (e) { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || !hostIn(u.hostname, hosts)) return null;
  let hit;
  try { hit = new RegExp(job.pattern).exec(u.pathname); } catch (e) { return null; }
  if (!hit) return null;
  const kept = (job.keep_params || []).map((k) => [k, u.searchParams.get(k)]);
  if (kept.some((x) => !x[1] || !/^[\w.-]{1,100}$/.test(x[1]))) return null;
  if (job.canonical) {
    const vals = { host: u.host, id: hit[1] || '', path: u.pathname.replace(/\/+$/, '') || '/' };
    for (const x of kept) vals[x[0]] = encodeURIComponent(x[1]);
    try { return new URL(job.canonical.replace(/\{(\w+)\}/g, (_m, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : ''))).toString(); } catch (e) { return null; }
  }
  const q = kept.length ? '?' + kept.map((x) => x[0] + '=' + encodeURIComponent(x[1])).join('&') : '';
  return u.protocol + '//' + u.host + u.pathname + q;
}

export function workplaceOf(text) {
  if (/\bhybrid\b/i.test(text)) return 'hybrid';
  if (/\bremote\b|work from home|\bwfh\b/i.test(text)) return 'remote';
  return undefined;
}

/**
 * Read one search page: its jobs (the portal's JSON APIs the page already loaded, re-fetched with the person's cookies;
 * window state such as __NEXT_DATA__; JSON-LD JobPosting; job links with their card text) and its signals (a sign-in
 * wall, a challenge, nothing found). `C` is the portal's config from page-script.ts; `G` the page's global object.
 */
export async function scanPage(C, G) {
  const d = G.document, L = G.location, MAX = C.max || 60;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = (v, n) => (typeof v === 'string' ? v.slice(0, 4000).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : typeof v === 'number' && isFinite(v) ? String(v) : '');
  const vis = (el) => { try { return el.getClientRects().length > 0 && !(el.offsetWidth < 2 && el.offsetHeight < 2); } catch (e) { return false; } };
  const res = () => { try { return G.performance.getEntriesByType('resource').map((e) => e.name); } catch (e) { return []; } };
  for (let i = 0, n = -1, still = 0; i < 40 && C.settle_ms > 0; i++) {
    const k = res().length;
    still = k === n && d.readyState === 'complete' ? still + 200 : 0;
    if (still >= C.settle_ms) break;
    n = k;
    await wait(200);
  }
  const found = new Map();
  const job = (raw, f) => {
    const url = canonUrl(raw, L.href, C.job, C.hosts), title = T(f.title, 120);
    if (!url || !title) return;
    const o = { url, title, company: T(f.company, 80), location: T(f.location, 80) };
    const p = T(f.posted_at, 40), w = workplaceOf(o.location + ' ' + T(f.workplace, 300)), cc = T(f.company_country, 40);
    if (p) o.posted_at = p;
    if (w) o.workplace = w;
    if (cc) o.company_country = cc;
    const have = found.get(url);
    if (have) { for (const k of ['company', 'location', 'posted_at', 'workplace', 'company_country']) if (!have[k] && o[k]) have[k] = o[k]; } else if (found.size < MAX) found.set(url, o);
  };
  const fromList = (root, a) => {
    const list = pathValue(root, a.list);
    if (!Array.isArray(list)) return;
    for (const it of list.slice(0, 500)) {
      if (!it || typeof it !== 'object') continue;
      if (a.where && !Object.keys(a.where).every((k) => { const v = pathValue(it, k); try { return typeof v === 'string' && new RegExp(a.where[k]).test(v); } catch (e) { return false; } })) continue;
      const f = {};
      for (const k of Object.keys(a.fields)) f[k] = pathValue(it, a.fields[k]);
      const id = T(f.id, 100);
      const raw = a.fields.url ? T(f.url, 2000) : a.url_template && /^[\w-]{1,100}$/.test(id) ? a.url_template.replace('{id}', encodeURIComponent(id)) : '';
      if (raw) job(raw, f);
    }
  };
  const fetched = new Set();
  for (const a of C.json) {
    if (a.state) {
      try {
        const seg = a.state.split('.'), top = seg.shift();
        let v = G[top];
        if (v === undefined && top === '__NEXT_DATA__') { const el = d.getElementById('__NEXT_DATA__'); if (el) v = JSON.parse(String(el.textContent).slice(0, 5e6)); }
        fromList(seg.length ? pathValue(v, seg.join('.')) : v, a);
      } catch (e) { }
    }
    if (!a.url) continue;
    let re;
    try { re = new RegExp(a.url); } catch (e) { continue; }
    const urls = res().filter((u) => { try { return re.test(u) && new URL(u).origin === L.origin && !fetched.has(u); } catch (e) { return false; } }).slice(-4);
    for (const u of urls) {
      fetched.add(u);
      try {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
        const r = await G.fetch(u, { credentials: 'include', headers: { accept: 'application/json' }, signal: ctl.signal });
        const txt = r.ok ? await r.text() : '';
        clearTimeout(t);
        if (txt && txt.length <= 3e6) fromList(JSON.parse(txt), a);
      } catch (e) { }
    }
  }
  const types = (n) => [].concat(n && n['@type']).map((t) => String(t == null ? '' : t).toLowerCase());
  const ld = (v, depth, out) => {
    if (!v || typeof v !== 'object' || depth > 6 || out.length > 500) return out;
    if (Array.isArray(v)) { for (const x of v) ld(x, depth + 1, out); return out; }
    const t = types(v);
    if (t.includes('jobposting')) out.push(v);
    else if (t.includes('listitem')) { if (v.item && typeof v.item === 'object') ld(v.item, depth + 1, out); }
    else { ld(v['@graph'], depth + 1, out); ld(v.itemListElement, depth + 1, out); }
    return out;
  };
  const place = (l) => {
    const a = (l && l.address) || l;
    if (typeof a === 'string') return a.trim();
    const c = a && (typeof a.addressCountry === 'object' ? a.addressCountry && a.addressCountry.name : a.addressCountry);
    return [a && a.addressLocality, a && a.addressRegion, c].map((x) => T(x, 80)).filter((x, i, all) => x && all.indexOf(x) === i).join(', ');
  };
  for (const el of Array.from(d.querySelectorAll('script[type="application/ld+json"]')).slice(0, 30)) {
    let j;
    try { j = JSON.parse(String(el.textContent).slice(0, 1e6)); } catch (e) { continue; }
    for (const n of ld(j, 0, [])) {
      const org = n.hiringOrganization, oa = org && org.address;
      const remote = [].concat(n.jobLocationType).some((t) => /telecommute|remote/i.test(String(t == null ? '' : t)));
      const loc = [].concat(n.jobLocation).filter(Boolean).map(place).filter(Boolean).join(' · ');
      job(T(n.url || n.sameAs || n['@id'], 2000), { title: n.title || n.name, company: typeof org === 'string' ? org : org && org.name, location: loc || (remote ? 'Remote' : ''), posted_at: n.datePosted, workplace: remote ? 'remote' : '', company_country: oa && (typeof oa.addressCountry === 'object' ? oa.addressCountry && oa.addressCountry.name : oa.addressCountry) });
    }
  }
  const urlOf = new Map(), groups = new Map();
  for (const a of Array.from(d.querySelectorAll('a[href]')).slice(0, 3000)) {
    const u = canonUrl(a.getAttribute('href'), L.href, C.job, C.hosts);
    if (!u) continue;
    urlOf.set(a, u);
    if (!groups.has(u)) groups.set(u, []);
    groups.get(u).push(a);
  }
  for (const [u, as] of groups) {
    const title = as.map((a) => T(a.innerText || a.textContent, 300)).find((t) => t.length >= 3 && t.length <= 200 && !RX.button.test(t));
    if (!title) continue;
    let card = as[0];
    for (let i = 0; i < 8 && card.parentElement && card.parentElement !== d.body; i++) {
      if (Array.from(card.parentElement.querySelectorAll('a[href]')).some((x) => urlOf.has(x) && urlOf.get(x) !== u)) break;
      card = card.parentElement;
    }
    const lines = String(card.innerText || card.textContent || '').split('\n').map((l) => l.replace(/^-\s+/, '').trim()).filter((l) => l && l.length <= 160 && l.toLowerCase() !== title.toLowerCase() && !RX.button.test(l));
    let company = '', location = '', posted = '';
    for (const l of lines) {
      if (!posted && RX.time.test(l)) { posted = l.replace(/^posted\s+(on\s+)?/i, ''); continue; }
      if (!location && RX.where.test(l)) { location = l; continue; }
      if (RX.noise.test(l) || RX.time.test(l) || !/\p{L}/u.test(l)) continue;
      if (!company) company = l; else if (!location) location = l;
    }
    job(u, { title, company, location, posted_at: posted, workplace: lines.join(' ') });
  }
  const jobs = [];
  let size = 200;
  for (const j of found.values()) { size += JSON.stringify(j).length + 1; if (size > (C.budget || 10000)) break; jobs.push(j); }
  const path = L.pathname, empty = jobs.length === 0;
  const wall = C.wall.some((w) => { try { return new RegExp(w).test(path); } catch (e) { return false; } }) || (empty && Array.from(d.querySelectorAll('input[type=password]')).some(vis));
  const text = String((d.body && (d.body.innerText || d.body.textContent)) || '').slice(0, 20000);
  const strong = RX.block.test(d.title || '') || RX.human.test(text) || /\/checkpoint\//.test(path) || !!d.querySelector('#challenge-form,#challenge-running,[id^="px-captcha"],iframe[src*="captcha-delivery.com"]');
  const weak = Array.from(d.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],iframe[src*="turnstile"]')).some((f) => vis(f) && !/size=invisible/.test(f.src || ''));
  return { url: String(L.href).slice(0, 2000), signals: { sign_in_wall: wall, challenge: strong || (weak && empty), empty }, jobs };
}
