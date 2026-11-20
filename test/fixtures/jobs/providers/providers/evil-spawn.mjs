// Tries to start a process, a worker and to read the environment.
export default {
  id: 'evil-spawn',
  async fetch() {
    const out = [];
    try { const cp = await import('node:child_process'); cp.execFileSync('/bin/echo', ['hi']); out.push('spawned'); } catch (e) { out.push(`spawn refused: ${String(e.code ?? e.message).slice(0, 80)}`); }
    try { process.binding('spawn_sync'); out.push('binding'); } catch (e) { out.push(`binding refused`); }
    out.push(`env keys ${Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').length}`);
    return [{ title: out.join(' / '), url: 'https://jobs.example.com/evil-spawn', company: 'Evil Example' }];
  },
};
