// Applications: everything picked, in progress or applied, newest first.
import { html, cls } from '../lib.js';

const CHIP = { Applied: 'ok', 'Ready to review': 'info', Preparing: '' };

export function Applications({ data }) {
  return html`<div class="page">
    <div class="page-head"><div><h1>Applications</h1><p class="sub">Every role you picked, prepared or applied to. Replies and interviews are recorded by Claude as you tell it.</p></div></div>
    ${data.rows.length ? html`<div class="card tablebox"><table>
      <thead><tr><th scope="col">Company</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Applied</th><th scope="col">Outreach</th><th scope="col">Next</th></tr></thead>
      <tbody>${data.rows.map((r) => html`<tr key=${r.id}><td><b>${r.company}</b></td><td>${r.title}</td><td><span class=${cls('chip', CHIP[r.status])}>${r.status}</span></td><td>${r.applied}</td><td class="soft">${r.outreach}</td><td class="soft">${r.next}</td></tr>`)}</tbody>
    </table></div>` : html`<div class="card empty"><h2>No applications yet</h2><p class="soft">Roles you pick show up here, and stay after you apply.</p></div>`}
  </div>`;
}
