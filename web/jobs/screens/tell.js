// Tell Crewdeck (P3): one input at the top of Today for anything the person wants Crewdeck to know (a link, a LinkedIn
// post, "now PM roles"), and the Proposals card: what Claude suggests changing, each item with Approve / Reject, and what
// Crewdeck applied at once from the person's own words, with Undo. Pure: data and callbacks in, markup out.
import { useState } from 'preact/hooks';
import { html, noop, plural, More } from '../lib.js';

export const TELL_PLACEHOLDER = 'Tell Crewdeck anything: a link, a LinkedIn post, \'now PM roles\'…';
export const MAX_TELL = 3000;

export function TellBox({ onTell = noop }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    const text = v.trim();
    if (!text || busy) return;
    setBusy(true);
    try { if (await onTell(text)) setV(''); } finally { setBusy(false); }
  };
  return html`<form class="tell" aria-label="Tell Crewdeck" onSubmit=${go}>
    <input class="field" aria-label="Tell Crewdeck" type="text" maxlength=${MAX_TELL} autocomplete="off" placeholder=${TELL_PLACEHOLDER} value=${v} onInput=${(e) => setV(e.currentTarget.value)} />
    <button type="submit" class="btn small primary" disabled=${!v.trim() || busy}>Send</button>
  </form>`;
}

const ORIGIN = { person: 'from what you said', quoted: 'from what you pasted', fetched: 'from a page Claude read' };

function Item({ p, it, onApprove, onReject }) {
  return html`<li class="pitem">
    <div class="pline">
      <span class="what">${it.line}</span>
      <span class="pacts">
        <button type="button" class="btn small" onClick=${() => onApprove(p.id, it.n)} aria-label=${`Approve: ${it.line}`}>Approve</button>
        <button type="button" class="btn small quiet" onClick=${() => onReject(p.id, it.n)} aria-label=${`Reject: ${it.line}`}>Reject</button>
      </span>
    </div>
    <span class="hint">${it.starts ? `Starts ${it.starts} · ` : ''}${it.reason}${it.error ? html` · <span class="bad">Not applied: ${it.error}</span>` : null}</span>
    ${it.evidence ? html`<${More} summary="Where this comes from"><p>“${it.evidence}”</p></${More}>` : null}
  </li>`;
}

/** Pending proposal items, then a quiet line for what Crewdeck applied on its own (Undo). Nothing at all when empty. */
export function Proposals({ data, onApprove = noop, onReject = noop, onApproveAll = noop, onUndo = noop }) {
  const pending = (data?.pending ?? []).filter((p) => p.items.some((i) => i.status === 'pending'));
  const undoable = [...(data?.pending ?? []), ...(data?.recent ?? [])].flatMap((p) => p.items.filter((i) => i.can_undo).map((it) => ({ p, it })));
  // ADR-0008 §9: approved for a later day ("from tomorrow…"): shown with its date, Undo cancels it before it starts.
  const waiting = undoable.filter(({ it }) => it.status === 'scheduled');
  const applied = undoable.filter(({ it }) => it.status !== 'scheduled');
  if (!pending.length && !applied.length && !waiting.length) return null;
  const count = pending.reduce((n, p) => n + p.items.filter((i) => i.status === 'pending').length, 0);
  return html`<section class="card proposals" aria-labelledby="proposals-h">
    <header class="phead">
      <h2 id="proposals-h">Proposals${count ? html` <span class="n">${count}</span>` : null}</h2>
      ${count > 1 ? html`<button type="button" class="btn small primary" onClick=${() => onApproveAll(pending.map((p) => p.id))}>Approve all</button>` : null}
    </header>
    ${pending.map((p) => html`<div class="prop" key=${p.id}>
      <p class="small soft">${p.summary} · ${ORIGIN[p.origin] ?? ''}</p>
      <ul class="plist">${p.items.filter((i) => i.status === 'pending').map((it) => html`<${Item} key=${it.n} p=${p} it=${it} onApprove=${onApprove} onReject=${onReject} />`)}</ul>
    </div>`)}
    ${waiting.length ? html`<ul class="plist">${waiting.map(({ p, it }) => html`<li class="pitem" key=${`${p.id}.${it.n}`}><div class="pline"><span class="what">${it.line}</span>
        <button type="button" class="linkbtn" onClick=${() => onUndo(p.id, it.n)} aria-label=${`Undo: ${it.line}`}>Undo</button></div><span class="hint">Starts ${it.starts}</span></li>`)}</ul>` : null}
    ${applied.length ? html`<${More} summary=${`Applied from your words: ${plural(applied.length, 'change')}`}>
      <ul class="plist">${applied.map(({ p, it }) => html`<li class="pitem" key=${`${p.id}.${it.n}`}><div class="pline"><span class="what">${it.done ?? it.line}</span>
        <button type="button" class="linkbtn" onClick=${() => onUndo(p.id, it.n)} aria-label=${`Undo: ${it.done ?? it.line}`}>Undo</button></div></li>`)}</ul>
    </${More}>` : null}
  </section>`;
}

/** The top of Today: the Tell box, then the Proposals card (when something waits). */
export function TellArea({ proposals, actions = {} }) {
  const a = { onTell: noop, onApproveProposal: noop, onRejectProposal: noop, onApproveAllProposals: noop, onUndoProposal: noop, ...actions };
  return html`<div class="tellarea">
    <${TellBox} onTell=${a.onTell} />
    <${Proposals} data=${proposals} onApprove=${a.onApproveProposal} onReject=${a.onRejectProposal} onApproveAll=${a.onApproveAllProposals} onUndo=${a.onUndoProposal} />
  </div>`;
}
