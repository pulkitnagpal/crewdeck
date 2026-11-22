// Preferences: a form over jobs/search.md. It saves through the same validated path as `crewdeck jobs pref set`: all
// changed fields at once, or none with the reason next to each field; every change gets a line under ## Changes.
// A Preview beside Save (design §24.6) runs the unsaved form over the postings already fetched, read-only.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, noop, cls, plural, More } from '../lib.js';

/** A field's help: one short line always shown; a [short, long] pair puts the long part behind More. */
const helpOf = (help) => {
  if (!help) return null;
  const [short, long] = Array.isArray(help) ? help : [help, null];
  return html`${short ? html`<span class="help">${short}</span>` : null}${long ? html`<${More} summary="Details"><span>${long}</span></${More}>` : null}`;
};
/** A section's header: its title, at most one short line, the rest behind More. */
const head = (title, short = null, long = null) => html`<header><h2>${title}</h2>${short ? html`<span class="hint">${short}</span>` : null}${long ? html`<${More} summary="How it works"><span>${long}</span></${More}>` : null}</header>`;

const LIST = new Set(['roles.titles', 'roles.seniority_prefer', 'roles.exclude_title_words', 'places.onsite', 'places.remote_from', 'places.relocate_to', 'places.authorized_in', 'exclude.companies', 'exclude.industries']);
const CHECKS = new Set(['workplace', 'employment_types', 'work_pattern.shifts', 'work_pattern.shifts_avoid']);
const NUM = new Set(['places.commute_km', 'pay.floor', 'schedule.daily_picks', 'schedule.cooldown_days', 'schedule.per_company']);
/** Numbers the user may leave empty (their defaults apply): saved as "no value". */
const OPTNUM = new Set(['pay.hours_per_week', 'pay.days_per_week', 'work_pattern.hours_per_week.min', 'work_pattern.hours_per_week.max']);
const BOOL = new Set(['work_pattern.term_time_only']);
const WORDS = { words: 'every word of a title, any order', broad: 'also a shared head word (more to judge)', entry: 'entry level', experienced: 'experienced', senior: 'senior', any: 'any level', remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', top_of_range: 'the top of the range reaches it', bottom_of_range: 'the bottom of the range reaches it', keep: 'keep them', drop: 'drop them', occasional: 'occasional or more', frequent: 'frequent travel', year: 'a year', month: 'a month', week: 'a week', day: 'a day', hour: 'an hour', company: 'any role at that company', role: 'the same title at that company only' };
const word = (v, k) => (k === 'roles.match' && v === 'off' ? 'off: every title goes to the judge' : k === 'exclude.travel' && v === 'off' ? 'nothing (off)' : WORDS[v] ?? v);
const SHIFT_WORDS = { day: 'Days', evening: 'Evenings', night: 'Nights', weekend: 'Weekends', rotating: 'Rotating', 'on-call': 'On call' };
/** A licence on one line: "RN (Ohio)" for { name: RN, where: Ohio }. */
const licenceLine = (l) => (typeof l === 'string' ? l : l?.where ? `${l.name} (${l.where})` : l?.name ?? '');
const norm = (p) => String(p ?? '').replace(/\[(\d+)\]/g, '.$1');

/**
 * The form's working values: lists as one entry per line, so commas inside a place ("Cambridge, MA") survive. A target
 * keeps `at`, its place in the note, so Save updates it in place (keys the form doesn't show stay); a change from a fix
 * (same targets, same order) takes them from `ref`, the form as loaded.
 */
function toForm(values, ref = null) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (LIST.has(k)) out[k] = (v ?? []).join('\n');
    else if (k === 'licenses') out[k] = (v ?? []).map(licenceLine).join('\n');
    else if (NUM.has(k) || OPTNUM.has(k)) out[k] = v === null || v === undefined ? '' : String(v);
    else if (BOOL.has(k)) out[k] = v === true;
    else if (k === 'languages') out[k] = (v ?? []).map((l) => ({ name: l.name ?? '', level: l.level ?? '' }));
    else if (k === 'needs_sponsorship') out[k] = v === true ? 'yes' : v === false ? 'no' : '';
    else if (k === 'roles.targets') {
      const loaded = ref?.[k] ?? [];
      out[k] = (v ?? []).map((t, i) => {
        const at = Number.isInteger(t.at) ? t.at : (v.length === loaded.length ? loaded[i]?.at : undefined);
        return { name: t.name ?? '', titles: (t.titles ?? []).join('\n'), skills: (t.skills ?? []).join('\n'), families: t.families ?? [], ...(Number.isInteger(at) ? { at } : {}) };
      });
    }
    else out[k] = v ?? (CHECKS.has(k) ? [] : '');
  }
  return out;
}

