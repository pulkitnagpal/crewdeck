// The top bar: the Jobs screens, what Claude is doing (agent strip), Add link and Find N jobs.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, noop, plural, ago, clock, Icon, Spark } from '../lib.js';

/** The four tabs (the page's hash names stay: today is For you, applications is Applied), and what lives behind More. */
export const SCREENS = [['today', 'For you'], ['explore', 'Explore'], ['applications', 'Applied'], ['sources', 'Sources']];
export const MORE = [['knowledge', 'What Claude knows'], ['preferences', 'Preferences'], ['settings', 'Settings']];
export const ALL_SCREENS = [...SCREENS, ...MORE];
const ICON = { today: 'sparkle', explore: 'search', applications: 'check', sources: 'feed' };
const num = (n) => Number(n ?? 0).toLocaleString('en-US');

/** connected / working / waiting / last lines, in one line. */
export function agentLine(agent) {
  if (!agent) return { dot: 'off', head: 'Connecting…', text: '' };
  const working = agent.working?.[0];
  const waiting = agent.waiting ?? [];
  const what = (r) => `${r.label}${r.role ? ` · ${r.role.company}` : ''}`;
  // What waits behind the work in hand goes in the head, which the narrow pane never cuts off: a link pasted or a Find
  // clicked while Claude applies must still show that it was queued.
  if (working) return { dot: 'busy', head: waiting.length ? `Claude is working (${waiting.length} waiting):` : 'Claude is working:', text: `${what(working)}${working.last ? ` · ${working.last.text}` : ''}` };
  // P4: Crewdeck opened a Jobs chat in front for it (hold: 'chat'): the person confirms the folder and presses Enter there.
  const inFront = waiting.find((r) => r.hold === 'chat');
  if (inFront && !working) return { dot: 'wait', head: 'A Jobs chat opened for this:', text: `${what(inFront)} · confirm the folder, then press Enter there` };
  if (waiting.length && !agent.connected) return { dot: 'off', head: 'No Claude session:', text: `${plural(waiting.length, 'request')} waiting` };
  // Find waits for a fresh fetch (hold: 'fetching') before Claude reads anything: say so rather than "waiting".
  if (waiting.length && waiting[0].hold === 'fetching') return { dot: 'busy', head: 'Fetching new postings first…', text: `${what(waiting[0])}${waiting.length > 1 ? ` (+${waiting.length - 1})` : ''}` };
  if (waiting.length) return { dot: 'wait', head: 'Waiting for Claude:', text: `${what(waiting[0])}${waiting.length > 1 ? ` (+${waiting.length - 1})` : ''}` };
  // Idle (no work in hand or waiting): nothing to say; Jobs chats open when you ask for something.
  return null;
}

export function AgentStrip({ agent }) {
  const l = agentLine(agent);
  if (!l) return null;
  return html`<div class="agent" role="status" aria-live="polite">
    <span class=${`dot ${l.dot}`} aria-hidden="true"></span>
    <span class="txt" title=${`${l.head} ${l.text}`}><b>${l.head}</b> ${l.text}</span>
  </div>`;
}

/** "12 new roles since 09:40 · fetched 2 h ago": what scheduled sourcing found, in one line (design §2.4). */
export function sourcesLine(src, now = Date.now()) {
  if (!src) return null;
  if (!src.ready) return { text: 'Job boards not set up', title: 'Run crewdeck jobs providers install (pasted links work without them)', refresh: false };
  // No source switched on yet (a new user before setup): nothing to fetch, so say where they come from instead.
  if (src.listed === 0 && !src.running) return { text: 'No sources yet', title: 'Setup with Claude proposes sources; or add them on the Sources tab', refresh: false, sources: true };
  const head = src.running ? 'Fetching roles…' : (src.new_since ?? 0) > 0 ? plural(src.new_since, 'new role') : '';
  // "Feeds updated 2 h ago": the automatic, free fetch of the job boards and career sites.
  const last = src.last?.finished ? `Feeds updated ${ago(src.last.finished, now)}${src.last.ok ? '' : ' (with errors)'}` : src.running ? '' : 'Feeds not fetched yet';
  const title = [src.last?.error, src.next_at && !src.running ? `next fetch ${clock(src.next_at)}` : '', `${plural(src.waiting ?? 0, 'role')} waiting to be judged`].filter(Boolean).join(' · ');
  return { text: [head, last].filter(Boolean).join(' · '), title, refresh: !src.running };
}

