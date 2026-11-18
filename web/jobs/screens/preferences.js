// Preferences: a form over jobs/search.md. It saves through the same validated path as `crewdeck jobs pref set`: all
// changed fields at once, or none with the reason next to each field; every change gets a line under ## Changes.
import { useState } from 'preact/hooks';
import { html, noop, cls, plural } from '../lib.js';

const LIST = new Set(['roles.titles', 'roles.seniority_prefer', 'roles.exclude_title_words', 'places.onsite', 'places.remote_from', 'licenses', 'exclude.companies', 'exclude.industries']);
const CHECKS = new Set(['workplace', 'employment_types']);
const NUM = new Set(['places.commute_km', 'pay.floor', 'schedule.daily_picks', 'schedule.cooldown_days']);
const WORDS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', top_of_range: 'the top of the range reaches it', bottom_of_range: 'the bottom of the range reaches it', keep: 'keep them', drop: 'drop them', none: 'nothing', occasional: 'occasional or more', frequent: 'frequent travel', year: 'a year', month: 'a month', hour: 'an hour' };
const word = (v) => WORDS[v] ?? v;
const norm = (p) => String(p ?? '').replace(/\[(\d+)\]/g, '.$1');

/** The form's working values: lists as one entry per line, so commas inside a place ("Cambridge, MA") survive. */
function toForm(values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (LIST.has(k)) out[k] = (v ?? []).join('\n');
    else if (NUM.has(k)) out[k] = v === null || v === undefined ? '' : String(v);
    else if (k === 'languages') out[k] = (v ?? []).map((l) => ({ name: l.name ?? '', level: l.level ?? '' }));
    else if (k === 'needs_sponsorship') out[k] = v === true ? 'yes' : v === false ? 'no' : '';
    else out[k] = v ?? (CHECKS.has(k) ? [] : '');
  }
  return out;
}

/** The value the server takes for one field. */
function fromForm(k, v) {
  if (LIST.has(k)) return v.split('\n').map((x) => x.trim()).filter(Boolean);
  if (NUM.has(k)) return v.trim() === '' ? NaN : Number(v);
  if (k === 'languages') return v.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), ...(l.level ? { level: l.level } : {}) }));
  if (k === 'needs_sponsorship') return v === 'yes';
  return v;
}

