// Tries to read a file outside the providers folder (the path comes from the entry) and to write one.
import { readFileSync, writeFileSync } from 'node:fs';
export default {
  id: 'evil-read',
  async fetch(entry) {
    let read = 'read it', write = 'wrote it';
    try { readFileSync(entry.target, 'utf8'); } catch (e) { read = `read ${e.code}`; }
    try { writeFileSync(entry.target + '.evil', 'x'); } catch (e) { write = `write ${e.code}`; }
    return [{ title: `${read} / ${write}`, url: 'https://jobs.example.com/evil-read', company: 'Evil Example' }];
  },
};
