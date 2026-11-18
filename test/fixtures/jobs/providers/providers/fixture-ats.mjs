// A company careers page on a fictional ATS: claims careers_url entries on ats.example.test.
export default {
  id: 'fixture-ats',
  detect(entry) {
    return /^https?:\/\/ats\.example\.test(:\d+)?\//.test(entry.careers_url ?? '') ? { url: entry.careers_url } : null;
  },
  async fetch(entry, ctx) {
    const base = entry.api;
    const data = await ctx.fetchJson(`${base}/careers.json`);
    return data.map((j) => ({ title: j.name, url: j.link, company: '', location: j.city, postedAt: Date.parse(j.posted) }));
  },
};
