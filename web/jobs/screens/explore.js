// Explore: every role Crewdeck found that passed your rules, free to search, filter and open yourself (no Claude involved).
// Saving a role marks it for "Judge these N", the one thing here that asks Claude (it carries the spark and a token hint).
// Roles come from two kinds of source, shown by their own quiet icon: a feed (automatic) or one of your accounts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, noop, cls, safeHref, plural, age, Icon, Spark } from '../lib.js';

const n = (x) => Number(x ?? 0).toLocaleString('en-US');
/** About 1.3k tokens per role judged. */
export const TOKENS_PER_JUDGED = 1300;
/** "about 8k tokens" for N roles. */
export const judgeHint = (roles) => `about ${Math.max(1, Math.round((roles * TOKENS_PER_JUDGED) / 1000))}k tokens`;

/** "Remote · India": the workplace (when the source says) then where. */
export function whereText(r) {
  const w = r.workplace ? r.workplace[0].toUpperCase() + r.workplace.slice(1) : '';
  const loc = String(r.location ?? '').trim();
  if (w && loc && !loc.toLowerCase().startsWith(w.toLowerCase())) return `${w} · ${loc}`;
  return loc || w || '—';
}

/** The little mark of where a role was found: a feed (signal) or one of your accounts (person). */
export const SourceMark = ({ group }) => html`<span class=${`srcmark ${group === 'accounts' ? 'acct' : 'feed'}`} aria-hidden="true"><${Icon} name=${group === 'accounts' ? 'person' : 'feed'} size=${14} /></span>`;

function Chip({ on, onClick, children, dashed = false }) {
  return html`<button type="button" class=${cls('fchip', on && 'on', dashed && 'dashed')} aria-pressed=${on ? 'true' : 'false'} onClick=${onClick}>${children}</button>`;
}

export const EMPTY_QUERY = { q: '', group: 'all', strong: false, days: 0, saved: false, others: false, sort: 'best', limit: 50 };

function Row({ r, onSave, onHide }) {
  const href = safeHref(r.url);
  const picked = r.status === 'picked' || r.status === 'prepared';
  return html`<tr class="xrow" data-role=${r.id}>
    <td class="xjob"><${href ? 'a' : 'span'} class="xtitle" href=${href ?? undefined} target="_blank" rel="noopener noreferrer">${r.title}<//><span class="xco">${r.company}</span></td>
    <td class="xwhere" data-label="Where">${whereText(r)}</td>
    <td class="xfound" data-label="Found on"><span class="foundon"><${SourceMark} group=${r.group} />${r.source_label}</span></td>
    <td class="xage" data-label="Posted">${age(r.posted_at)}</td>
    <td class="xact">${picked ? html`<span class="picked">Picked</span>` : html`
      <button type="button" class=${cls('iconbtn', r.saved && 'on')} aria-pressed=${r.saved ? 'true' : 'false'} aria-label=${r.saved ? `Saved: remove ${r.title} at ${r.company}` : `Save ${r.title} at ${r.company}`} onClick=${() => onSave(r)}><${Icon} name="bookmark" size=${16} fill=${r.saved} /></button>
      <button type="button" class="iconbtn quiet" aria-label=${`Hide ${r.title} at ${r.company}`} title="Hide: never show this job again" onClick=${() => onHide(r)}><${Icon} name="eyeoff" size=${16} /></button>`}</td>
  </tr>`;
}

/**
 * `data` is GET /api/jobs/explore; `query` the filters the page sent. `onQuery(patch)` changes them (the page refetches).
 */
