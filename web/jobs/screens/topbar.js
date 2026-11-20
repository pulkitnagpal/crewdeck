// The top bar: the Jobs screens, what Claude is doing (agent strip), Add link and Find N jobs.
import { useState } from 'preact/hooks';
import { html, noop, plural, ago, clock, Icon } from '../lib.js';

export const SCREENS = [['today', 'Today'], ['sources', 'Sources'], ['applications', 'Applications'], ['knowledge', 'What Claude knows'], ['preferences', 'Preferences'], ['settings', 'Settings']];

/** connected / working / waiting / last lines, in one line. */
export function agentLine(agent) {
  if (!agent) return { dot: 'off', head: 'Connecting…', text: '' };
  const working = agent.working?.[0];
  const waiting = agent.waiting ?? [];
  const what = (r) => `${r.label}${r.role ? ` · ${r.role.company}` : ''}`;
  // What waits behind the work in hand goes in the head, which the narrow pane never cuts off: a link pasted or a Find
  // clicked while Claude applies must still show that it was queued.
  if (working) return { dot: 'busy', head: waiting.length ? `Claude is working (${waiting.length} waiting):` : 'Claude is working:', text: `${what(working)}${working.last ? ` · ${working.last.text}` : ''}` };
  if (waiting.length && !agent.connected) return { dot: 'off', head: 'No Claude session:', text: `${plural(waiting.length, 'request')} waiting` };
  if (waiting.length) return { dot: 'wait', head: 'Waiting for Claude:', text: `${what(waiting[0])}${waiting.length > 1 ? ` (+${waiting.length - 1})` : ''}` };
  if (!agent.connected) return { dot: 'off', head: 'No Claude session', text: 'on Jobs' };
  const last = agent.recent?.[0];
  return { dot: 'ok', head: 'Claude connected', text: last?.result ? `· Last: ${last.result}` : '' };
}

export function AgentStrip({ agent }) {
  const l = agentLine(agent);
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
  const since = src.since ? `since ${new Date(src.since).toDateString() === new Date(now).toDateString() ? clock(src.since) : new Date(src.since).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'waiting';
  const head = src.running ? 'Fetching roles…' : `${plural(src.new_since ?? 0, 'new role')} ${since}`;
  const last = src.last?.finished ? ` · fetched ${ago(src.last.finished, now)}${src.last.ok ? '' : ' (with errors)'}` : src.running ? '' : ' · not fetched yet';
  const title = [src.last?.error, src.next_at && !src.running ? `next fetch ${clock(src.next_at)}` : '', `${plural(src.waiting ?? 0, 'role')} waiting to be judged`].filter(Boolean).join(' · ');
  return { text: `${head}${last}`, title, refresh: !src.running };
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

export function TopBar({ screen, onNav = noop, agent, quota = 5, onFind = noop, onLink = noop, setupNeeded = false, sources = null, onRefresh = noop }) {
  return html`<header class="top">
    <nav class="tabsnav" aria-label="Jobs">
      ${SCREENS.map(([k, label]) => html`<button type="button" aria-current=${screen === k ? 'page' : undefined} onClick=${() => onNav(k)}>${label}</button>`)}
    </nav>
    <span class="grow"></span>
    <span class="break"></span>
    <${AgentStrip} agent=${agent} />
    <${SourcesStrip} sources=${sources} onRefresh=${onRefresh} onSources=${() => onNav('sources')} />
    <${AddLink} onAdd=${onLink} />
    <button type="button" class="btn primary find" onClick=${onFind} disabled=${setupNeeded} title=${setupNeeded ? 'Set up Jobs first' : `Claude judges the best candidates and picks ${quota}`}>
      Find ${quota} jobs
    </button>
  </header>`;
}
