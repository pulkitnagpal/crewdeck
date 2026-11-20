// The apply panel (design §2.3a): Apply, then what Claude is doing in its own tab of the browser pane, the questions it
// needs, the tailored resume, and the user's turn to submit. Claude never clicks Submit.
import { useState } from 'preact/hooks';
import { html, noop, cls, clock, safeHref, plural, CopyButton } from '../lib.js';

const STEPS = ['Claude opens the application in a tab next to this one', 'Claude fills each page from your answers', 'You review the form and click Submit', 'You mark it applied here'];
const AT = { waiting: 0, filling: 1, needs_you: 1, your_turn: 2, confirmation: 3, stopped: 1, applied: 4 };

function Steps({ state }) {
  const at = AT[state] ?? -1;
  return html`<ol class="steps" aria-label="How Apply works">${STEPS.map((s, i) => html`<li key=${i} class=${i < at ? 'done' : i === at ? 'now' : ''}>${s}</li>`)}</ol>`;
}

function Lines({ lines }) {
  if (!lines?.length) return null;
  return html`<div class="block"><h3>What Claude did</h3>
    <ul class="lines" aria-live="polite">${[...lines].reverse().map((l, i) => html`<li key=${i}><time datetime=${l.at}>${clock(l.at)}</time><span>${l.text}</span></li>`)}</ul></div>`;
}

function Resume({ d, reveal, onReveal, linkedin }) {
  // The user's word for it (me/career.md → resume.word): "CV" or "resume".
  const word = d.resume_word === 'CV' ? 'CV' : 'resume';
  const letter = d.letter ? html`<span class="hint">Cover letter ready: ${d.letter} (next to the ${word}; Claude offers it for the form's letter upload).</span>` : null;
  if (!d.resume) return html`<div class="block"><h3>Tailored ${word}</h3><span class="hint">Not made yet: Claude makes it while preparing the role (a form with no upload and no work history needs none).</span>${letter}</div>`;
  return html`<div class="block"><h3>Tailored ${word}</h3>
    <div class="resume"><span class="pdfico" aria-hidden="true">PDF</span><span class="file" title=${d.resume.file}>${d.resume.file}</span></div>
    <div class="row-flex">
      <a class="btn small" href=${d.resume.url} target="_blank" rel="noopener">Open</a>
      <a class="btn small" href=${`${d.resume.url}?download=1`} download=${d.resume.file}>Download</a>
      ${reveal ? html`<button type="button" class="btn small" onClick=${() => onReveal(d.id)}>Show in Finder</button>` : null}
    </div>
    <span class="hint">${linkedin ? `Easy Apply: Claude picks a ${word} already on LinkedIn when one matches; otherwise attach this one in the form.` : 'The form\'s upload button is yours: Claude can\'t attach files.'}</span>
    ${letter}
  </div>`;
}

/** A first-time question inside the panel: options to click, or a box for the user's words. */
function AnswerBox({ label, options = [], onSave, required = true }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (v) => { setBusy(true); await onSave(v); setBusy(false); setText(''); };
  return html`<div class="stack">
    <span class="q">${label}${required ? '' : ' (optional)'}</span>
    ${options.length ? html`<div class="options">${options.map((o) => html`<button type="button" class="option" disabled=${busy} onClick=${() => save({ option: o })}>${o}</button>`)}</div>`
      : html`<div class="editbox"><textarea rows="2" aria-label=${`Your answer: ${label}`} placeholder="Your answer, in your words" value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
        <div class="row-flex"><button type="button" class="btn primary small" disabled=${!text.trim() || busy} onClick=${() => save({ text })}>Save and continue</button></div></div>`}
  </div>`;
}

