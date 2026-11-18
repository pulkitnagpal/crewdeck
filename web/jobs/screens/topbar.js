// The top bar: the Jobs screens, what Claude is doing (agent strip), Add link and Find N jobs.
import { useState } from 'preact/hooks';
import { html, noop, plural, Icon } from '../lib.js';

export const SCREENS = [['today', 'Today'], ['applications', 'Applications'], ['knowledge', 'What Claude knows'], ['preferences', 'Preferences'], ['settings', 'Settings']];

/** connected / working / waiting / last lines, in one line. */
export function agentLine(agent) {
  if (!agent) return { dot: 'off', head: 'Connecting…', text: '' };
  const working = agent.working?.[0];
  const what = (r) => `${r.label}${r.role ? ` · ${r.role.company}` : ''}`;
  if (working) return { dot: 'busy', head: 'Claude is working:', text: `${what(working)}${working.last ? ` · ${working.last.text}` : ''}` };
  const waiting = agent.waiting ?? [];
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

export function TopBar({ screen, onNav = noop, agent, quota = 5, onFind = noop, onLink = noop, setupNeeded = false }) {
  return html`<header class="top">
    <nav class="tabsnav" aria-label="Jobs">
      ${SCREENS.map(([k, label]) => html`<button type="button" aria-current=${screen === k ? 'page' : undefined} onClick=${() => onNav(k)}>${label}</button>`)}
    </nav>
    <span class="grow"></span>
    <span class="break"></span>
    <${AgentStrip} agent=${agent} />
    <${AddLink} onAdd=${onLink} />
    <button type="button" class="btn primary find" onClick=${onFind} disabled=${setupNeeded} title=${setupNeeded ? 'Set up Jobs first' : `Claude judges the best candidates and picks ${quota}`}>
      Find ${quota} jobs
    </button>
  </header>`;
}
