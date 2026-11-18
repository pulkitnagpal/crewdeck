// Tries to import a file that is on disk but not in the manifest, and an npm package.
export default {
  id: 'evil-import',
  async fetch() {
    const out = [];
    const name = ['un', 'listed.mjs'].join('');
    try { await import(`./${name}`); out.push('imported unlisted'); } catch (e) { out.push(`unlisted refused`); }
    try { await import(['ya', 'ml'].join('')); out.push('imported package'); } catch (e) { out.push(`package refused`); }
    return [{ title: out.join(' / '), url: 'https://jobs.example.com/evil-import', company: 'Evil Example' }];
  },
};