export function ApplyPanel({ d, panel, reveal = false, workspace = '', openSession = false, onOpenSession = noop, onApply = noop, onCancel = noop, onMarkApplied = noop, onAnswer = noop, onReveal = noop, onToast = noop }) {
  const p = panel ?? { state: 'ready', progress: [] };
  const c = d.counts;
  const url = safeHref(d.url);
  const linkedin = !!url && /(^|\.)linkedin\.com\.*$/i.test(new URL(url).hostname);
  const firstRows = d.rows.filter((r) => r.status === 'first_time' && r.required);
  const openForm = url ? html`<a class="btn small" href=${url} target="_blank" rel="noopener noreferrer">Open the form</a>` : null;
  // Stop a request that waits, or that a session took and never finished (it closed, crashed or got stuck).
  const cancel = p.request ? html`<button type="button" class="btn quiet small" onClick=${() => onCancel(p.request)}>Cancel</button>` : null;
  const submitted = (primary) => html`<button type="button" class=${cls('btn', primary && 'primary big')} onClick=${() => onMarkApplied(d.id)}>I submitted it</button>`;

  let body;
  switch (p.state) {
    case 'applied':
      body = html`<div class="state ok"><span class="title">Applied${p.applied ? ` · ${p.applied}` : ''}</span><span class="small">The company cooldown has started and today's journal has a line for it.</span></div>`;
      break;
    case 'walk_in':
      body = html`<div class="state info"><span class="title">Apply in person</span>
          <span class="small">${p.note ? `From the posting: ${p.note}` : 'The posting asks you to come in: it says where and when.'}</span>
          <span class="small">Take your answers below (and the ${d.resume_word === 'CV' ? 'CV' : 'resume'}, printed) with you.</span></div>
        ${url ? html`<a class="btn" href=${url} target="_blank" rel="noopener noreferrer">Open the posting</a>` : null}
        <div class="stack">${(d.copy ?? []).map((a, i) => html`<div class="copyrow" key=${i}><span class="lbl">${a.label}</span><span class="ans">${a.text}</span></div>`)}</div>
        <button type="button" class="btn primary big" onClick=${() => onMarkApplied(d.id)}>I applied in person</button>`;
      break;
    case 'copy':
      body = html`<div class="state info"><span class="title">Copy these answers into the ${p.method === 'email' ? 'email' : p.method === 'document' ? 'document' : p.method === 'chatbot' ? 'chat' : 'form'}</span><span class="small">${p.copyReason}</span>${p.note ? html`<span class="small">From the posting: ${p.note}</span>` : null}</div>
        ${url ? html`<a class="btn" href=${url} target="_blank" rel="noopener noreferrer">Open the posting</a>` : null}
        <div class="stack">${(d.copy ?? []).map((a, i) => html`<div class="copyrow" key=${i}><span class="lbl">${a.label}</span><span class="ans">${a.text}</span>
          <div class="row-flex"><${CopyButton} text=${a.text} label="Copy" onCopied=${onToast} /></div></div>`)}</div>
        ${submitted(true)}`;
      break;
    case 'waiting':
      body = html`<div class="state info" role="status"><span class="title"><span class="dot wait"></span>Waiting for Claude</span>
        <span class="small">${p.connected ? 'Claude picks it up as soon as the chat is idle.' : html`No Claude session is working Jobs: open one in <code>${workspace}</code>.${openSession ? html` <button type="button" class="btn small primary" onClick=${onOpenSession}>Open in Claude</button>` : ''}`}</span>
        <div class="row-flex">${cancel}</div></div>
        <${Steps} state="waiting" />`;
      break;
    case 'filling':
      body = html`<div class="state info" role="status"><span class="title"><span class="dot busy"></span>Claude is filling the form</span>
        <span class="small">In its own tab of the browser pane, next to this one. Switch to it any time to watch.</span>
        ${p.connected ? null : html`<span class="small">No Claude session is connected: if it closed, cancel and try again.</span>`}
        <div class="row-flex">${openForm}${cancel}</div></div>
        <${Steps} state="filling" />`;
      break;
    case 'needs_you':
      body = html`<div class="state warn" role="status"><span class="title">Claude needs your answer</span>
          <span class="small">The form asks something Claude hasn't seen before. Your answer is remembered for every later form, and Claude continues from where it stopped.</span></div>
        ${firstRows.length
          ? firstRows.map((r) => html`<${AnswerBox} key=${r.field_id} label=${r.label} options=${r.options} required=${r.required} onSave=${(v) => onAnswer(d.id, { field_id: r.field_id, ...v })} />`)
          : html`<${AnswerBox} label=${p.question} onSave=${(v) => onAnswer(d.id, { request: p.request, text: v.text ?? v.option })} />`}
        <${Steps} state="needs_you" />`;
      break;
    case 'your_turn':
      body = html`<div class="state ok" role="status"><span class="title">Your turn: review the form tab and click Submit</span>
        ${p.reason ? html`<span class="small">Claude: ${p.reason}</span>` : null}
        <span class="small">Claude stopped at the review page and never clicks Submit.</span><div class="row-flex">${openForm}</div></div>
        ${submitted(true)}
        <button type="button" class="btn quiet small" onClick=${() => onApply(d.id)}>Ask Claude to fill it again</button>`;
      break;
    case 'confirmation':
      body = html`<div class="state ok" role="status"><span class="title">Claude sees the confirmation page</span>
        ${p.seen ? html`<span class="small">${p.seen}</span>` : null}</div>
        <button type="button" class="btn primary big" onClick=${() => onMarkApplied(d.id)}>Mark applied</button>`;
      break;
    case 'stopped':
      body = html`<div class="state bad" role="status"><span class="title">Claude stopped</span><span class="small">${p.reason}</span>
        <span class="small soft">Sign in, solve a check or wait for a limit yourself in the form tab, then try again. Claude doesn't retry on its own.</span></div>
        <div class="row-flex"><button type="button" class="btn primary" onClick=${() => onApply(d.id)}>Try again</button>${submitted(false)}</div>`;
      break;
    default:
      body = html`<div class="stats">
          <div class="stat"><b>${c.total}</b><span>questions</span></div>
          <div class="stat"><b>${c.known}</b><span>from what you've said</span></div>
          <div class="stat"><b>${c.drafted}</b><span>drafted, please check</span></div>
          <div class=${cls('stat', c.first && 'warn')}><b>${c.first}</b><span>first time</span></div>
        </div>
        ${p.method === 'account_needed' ? html`<div class="state warn" role="note"><span class="title">This site needs an account</span>
          <span class="small">Create it in the form tab (Claude never creates accounts), sign in, then click Continue.</span>${url ? html`<div class="row-flex">${openForm}</div>` : null}</div>` : null}
        <button type="button" class="btn primary big" disabled=${!d.approvable} onClick=${() => onApply(d.id)}>${p.method === 'account_needed' ? 'Continue' : 'Apply'}</button>
        <span class="hint">${d.approvable ? 'Claude opens the real form in a tab next to this one and fills it from your answers. You review it and click Submit.'
          : c.total ? `Answer the ${plural(c.first, 'first-time question')} first (here, or tell Claude).` : 'Claude is still reading the application form.'}</span>`;
  }
  return html`<aside class="side" aria-label="Apply">
    <div class="panel-head"><h2>Apply</h2>${p.state !== 'ready' && p.state !== 'copy' && p.state !== 'walk_in' ? html`<span class=${cls('chip', { applied: 'ok', needs_you: 'warn', stopped: 'bad', your_turn: 'ok', confirmation: 'ok' }[p.state] ?? 'info')}>${{ waiting: 'Waiting', filling: 'Filling', needs_you: 'Needs you', your_turn: 'Your turn', confirmation: 'Submitted?', stopped: 'Stopped', applied: 'Applied' }[p.state]}</span>` : null}</div>
    ${body}
    <${Lines} lines=${p.progress} />
    ${p.state !== 'applied' && p.state !== 'copy' && p.state !== 'walk_in' ? html`<${Resume} d=${d} reveal=${reveal} onReveal=${onReveal} linkedin=${linkedin} />` : null}
  </aside>`;
}