export function Preferences({ data, onSave = noop, onNotes = noop }) {
  const [init] = useState(() => toForm(data.values));
  const [vals, setVals] = useState(init);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  if (!data.exists) {
    return html`<div class="page narrow"><div class="card section"><h1>Preferences</h1><p class="soft">jobs/search.md is missing. Set up Jobs first (Today → Set up with Claude), or copy it from vault-template.</p></div></div>`;
  }
  const changed = Object.keys(vals).filter((k) => JSON.stringify(vals[k]) !== JSON.stringify(init[k]));
  const noteIssues = data.issues.filter((i) => i.level === 'error');
  const errFor = (k) => [...errors, ...noteIssues].filter((e) => norm(e.path) === k || norm(e.path).startsWith(`${k}.`)).map((e) => e.message);
  const set = (k, v) => setVals({ ...vals, [k]: v });

  // A plain function, not a component: a component made inside render would remount (and lose focus) on every key.
  const wrap = (k, label, help, control) => {
    const errs = errFor(k);
    return html`<div class=${cls('f', errs.length && 'bad')}>
      <label for=${`p-${k}`}>${label}</label>${control}
      ${errs.map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}
      ${help ? html`<span class="help">${help}</span>` : null}
    </div>`;
  };
  const lines = (k, label, help, rows = 3) => wrap(k, label, help, html`<textarea id=${`p-${k}`} class="field" rows=${rows} value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)}></textarea>`);
  const text = (k, label, help) => wrap(k, label, help, html`<input id=${`p-${k}`} class="field" value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)} />`);
  const num = (k, label, help) => wrap(k, label, help, html`<input id=${`p-${k}`} class="field" type="number" inputmode="numeric" min="0" value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)} />`);
  const pick = (k, label, opts, help) => wrap(k, label, help, html`<select id=${`p-${k}`} class="field" value=${vals[k]} onChange=${(e) => set(k, e.currentTarget.value)}>${opts.map((o) => html`<option value=${o}>${word(o)}</option>`)}</select>`);
  const checks = (k, label, opts, help) => {
    const errs = errFor(k);
    return html`<fieldset class=${cls('f', errs.length && 'bad')}><legend class="lab">${label}</legend><div class="checks">${opts.map((o) => html`<label class="check"><input type="checkbox" checked=${vals[k].includes(o)}
      onChange=${(e) => set(k, e.currentTarget.checked ? [...vals[k], o] : vals[k].filter((x) => x !== o))} />${word(o)}</label>`)}</div>
      ${errs.map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}${help ? html`<span class="help">${help}</span>` : null}</fieldset>`;
  };

  const save = async () => {
    const changes = Object.fromEntries(changed.map((k) => [k, fromForm(k, vals[k])]));
    const bad = Object.entries(changes).filter(([k, v]) => NUM.has(k) && !Number.isFinite(v)).map(([k]) => ({ path: k, message: 'give a number' }));
    if (bad.length) { setErrors(bad); return; }
    setBusy(true);
    const r = await onSave(changes);
    setBusy(false);
    if (r?.ok === false) setErrors(r.issues ?? []);
    else setErrors([]);
  };

  return html`<div class="page narrow">
    <div class="page-head">
      <div><h1>Preferences</h1><p class="sub">What you want, as Jobs reads it from <code>jobs/search.md</code>. Saving here logs each change under Changes in that note, like telling Claude.</p></div>
      <button type="button" class="btn small" onClick=${() => onNotes(data.page)}>Open in Notes</button>
    </div>
    ${data.source === 'last-valid' ? html`<div class="banner bad"><div class="body"><b>jobs/search.md has errors</b><span class="fix">Jobs uses its last valid version until they are fixed; the fields below show that version.</span></div></div>` : null}
    <div class="form">
      <section class="card section"><header><h2>Roles</h2><span class="hint">A posting's title must contain one of your titles.</span></header>
        <div class="grid2">${lines('roles.titles', 'Job titles', 'One per line, e.g. data analyst', 4)}${lines('roles.exclude_title_words', 'Never titles with', 'Whole words, one per line, e.g. intern', 4)}</div>
        ${lines('roles.seniority_prefer', 'Seniority you prefer', 'Ordering only, not a filter (one per line)', 2)}
        ${checks('employment_types', 'Employment types', data.options.employment_types)}
      </section>
      <section class="card section"><header><h2>Where</h2><span class="hint">On-site and hybrid roles are checked against your cities; remote ones against where you can work from.</span></header>
        ${checks('workplace', 'Workplace', data.options.workplace, 'None ticked means any')}
        <div class="grid2">${lines('places.onsite', 'Cities for on-site or hybrid', 'One per line ("Town, Country" for small towns)')}${lines('places.remote_from', 'Remote from', 'Countries, regions or states, one per line; "worldwide" accepts anywhere')}</div>
        <div class="grid3">${num('places.commute_km', 'Commute distance (km)')}</div>
      </section>
      <section class="card section"><header><h2>Pay</h2><span class="hint">Postings below your floor are dropped; any currency is converted with your rates in the note.</span></header>
        <div class="grid3">${text('pay.currency', 'Currency', 'Three letters, e.g. EUR')}${num('pay.floor', 'Floor', '0 = no floor')}${pick('pay.period', 'Per', data.options.period)}</div>
        <div class="grid3">${pick('pay.rule', 'Keep a range when', data.options.rule)}${pick('pay.unlisted', 'Postings with no pay', data.options.unlisted)}${text('pay.locale', 'Number format', 'e.g. de-DE, en-US')}</div>
      </section>
      <section class="card section"><header><h2>You</h2></header>
        <div class="f"><span class="lab">Languages</span>
          ${vals.languages.map((l, i) => html`<div class="langrow" key=${i}>
            <input class="field" aria-label=${`Language ${i + 1}`} value=${l.name} placeholder="Language" onInput=${(e) => set('languages', vals.languages.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} />
            <select class="field" aria-label=${`Level for language ${i + 1}`} value=${l.level} onChange=${(e) => set('languages', vals.languages.map((x, j) => (j === i ? { ...x, level: e.currentTarget.value } : x)))}>
              <option value="">level…</option>${data.options.levels.map((o) => html`<option value=${o}>${o}</option>`)}</select>
            <button type="button" class="btn quiet small" aria-label=${`Remove language ${i + 1}`} onClick=${() => set('languages', vals.languages.filter((_, j) => j !== i))}>Remove</button></div>`)}
          ${errFor('languages').map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}
          <div><button type="button" class="btn small" onClick=${() => set('languages', [...vals.languages, { name: '', level: '' }])}>Add a language</button></div>
        </div>
        <div class="grid2">${lines('licenses', 'Licences', 'e.g. RN (Texas), one per line', 2)}${pick('needs_sponsorship', 'Need visa sponsorship', ['no', 'yes'])}</div>
      </section>
      <section class="card section"><header><h2>Never</h2></header>
        <div class="grid2">${lines('exclude.companies', 'Companies', 'One per line')}${lines('exclude.industries', 'Industries', 'One per line, e.g. gambling')}</div>
        <div class="grid3">${pick('exclude.travel', 'Rule out travel from', data.options.travel)}</div>
      </section>
      <section class="card section"><header><h2>Daily</h2></header>
        <div class="grid3">${num('schedule.daily_picks', 'Picks a day')}${num('schedule.cooldown_days', 'Cooldown after applying (days)')}${text('schedule.timezone', 'Time zone', 'e.g. Europe/Berlin; empty = this computer\'s')}</div>
        ${lines('judge_notes', 'Anything else, for the judging step', 'In your words, e.g. "prefer product companies over agencies"', 3)}
      </section>
      <div class="savebar" role="region" aria-label="Save preferences">
        <span class="grow small soft">${errors.length ? html`<span class="err">Nothing saved: fix ${plural(errors.length, 'field')} above.</span>` : changed.length ? `${plural(changed.length, 'change')} not saved yet` : 'Everything saved'}</span>
        <button type="button" class="btn quiet" disabled=${!changed.length || busy} onClick=${() => { setVals(init); setErrors([]); }}>Undo</button>
        <button type="button" class="btn primary" disabled=${!changed.length || busy} onClick=${save}>Save</button>
      </div>
    </div>
  </div>`;
}
