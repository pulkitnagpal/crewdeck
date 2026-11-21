// Sources (design §24.3, D23): where Jobs looks, in the order it looks. Yours (move up/down, on/off, remove, the last
// fetch of each), add a company or a web address (checked at once in the sandbox), the catalog (filter by region, field
// and kind), LinkedIn's row (its switch is the user's own, through the native confirm), and the coverage line (D42).
// Every change is the `sources` page action, the same validated writer as `crewdeck jobs sources …`.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, noop, cls, ago, clock, plural, More } from '../lib.js';
import { TerminalCode } from './settings.js';
import { Portals } from './portals.js';

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
const FAMILY = (id) => id.replace(/-/g, ' ');
/** The coverage line split in two: its first sentence (shown) and the rest (what else works, behind More). */
export function splitLine(line = '') {
  const m = /^(.+?\.)\s+(?=[A-Z])([\s\S]+)$/.exec(line);
  return m ? [m[1], m[2]] : [line, ''];
}

/** "Example Health's", "Example Stores'". */
export const poss = (name) => `${name}${/s$/i.test(name) ? '\'' : '\'s'}`;

/** One line for a source's last fetch, its "checking…" state, or why it isn't fetched (in plain words). */
export function lastLine(r, now = Date.now()) {
  if (r.resolving) return { kind: 'busy', text: 'Checking its page… (up to 30 seconds)' };
  const res = r.resolved;
  if (res?.refused) return { kind: 'warn', text: `Couldn't check this page here: ${res.refused} · tried again next fetch` };
  if (r.kind === 'linkedin' && !r.enabled) return { kind: 'off', text: 'Off · only you can switch it on' };
  if (!r.enabled) return { kind: 'off', text: 'Off · not fetched' };
  if (r.fetch === 'none') return { kind: 'warn', text: r.why ? `Not fetched: ${r.why}` : 'Not fetched: Crewdeck can\'t read this page. Paste its postings on Today.' };
  if (res?.result?.ok && (!r.last || r.last.at < res.at)) return { kind: 'ok', text: `${res.result.provider_name}: ${plural(res.result.jobs ?? 0, 'role')} on a test · fetched next run` };
  const l = r.last;
  if (!l) return { kind: 'none', text: 'Not fetched yet' };
  // LinkedIn after a stop (1 h, 4 h, 12 h, then 24 h): when it is tried again, in the viewer's clock.
  if (l.paused_until && Date.parse(l.paused_until) > now) return { kind: 'warn', text: `LinkedIn paused until ${clock(l.paused_until)} · ${ago(l.at, now)}` };
  const desc = l.descriptions?.total ? ` · ${n(l.descriptions.full)} of ${n(l.descriptions.total)} with full descriptions` : '';
  if (l.ok) return { kind: 'ok', text: `${plural(l.jobs, 'role')} · ${n(l.new)} new · ${n(l.kept)} match your rules${desc} · ${ago(l.at, now)}` };
  return { kind: 'bad', text: `${l.why ?? l.error ?? 'The last fetch failed'} · ${ago(l.at, now)}` };
}

/** Is the region option `R` relevant to a catalog entry? It covers R (R is inside one of its regions) or sits inside R. */
export function inRegion(c, R, within) {
  if (!R) return true;
  if (R === 'world') return c.regions.includes('world');
  return c.regions.some((g) => g !== 'world' && (g === R || (within[R] ?? []).includes(g) || (within[g] ?? []).includes(R)));
}

export function filterCatalog(catalog, f, within) {
  return catalog.filter((c) => (f.careers || c.needs !== 'careers_url') && inRegion(c, f.region, within)
    && (!f.family || c.families.includes(f.family)) && (!f.kind || c.kind === f.kind));
}

function Chips({ r }) {
  return html`<span class="chips">
    <span class="chip">${r.kind_label}</span>
    ${r.confidence && r.confidence !== 'high' ? html`<span class="chip warn">not verified</span>` : null}
  </span>`;
}

