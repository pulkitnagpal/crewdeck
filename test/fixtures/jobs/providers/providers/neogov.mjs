// A NEOGOV-shaped agency page on a fictional host: www.governmentjobs.example.test/careers/<agency>, 10 postings per
// page (?page=N), one agency per entry.
const RE = /^https?:\/\/www\.governmentjobs\.example\.test(:\d+)?\/careers\/([a-z0-9-]+)\/?$/;
export default {
  id: 'neogov',
  detect(entry) {
    return RE.test(entry.careers_url ?? '') ? { url: entry.careers_url } : null;
  },
  async fetch(entry, ctx) {
    const m = RE.exec(entry.careers_url ?? '');
    if (!m) throw new Error('neogov (fixture): not a NEOGOV agency page');
    const jobs = [];
    for (let page = 1; page <= (ctx.maxPages ?? 30); page++) {
      const d = await ctx.fetchJson(`${new URL(entry.careers_url).origin}/careers/${m[2]}/jobs.json?page=${page}`);
      for (const j of d.jobs) jobs.push({ title: j.title, url: j.url, company: d.agency, location: j.location });
      if (!d.more) break;
    }
    return jobs;
  },
};
