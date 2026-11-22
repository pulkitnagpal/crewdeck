// What is missing (design §2.9): no Claude session on the jobs lane, a note that fails validation, no browser.
import { html, noop, plural, CopyButton, More } from '../lib.js';

export function Banners({ state, onNotes = noop, onToast = noop, onOpenSession = noop }) {
  if (!state) return null;
  const a = state.agent ?? {};
  const waiting = a.waiting?.length ?? 0;
  const list = [];
  // Jobs chats open per request (P4), so no session is the normal idle state: say so only when work waits with no chat.
  const stuck = waiting && !(a.waiting ?? []).some((r) => r.hold === 'chat' || r.hold === 'fetching');
  if (!a.connected && !state.setup?.needed && stuck) {
    list.push(html`<div class=${`banner ${waiting ? 'warn' : ''}`} key="session">
      <div class="body">
        <span><b>No Claude session is working Jobs.</b>${waiting ? html` <span class="chip warn">${plural(waiting, 'request')} waiting</span>` : ''}</span>
        <${More} summary="Why?"><p>Open one in Claude desktop: <b>Open in Claude</b> starts a Code session in your jobs folder, <code>${a.workspace}</code>.</p>
          <p>Your requests wait here until that session picks them up. It needs the crewdeck plugin, which <code>crewdeck setup</code> installs.</p></${More}>
      </div>
      <div class="row-flex">${a.open_session ? html`<button type="button" class="btn small primary" onClick=${onOpenSession}>Open in Claude</button>` : null}<${CopyButton} text=${a.workspace} label="Copy folder" onCopied=${onToast} /></div>
    </div>`);
  }
  for (const [i, b] of (state.banners ?? []).entries()) {
    list.push(html`<div class=${`banner ${b.kind === 'note' ? 'bad' : 'warn'}`} key=${`b${i}`}>
      <div class="body"><b>${b.text}</b>${b.fix ? html`<${More} summary="How to fix"><p>${b.fix}</p></${More}>` : null}</div>
      ${b.page ? html`<div class="row-flex"><button type="button" class="btn small" onClick=${() => onNotes(b.page)}>Open in Notes</button></div>` : null}
    </div>`);
  }
  return list.length ? html`<div class="banners">${list}</div>` : null;
}
