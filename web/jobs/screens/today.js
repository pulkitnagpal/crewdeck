// Today: the roles waiting for the user, one role's application (first-time questions on top, every answer with its
// source), and its apply panel.
import { useState } from 'preact/hooks';
import { html, noop, cls, safeHref, Icon } from '../lib.js';
import { ApplyPanel } from './apply.js';
import { SetupCard } from './setup.js';

function QueueItem({ item, active, onSelect }) {
  return html`<button type="button" class="qitem" aria-current=${active ? 'true' : undefined} onClick=${() => onSelect(item.id)}>
    <span class="co">${item.company}</span><span class="ti">${item.title}</span>
    <span class=${cls('chip', item.chip.kind)}>${item.chip.text}</span>
  </button>`;
}

function FirstTimeRow({ row, onAnswer }) {
  const [text, setText] = useState('');
  return html`<div class="qa first">
    <span class="ref">${row.ref}</span>
    <div class="body">
      <div class="head"><span class="q">${row.label}${row.required ? '' : ' (optional)'}</span><span class="chip first">First time</span></div>
      ${row.options.length ? html`<div class="options" role="group" aria-label=${row.label}>${row.options.map((o) => html`<button type="button" class="option" onClick=${() => onAnswer(row.field_id, { option: o })}>${o}</button>`)}</div>`
        : html`<div class="editbox"><textarea rows="2" aria-label=${`Your answer: ${row.label}`} placeholder="Your answer, in your words" value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
          <div class="row-flex"><button type="button" class="btn small" disabled=${!text.trim()} onClick=${() => { onAnswer(row.field_id, { text }); setText(''); }}>Save my answer</button></div></div>`}
      <span class="hint">${row.reason && !/^met on|^sensitive/.test(row.reason) ? row.reason : 'Answer once here (or tell Claude): it is remembered for every later form.'}</span>
    </div>
  </div>`;
}

function AnswerRow({ row, asking, onEdit, onImprove }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(row.text ?? '');
  const [askOpen, setAskOpen] = useState(false);
  const [note, setNote] = useState('');
  return html`<div class=${cls('qa', asking && 'asking')}>
    <span class="ref">${row.ref}</span>
    <div class="body">
      <div class="head"><span class="q">${row.label}</span>
        <span class="tools">
          ${asking ? html`<span class="chip info">Claude is on it</span>` : null}
          ${row.status === 'drafted' ? html`<span class="chip">Draft</span>` : null}
          <button type="button" class="linkbtn" aria-expanded=${editing} onClick=${() => { setText(row.text ?? ''); setEditing(!editing); }}>${editing ? 'Cancel' : 'Edit'}</button>
          <button type="button" class="linkbtn" aria-expanded=${askOpen} onClick=${() => setAskOpen(!askOpen)}>Ask Claude</button>
        </span></div>
      ${editing ? html`<div class="editbox"><textarea aria-label=${`Edit: ${row.label}`} rows=${Math.min(8, Math.max(2, Math.ceil(text.length / 70)))} value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
          <div class="row-flex"><button type="button" class="btn small primary" disabled=${!text.trim()} onClick=${() => { onEdit(row.field_id, text); setEditing(false); }}>Save</button><span class="hint">Your words are kept as they are: Claude never redrafts them.</span></div></div>`
        : html`<p class="ans">${row.text}</p>`}
      ${askOpen ? html`<div class="editbox"><input aria-label=${`What should Claude change in: ${row.label}`} placeholder="What should change? e.g. shorter, mention the dashboards" value=${note} onInput=${(e) => setNote(e.currentTarget.value)} />
          <div class="row-flex"><button type="button" class="btn small" onClick=${() => { onImprove(row.field_id, note); setAskOpen(false); setNote(''); }}>Send to Claude</button></div></div>` : null}
      ${row.source ? html`<span class="hint">${row.source}</span>` : null}
    </div>
  </div>`;
}

