// One-tap reasons for Not interested (For you) and Hide (Explore): chips, one tap is done (no typing). "Other…" opens the
// free-text field; a quiet link sends the person to the Tell box for a general rule. The labels are the reason text that
// Crewdeck remembers (the server keeps the same list: src/jobs/pipeline/apply.ts SKIP_REASONS; a test compares them).
import { useLayoutEffect, useRef } from 'preact/hooks';
import { html, cls, noop } from '../lib.js';

export const REASONS = [
  { id: 'location', label: 'Wrong location' },
  { id: 'too_junior', label: 'Too junior' },
  { id: 'too_senior', label: 'Too senior' },
  { id: 'stack', label: 'Not my stack' },
  { id: 'company', label: "Don't like the company" },
  { id: 'pay', label: 'Pay too low' },
  { id: 'applied_elsewhere', label: 'Already applied elsewhere' },
  { id: 'other', label: 'Other' },
];

/** The chips as buttons: a tap on one reason calls onPick(reason); Other… calls onOther; the quiet link calls onGeneral. */
export function ReasonChips({ onPick = noop, onOther = noop, onGeneral = noop, otherOpen = false, first = true }) {
  const box = useRef(null);
  // Focus goes to the first chip when the box opens, so the keyboard can pick at once.
  useLayoutEffect(() => { if (first) box.current?.querySelector('button')?.focus(); }, []);
  return html`<div class="reasons" ref=${box}>
    <div class="rchips" role="group" aria-label="Why? Pick one">
      ${REASONS.map((r) => (r.id === 'other'
        ? html`<button type="button" key=${r.id} class=${cls('rchip', 'dashed', otherOpen && 'on')} aria-expanded=${otherOpen ? 'true' : 'false'} onClick=${onOther}>Other…</button>`
        : html`<button type="button" key=${r.id} class="rchip" onClick=${() => onPick(r)}>${r.label}</button>`))}
    </div>
    <button type="button" class="linkbtn quiet rule" onClick=${onGeneral}>Tell Crewdeck a general rule</button>
  </div>`;
}

/** Esc on a box closes it (the opener takes the focus back). */
export const onEsc = (close) => (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