export function SourcesStrip({ sources, onRefresh = noop, onSources = noop }) {
  const l = sourcesLine(sources);
  if (!l) return null;
  return html`<div class=${`sources${l.sources ? ' short' : ''}`} role="status" title=${l.title}>
    <span class="txt">${l.text}</span>
    ${l.refresh ? html`<button type="button" class="linkbtn" onClick=${onRefresh}>Refresh sources</button>` : null}
    ${l.sources ? html`<button type="button" class="linkbtn" onClick=${onSources}>Open Sources</button>` : null}
  </div>`;
}

export function AddLink({ onAdd = noop }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    if (!v.trim()) return;
    setBusy(true);
    const ok = await onAdd(v.trim());
    setBusy(false);
    if (ok) setV('');
  };
  return html`<form class="addlink" onSubmit=${go}>
    <label class="sr" for="add-link">Paste a job link</label>
    <${Icon} name="link" size=${14} />
    <input id="add-link" type="url" inputmode="url" placeholder="Paste a job link" value=${v} onInput=${(e) => setV(e.currentTarget.value)} />
    <button type="submit" class="btn small" disabled=${!v.trim() || busy}>Add link</button>
  </form>`;
}

/** The tab's number: picks waiting, roles in Explore, roles applied to (none on Sources). */
export function tabCount(k, counts) {
  const n = k === 'today' ? counts?.picks : k === 'explore' ? counts?.explore : k === 'applications' ? counts?.applied : undefined;
  return n === undefined || n === null ? null : num(n);
}

/** What Claude's own tab and the screens behind More are called on a phone's header. */
export const titleOf = (screen) => (ALL_SCREENS.find(([k]) => k === screen) ?? ['', 'Jobs'])[1];

/** The overflow menu: What Claude knows, Preferences and Settings stay reachable without being tabs. */
export function MoreMenu({ screen, onNav = noop }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const current = MORE.some(([k]) => k === screen);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); wrap.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return html`<div class="moremenu" ref=${wrap}>
    <button type="button" class=${`morebtn${current ? ' on' : ''}`} aria-haspopup="true" aria-expanded=${open ? 'true' : 'false'} aria-controls="more-menu" aria-label="More: What Claude knows, Preferences, Settings" onClick=${() => setOpen(!open)}>
      <${Icon} name="dots" size=${18} /><span class="lbl">More</span>
    </button>
    ${open ? html`<ul class="menu" id="more-menu">
      ${MORE.map(([k, label]) => html`<li key=${k}><button type="button" aria-current=${screen === k ? 'page' : undefined} onClick=${() => { setOpen(false); onNav(k); }}>${label}</button></li>`)}
    </ul>` : null}
  </div>`;
}

/** The phone's bottom bar: the four tabs, icon over label (the top tabs hide below 700 px, this shows). */
export function BottomTabs({ screen, onNav = noop, counts = null }) {
  return html`<nav class="bottombar" aria-label="Jobs sections">
    ${SCREENS.map(([k, label]) => html`<button type="button" key=${k} aria-current=${screen === k ? 'page' : undefined} onClick=${() => onNav(k)}>
      <${Icon} name=${ICON[k]} size=${20} /><span>${label}</span>${tabCount(k, counts) ? html`<span class="sr"> ${tabCount(k, counts)}</span>` : null}</button>`)}
  </nav>`;
}

export function TopBar({ screen, onNav = noop, agent, quota = 5, onFind = noop, onLink = noop, setupNeeded = false, sources = null, onRefresh = noop, counts = null, narrow = false }) {
  return html`<header class="top">
    <div class="toprow">
      <span class="brand">Jobs</span>
      <span class="phonetitle">${titleOf(screen)}</span>
      <nav class="tabsnav" aria-label="Jobs sections">
        ${SCREENS.map(([k, label]) => html`<button type="button" aria-current=${screen === k ? 'page' : undefined} onClick=${() => onNav(k)}>${label}${tabCount(k, counts) ? html` <span class="n">${tabCount(k, counts)}</span>` : null}</button>`)}
      </nav>
      <span class="grow"></span>
      <${MoreMenu} screen=${screen} onNav=${onNav} />
      <button type="button" class="btn primary find" onClick=${onFind} disabled=${setupNeeded} title=${setupNeeded ? 'Set up Jobs first' : `Choose what Claude reads, then it picks up to ${quota}`}>
        <${Spark} size=${16} />Find jobs
      </button>
    </div>
    ${agentLine(agent) ? html`<div class="topsub"><${AgentStrip} agent=${agent} /></div>` : null}
  </header>`;
}