export function Explore({ data, query = EMPTY_QUERY, found = null, onQuery = noop, onSave = noop, onHide = noop, onJudge = noop, judging = false }) {
  const q = { ...EMPTY_QUERY, ...query };
  const [text, setText] = useState(q.q);
  const timer = useRef(null);
  // Typing waits a moment before it asks again.
  useEffect(() => () => clearTimeout(timer.current), []);
  const type = (v) => { setText(v); clearTimeout(timer.current); timer.current = setTimeout(() => onQuery({ q: v }), 250); };
  const c = data.counts;
  const total = found ?? c.feeds + c.accounts;
  const judgeable = data.judgeable ?? c.saved;
  const more = data.rows.length < data.total;
  const canMore = more && q.limit < 200;
  return html`<div class="explore">
    <div class="xtools">
      <div class="xsearch">
        <label class="searchbox">
          <${Icon} name="search" size=${16} />
          <span class="sr">Search jobs</span>
          <input type="search" placeholder=${`Search ${n(total)} jobs: title, company, skill`} value=${text} onInput=${(e) => type(e.currentTarget.value)} />
        </label>
        <label class="sortbox">Sort
          <select class="select" value=${q.sort} onChange=${(e) => onQuery({ sort: e.currentTarget.value })}>
            <option value="best" selected=${q.sort === 'best'}>Best match</option>
            <option value="newest" selected=${q.sort === 'newest'}>Newest</option>
          </select></label>
      </div>
      <div class="fchips" role="group" aria-label="Filters">
        <${Chip} on=${q.group === 'all'} onClick=${() => onQuery({ group: 'all' })}>All sources<//>
        <${Chip} on=${q.group === 'feeds'} onClick=${() => onQuery({ group: q.group === 'feeds' ? 'all' : 'feeds' })}>Feeds <span class="cnt">${n(c.feeds)}</span><//>
        <${Chip} on=${q.group === 'accounts'} onClick=${() => onQuery({ group: q.group === 'accounts' ? 'all' : 'accounts' })}>Your accounts <span class="cnt">${n(c.accounts)}</span><//>
        <span class="fsep" aria-hidden="true"></span>
        <${Chip} on=${q.strong} onClick=${() => onQuery({ strong: !q.strong })}>Strong title match<//>
        <${Chip} on=${q.days === 7} onClick=${() => onQuery({ days: q.days === 7 ? 0 : 7 })}>Last 7 days<//>
        <${Chip} on=${q.saved} onClick=${() => onQuery({ saved: !q.saved })}>Saved <span class="cnt">${n(c.saved)}</span><//>
        <${Chip} dashed=${true} on=${q.others} onClick=${() => onQuery({ others: !q.others })}>Also show other occupations (${n(c.others)})<//>
      </div>
    </div>
    <div class="xbody">
      <div class="card xcard">
        ${data.rows.length ? html`<div class="xscroll"><table class="xtable">
          <thead><tr><th scope="col">Job</th><th scope="col">Where</th><th scope="col">Found on</th><th scope="col">Posted</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
          <tbody>${data.rows.map((r) => html`<${Row} key=${r.id} r=${r} onSave=${onSave} onHide=${onHide} />`)}</tbody></table></div>`
          : html`<p class="xempty">${q.q || q.strong || q.days || q.saved || q.group !== 'all' ? 'Nothing matches these filters.' : 'Nothing found yet: feeds update by themselves, or Find jobs reads your accounts.'}</p>`}
        <div class="xfoot" role="status">Showing ${n(data.rows.length)} of ${n(data.total)}${canMore ? html` · <button type="button" class="linkbtn" onClick=${() => onQuery({ limit: Math.min(200, q.limit + 50) })}>show more</button>` : more ? ' · narrow the search to see the rest' : ''}</div>
      </div>
      <aside class=${`xside${c.saved ? '' : ' empty'}`} aria-label="Saved">
        <div class="card xsaved">
          <b>${plural(c.saved, 'saved', 'saved')}</b>
          ${c.saved ? html`
            <p class="soft">Ask Claude to check if you are eligible, then prepare the ones that fit.</p>
            <button type="button" class="btn primary big2" disabled=${!judgeable || judging} onClick=${onJudge}><${Spark} size=${16} />Judge these ${judgeable}</button>
            <span class="hint center">${judgeable ? judgeHint(judgeable) : 'every saved role was judged already'}${judgeable && judgeable < c.saved ? ` · ${c.saved - judgeable} judged already` : ''}</span>`
            : html`<p class="soft">Save the jobs you like with the bookmark. Then ask Claude to check which ones fit you.</p>`}
        </div>
        <ul class="legend">
          <li><${SourceMark} group="feeds" />Feeds: fetched for free, every 12 h</li>
          <li><${SourceMark} group="accounts" />Your accounts: read when you Find</li>
        </ul>
      </aside>
    </div>
  </div>`;
}
