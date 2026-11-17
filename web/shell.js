// The shell keeps one iframe per view alive, so switching is instant and each tool keeps its state.
(async function () {
  const $ = (id) => document.getElementById(id);
  const state = await (await fetch('/api/state')).json();
  const views = [{ id: 'notes', label: 'Notes', url: state.notes }]
    .concat(state.projects.map((p) => ({ id: `board:${p.name}`, label: `${p.name} · Board`, url: `${location.protocol}//${location.hostname}:${p.boardPort}/`, short: p.name.slice(0, 2).toUpperCase() })));

  for (const v of views.slice(1)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'nav'; b.dataset.view = v.id; b.textContent = v.short;
    b.title = v.label; b.setAttribute('aria-label', v.label);
    $('projects').appendChild(b);
  }

  const frames = {};
  function show(id) {
    const v = views.find((x) => x.id === id) ?? views[0];
    if (!frames[v.id]) {
      const f = document.createElement('iframe');
      f.src = v.url; f.title = v.label;
      $('frames').appendChild(f);
      frames[v.id] = f;
    }
    for (const [k, f] of Object.entries(frames)) f.classList.toggle('on', k === v.id);
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === v.id));
    $('crumb').textContent = v.label;
    $('open').href = v.url;
    try { localStorage.setItem('crewdeck:view', v.id); } catch {}
  }

  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  let last = null;
  try { last = localStorage.getItem('crewdeck:view'); } catch {}
  show(last ?? 'notes');
})();