/** A row's less-used facts (system, regions, address), one More away. */
function rowFacts(r, page) {
  const sys = r.provider_name && r.kind !== 'linkedin' && r.provider_name !== r.name ? r.provider_name : null;
  const where = r.region_names?.length ? r.region_names.join(', ') : null;
  if (!sys && !where && !page) return null;
  return html`<${More} summary="Details">
    ${sys ? html`<span>Runs on ${sys}</span>` : null}
    ${where ? html`<span>Covers ${where}</span>` : null}
    ${page ? html`<span class="addr">${page}</span>` : null}
  </${More}>`;
}

function LinkedInControls({ r, data, onFeature }) {
  const [confirming, setConfirming] = useState(false);
  const [terminal, setTerminal] = useState(null);
  const sw = data.linkedin.switches;
  const on = async () => { setConfirming(false); const x = await onFeature('linkedin_search', true); if (x?.terminal) setTerminal(x.terminal); };
  return html`<div class="stack">
    ${r.enabled ? html`<div class="row-flex"><button type="button" class="btn small" onClick=${() => onFeature('linkedin_search', false)}>Switch LinkedIn search off</button></div>`
      : html`<div class="row-flex"><button type="button" class="btn small" aria-expanded=${confirming} onClick=${() => setConfirming(!confirming)}>Switch on…</button></div>`}
    <${More} summary="LinkedIn details"><span>Only you can switch LinkedIn search on; Claude can't.</span>
      <span>Pasted LinkedIn links: ${sw.linkedin_links ? 'on' : 'off'} · Easy Apply: ${sw.easy_apply ? 'on' : 'off'} (both in Settings)</span></${More}>
    ${confirming ? html`<div class="confirm" role="alertdialog" aria-labelledby=${`src-${r.key}`}>
      <b>Switch on LinkedIn search?</b><span class="small">${data.linkedin.risk}</span>
      <span class="small">Your computer then asks you to confirm in its own dialog.</span>
      <div class="row-flex"><button type="button" class="btn primary small" onClick=${on}>Yes, switch it on</button>
        <button type="button" class="btn quiet small" onClick=${() => setConfirming(false)}>Cancel</button></div>
    </div>` : null}
    ${terminal ? html`<${TerminalCode} t=${terminal} onClose=${() => setTerminal(null)} />` : null}
  </div>`;
}

function Row({ r, i, count, data, asked, onMove, onToggle, onRemove, onCheck, onAsk, onFeature }) {
  const [removing, setRemoving] = useState(false);
  const line = lastLine(r);
  const page = r.careers_url || r.url;
  const unread = page && r.fetch === 'none' && !r.resolving;
  return html`<li class=${cls('srow', !r.enabled && 'off')} data-key=${r.key}>
    <span class="pos" aria-hidden="true">${i + 1}</span>
    <div class="body">
      <div class="head"><h3 id=${`src-${r.key}`}>${r.name}</h3><${Chips} r=${r} /></div>
      <p class=${cls('last small', line.kind)}>${line.kind === 'busy' ? html`<span class="dot busy" aria-hidden="true"></span>` : null}${line.text}</p>
      ${asked ? html`<p class="small"><span class="dot wait" aria-hidden="true"></span> Claude is looking for its jobs page (${asked})</p>` : null}
      ${unread ? html`<div class="row-flex">
        ${asked ? null : html`<button type="button" class="btn small" onClick=${() => onAsk(r)}>Ask Claude to find the jobs page</button>`}
        <button type="button" class="btn small quiet" onClick=${() => onCheck(r)}>Check again</button></div>` : null}
      ${r.kind === 'linkedin' ? html`<${LinkedInControls} r=${r} data=${data} onFeature=${onFeature} />` : rowFacts(r, page)}
      ${removing ? html`<div class="confirm" role="alertdialog" aria-labelledby=${`src-${r.key}`}>
        <b>Remove ${r.name} from your list?</b>
        <span class="small">Roles already found stay. You can add it back later.</span>
        <div class="row-flex"><button type="button" class="btn small danger" onClick=${() => { setRemoving(false); onRemove(r); }}>Remove</button>
          <button type="button" class="btn quiet small" onClick=${() => setRemoving(false)}>Cancel</button></div></div>` : null}
    </div>
    <div class="ctl">
      <div class="moves" role="group" aria-label=${`Order of ${r.name}`}>
        <button type="button" class="btn small" data-move=${`${r.key}:up`} disabled=${i === 0} aria-label=${`Move ${r.name} up`} onClick=${() => onMove(r, i - 1, 'up')} title="Move up">↑</button>
        <button type="button" class="btn small" data-move=${`${r.key}:down`} disabled=${i === count - 1} aria-label=${`Move ${r.name} down`} onClick=${() => onMove(r, i + 1, 'down')} title="Move down">↓</button>
      </div>
      ${r.kind === 'linkedin' ? html`<span class=${cls('chip', r.enabled ? 'ok' : '')}>${r.enabled ? 'On' : 'Off'}</span>`
        : html`<button type="button" class="switch" role="switch" aria-checked=${r.enabled ? 'true' : 'false'} aria-label=${`Fetch ${r.name}`} onClick=${() => onToggle(r)}></button>`}
      <button type="button" class="btn small quiet" aria-expanded=${removing} aria-label=${`Remove ${r.name}`} onClick=${() => setRemoving(!removing)}>Remove</button>
    </div>
  </li>`;
}