/** The value the server takes for one field. */
function fromForm(k, v, loaded = null) {
  if (LIST.has(k)) return v.split('\n').map((x) => x.trim()).filter(Boolean);
  // A line that is a licence as loaded goes back as written ({ name, where } stays a map); a new line is text.
  if (k === 'licenses') return v.split('\n').map((x) => x.trim()).filter(Boolean).map((line) => (loaded ?? []).find((l) => typeof l === 'object' && licenceLine(l) === line) ?? line);
  if (NUM.has(k)) return v.trim() === '' ? NaN : Number(v);
  if (OPTNUM.has(k)) return v.trim() === '' ? null : Number(v);
  if (BOOL.has(k)) return v === true;
  if (k === 'languages') return v.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), ...(l.level ? { level: l.level } : {}) }));
  if (k === 'needs_sponsorship') return v === 'yes';
  if (k === 'roles.targets') {
    const lines = (x) => x.split('\n').map((y) => y.trim()).filter(Boolean);
    return v.map((t) => ({ name: t.name.trim(), titles: lines(t.titles), skills: lines(t.skills), families: t.families, ...(Number.isInteger(t.at) ? { at: t.at } : {}) })).filter((t) => t.titles.length || t.name);
  }
  return v;
}

const plural_ = (n, w) => `${Number(n).toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

/** What the unsaved form catches on the postings already fetched (the same preview as `crewdeck jobs preview`). */
export function PreviewPanel({ pv, busy, dirty, onApply = noop }) {
  if (!pv) return html`<section class="card pv" aria-label="Preview"><h2>Preview</h2><p class="soft small" role="status">${busy ? 'Checking your postings…' : 'Change a field to see what it catches.'}</p></section>`;
  if (pv.ok === false) return html`<section class="card pv" aria-label="Preview"><h2>Preview</h2><p class="err" role="status">Can't preview: ${pv.issues.map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`).join('; ')}</p></section>`;
  if (!pv.pool) return html`<section class="card pv" aria-label="Preview"><h2>Preview</h2><p class="soft">No postings from the last ${pv.days} days yet.</p>
    <${More} summary="Why?"><span>Once your sources are fetched (Refresh sources at the top; add sources on the Sources tab) or you paste job links, this shows what your choices catch.</span></${More}></section>`;
  const fixes = pv.suggestions.filter((x) => (x.more > 0 || x.raised > 0) && Object.keys(x.change).length);
  return html`<section class="card pv" aria-label="Preview" aria-busy=${busy ? 'true' : 'false'}>
    <h2>Preview <span class="small soft">${plural_(pv.pool, 'posting')} from the last ${pv.days} days</span></h2>
    <p class="count" role="status">${pv.pass.toLocaleString('en-US')} ${pv.pass === 1 ? 'passes' : 'pass'} your rules${pv.was !== null && pv.was !== undefined && dirty ? ` (now ${pv.was.toLocaleString('en-US')})` : ''}</p>
    ${pv.drops.length ? html`<p class="small">Dropped, by first reason: ${pv.drops.slice(0, 5).map((d) => `${d.label} ${d.n.toLocaleString('en-US')}`).join(' · ')}</p>` : null}
    ${pv.other_occupations ? html`<p class="small soft">Other occupations (not dropped: ranked last and not judged): ${pv.other_occupations.toLocaleString('en-US')}</p>` : null}
    ${pv.single.length ? html`<p class="small soft">Only one thing stops them: ${pv.single.map((d) => `${d.label} ${d.n.toLocaleString('en-US')}`).join(' · ')}</p>` : null}
    ${pv.near.length ? html`<div class="small"><span>Near misses on title:</span><ul>${pv.near.slice(0, 3).map((g) => html`<li key=${g.head}>${g.head} → ${g.items.slice(0, 5).map((x) => `${x.label} (${x.n})`).join(', ')}</li>`)}</ul></div>` : null}
    ${pv.passing.length ? html`<p class="small soft">Passing, e.g.: ${pv.passing.slice(0, 3).map((x) => `${x.title} — ${x.company}`).join(' · ')}</p>` : null}
    ${fixes.length ? html`<div class="fixes">${fixes.map((x, i) => html`<button type="button" key=${i} class="btn small" title=${x.text} onClick=${() => onApply(x.change)}>${x.label}</button>`)}</div>` : null}
    ${fixes.length ? html`<span class="hint">A fix fills the form; nothing is saved until you click Save.</span>` : null}
  </section>`;
}

