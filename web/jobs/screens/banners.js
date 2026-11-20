// What is missing (design §2.9): no Claude session on the jobs lane, a note that fails validation, no browser.
import { html, noop, plural, CopyButton } from '../lib.js';

export function Banners({ state, onNotes = noop, onToast = noop }) {
  if (!state) return null;
  const a = state.agent ?? {};
  const waiting = a.waiting?.length ?? 0;
  const list = [];
  if (!a.connected && !state.setup?.needed) {
    list.push(html`<div class=${`banner ${waiting ? 'warn' : ''}`} key="session">
      <div class="body">
        <span><b>No Claude session is working Jobs.</b> In Claude desktop, start a new Code session in this folder: <code>${a.workspace}</code>${waiting ? html` · ${plural(waiting, 'request')} waiting` : ''}</span>
        <span class="fix">Your requests wait here until that session picks them up. It needs the crewdeck plugin, which <code>crewdeck setup</code> installs.</span>
      </div>
      <div class="row-flex"><${CopyButton} text=${a.workspace} label="Copy folder" onCopied=${onToast} /></div>
    </div>`);
  }
  for (const [i, b] of (state.banners ?? []).entries()) {
    list.push(html`<div class=${`banner ${b.kind === 'note' ? 'bad' : 'warn'}`} key=${`b${i}`}>
      <div class="body"><b>${b.text}</b>${b.fix ? html`<span class="fix">${b.fix}</span>` : null}</div>
      ${b.page ? html`<div class="row-flex"><button type="button" class="btn small" onClick=${() => onNotes(b.page)}>Open in Notes</button></div>` : null}
    </div>`);
  }
  return list.length ? html`<div class="banners">${list}</div>` : null;
}
