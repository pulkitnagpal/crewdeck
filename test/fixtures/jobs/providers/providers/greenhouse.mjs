// A Greenhouse-shaped board on a fictional host: job-boards.greenhouse.example.test/<slug>, the whole board in one
// answer from /v1/boards/<slug>/jobs.
const RE = /^https?:\/\/job-boards\.greenhouse\.example\.test(:\d+)?\/([a-z0-9-]+)\/?$/;
export default {
  id: 'greenhouse',
  detect(entry) {
    return RE.test(entry.careers_url ?? '') ? { url: entry.careers_url } : null;
  },
  async fetch(entry, ctx) {
    const m = RE.exec(entry.careers_url ?? '');
    if (!m) throw new Error('greenhouse (fixture): not a Greenhouse board');
    const d = await ctx.fetchJson(`${new URL(entry.careers_url).origin}/v1/boards/${m[2]}/jobs`);
    return d.jobs.map((j) => ({ title: j.title, url: j.absolute_url, company: '', location: j.location?.name ?? '' }));
  },
};
