// First run (design §2.2, §24.4): Claude interviews the user (with or without a resume), proposes where to look, fetches
// once and previews what passes, and writes their notes; or the user edits the files themselves.
import { useState } from 'preact/hooks';
import { html, noop, CopyButton, Icon } from '../lib.js';

const LABEL = { profile: 'Who you are', career: 'Your work (resume facts)', search: 'What you want', memory: 'What Claude learned', sources: 'Where to look (also the Sources tab)' };

function fileState(f) {
  if (!f.exists) return html`<span class="chip warn">missing</span>`;
  if (f.errors) return html`<span class="chip bad">${f.errors} error${f.errors > 1 ? 's' : ''}</span>`;
  return html`<span class="chip ok">ok</span>`;
}

export function SetupCard({ state, onSetup = noop, onNotes = noop, onToast = noop }) {
  const [editing, setEditing] = useState(false);
  const s = state.setup;
  const a = state.agent ?? {};
  const req = s.request && (s.request.status === 'new' || s.request.status === 'picked') ? s.request : null;
  return html`<section class="card setup" aria-labelledby="setup-title">
    <div class="stack">
      <span class="chip info self-start"><${Icon} name="sparkle" size=${12} /> First run</span>
      <h1 id="setup-title">Set up Jobs</h1>
      <p class="lead">Claude asks about your work, from your resume or just by talking if you don't have one, then the kinds of job you want, where you can work and where to look. Before anything is used, it shows how many real postings your choices catch. Everything lands in notes you can read and change at any time.</p>
    </div>
    <ol class="how">
      <li><div class="stack"><span>In Claude desktop, start a new <b>Code</b> session in your jobs folder and say hello</span>
        <span class="row-flex"><code>${a.workspace}</code><${CopyButton} text=${a.workspace} label="Copy" onCopied=${onToast} />
          ${a.connected ? html`<span class="chip ok">Claude connected</span>` : html`<span class="chip">not connected yet</span>`}</span>
        <span class="small soft">Pick the folder in the session's folder chooser (or paste the path). Claude works on Jobs only from there, with its own safety rules.</span></div></li>
      <li><div class="stack"><span>Click <b>Set up with Claude</b> and answer its questions in that chat, in your own words and your own language.</span>
        <span class="small soft">Have your resume or CV ready if you have one; no resume is fine too. It takes about 20 to 30 minutes.</span></div></li>
      <li><div class="stack"><span>Claude proposes job boards for your field and country, checks the careers pages of employers you name, fetches once and previews what passes your rules.</span>
        <span class="small soft">If no job board covers your field where you live, it says so and what still works: employers' pages, LinkedIn if you switch it on, links you paste.</span></div></li>
      <li><span>Review what Claude wrote: on the <b>Sources</b> and <b>Preferences</b> tabs, or in Notes. Nothing is used until you are happy with it.</span></li>
    </ol>
    ${req ? html`<div class="state info" role="status"><span class="title"><span class=${`dot ${req.status === 'picked' ? 'busy' : 'wait'}`}></span>${req.status === 'picked' ? 'Claude is setting up Jobs with you in the chat' : 'Waiting for Claude to start the setup'}</span>
        ${req.last ? html`<span class="small soft">${req.last.text}</span>` : null}</div>` : null}
    ${s.request?.status === 'failed' ? html`<div class="state bad"><span class="title">Setup stopped</span><span class="small">${s.request.result}</span></div>` : null}
    <div class="row-flex">
      <button type="button" class="btn primary" onClick=${onSetup} disabled=${!!req}>Set up with Claude</button>
      <button type="button" class="btn" aria-expanded=${editing} onClick=${() => setEditing(!editing)}>I'll edit the files</button>
    </div>
    ${editing ? html`<div class="stack">
      <p class="soft small">These notes live in your vault. Templates with comments are in <code>vault-template/</code> in the Crewdeck repo.</p>
      <ul class="files">${s.files.map((f) => html`<li key=${f.name}><code title=${f.path}>${f.file}</code><span class="small soft">${LABEL[f.name] ?? ''}</span>${fileState(f)}
        ${f.exists ? html`<button type="button" class="btn small" onClick=${() => onNotes(f.page)}>Open in Notes</button>` : null}</li>`)}</ul>
      <p class="small">When you are done, check them in a terminal:</p>
      <div class="row-flex"><code>crewdeck jobs check</code><${CopyButton} text="crewdeck jobs check" onCopied=${onToast} /></div>
    </div>` : null}
  </section>`;
}
