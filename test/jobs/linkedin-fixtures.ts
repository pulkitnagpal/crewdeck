// Fake LinkedIn guest-API markup (fictional companies) for the parser and client tests.
export const CARD = (id: string, title: string, co: string, loc = 'Berlin, Germany') => `<li>
  <div class="base-card base-search-card" data-entity-urn="urn:li:jobPosting:${id}">
  <h3 class="base-search-card__title">\n  ${title}\n </h3><h4 class="base-search-card__subtitle"><a class="hidden-nested-link">\n ${co}\n</a></h4>
  <span class="job-search-card__location">\n ${loc}\n </span><time class="job-search-card__listdate" datetime="2026-11-16">3 days ago</time></div></li>`;
export const DETAIL = (o: { title?: string; company?: string; kind?: string; closed?: boolean } = {}) => `<section class="top-card-layout">
  <h2 class="top-card-layout__title topcard__title">${o.title ?? 'Senior Data Analyst'}</h2>
  <a class="topcard__org-name-link topcard__flavor--black-link" href="#">\n ${o.company ?? 'Example &amp; Partners'}\n</a>
  <span class="topcard__flavor topcard__flavor--bullet">Berlin, Germany</span>
  <div data-tracking-control-name="public_jobs_${o.kind ?? 'apply-link-onsite'}"></div>
  ${o.closed ? '<figure class="closed-job"><figcaption>No longer accepting applications</figcaption></figure>' : ''}
  <div class="show-more-less-html__markup show-more-less-html__markup--clamp-after-5"><p>Build <strong>Looker</strong> dashboards.</p><ul><li>SQL</li><li>dbt</li></ul>Hybrid, Berlin.</div></section>`;
