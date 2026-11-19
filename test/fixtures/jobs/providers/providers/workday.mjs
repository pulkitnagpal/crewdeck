// A Workday-shaped careers page on a fictional host: <tenant>.wd1.myworkdayjobs.example.test/<site>. The list comes from
// a POST to /wday/cxs/<tenant>/<site>/jobs, 20 per page, like the real CXS endpoint.
const RE = /^https?:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.example\.test(:\d+)?\/([A-Za-z0-9_-]+)\/?$/;
export default {
  id: 'workday',
  detect(entry) {
    return RE.test(entry.careers_url ?? '') ? { url: entry.careers_url } : null;
  },
  async fetch(entry, ctx) {
    const m = RE.exec(entry.careers_url ?? '');
    if (!m) throw new Error('workday (fixture): not a Workday careers page');
    const origin = new URL(entry.careers_url).origin;
    const jobs = [];
    for (let page = 0; page < (ctx.maxPages ?? 10); page++) {
      const r = await fetch(`${origin}/wday/cxs/${m[1]}/${m[3]}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limit: 20, offset: page * 20 }) });
      if (!r.ok) throw new Error(`workday (fixture): HTTP ${r.status}`);
      const d = await r.json();
      for (const p of d.jobPostings) jobs.push({ title: p.title, url: `${origin}/${m[3]}${p.externalPath}`, company: '', location: p.locationsText });
      if ((page + 1) * 20 >= d.total) break;
    }
    return jobs;
  },
};
