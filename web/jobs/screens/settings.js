// Settings: the risky switches (design §12), off until the user switches them on here. Each says its risk where it is
// switched; switching one on takes a second click. An agent can't change these: only this page (or a real terminal).
import { useState } from 'preact/hooks';
import { html, noop } from '../lib.js';

function Feature({ f, onSet }) {
  const [confirming, setConfirming] = useState(false);
  const [limit, setLimit] = useState(f.limit ? String(f.limit.value) : '');
  const toggle = () => (f.on ? onSet(f.name, false) : setConfirming(true));
  return html`<div class="card">
    <div class="switchrow">
      <div class="body">
        <h2 id=${`f-${f.name}`}>${f.title}</h2>
        <p class="soft small">${f.risk}</p>
        ${f.on && f.limit ? html`<div class="row-flex">
          <label class="small" for=${`l-${f.name}`}>${f.limit.name === 'daily_quick_apply' ? 'Forms per day' : 'Drafts per day'} (at most ${f.limit.cap})</label>
          <input id=${`l-${f.name}`} class="field" type="number" min="0" max=${f.limit.cap} value=${limit} onInput=${(e) => setLimit(e.currentTarget.value)} />
          <button type="button" class="btn small" disabled=${limit === String(f.limit.value)} onClick=${() => onSet(f.limit.name, Number(limit))}>Save</button>
        </div>` : null}
        ${confirming ? html`<div class="confirm" role="alertdialog" aria-labelledby=${`f-${f.name}`}>
          <b>Switch on ${f.title}?</b><span class="small">${f.risk}</span>
          <div class="row-flex"><button type="button" class="btn primary small" onClick=${() => { setConfirming(false); onSet(f.name, true); }}>Yes, switch it on</button>
            <button type="button" class="btn quiet small" onClick=${() => setConfirming(false)}>Cancel</button></div>
        </div>` : null}
      </div>
      <button type="button" class="switch" role="switch" aria-checked=${f.on ? 'true' : 'false'} aria-labelledby=${`f-${f.name}`} onClick=${toggle}></button>
    </div>
  </div>`;
}

export function Settings({ data, onSet = noop }) {
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Riskier features stay off until you switch them on here. Claude can't change these.</p></div></div>
    <div class="stack">${data.features.map((f) => html`<${Feature} key=${`${f.name}:${f.on}:${f.limit?.value}`} f=${f} onSet=${onSet} />`)}</div>
    <section class="card section"><header><h2>Where things are</h2></header>
      <dl class="kv">
        <dt>Jobs folder</dt><dd><code>${data.workspace}</code> <span class="hint">open a Claude session here to work Jobs</span></dd>
        <dt>Your notes</dt><dd><code>${data.vault}</code></dd>
        <dt>Tracker and PDFs</dt><dd><code>${data.home}</code></dd>
        <dt>Browser</dt><dd>${data.browser ? data.browser.name : html`<span class="err">none found</span> <span class="hint">${data.browserHint}</span>`}</dd>
      </dl>
    </section>
  </div>`;
}