/** Add a company (careers page) or a web address: added, then checked in the sandbox; the answer shows here. */
function AddPage({ kind, data, onAdd, onAsk, asking }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = `add-${kind}`;
  const company = kind === 'company';
  const r = key ? data.rows.find((x) => x.key === key) : null;
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    const k = await onAdd({ name: name.trim(), url: url.trim(), company });
    setBusy(false);
    if (k) { setKey(k); setName(''); setUrl(''); }
  };
  let outcome = null;
  if (r) {
    const res = r.resolved;
    if (r.resolving) outcome = html`<p><span class="dot busy" aria-hidden="true"></span> Checking ${poss(r.name)} page in the sandbox… This takes up to 30 seconds.</p>`;
    else if (res?.result?.ok) outcome = html`<p class="ok"><b>${r.name}: ${res.result.provider_name} · ${plural(res.result.jobs ?? 0, 'open role')}</b> on a one-page test. It's in your list at position ${r.position}.</p>`;
    else if (res?.refused) outcome = html`<p>Added to your list at position ${r.position}. Crewdeck couldn't check the page here: ${res.refused}.</p>`;
    else if (r.fetch === 'none') outcome = html`<div class="stack"><p><b>${poss(r.name)} page isn't readable by Crewdeck.</b> Paste its postings on Today when you see them, or let Claude look for the real jobs page.</p>
      <div class="row-flex">${asking[r.key] ? html`<span class="small">Claude is on it (${asking[r.key]})</span>` : html`<button type="button" class="btn small primary" onClick=${() => onAsk(r)}>Ask Claude to find the jobs page</button>`}</div></div>`;
    else outcome = html`<p>Added to your list at position ${r.position}.</p>`;
  }
  return html`<form class="card section addform" aria-labelledby=${`${id}-title`} onSubmit=${go}>
    <header><h2 id=${`${id}-title`}>${company ? 'Add a company' : 'Add a web address'}</h2>
      <p class="soft">${company ? 'An employer you\'d like to work for, and its careers page.' : 'Any careers page or job board address.'}</p></header>
    <div class="grid2">
      <label class="f" for=${`${id}-name`}><span class="lab">${company ? 'Company name' : 'What to call it'}</span>
        <input id=${`${id}-name`} class="field" required maxlength="200" value=${name} placeholder=${company ? 'e.g. Example Health' : 'e.g. Example County jobs'} onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <label class="f" for=${`${id}-url`}><span class="lab">${company ? 'Careers page' : 'Web address'}</span>
        <input id=${`${id}-url`} class="field" type="url" inputmode="url" required value=${url} placeholder="https://…" onInput=${(e) => setUrl(e.currentTarget.value)} /></label>
    </div>
    <div class="row-flex"><button type="submit" class="btn primary" disabled=${busy || !name.trim() || !url.trim()}>Add and check</button></div>
    <div class="outcome" role="status" aria-live="polite">${outcome}</div>
    <${More} summary="How it works">${company
      ? html`<span>Any employer counts: a company, hospital, school or chain. Crewdeck checks which system runs its careers page, in a sandbox, in up to 30 seconds.</span>`
      : html`<span>Crewdeck checks the page in a sandbox. If it can't read it, it stays in your list as "paste its postings", and Claude can look for the real jobs page.</span>`}</${More}>
  </form>`;
}

function CatalogRow({ c, reasons, onAdd }) {
  const careers = c.needs === 'careers_url';
  return html`<li class="crow">
    <div class="body">
      <div class="head"><h3>${c.name}</h3><span class="chips"><span class="chip">${c.kind_label}</span>${c.region_names.length ? html`<span class="chip">${c.region_names.join(', ')}</span>` : null}
        ${c.verified ? null : html`<span class="chip warn">not verified</span>`}</span></div>
      ${reasons ? html`<p class="small soft">Suggested: ${reasons[0]}</p>` : null}
      <${More} summary="Details">
        ${c.families.length && !c.families.includes('any') ? html`<span>For ${c.families.slice(0, 4).map(FAMILY).join(', ')}</span>` : null}
        ${reasons && reasons.length > 1 ? html`<span>Also: ${reasons.slice(1).join('; ')}</span>` : null}
        ${c.coverage ? html`<span>${c.coverage}</span>` : null}
        ${c.note ? html`<span>${c.note}</span>` : null}
      </${More}>
    </div>
    <div class="ctl">${c.added ? html`<span class="chip ok">In your list</span>`
      : careers ? html`<span class="small soft">Use Add a company</span>`
        : html`<button type="button" class="btn small" aria-label=${`Add ${c.name}`} onClick=${() => onAdd(c)}>Add</button>`}</div>
  </li>`;
}

/**
 * A More whose body is built only while open (same look as lib.js's More): for long lists and form controls, so a
 * closed one adds nothing to the page or the Tab order.
 */
function LazyMore({ summary, children }) {
  const [open, setOpen] = useState(false);
  return html`<details class="more" onToggle=${(e) => setOpen(e.currentTarget.open)}><summary>${summary}</summary>
    ${open ? html`<div class="more-body">${children}</div>` : null}</details>`;
}

function Catalog({ data, onAdd }) {
  const [f, setF] = useState({ region: '', family: '', kind: '', careers: false });
  const byId = new Map(data.catalog.map((c) => [c.id, c]));
  const suggested = data.suggested.map((s) => ({ c: byId.get(s.id), reasons: s.reasons })).filter((x) => x.c && !x.c.added);
  const list = filterCatalog(data.catalog, f, data.filters.within).sort((a, b) => Number(a.added) - Number(b.added) || a.name.localeCompare(b.name));
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const browse = html`<div class="stack"><${Browse} data=${data} f=${f} list=${list} set=${set} onAdd=${onAdd} /></div>`;
  return html`<section class="card section" aria-labelledby="cat-title">
    <header><h2 id="cat-title">Catalog</h2><p class="soft">Every source Crewdeck can read. Added ones join the end.</p></header>
    ${suggested.length ? html`<div class="stack"><h3>Suggested for you</h3><ul class="clist">${suggested.map((x) => html`<${CatalogRow} key=${`s-${x.c.id}`} c=${x.c} reasons=${x.reasons} onAdd=${onAdd} />`)}</ul></div>` : null}
    ${suggested.length ? html`<${LazyMore} summary=${`Browse all ${data.catalog.length}`}>${browse}</${LazyMore}>` : browse}
  </section>`;
}

function Browse({ data, f, list, set, onAdd }) {
  return html`<${LazyMore} summary=${f.region || f.family || f.kind || f.careers ? 'Filters (on)' : 'Filters'}><div class="filters" role="group" aria-label="Filter the catalog">
      <label class="f" for="cat-region"><span class="lab">Region</span><select id="cat-region" class="field" value=${f.region} onChange=${set('region')}>
        <option value="">Any region</option>
        ${data.filters.regions.map((r) => html`<option value=${r.id}>${r.name}${r.mine ? ' (yours)' : ''}</option>`)}</select></label>
      <label class="f" for="cat-family"><span class="lab">Field</span><select id="cat-family" class="field" value=${f.family} onChange=${set('family')}>
        <option value="">Any field</option><option value="any">General boards (every field)</option>
        ${data.filters.families.map((x) => html`<option value=${x.id}>${FAMILY(x.id)}${data.filters.mine_families.includes(x.id) ? ' (yours)' : ''}</option>`)}</select></label>
      <label class="f" for="cat-kind"><span class="lab">Kind</span><select id="cat-kind" class="field" value=${f.kind} onChange=${set('kind')}>
        <option value="">Any kind</option>${data.filters.kinds.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select></label>
      <label class="check"><input type="checkbox" checked=${f.careers} onChange=${set('careers')} />Show sources that need a careers page</label>
    </div></${LazyMore}>
    <p class="small soft" role="status">${list.length ? `Showing ${plural(list.length, 'source')}` : 'Nothing in the catalog fits these filters.'}</p>
    <ul class="clist">${list.map((c) => html`<${CatalogRow} key=${c.id} c=${c} onAdd=${onAdd} />`)}</ul>`;
}

export function Sources({ data, state = null, portals = null, onAct = async () => null, onFeature = async () => null, onNotes = noop }) {
  const [say, setSay] = useState('');
  const [focus, setFocus] = useState(null);
  const companyRef = useRef(null);
  // Requests Claude has for a source (Ask Claude to find the jobs page), by key.
  const asking = {};
  for (const r of [...(state?.agent?.working ?? []), ...(state?.agent?.waiting ?? [])]) {
    if (r.kind === 'source' && r.ref) asking[r.ref] = r.status === 'picked' ? 'working on it' : state.agent.connected ? 'waiting for Claude' : 'waiting for a Claude session in your jobs folder';
  }
  // Keyboard-first reordering: once the list shows the move, focus returns to the same button of the moved row (or its
  // other one at an end), so pressing Enter again keeps moving it.
  useEffect(() => {
    if (!focus || typeof document === 'undefined' || data.rows[focus.to]?.key !== focus.key) return;
    const want = document.querySelector(`[data-move="${focus.key}:${focus.dir}"]`);
    const other = document.querySelector(`[data-move="${focus.key}:${focus.dir === 'up' ? 'down' : 'up'}"]`);
    const el = want && !want.disabled ? want : other;
    if (el) { el.focus(); setFocus(null); }
  }, [data, focus]);

  const rows = data.rows;
  const move = async (r, to, dir) => {
    const x = await onAct('sources', { op: 'move', key: r.key, to: to + 1 });
    if (x) { setSay(`${r.name} moved to position ${to + 1} of ${rows.length}`); setFocus({ key: r.key, dir, to }); }
  };
  const toggle = async (r) => { const x = await onAct('sources', { op: r.enabled ? 'disable' : 'enable', key: r.key }); if (x) setSay(`${r.name} switched ${r.enabled ? 'off' : 'on'}`); };
  const remove = async (r) => { const x = await onAct('sources', { op: 'remove', key: r.key }); if (x) setSay(`${r.name} removed from your list`); };
  const check = async (r) => { const x = await onAct('resolveSource', { key: r.key }); if (x) setSay(`Checking ${poss(r.name)} page`); };
  const ask = async (r) => { const x = await onAct('findJobsPage', { key: r.key }); if (x) setSay(`Asked Claude to find ${poss(r.name)} jobs page`); };
  const addPage = async ({ name, url, company }) => {
    const x = await onAct('sources', company ? { op: 'add', name, careers_url: url, employer: true } : { op: 'add', name, url });
    if (!x?.key) return null;
    setSay(`${name} added at the end of your list: checking its page`);
    await onAct('resolveSource', { key: x.key });
    return x.key;
  };
  const addCat = async (c) => { const x = await onAct('sources', { op: 'add', provider: c.id }); if (x) setSay(`${c.name} added at position ${rows.length + 1}`); };
  const addLinkedIn = async () => { const x = await onAct('sources', { op: 'add', linkedin: true }); if (x) setSay('LinkedIn placed at the end of your list'); };

  const fetchable = rows.filter((r) => r.enabled && r.fetch === 'auto' && r.kind !== 'linkedin').length;
  const bare = !data.coverage.unset && !data.coverage.fits && !fetchable;
  const cov = splitLine(data.coverage.line);
  return html`<div class="page srcs">
    <div class="page-head">
      <div><h1>Sources</h1>
        <p class="sub">Where Jobs looks, top first.</p></div>
      <button type="button" class="btn small" onClick=${() => onNotes(data.note.page)}>Open in Notes</button>
    </div>
    <${More} summary="How it works">
      <span>The first source is fetched first and its roles rank a little higher. The order never changes what your rules drop.</span>
      <span>Use ↑ and ↓ to change the order. Switching a source off keeps it in the list without fetching it.</span>
    </${More}>
    <p class="sr" role="status" aria-live="polite">${say}</p>
    ${data.note.errors.length ? html`<div class="banner bad"><div class="body"><b>jobs/sources.md has errors</b><span class="fix">${data.note.errors.slice(0, 3).join('; ')}. Fix them in Notes first: changes here wait until then.</span></div></div>` : null}
    <section class=${cls('card section coverage', bare && 'bare')} aria-labelledby="cov-title">
      <header><h2 id="cov-title">${data.coverage.unset ? 'Where to look starts with setup' : bare ? 'No job board covers you yet' : 'What\'s covered'}</h2></header>
      <p>${cov[0]}</p>
      ${cov[1] ? html`<${More} summary="What else works"><span>${cov[1]}</span></${More}>` : null}
      ${bare ? html`<div class="row-flex">
        <button type="button" class="btn small primary" onClick=${() => companyRef.current?.querySelector('input')?.focus()}>Add a company</button>
        ${data.linkedin.in_list ? null : html`<button type="button" class="btn small" onClick=${addLinkedIn}>Place LinkedIn in your list</button>`}
        <button type="button" class="btn small" onClick=${() => document.getElementById('add-link')?.focus()}>Paste a job link</button></div>` : null}
    </section>
    <section class="card section" aria-labelledby="yours-title">
      <header><h2 id="yours-title">Yours <span class="soft">· ${plural(rows.length, 'source')}</span></h2></header>
      ${rows.length ? html`<ol class="slist" aria-label="Your sources, in priority order">${rows.map((r, i) => html`<${Row} key=${r.key} r=${r} i=${i} count=${rows.length} data=${data} asked=${asking[r.key]}
          onMove=${move} onToggle=${toggle} onRemove=${remove} onCheck=${check} onAsk=${ask} onFeature=${onFeature} />`)}</ol>`
        : html`<p>${data.coverage.unset ? 'No sources yet. Set up with Claude, or add one below.'
          : data.suggested.length ? 'No sources yet. Add the suggested ones below.'
          : 'No sources yet. Add one below.'}</p>`}
      ${data.linkedin.in_list ? null : html`<div class="row-flex"><span class="soft small">LinkedIn isn't in your list.</span>
        <button type="button" class="btn small" onClick=${addLinkedIn}>Place LinkedIn in your list</button></div>`}
    </section>
    <${Portals} portals=${portals} onAct=${onAct} say=${setSay}
      mine=${{ countries: data.filters.regions.filter((r) => r.mine).map((r) => r.id), within: data.filters.within, fields: data.filters.mine_families }} />
    <div class="grid2 adds" ref=${companyRef}>
      <${AddPage} kind="company" data=${data} onAdd=${addPage} onAsk=${ask} asking=${asking} />
      <${AddPage} kind="address" data=${data} onAdd=${addPage} onAsk=${ask} asking=${asking} />
    </div>
    <${Catalog} data=${data} onAdd=${addCat} />
    <section class="card section" aria-labelledby="where-title">
      <header><h2 id="where-title">Where this lives</h2><p class="soft">Your list is a note you can edit.</p></header>
      <${More} summary="Details"><dl class="kv">
        <dt>Your list</dt><dd>In your notes, in <code>${data.note.file}</code>${data.note.exists ? '' : ' (made when you add your first source)'}: the order, what's on or off, your companies and web addresses. You can read and edit it in Notes; this screen and Claude change it the same way, with a line under Changes. <button type="button" class="linkbtn" onClick=${() => onNotes(data.note.page)}>Open in Notes</button></dd>
        <dt>What each fetch found</dt><dd>In Crewdeck's own state, <code>${data.state_file}</code>: counts, errors and when. Nothing to edit there.</dd>
        <dt>LinkedIn's switch</dt><dd>In Settings, changed only by you. The row above only sets where LinkedIn sits in the order.</dd>
      </dl></${More}>
    </section>
  </div>`;
}