export function Preferences({ data, onSave = noop, onNotes = noop, onPreview = null, pending = null, preview = null }) {
  const [init] = useState(() => toForm(data.values));
  // A fix from Find's card (or the preview) arrives as unsaved changes: the form starts with them filled in.
  const [vals, setVals] = useState(() => (pending?.changes ? { ...init, ...toForm(pending.changes, init) } : init));
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState(preview);
  const [pvBusy, setPvBusy] = useState(false);
  const seq = useRef(0);
  const changed = Object.keys(vals).filter((k) => JSON.stringify(vals[k]) !== JSON.stringify(init[k]));
  const from = (k) => fromForm(k, vals[k], data.values[k]);
  const bad = (k, v) => (NUM.has(k) && !Number.isFinite(v)) || (OPTNUM.has(k) && v !== null && !Number.isFinite(v));
  const changesNow = () => Object.fromEntries(changed.map((k) => [k, from(k)]).filter(([k, v]) => !bad(k, v)));
  const key = JSON.stringify(changesNow());
  // Debounced: the preview follows the form as the user types; only the latest answer is shown.
  useEffect(() => {
    if (!onPreview || !data.exists) return undefined;
    const my = ++seq.current;
    setPvBusy(true);
    const t = setTimeout(async () => {
      const r = await onPreview(JSON.parse(key)).catch((e) => ({ ok: false, issues: [{ path: '', message: e.message }] }));
      if (my === seq.current) { setPv(r); setPvBusy(false); }
    }, pv ? 500 : 0);
    return () => clearTimeout(t);
  }, [key]);
  if (!data.exists) {
    return html`<div class="page narrow prefs"><div class="card section"><h1>Preferences</h1><p class="soft">jobs/search.md is missing. Set up Jobs first (Today → Set up with Claude).</p><${More} summary="Other ways"><span>Or copy jobs/search.md from vault-template into your notes.</span></${More}></div></div>`;
  }
  const noteIssues = data.issues.filter((i) => i.level === 'error');
  const errFor = (k) => [...errors, ...noteIssues].filter((e) => norm(e.path) === k || norm(e.path).startsWith(`${k}.`)).map((e) => e.message);
  const set = (k, v) => setVals({ ...vals, [k]: v });

  // A plain function, not a component: a component made inside render would remount (and lose focus) on every key.
  const wrap = (k, label, help, control) => {
    const errs = errFor(k);
    return html`<div class=${cls('f', errs.length && 'bad')}>
      <label for=${`p-${k}`}>${label}</label>${control}
      ${errs.map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}
      ${helpOf(help)}
    </div>`;
  };
  const lines = (k, label, help, rows = 3) => wrap(k, label, help, html`<textarea id=${`p-${k}`} class="field" rows=${rows} value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)}></textarea>`);
  const text = (k, label, help) => wrap(k, label, help, html`<input id=${`p-${k}`} class="field" value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)} />`);
  const num = (k, label, help) => wrap(k, label, help, html`<input id=${`p-${k}`} class="field" type="number" inputmode="decimal" min="0" value=${vals[k]} onInput=${(e) => set(k, e.currentTarget.value)} />`);
  const pick = (k, label, opts, help) => wrap(k, label, help, html`<select id=${`p-${k}`} class="field" value=${vals[k]} onChange=${(e) => set(k, e.currentTarget.value)}>${opts.map((o) => html`<option value=${o}>${word(o, k)}</option>`)}</select>`);
  const checks = (k, label, opts, help, words = null) => {
    const errs = errFor(k);
    return html`<fieldset class=${cls('f', errs.length && 'bad')}><legend class="lab">${label}</legend><div class="checks">${opts.map((o) => html`<label class="check"><input type="checkbox" checked=${vals[k].includes(o)}
      onChange=${(e) => set(k, e.currentTarget.checked ? [...vals[k], o] : vals[k].filter((x) => x !== o))} />${words?.[o] ?? word(o, k)}</label>`)}</div>
      ${errs.map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}${helpOf(help)}</fieldset>`;
  };
  const tick = (k, label, help) => {
    const errs = errFor(k);
    return html`<div class=${cls('f', errs.length && 'bad')}><label class="check"><input id=${`p-${k}`} type="checkbox" checked=${vals[k]} onChange=${(e) => set(k, e.currentTarget.checked)} />${label}</label>
      ${errs.map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}${helpOf(help)}</div>`;
  };

  const save = async () => {
    const changes = Object.fromEntries(changed.map((k) => [k, from(k)]));
    const wrong = Object.entries(changes).filter(([k, v]) => bad(k, v)).map(([k]) => ({ path: k, message: OPTNUM.has(k) ? 'give a number, or leave it empty' : 'give a number' }));
    if (wrong.length) { setErrors(wrong); return; }
    setBusy(true);
    const r = await onSave(changes, pending?.from);
    setBusy(false);
    if (r?.ok === false) setErrors(r.issues ?? []);
    else setErrors([]);
  };

  return html`<div class="page narrow prefs">
    <div class="page-head">
      <div><h1>Preferences</h1><p class="sub">What you want, kept in <code>jobs/search.md</code>.</p></div>
      <button type="button" class="btn small" onClick=${() => onNotes(data.page)}>Open in Notes</button>
    </div>
    <${More} summary="How saving works"><span>Saving here logs each change under Changes in that note, like telling Claude. Preview shows what your unsaved choices catch on postings already fetched.</span></${More}>
    ${data.source === 'last-valid' ? html`<div class="banner bad"><div class="body"><b>jobs/search.md has errors</b><span class="fix">Jobs uses its last valid version until they are fixed; the fields below show that version.</span></div></div>` : null}
    <div class="form">
      <section class="card section">${head('Roles', 'The job titles that pass.', 'A posting passes when its title has every word of one of your titles, in any order; plurals and gendered forms count, seniority words don\'t block.')}
        <fieldset class="f"><legend class="lab">Kinds of job</legend>
          ${vals['roles.targets'].map((t, i) => html`<div class="target" key=${i}>
            <div class="row-flex"><input class="field" aria-label=${`Name of kind of job ${i + 1}`} placeholder="e.g. Backend engineer" value=${t.name}
              onInput=${(e) => set('roles.targets', vals['roles.targets'].map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} />
              <button type="button" class="btn quiet small" aria-label=${`Remove kind of job ${i + 1}`} onClick=${() => set('roles.targets', vals['roles.targets'].filter((_, j) => j !== i))}>Remove</button></div>
            <div class="grid2">
              <label class="f"><span class="lab">Titles and variants</span><textarea class="field" rows="4" value=${t.titles} onInput=${(e) => set('roles.targets', vals['roles.targets'].map((x, j) => (j === i ? { ...x, titles: e.currentTarget.value } : x)))}></textarea><span class="help">One per line; the first three search LinkedIn</span></label>
              <label class="f"><span class="lab">Skills for this kind</span><textarea class="field" rows="4" value=${t.skills} onInput=${(e) => set('roles.targets', vals['roles.targets'].map((x, j) => (j === i ? { ...x, skills: e.currentTarget.value } : x)))}></textarea><span class="help">Optional: they rank its roles</span></label>
            </div>
            ${errFor(`roles.targets.${i}`).map((m, k) => html`<span class="err" key=${k}>${m}</span>`)}
          </div>`)}
          <div><button type="button" class="btn small" onClick=${() => set('roles.targets', [...vals['roles.targets'], { name: '', titles: '', skills: '', families: [] }])}>Add a kind of job</button></div>
        </fieldset>
        <div class="grid2">${lines('roles.titles', 'More job titles', ['One per line, e.g. data analyst', 'Read as one more kind of job.'], 3)}${lines('roles.exclude_title_words', 'Never titles with', 'Whole words, one per line, e.g. intern', 3)}</div>
        <div class="grid2">${pick('roles.match', 'Title matching', data.options.match ?? ['words', 'broad', 'off'])}${pick('roles.level', 'Level', data.options.level ?? ['any', 'entry', 'experienced', 'senior'], 'Drops titles with a seniority word outside it')}</div>
        ${lines('roles.seniority_prefer', 'Seniority you prefer', 'Ordering only, not a filter (one per line)', 2)}
      </section>
      <section class="card section">${head('Where', 'Your cities, and where you can work remotely from.', 'On-site and hybrid roles are checked against your cities; remote ones against where you can work from.')}
        ${checks('workplace', 'Workplace', data.options.workplace, 'None ticked means any')}
        <div class="grid2">${lines('places.onsite', 'Cities for on-site or hybrid', ['One per line', 'For a small town, write "Town, Country".'])}${lines('places.remote_from', 'Remote from', ['Countries or regions, one per line', 'States work too; "worldwide" accepts anywhere.'])}</div>
        <div class="grid3">${num('places.commute_km', 'Commute distance (km)')}</div>
        <div class="grid2">${lines('places.relocate_to', 'Cities you would move to', ['One per line', 'On-site or hybrid roles there pass, and the judging step is told you\'d move.'], 2)}${lines('places.authorized_in', 'Where you may work without sponsorship', 'Countries, one per line, e.g. United States', 2)}</div>
      </section>
      <section class="card section">${head('How you work', 'Only what you say; nothing is guessed.', 'The judging step never guesses a shift or an hours limit for you.')}
        ${checks('employment_types', 'Employment types', data.options.employment_types, ['None ticked means any', 'A posting whose source states another type is dropped; words in a description are judged.'])}
        <div class="grid2">${checks('work_pattern.shifts', 'Shifts you can work', data.options.shifts ?? [], null, SHIFT_WORDS)}${checks('work_pattern.shifts_avoid', 'Shifts you can\'t work', data.options.shifts ?? [], null, SHIFT_WORDS)}</div>
        <div class="grid3">${num('work_pattern.hours_per_week.min', 'Hours a week, at least', 'Empty = no minimum')}${num('work_pattern.hours_per_week.max', 'Hours a week, at most', 'Empty = no maximum')}</div>
        ${tick('work_pattern.term_time_only', 'Term-time only (school-year contracts)')}
      </section>
      <section class="card section">${head('Pay', 'Postings below your floor are dropped.', 'Any currency is converted with your rates in the note.')}
        <div class="grid3">${text('pay.currency', 'Currency', 'Three letters, e.g. EUR')}${num('pay.floor', 'Floor', '0 = no floor')}${pick('pay.period', 'Per', data.options.period)}</div>
        <div class="grid3">${num('pay.hours_per_week', 'Hours you work a week', ['Empty = your most hours above, else 40', 'Converts a month or a year into your period.'])}${num('pay.days_per_week', 'Days a week', 'For a day rate; empty = 5')}${text('pay.per_unit', 'Pay per word, page or project', ['In your words, e.g. €0.08 a word', 'For the judging step only, never a floor.'])}</div>
        <div class="grid3">${pick('pay.rule', 'Keep a range when', data.options.rule)}${pick('pay.unlisted', 'Postings with no pay', data.options.unlisted)}${text('pay.locale', 'Number format', 'e.g. de-DE, en-US')}</div>
      </section>
      <section class="card section">${head('You')}
        <div class="f"><span class="lab">Languages</span>
          ${vals.languages.map((l, i) => html`<div class="langrow" key=${i}>
            <input class="field" aria-label=${`Language ${i + 1}`} value=${l.name} placeholder="Language" onInput=${(e) => set('languages', vals.languages.map((x, j) => (j === i ? { ...x, name: e.currentTarget.value } : x)))} />
            <select class="field" aria-label=${`Level for language ${i + 1}`} value=${l.level} onChange=${(e) => set('languages', vals.languages.map((x, j) => (j === i ? { ...x, level: e.currentTarget.value } : x)))}>
              <option value="">level…</option>${data.options.levels.map((o) => html`<option value=${o}>${o}</option>`)}</select>
            <button type="button" class="btn quiet small" aria-label=${`Remove language ${i + 1}`} onClick=${() => set('languages', vals.languages.filter((_, j) => j !== i))}>Remove</button></div>`)}
          ${errFor('languages').map((m, i) => html`<span class="err" key=${i}>${m}</span>`)}
          <div><button type="button" class="btn small" onClick=${() => set('languages', [...vals.languages, { name: '', level: '' }])}>Add a language</button></div>
        </div>
        <div class="grid2">${lines('licenses', 'Licences', 'One per line, e.g. RN (Ohio)', 2)}${pick('needs_sponsorship', 'Need visa sponsorship', ['no', 'yes'])}</div>
      </section>
      <section class="card section">${head('Never')}
        <div class="grid2">${lines('exclude.companies', 'Companies', 'One per line')}${lines('exclude.industries', 'Industries', 'One per line, e.g. gambling')}</div>
        <div class="grid3">${pick('exclude.travel', 'Rule out travel from', data.options.travel)}</div>
      </section>
      <section class="card section">${head('Daily')}
        <div class="grid3">${num('schedule.daily_picks', 'Picks a day')}${num('schedule.cooldown_days', 'Cooldown after applying (days)')}${text('schedule.timezone', 'Time zone', 'e.g. Europe/Berlin; empty = this computer\'s')}</div>
        <div class="grid3">${pick('schedule.cooldown_scope', 'The cooldown holds back', data.options.cooldown_scope ?? ['company', 'role'], ['', 'Same title only suits hospitals, schools and chains with many similar openings.'])}${num('schedule.per_company', 'Roles in progress per company', 'At most this many picked or prepared at once')}</div>
        ${lines('judge_notes', 'Anything else, for the judging step', 'In your words, e.g. "prefer product companies over agencies"', 3)}
      </section>
      ${onPreview || pv ? html`<${PreviewPanel} pv=${pv} busy=${pvBusy} dirty=${changed.length > 0} onApply=${(change) => setVals({ ...vals, ...toForm(change, init) })} />` : null}
      <div class="savebar" role="region" aria-label="Save preferences">
        <span class="grow small soft">${errors.length ? html`<span class="err">Nothing saved: fix ${plural(errors.length, 'field')} above.</span>` : changed.length ? `${plural(changed.length, 'change')} not saved yet${pv?.ok !== false && pv?.pool ? ` · ${pv.pass.toLocaleString('en-US')} pass${pv.was !== null && pv.was !== undefined ? ` (now ${pv.was.toLocaleString('en-US')})` : ''}` : ''}` : 'Everything saved'}</span>
        <button type="button" class="btn quiet" disabled=${!changed.length || busy} onClick=${() => { setVals(init); setErrors([]); }}>Undo</button>
        <button type="button" class="btn primary" disabled=${!changed.length || busy} onClick=${save}>Save</button>
      </div>
    </div>
  </div>`;
}
