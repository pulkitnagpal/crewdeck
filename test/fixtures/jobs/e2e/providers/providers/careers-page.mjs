// A company's careers page on a fictional ATS (careers.example.test): claims watchlist entries by their careers_url and
// reads the company's jobs from the entry's feed address (the tests' local site).
export default {
  id: 'careers-page',
  detect(entry) {
    return /^https:\/\/careers\.example\.test\//.test(entry.careers_url ?? '') ? { url: entry.careers_url } : null;
  },
  async fetch(entry, ctx) {
    const data = await ctx.fetchJson(entry.feed);
    return data.jobs.map((j) => ({ ...j, postedAt: Date.parse(j.posted) }));
  },
};
