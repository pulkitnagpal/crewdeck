// The Find sheet: a dialog opened by "Find jobs". The person chooses what Claude spends (which of their accounts to read now,
// how many postings to judge, how many picks to prepare), sees the estimate, and only then starts it. Focus stays inside
// while it is open, Esc closes it, and focus goes back to the button that opened it.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { html, noop, plural, Icon, Spark } from '../lib.js';
import { effectiveState } from './portals.js';

export const BUDGETS = [20, 40, 80];
export const PREPARES = [3, 5, 0];
/** What one page read, one posting judged and one pick prepared cost, in tokens (the sheet's estimate). */
export const PAGE_TOKENS = 5000, JUDGED_TOKENS = 1300, PREPARED_TOKENS = 12000;

/** tokens ≈ pages × 5k + judged × 1.3k + prepared × 12k; minutes are rough (a page ¼ min, ten judged ¼ min, a pick 1 min). */
export function estimate({ pages = 0, judged = 0, prepared = 0 }) {
  const tokens = pages * PAGE_TOKENS + judged * JUDGED_TOKENS + prepared * PREPARED_TOKENS;
  const minutes = Math.max(1, Math.round(pages * 0.25 + (judged / 10) * 0.25 + prepared));
  return { tokens, minutes };
}
/** "≈ 70k" for a token count, to the nearest 5k above 20k (an estimate shouldn't look exact). */
export const tokenText = (t) => `≈ ${t >= 20_000 ? Math.round(t / 5000) * 5 : Math.max(1, Math.round(t / 1000))}k`;

/** The accounts the sheet offers: connected and switched on (the same ones Find would read). */
export const readable = (portals) => (Array.isArray(portals) ? portals : []).filter((p) => effectiveState(p) === 'connected' && p.enabled);

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function FindSheet({ portals = null, titles = [], found = 0, quota = 5, onClose = noop, onFind = noop, onSources = noop }) {
  const accounts = readable(portals);
  const [picked, setPicked] = useState(null);
  const [budget, setBudget] = useState(40);
  const [prepare, setPrepare] = useState(3);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  // The accounts start ticked, once the list is known.
  const on = picked ?? new Set(accounts.map((p) => p.id));
  const pages = accounts.filter((p) => on.has(p.id)).reduce((n, p) => n + (p.pages ?? p.searches ?? 3), 0);
  const est = estimate({ pages, judged: budget, prepared: Math.min(prepare, quota) });

  // Focus: into the dialog on open (before the first paint), back to the opener on close; Tab stays inside; Esc closes.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    box.current?.querySelector('input, select, button')?.focus();
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); try { opener?.focus?.(); } catch {} };
  }, []);

  const toggle = (id) => { const next = new Set(on); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  const arrow = (e) => {
    const i = BUDGETS.indexOf(budget);
    const j = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(BUDGETS.length - 1, i + 1) : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(0, i - 1) : i;
    if (j !== i) { e.preventDefault(); setBudget(BUDGETS[j]); e.currentTarget.parentElement.querySelectorAll('button')[j]?.focus(); }
  };
  const go = async () => {
    setBusy(true);
    const ok = await onFind({ count: quota, portals: accounts.filter((p) => on.has(p.id)).map((p) => p.id), budget, prepare });
    setBusy(false);
    if (ok !== false) onClose();
  };
  const shown = titles.slice(0, 5);

  return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section class="sheet" role="dialog" aria-modal="true" aria-labelledby="find-h" ref=${box}>
      <div class="sheet-head">
        <div class="grow"><h2 id="find-h">Find jobs for you</h2><p class="soft">Claude reads, judges and prepares. You decide what it spends.</p></div>
        <button type="button" class="iconbtn" aria-label="Close" onClick=${onClose}><${Icon} name="close" size=${14} /></button>
      </div>
      <div class="sheet-sec">
        <h3 class="eyebrow">Read your accounts now</h3>
        ${accounts.length ? accounts.map((p) => html`<label class="checkrow" key=${p.id}>
            <input type="checkbox" checked=${on.has(p.id)} onChange=${() => toggle(p.id)} />
            <span class="grow">${p.name}</span><span class="soft">${plural(p.searches ?? 3, 'search', 'searches')}</span></label>`)
          : html`<p class="soft">${Array.isArray(portals) ? 'No account is connected and switched on: Claude judges what your feeds already found.' : 'Checking your accounts…'}
            ${Array.isArray(portals) ? html` <button type="button" class="linkbtn" onClick=${() => { onClose(); onSources(); }}>Connect an account</button>` : null}</p>`}
        ${accounts.length && shown.length ? html`<p class="soft small">Searches cover all your titles: ${shown.join(', ')}${titles.length > shown.length ? ', …' : ''}.</p>` : null}
      </div>
      <div class="sheet-sec">
        <h3 class="eyebrow">Judge</h3>
        <div class="optrow">
          <span class="grow" id="budget-l">Best matches Claude reads</span>
          <div class="seg" role="radiogroup" aria-labelledby="budget-l">
            ${BUDGETS.map((n) => html`<button type="button" role="radio" key=${n} aria-checked=${budget === n ? 'true' : 'false'} onKeyDown=${arrow} onClick=${() => setBudget(n)}>${n}</button>`)}
          </div>
        </div>
        <p class="soft small">From ${Number(found).toLocaleString('en-US')} already found, best first. It stops early once ${quota} companies fit.</p>
        <div class="optrow">
          <label class="grow" for="prepare-n">Prepare the top</label>
          <select id="prepare-n" class="select" value=${String(prepare)} onChange=${(e) => setPrepare(Number(e.currentTarget.value))}>
            ${PREPARES.map((n) => html`<option value=${String(n)} selected=${prepare === n}>${n}</option>`)}
          </select>
        </div>
      </div>
      <div class="estimate" role="status" aria-label="Estimate">
        <div><b>${tokenText(est.tokens)}</b><span>tokens</span></div>
        <div><b>≈ ${est.minutes} min</b><span>in a Jobs chat</span></div>
        <div><b>up to ${quota}</b><span>picks, never padded</span></div>
      </div>
      <div class="sheet-foot">
        <button type="button" class="btn big2" onClick=${onClose}>Cancel</button>
        <button type="button" class="btn primary big2" disabled=${busy} onClick=${go}><${Spark} size=${16} />Find</button>
      </div>
    </section>
  </div>`;
}
