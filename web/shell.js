// The shell keeps one iframe per view alive, so switching is instant and each tool keeps its state.
(async function () {
  const $ = (id) => document.getElementById(id);
  const state = await (await fetch('/api/state')).json();
  document.documentElement.dataset.appearance = state.appearance;

  const ICON = {
    notes: '<svg viewBox="0 0 24 24"><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="13" cy="17" r="2.5"/><path d="M8 8l3 7M16 8l-2 7M8.5 7h7"/></svg>',
    board: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/></svg>',
    app: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16"/></svg>',
  };
  const host = `${location.protocol}//${location.hostname}`;
  const sameHost = (u) => u.replace(/^http:\/\/(localhost|127\.0\.0\.1)/, host); // same-site frames keep their storage
  // Embedded apps that understand ?appearance= follow Crewdeck's light/dark choice.
  const withAppearance = (u) => { const x = new URL(u); x.searchParams.set('appearance', state.appearance); return x.toString(); };
  const views = [
    { id: 'notes', kind: 'Notes', label: 'Memory', short: 'Notes', url: `${host}:${state.notes.port}/`, icon: ICON.notes },
    'sep',
    ...state.projects.map((p) => ({ id: `board:${p.name}`, kind: 'Board', label: p.label, short: p.label, url: `${host}:${p.boardPort}/`, icon: ICON.board })),
    ...(state.apps.length ? ['sep'] : []),
    ...state.apps.map((a) => ({ id: `app:${a.name}`, kind: 'App', label: a.label, short: a.label, url: withAppearance(sameHost(a.url)), icon: ICON[a.name] ?? ICON.app })),
  ];

  for (const v of views) {
    if (v === 'sep') { const d = document.createElement('div'); d.className = 'sep'; $('nav').appendChild(d); continue; }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav'; b.dataset.view = v.id; b.title = `${v.kind}: ${v.label}`; b.setAttribute('aria-label', `${v.kind}: ${v.label}`);
    b.innerHTML = `<span class="ico">${v.icon ?? `<span class="mono">${v.mono}</span>`}</span><span class="lbl"></span>`;
    b.querySelector('.lbl').textContent = v.short;
    b.addEventListener('click', () => show(v.id));
    $('nav').appendChild(b);
  }

  const real = views.filter((v) => v !== 'sep');
  const frames = {};
  function show(id) {
    const v = real.find((x) => x.id === id) ?? real[0];
    if (!frames[v.id]) {
      const f = document.createElement('iframe');
      f.src = v.url; f.title = `${v.kind}: ${v.label}`;
      $('frames').appendChild(f);
      frames[v.id] = f;
    }
    current = v;
    for (const [k, f] of Object.entries(frames)) f.classList.toggle('on', k === v.id);
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === v.id));
    $('kind').textContent = v.kind; $('kind').hidden = v.kind === v.label; $('crumb').textContent = v.label; $('open').href = v.url;
    try { localStorage.setItem('crewdeck:view', v.id); } catch {}
  }
  // Ask Claude: the request goes to the lane of what you're looking at (a project's board → that project).
  let current = real[0];
  const laneOf = (v) => (v.id.startsWith('board:') ? `project:${v.id.slice(6)}` : 'cockpit');
  let watching = null;
  $('ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('ask-text').value.trim();
    if (!text) return;
    const lane = laneOf(current);
    const r = await fetch('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane, text }) });
    const req = await r.json();
    if (!r.ok) { setSent(req.error ?? 'could not send', 'bad'); return; }
    $('ask-text').value = '';
    setSent(`Sent to ${lane} · waiting for Claude`);
    watching = req.id;
  });
  function setSent(t, cls = '') { $('sent').textContent = t; $('sent').className = `sent ${cls}`; $('sent').title = t; }
  setInterval(async () => {
    if (!watching) return;
    const list = await (await fetch('/api/requests')).json();
    const r = list.find((x) => x.id === watching);
    if (!r) return;
    if (r.status === 'picked') setSent(`Claude is on it (${r.lane})`);
    if (r.status === 'done' || r.status === 'failed') { setSent(`${r.status === 'done' ? '✓' : '✗'} ${r.result || r.status}`, r.status === 'done' ? 'ok' : 'bad'); watching = null; }
  }, 2000);

  let last = null;
  try { last = localStorage.getItem('crewdeck:view'); } catch {}
  show(last ?? 'notes');
})();
