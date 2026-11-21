// What Claude knows about the user, by note: each item with its source, and the note to open in Notes.
import { html, noop, More } from '../lib.js';

const TABS = [['profile', 'Profile'], ['career', 'Career'], ['search', 'Search'], ['memory', 'Memory'], ['answers', 'Answers'], ['learned', 'Learned']];
const ABOUT = {
  profile: 'Who you are and your standard answers.',
  career: 'Your resume facts, word for word.',
  search: 'What you are looking for.',
  memory: 'What you told Claude, with the date.',
  answers: 'Answers you approved on application forms.',
  learned: 'How your actions reorder what Claude reads first.',
};
/** The longer word on each tab, one More away. */
const MORE = {
  profile: 'From me/profile.md.',
  career: 'Claude cites these and never writes new ones.',
  search: 'From jobs/search.md.',
  memory: 'In your own words, as you said them along the way.',
  answers: 'The latest answer you approved for each question, kept in the tracker per role.',
  learned: 'Applying, "not interested", setting a pick aside and leaving a pick for a week nudge the order a little. Never a rule: nothing is hidden or let through because of it. Only your actions count, never Claude\'s.',
};
const EMPTY = {
  profile: 'Nothing here yet. Set up Jobs, or tell Claude about yourself.',
  career: 'No resume facts yet. Give Claude your resume during setup.',
  search: 'Nothing here yet. Set your search on Preferences.',
  memory: 'Nothing yet. Say "remember…" to Claude.',
  answers: 'No approved answers yet.',
  learned: 'Nothing learned yet. It comes from what you apply to and pass on.',
};

export function Knowledge({ data, onTab = noop, onNotes = noop }) {
  return html`<div class="page">
    <div class="page-head">
      <div><h1>What Claude knows</h1><p class="sub">Only your resume and your own words.</p></div>
    </div>
    <div class="tabs" role="tablist" aria-label="Notes">
      ${TABS.map(([k, label]) => html`<button type="button" role="tab" aria-selected=${data.tab === k} onClick=${() => onTab(k)}>${label}<span class="n">${data.counts[k]}</span></button>`)}
    </div>
    <div class="row-flex"><span class="soft small grow">${ABOUT[data.tab]}</span>
      ${data.page ? html`<button type="button" class="btn small" onClick=${() => onNotes(data.page)}>Open in Notes</button>` : null}</div>
    <${More} summary="Details"><span>${MORE[data.tab]}</span><span>Each item shows its source. Change anything in Notes or by telling Claude.</span></${More}>
    <ul class="kb">
      ${data.items.map((i) => html`<li class="card" key=${i.id}><div class="stack">
          <span class="t">${i.title}</span><span class="x">${i.text}</span>
          ${i.quote && i.quote !== i.text ? html`<span class="quote">“${i.quote}”</span>` : null}
          ${i.source ? html`<span class="hint">${i.source}</span>` : null}
        </div>${i.used ? html`<span class="used">${i.used}</span>` : null}</li>`)}
      ${data.items.length ? null : html`<li class="card"><span class="soft">${EMPTY[data.tab] ?? 'Nothing here yet.'}</span></li>`}
    </ul>
  </div>`;
}
