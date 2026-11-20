// Settings: the risky switches (design §12), off until the user switches them on here. Each says its risk where it is
// switched; switching one on takes a second click here and a yes in the system's own dialog. Without a dialog the
// server answers with a one-time code shown only here, for the user's own terminal.
import { useState } from 'preact/hooks';
import { html, noop, More } from '../lib.js';

/** Each switch's consequence in one line; the full risk text is one More away (and in the confirm). */
const SHORT = {
  linkedin_search: 'Against LinkedIn\'s terms: your IP may be limited or blocked.',
  linkedin_links: 'Reads pasted LinkedIn links; the same terms risk.',
  easy_apply: 'Claude fills Easy Apply; your account could be restricted.',
  email_drafts: 'Gmail drafts to recruiters; never sent by Crewdeck.',
  linkedin_message_text: 'Claude writes the text; you send it yourself.',
};
export const shortRisk = (f) => SHORT[f.name] ?? (/^(.+?\.)(\s|$)/.exec(f.risk ?? '')?.[1] ?? f.risk);

/** No system dialog: the command to run in a terminal and the code it asks for (10 minutes, once). */
export function TerminalCode({ t, onClose = noop }) {
  return html`<div class="confirm" role="alertdialog" aria-label="Confirm in your terminal">
    <b>Confirm in your own terminal</b>
    <span class="small">This computer has no confirmation dialog Crewdeck can show. Run this yourself in a terminal (not in a Claude chat):</span>
    <code>${t.command}</code>
    <span class="small">When it asks, type this code (valid 10 minutes, once): <b class="code">${t.code}</b></span>
    <div class="row-flex"><button type="button" class="btn quiet small" onClick=${onClose}>Done</button></div>
  </div>`;
}

function Feature({ f, onSet }) {
  const [confirming, setConfirming] = useState(false);
  const [terminal, setTerminal] = useState(null);
  const set = async (name, value) => { const r = await onSet(name, value); if (r?.terminal) setTerminal(r.terminal); };
  const [limit, setLimit] = useState(f.limit ? String(f.limit.value) : '');
  const toggle = () => (f.on ? onSet(f.name, false) : setConfirming(true));
  return html`<div class="card">
    <div class="switchrow">
      <div class="body">
        <h2 id=${`f-${f.name}`}>${f.title}</h2>
        <p class="soft small">${shortRisk(f)}</p>
        ${f.risk && f.risk !== shortRisk(f) ? html`<${More} summary="Why?"><span>${f.risk}</span></${More}>` : null}
        ${f.on && f.limit ? html`<div class="row-flex">
          <label class="small" for=${`l-${f.name}`}>${f.limit.name === 'daily_quick_apply' ? 'Forms per day' : 'Drafts per day'} (at most ${f.limit.cap})</label>
          <input id=${`l-${f.name}`} class="field" type="number" min="0" max=${f.limit.cap} value=${limit} onInput=${(e) => setLimit(e.currentTarget.value)} />
          <button type="button" class="btn small" disabled=${limit === String(f.limit.value)} onClick=${() => set(f.limit.name, Number(limit))}>Save</button>
        </div>` : null}
        ${confirming ? html`<div class="confirm" role="alertdialog" aria-labelledby=${`f-${f.name}`}>
          <b>Switch on ${f.title}?</b><span class="small">${f.risk}</span>
          <span class="small soft">Your computer then asks you to confirm in its own dialog.</span>
          <div class="row-flex"><button type="button" class="btn primary small" onClick=${() => { setConfirming(false); set(f.name, true); }}>Yes, switch it on</button>
            <button type="button" class="btn quiet small" onClick=${() => setConfirming(false)}>Cancel</button></div>
        </div>` : null}
        ${terminal ? html`<${TerminalCode} t=${terminal} onClose=${() => setTerminal(null)} />` : null}
      </div>
      <button type="button" class="switch" role="switch" aria-checked=${f.on ? 'true' : 'false'} aria-labelledby=${`f-${f.name}`} onClick=${toggle}></button>
    </div>
  </div>`;
}

export function Settings({ data, onSet = noop }) {
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Settings</h1><p class="sub">Riskier features. Off until you switch them on.</p></div></div>
    <${More} summary="How it works"><span>Switching one on takes a second click here and a yes in your computer's own dialog. Claude can't change these.</span></${More}>
    <div class="stack">${data.features.map((f) => html`<${Feature} key=${`${f.name}:${f.on}:${f.limit?.value}`} f=${f} onSet=${onSet} />`)}</div>
    <section class="card section"><header><h2>Where things are</h2></header>
      ${data.browser ? null : html`<p><span class="err">No browser found</span> <span class="hint">${data.browserHint}</span></p>`}
      <${More} summary="Folders and browser"><dl class="kv">
        <dt>Jobs folder</dt><dd><code>${data.workspace}</code> <span class="hint">open a Claude session here to work Jobs</span></dd>
        <dt>Your notes</dt><dd><code>${data.vault}</code></dd>
        <dt>Tracker and PDFs</dt><dd><code>${data.home}</code></dd>
        <dt>Browser</dt><dd>${data.browser ? data.browser.name : 'none found'}</dd>
      </dl></${More}>
    </section>
  </div>`;
}
