// What Claude knows about the user, by note: each item with its source, and the note to open in Notes.
import { html, noop } from '../lib.js';

const TABS = [['profile', 'Profile'], ['career', 'Career'], ['search', 'Search'], ['memory', 'Memory'], ['answers', 'Answers']];
const ABOUT = {
  profile: 'Who you are and your standard answers, from me/profile.md.',
  career: 'Your resume facts, word for word: Claude cites these and never writes new ones.',
  search: 'What you are looking for, from jobs/search.md.',
  memory: 'What you told Claude along the way, in your words, with the date.',
  answers: 'The latest answer you approved for each question on an application form.',
};

export function Knowledge({ data, onTab = noop, onNotes = noop }) {
  return html`<div class="page">
    <div class="page-head">
      <div><h1>What Claude knows</h1><p class="sub">Only your resume and your own words, each with its source. Change anything in Notes or by telling Claude.</p></div>
    </div>
    <div class="tabs" role="tablist" aria-label="Notes">
      ${TABS.map(([k, label]) => html`<button type="button" role="tab" aria-selected=${data.tab === k} onClick=${() => onTab(k)}>${label}<span class="n">${data.counts[k]}</span></button>`)}
    </div>
    <div class="row-flex"><span class="soft small grow">${ABOUT[data.tab]}</span>
      ${data.page ? html`<button type="button" class="btn small" onClick=${() => onNotes(data.page)}>Open in Notes</button>` : html`<span class="hint">Kept in the tracker, per role.</span>`}</div>
    <ul class="kb">
      ${data.items.map((i) => html`<li class="card" key=${i.id}><div class="stack">
          <span class="t">${i.title}</span><span class="x">${i.text}</span>
          ${i.quote && i.quote !== i.text ? html`<span class="quote">“${i.quote}”</span>` : null}
          ${i.source ? html`<span class="hint">${i.source}</span>` : null}
        </div>${i.used ? html`<span class="used">${i.used}</span>` : null}</li>`)}
      ${data.items.length ? null : html`<li class="card"><span class="soft">Nothing here yet.</span></li>`}
    </ul>
  </div>`;
}