function NotInterested({ d, onSave, onCancel }) {
  const [reason, setReason] = useState('');
  const [words, setWords] = useState('');
  return html`<div class="skipbox">
    <b>Not interested in ${d.company}?</b>
    <label class="f"><span class="lab">Why? Later searches read this in your words.</span>
      <textarea class="field" rows="2" placeholder="e.g. too much travel for me" value=${reason} onInput=${(e) => setReason(e.currentTarget.value)}></textarea></label>
    <label class="f"><span class="lab">Also skip every future role with these words in the title (optional, comma-separated)</span>
      <input class="field" value=${words} placeholder="e.g. Sales" onInput=${(e) => setWords(e.currentTarget.value)} /></label>
    <div class="row-flex"><button type="button" class="btn primary small" disabled=${!reason.trim()} onClick=${() => onSave(reason, words.split(',').map((w) => w.trim()).filter(Boolean))}>Skip and remember</button>
      <button type="button" class="btn quiet small" onClick=${onCancel}>Cancel</button></div>
  </div>`;
}

function Detail({ d, asking, actions }) {
  const [tab, setTab] = useState('form');
  const [skipping, setSkipping] = useState(false);
  const posting = safeHref(d.url);
  const first = d.rows.filter((r) => r.status === 'first_time');
  return html`<section class="detail" aria-labelledby="role-title">
    <div class="dhead">
      <div>
        <h1 id="role-title">${d.company}</h1>
        <p class="meta">${d.title}${d.meta ? ` · ${d.meta}` : ''}</p>
        ${d.why ? html`<p class="why">${d.why}</p>` : null}
      </div>
      <div class="acts">
        ${posting ? html`<a class="btn small" href=${posting} target="_blank" rel="noopener noreferrer">View posting</a>` : null}
        ${d.status !== 'applied' ? html`<button type="button" class="btn small quiet" aria-expanded=${skipping} onClick=${() => setSkipping(!skipping)}>Not interested</button>` : null}
      </div>
    </div>
    ${skipping ? html`<${NotInterested} d=${d} onCancel=${() => setSkipping(false)} onSave=${(reason, words) => { actions.onSkip(d.id, reason, words); setSkipping(false); }} />` : null}
    <div class="tabs" role="tablist">
      ${[['form', 'Application form', d.rows.length], ['resume', 'Resume'], ['outreach', 'Outreach', d.outreach.length || undefined]].map(([k, label, n]) =>
        html`<button type="button" role="tab" aria-selected=${tab === k} onClick=${() => setTab(k)}>${label}${n ? html`<span class="n">${n}</span>` : null}</button>`)}
    </div>
    ${tab === 'form' ? html`<section class="rows" aria-label="Questions and answers">
        ${first.length ? html`<p class="small soft">${first.length === 1 ? 'One question is' : `${first.length} questions are`} new to Claude: answer once and it is remembered.</p>` : null}
        ${d.rows.map((r) => (r.status === 'first_time'
          ? html`<${FirstTimeRow} key=${`f${r.field_id}`} row=${r} onAnswer=${(f, v) => actions.onAnswer(d.id, { field_id: f, ...v })} />`
          : html`<${AnswerRow} key=${`a${r.field_id}:${r.answer_id ?? ''}`} row=${r} asking=${asking.includes(r.field_id)} onEdit=${(f, t) => actions.onEdit(d.id, f, t)} onImprove=${(f, n) => actions.onImprove(d.id, f, n)} />`))}
        ${d.rows.length ? null : html`<p class="soft">Claude hasn't read this application form yet: it does that while preparing the role.</p>`}
        ${d.questions.length ? html`<div class="qa"><span class="ref">?</span><div class="body"><span class="q">Claude would like to know</span>${d.questions.map((q) => html`<p key=${q.id}>${q.text}</p>`)}<span class="hint">Answer in the chat.</span></div></div>` : null}
      </section>` : null}
    ${tab === 'resume' ? html`<section class="stack">${d.resume ? html`<p class="soft">${d.resume.note} · ${d.resume.file}</p><iframe class="pdf" src=${d.resume.url} title="Tailored resume"></iframe>` : html`<p class="soft">No tailored resume yet.</p>`}</section>` : null}
    ${tab === 'outreach' ? html`<section class="stack">${d.outreach.length ? d.outreach.map((o, i) => html`<div class="mini" key=${i}><b>${o.channel === 'email' ? 'Email' : 'LinkedIn'}${o.who ? `: ${o.who}` : ''}</b><span class="soft">${o.summary}</span><span class="hint">${o.status === 'sent' ? 'Sent' : 'Draft: you send it'}</span></div>`) : html`<p class="soft">No outreach prepared.</p>`}</section>` : null}
  </section>`;
}

const n = (x) => Number(x ?? 0).toLocaleString('en-US');

