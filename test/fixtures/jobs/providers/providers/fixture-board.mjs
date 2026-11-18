// A job board: the entry's api answers { jobs: [...] }.
export default {
  id: 'fixture-board',
  async fetch(entry, ctx) {
    const data = await ctx.fetchJson(entry.api);
    return data.jobs;
  },
};
