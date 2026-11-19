// The Jobs page: one screen at a time (#today, #applications, #knowledge, #preferences, #settings), live while Claude
// works (server-sent events), every change through the page's own actions.
import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { html, notesUrl } from './lib.js';
import { act, get, live } from './api.js';
import { TopBar, SCREENS } from './screens/topbar.js';
import { Banners } from './screens/banners.js';
import { Today } from './screens/today.js';
import { Applications } from './screens/applications.js';
import { Knowledge } from './screens/knowledge.js';
import { Preferences } from './screens/preferences.js';
import { Settings } from './screens/settings.js';

const screenOf = () => { const s = location.hash.slice(1).split('/')[0]; return SCREENS.some(([k]) => k === s) ? s : 'today'; };

function App() {
  const [screen, setScreen] = useState(screenOf);
  const [state, setState] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('profile');
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState('');
  const sentLinks = useRef(new Map());
  const toastTimer = useRef(null);

  const say = useCallback((text, bad = false) => {
    setToast({ text, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), bad ? 6000 : 3000);
  }, []);

  const load = useCallback(async () => {
    try {
      const path = screen === 'today' ? `today${selected ? `?role=${selected}` : ''}` : screen === 'knowledge' ? `knowledge?tab=${tab}` : screen;
      const [s, d] = await Promise.all([get('state'), get(path)]);
      setState(s); setData({ screen, tab, d }); setError('');
    } catch (e) { setError(e.message); }
  }, [screen, selected, tab]);

  const latest = useRef(load);
  latest.current = load;
  useEffect(() => { load(); }, [load]);
  // Live: one stream for the page's lifetime; bursts (a CLI command writes several rows) coalesce into one reload.
  useEffect(() => {
    let t = null;
    const stop = live(() => { clearTimeout(t); t = setTimeout(() => latest.current(), 120); });
    return () => { stop(); clearTimeout(t); };
  }, []);
  useEffect(() => {
    const on = () => setScreen(screenOf());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);

  /** Run an action; errors become a toast. Returns the answer, or null. */
  const run = useCallback(async (name, body, ok) => {
    try {
      const r = await act(name, body);
      const m = typeof ok === 'function' ? ok(r) : ok;
      if (m) say(m);
      load();
      return r;
    }
    catch (e) { say(e.message, true); return null; }
  }, [load, say]);

  // Notes opens in the shell's Notes view (same origin); alone, in a new tab.
  const openNotes = useCallback((page) => {
    if (window.parent !== window) { try { window.parent.postMessage({ type: 'crewdeck:open-notes', page }, location.origin); return; } catch {} }
    window.open(notesUrl(state?.notesPort ?? 4849, page), '_blank', 'noopener');
  }, [state]);

  const nav = (k) => { location.hash = k; setScreen(k); };
  const actions = {
    onSelect: (id) => { setSelected(id); act('select', { role: id }).catch(() => {}); },
    onAnswer: (role, v) => run('answer', { role, ...v }, (r) => (r.reapplied ? 'Remembered. Claude continues the application.' : 'Remembered for every later form')),
    onEdit: (role, field_id, text) => run('editAnswer', { role, field_id, text }, 'Saved as your words'),
    onImprove: (role, field_id, instruction) => run('improve', { role, field_id, instruction }, 'Sent to Claude'),
    onSkip: (role, reason, titleWords) => run('notInterested', { role, reason, titleWords }, 'Skipped. Your reason is remembered.').then(() => setSelected(null)),
    onApply: (role) => run('approve', { role }, (r) => (r.mode === 'copy' ? 'This site takes answers you copy in' : 'Sent to Claude')),
    onMarkApplied: (role) => run('markApplied', { role }, 'Marked applied'),
    onCancel: (request) => run('cancel', { request }, 'Cancelled'),
    onReveal: (role) => run('reveal', { role }),
    onSetup: () => run('setup', {}, 'Claude will start the setup in the chat'),
    onNotes: openNotes,
    onToast: say,
  };
  const onLink = async (url) => {
    const r = await run('addLink', { url }, 'Link sent to Claude');
    if (r?.request) sentLinks.current.set(r.request, url);
    return !!r;
  };

  const d = data?.d;
  const ready = d && data.screen === screen;
  let body;
  if (!state || !ready) body = html`<p class="loading">${error || 'Loading…'}</p>`;
  else if (screen === 'today') body = html`<${Today} data=${d} state=${state} actions=${actions} />`;
  else if (screen === 'applications') body = html`<${Applications} data=${d} />`;
  else if (screen === 'knowledge') body = html`<${Knowledge} data=${d} onTab=${setTab} onNotes=${openNotes} />`;
  else if (screen === 'preferences') body = html`<${Preferences} key=${JSON.stringify(d.values)} data=${d} onNotes=${openNotes} onSave=${(changes) => run('prefs', { changes }, (r) => (r.ok ? 'Saved to jobs/search.md' : null))} />`;
  else body = html`<${Settings} data=${d} onSet=${(name, value) => run('feature', { name, value }, (r) => (r.ok ? `${name.replace(/_/g, ' ')}: ${value === true ? 'on' : value === false ? 'off' : value}` : null))} />`;

  // A link Claude couldn't pick (cooldown, already applied): offer the user's override, set by this click only.
  const warned = (state?.agent?.recent ?? []).find((r) => r.kind === 'link' && sentLinks.current.has(r.id) && /warning|cooldown|already|in progress/i.test(r.result ?? ''));
  return html`<div class="app">
    <${TopBar} screen=${screen} onNav=${nav} agent=${state?.agent} quota=${state?.quota ?? 5} setupNeeded=${!!state?.setup?.needed}
      onFind=${() => run('find', { count: state?.quota ?? 5 }, 'Sent to Claude')} onLink=${onLink}
      sources=${state?.sources} onRefresh=${() => run('refreshSources', {}, (r) => (r.already ? 'Already fetching' : 'Fetching new roles (no Claude needed)'))} />
    <${Banners} state=${state} onNotes=${openNotes} onToast=${say} />
    ${warned ? html`<div class="banners"><div class="banner warn"><div class="body"><b>That link wasn't added</b><span class="fix">${warned.result}</span></div>
      <div class="row-flex"><button type="button" class="btn small" onClick=${() => { const url = sentLinks.current.get(warned.id); sentLinks.current.delete(warned.id); run('addLink', { url, force: true }, 'Sent to Claude: add it anyway'); }}>Add it anyway</button>
      <button type="button" class="btn quiet small" onClick=${() => { sentLinks.current.delete(warned.id); load(); }}>Dismiss</button></div></div></div>` : null}
    <main class=${`content${screen === 'today' && d?.queue?.length ? ' fixed' : ''}`} id="main">${body}</main>
    ${toast ? html`<div class=${`toast${toast.bad ? ' bad' : ''}`} role=${toast.bad ? 'alert' : 'status'}>${toast.text}</div>` : null}
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