/**
 * Find explains a small result (design §24.7, D28): the funnel stored with the run, what the rules dropped, what the
 * judge said, sources that returned nothing, and fixes from the preview. Each fix opens Preferences with the change in
 * the form and its preview showing; nothing is saved until the user clicks Save.
 */
export function WhySoFew({ find, preview, onFix = noop, onPreview = noop, onNotes = noop }) {
  const f = find.funnel;
  // The rules took most of the pool, or the judge said no to most of what they let through (or both).
  const rulesCause = f.rules.reduce((x, r) => x + r.n, 0) > f.passed_rules;
  const judgeCause = f.passed_rules >= f.need && f.fits < f.need && f.no > 0;
  const fixes = (preview?.suggestions ?? []).filter((s) => s.more > 0).slice(0, 2);
  return html`<section class="card why" aria-labelledby="why-title">
    <div class="stack">
      <h2 id="why-title">Why so few? <span class="soft">Find ${f.need} jobs: ${f.picked} picked</span></h2>
      <p class="funnel">${f.line}</p>
      ${rulesCause && f.rules_line ? html`<p class="soft">${f.rules_line}</p>` : null}
      ${judgeCause && f.judge_reasons.length ? html`<div class="soft"><span>The judge's most common reasons:</span><ul class="reasons">${f.judge_reasons.map((r, i) => html`<li key=${i}>${r.text}${r.n > 1 ? ` (${n(r.n)})` : ''}</li>`)}</ul></div>` : null}
      ${f.sources?.empty ? html`<p class="soft">Sources: ${f.sources.empty} of your ${f.sources.total} returned nothing${f.sources.why.length ? ` (${f.sources.why.join('; ')})` : ''}. <button type="button" class="linkbtn" onClick=${() => onNotes('jobs/sources')}>Open your sources</button></p>` : null}
      ${f.coverage ? html`<p class="soft">${f.coverage}</p>` : null}
      <div class="row-flex">
        ${fixes.map((s, i) => html`<button type="button" key=${i} class=${`btn small${i === 0 ? ' primary' : ''}`} title=${s.text} onClick=${() => onFix(s)}>${s.label}</button>`)}
        ${preview ? null : html`<span class="small soft" role="status">Checking what one change would bring back…</span>`}
        <button type="button" class="btn small quiet" onClick=${onPreview}>See the preview</button>
      </div>
    </div>
  </section>`;
}

export function Today({ data, state, preview = null, actions = {} }) {
  const a = { onSelect: noop, onAnswer: noop, onEdit: noop, onImprove: noop, onSkip: noop, onApply: noop, onMarkApplied: noop, onReveal: noop, onToast: noop, onSetup: noop, onNotes: noop, onFix: noop, onPreview: noop, ...actions };
  const setup = state?.setup?.needed;
  if (setup && !data.queue.length) return html`<div class="page"><${SetupCard} state=${state} onSetup=${a.onSetup} onNotes=${a.onNotes} onToast=${a.onToast} /></div>`;
  const why = data.find ? html`<${WhySoFew} find=${data.find} preview=${preview} onFix=${a.onFix} onPreview=${a.onPreview} onNotes=${a.onNotes} />` : null;
  if (!data.queue.length) {
    return html`<div class="page">${why}<div class="empty">
      <span class="ico"><${Icon} name="briefcase" size=${22} /></span>
      <h2>Nothing to review</h2>
      <p class="soft">Paste a job link above, or click <b>Find ${state?.quota ?? 5} jobs</b>: Claude judges the best candidates and prepares each pick. Roles you applied to are in Applications.</p>
    </div></div>`;
  }
  return html`<div class="todaycol">${why}<div class="today">
    <nav class="queue" aria-label="Today's roles">
      <span class="label">Today · ${data.queue.length}</span>
      ${data.queue.map((q) => html`<${QueueItem} key=${q.id} item=${q} active=${q.id === data.selected} onSelect=${a.onSelect} />`)}
    </nav>
    ${data.detail ? html`<div class="work">
      <${Detail} d=${data.detail} asking=${data.asking ?? []} actions=${a} />
      <${ApplyPanel} d=${data.detail} panel=${data.panel} reveal=${!!state?.reveal} workspace=${state?.agent?.workspace ?? ''}
        onApply=${a.onApply} onCancel=${a.onCancel} onMarkApplied=${a.onMarkApplied} onAnswer=${a.onAnswer} onReveal=${a.onReveal} onToast=${a.onToast} />
    </div>` : null}
  </div></div>`;
}
