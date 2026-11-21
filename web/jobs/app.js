// The Jobs page: one screen at a time (#today, #sources, #applications, #knowledge, #preferences, #settings), live while Claude
// works (server-sent events), every change through the page's own actions.
import { render } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { html, notesUrl } from './lib.js';
import { act, get, live, preview } from './api.js';
import { TopBar, SCREENS } from './screens/topbar.js';
import { Banners } from './screens/banners.js';
import { Today } from './screens/today.js';
import { Applications } from './screens/applications.js';
import { Knowledge } from './screens/knowledge.js';
import { Preferences } from './screens/preferences.js';
import { Settings } from './screens/settings.js';
import { Sources } from './screens/sources.js';

const screenOf = () => { const s = location.hash.slice(1).split('/')[0]; return SCREENS.some(([k]) => k === s) ? s : 'today'; };

function App() {
  const [screen, setScreen] = useState(screenOf);
  const [state, setState] = useState(null);
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('profile');
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState('');
  // A change opened from Find's card (or "See the preview"): Preferences starts with it filled in, unsaved.
  const [pending, setPending] = useState(null);
  // The preview behind Today's "Why so few?" fixes, fetched once per stored funnel.
  const [todayPv, setTodayPv] = useState(null);
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
      // Sources also lists the signed-in portals (ADR-0008); a Crewdeck without them answers 404 and the section hides.
      const [s, d, portals] = await Promise.all([get('state'), get(path), screen === 'sources' ? get('portals').catch(() => null) : null]);
      setState(s); setData({ screen, tab, d, portals: portals?.portals ?? null, portalsMode: portals?.mode ?? 'profile' }); setError('');
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

  const nav = (k) => {
    if (k !== 'preferences') setPending(null);
    if (k !== 'today') setTodayPv(null); // back on Today, the fixes are counted on the notes as they are then
    location.hash = k; setScreen(k);
  };
  const funnelAt = data?.screen === 'today' ? data.d?.find?.funnel?.at : null;
  useEffect(() => {
    if (!funnelAt || todayPv?.at === funnelAt) return;
    preview({}).then((r) => setTodayPv({ at: funnelAt, r })).catch(() => setTodayPv({ at: funnelAt, r: { ok: false, suggestions: [] } }));
  }, [funnelAt]);
  // P4: Find, Prepare and Apply open a Jobs chat in front (or go to the Jobs chat that is free).
  const sent = (r) => (r?.opened ? 'A Jobs chat is opening in front of you: confirm the folder, then press Enter' : 'Sent to your Jobs chat');
  const actions = {
    onSelect: (id) => { setSelected(id); act('select', { role: id }).catch(() => {}); },
    onAnswer: (role, v) => run('answer', { role, ...v }, (r) => (r.reapplied ? 'Remembered. Claude continues the application.' : 'Remembered for every later form')),
    onEdit: (role, field_id, text) => run('editAnswer', { role, field_id, text }, 'Saved as your words'),
    onImprove: (role, field_id, instruction) => run('improve', { role, field_id, instruction }, 'Sent to Claude'),
    onSkip: (role, reason, titleWords) => run('notInterested', { role, reason, titleWords }, 'Skipped. Your reason is remembered.').then(() => setSelected(null)),
    onApply: (role) => run('approve', { role }, (r) => (r.mode === 'copy' ? 'This site takes answers you copy in' : sent(r))),
    onPrepare: (role) => run('prepare', { role }, (r) => (r.prepared ? 'Already prepared' : sent(r))),
    onMarkApplied: (role) => run('markApplied', { role }, 'Marked applied'),
    onCancel: (request) => run('cancel', { request }, 'Cancelled'),
    onReveal: (role) => run('reveal', { role }),
    onOpenSession: (request) => run('openSession', typeof request === 'number' ? { request } : {}, 'Claude desktop is opening: confirm the folder, then press Enter'),
    onSetup: () => run('setup', {}, 'Claude will start the setup in the chat'),
    onNotes: openNotes,
    onToast: say,
    onFix: (s) => { setPending({ changes: s.change, from: 'find' }); nav('preferences'); },
    onPreview: () => { setPending({ changes: {}, from: 'find' }); nav('preferences'); },
    onSources: () => nav('sources'),
    onDryRun: (changes) => preview({ search: changes }),
    // Tell Crewdeck (P3): queued for a Jobs chat; proposals are approved or rejected item by item.
    onTell: async (text) => !!(await run('tell', { text }, (r) => (r.opened_chat ? 'Sent: a Jobs chat is opening for it' : 'Sent to Claude'))),
    onApproveProposal: (id, item) => run('approveProposal', { id, item }, (r) => (r.failed?.length ? null : 'Approved')).then((r) => { if (r?.failed?.length) say(r.failed[0], true); }),
    onRejectProposal: (id, item) => run('rejectProposal', { id, item }, 'Rejected'),
    onApproveAllProposals: async (ids) => {
      let failed = [];
      for (const id of ids) { const r = await run('approveProposal', { id }); failed = failed.concat(r?.failed ?? []); }
      say(failed.length ? failed[0] : 'All approved', !!failed.length);
    },
    onUndoProposal: (id, item) => run('undoProposal', { id, item }, 'Undone'),
  };
  const onFeature = (name, value) => run('feature', { name, value }, (r) => (r.ok ? `${name.replace(/_/g, ' ')}: ${value === true ? 'on' : value === false ? 'off' : value}` : null));
  const onLink = async (url) => {
    const r = await run('addLink', { url }, 'Link sent to Claude');
    if (r?.request) sentLinks.current.set(r.request, url);
    return !!r;
  };

  const d = data?.d;
  const ready = d && data.screen === screen;
  let body;
  if (!state || !ready) body = html`<p class="loading">${error || 'Loading…'}</p>`;
  else if (screen === 'today') body = html`<${Today} data=${d} state=${state} preview=${todayPv?.at === d.find?.funnel?.at ? todayPv?.r : null} actions=${actions} />`;
  else if (screen === 'applications') body = html`<${Applications} data=${d} />`;
  else if (screen === 'knowledge') body = html`<${Knowledge} data=${d} onTab=${setTab} onNotes=${openNotes} />`;
  else if (screen === 'preferences') {
    body = html`<${Preferences} key=${JSON.stringify([d.values, pending])} data=${d} pending=${pending} onNotes=${openNotes} onPreview=${(changes) => preview({ search: changes })}
      onSave=${async (changes, from) => { const r = await run('prefs', { changes, ...(from ? { from } : {}) }, (x) => (x.ok ? 'Saved to jobs/search.md' : null)); if (r?.ok) setPending(null); return r; }} />`;
  }
  else if (screen === 'sources') body = html`<${Sources} data=${d} state=${state} portals=${data.portals} portalsMode=${data.portalsMode} onAct=${(name, b) => run(name, b)} onFeature=${onFeature} onNotes=${openNotes} />`;
  else body = html`<${Settings} data=${d} onSet=${onFeature} />`;

  // A link Claude couldn't pick (cooldown, already applied): offer the user's override, set by this click only.
  const warned = (state?.agent?.recent ?? []).find((r) => r.kind === 'link' && sentLinks.current.has(r.id) && /warning|cooldown|already|in progress/i.test(r.result ?? ''));
  return html`<div class="app">
    <${TopBar} screen=${screen} onNav=${nav} agent=${state?.agent} quota=${state?.quota ?? 5} setupNeeded=${!!state?.setup?.needed}
      onFind=${() => run('find', { count: state?.quota ?? 5 }, sent)} onLink=${onLink}
      sources=${state?.sources} onRefresh=${() => run('refreshSources', {}, (r) => (r.already ? 'Already fetching' : 'Fetching new roles (no Claude needed)'))} />
    <${Banners} state=${state} onNotes=${openNotes} onToast=${say} onOpenSession=${actions.onOpenSession} />
    ${warned ? html`<div class="banners"><div class="banner warn"><div class="body"><b>That link wasn't added</b><span class="fix">${warned.result}</span></div>
      <div class="row-flex"><button type="button" class="btn small" onClick=${() => { const url = sentLinks.current.get(warned.id); sentLinks.current.delete(warned.id); run('addLink', { url, force: true }, 'Sent to Claude: add it anyway'); }}>Add it anyway</button>
      <button type="button" class="btn quiet small" onClick=${() => { sentLinks.current.delete(warned.id); load(); }}>Dismiss</button></div></div></div>` : null}
    <main class=${`content${screen === 'today' && d?.queue?.length ? ' fixed' : ''}`} id="main">${body}</main>
    ${toast ? html`<div class=${`toast${toast.bad ? ' bad' : ''}`} role=${toast.bad ? 'alert' : 'status'}>${toast.text}</div>` : null}
  </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
