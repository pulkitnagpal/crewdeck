// `crewdeck doctor`, Jobs section: is everything a new user needs in place (design §2.9)? Reads files only; whether a
// Claude session works the jobs lane comes from the running Crewdeck, asked by the caller (src/cli.ts).
import { existsSync, statSync } from 'node:fs';
import type { Config } from '../config.ts';
import { NOTES, NOTE_NAMES, loadJobNotes } from './notes.ts';
import { dbFile } from './db.ts';
import { findBrowser, installHint } from './browser.ts';
import { providersStatus } from './providers.ts';
import { isPrivate, workspaceStatus } from './setup.ts';

export type Line = { ok: boolean | null; text: string };
/** What the running Crewdeck says about the jobs lane: null = not running; jobs false = running with Jobs off. */
export type Presence = null | { jobs: false } | { jobs: true; connected: boolean; seen: string | null };

export async function jobsDoctor(c: Config, presence: Presence): Promise<Line[]> {
  if (!c.jobs.enabled) return [{ ok: null, text: 'Jobs is off: crewdeck jobs init switches it on' }];
  const out: Line[] = [];
  const home = c.jobs.home;
  out.push({ ok: isPrivate(home), text: existsSync(home) ? `jobs home ${home}${isPrivate(home) ? ' (0700)' : ': others can read it (chmod 700)'}` : `jobs home ${home} is missing: run crewdeck jobs init` });

  const file = dbFile(home);
  if (!existsSync(file)) out.push({ ok: false, text: 'tracker jobs.db is missing: run crewdeck jobs init' });
  else {
    try {
      const { openDb } = await import('./db.ts');
      const db = openDb(file);
      const v = (db.prepare('pragma user_version').get() as any).user_version;
      db.close();
      const priv = (statSync(file).mode & 0o077) === 0;
      out.push({ ok: priv, text: `tracker jobs.db (schema v${v}${priv ? ', 0600' : ', readable by others: chmod 600'})` });
    } catch (e: any) { out.push({ ok: false, text: `tracker jobs.db: ${e?.message ?? e}` }); }
  }

  const notes = loadJobNotes(c.vault, home);
  for (const n of NOTE_NAMES) {
    const l = notes[n];
    const errs = l.issues.filter((i) => i.level === 'error').length, warns = l.issues.length - errs;
    if (!l.exists) { out.push({ ok: false, text: `${NOTES[n]} is missing: crewdeck jobs init creates it` }); continue; }
    out.push({ ok: !errs, text: `${NOTES[n]}${errs ? `: ${errs} error${errs > 1 ? 's' : ''} (crewdeck jobs check)${l.source === 'last-valid' ? ', using its last valid version' : ''}` : warns ? ` (${warns} warning${warns > 1 ? 's' : ''})` : ''}` });
  }

  const b = findBrowser(c.jobs.browser);
  out.push({ ok: !!b, text: b ? `browser for Jobs (forms, resume PDFs): ${b.name}` : `no Chromium-based browser for Jobs (forms, resume PDFs). ${installHint()}` });

  const ws = workspaceStatus(c);
  const stale = ws.filter((f) => !f.current);
  out.push({ ok: !stale.length, text: stale.length
    ? `jobs workspace ${c.jobs.workspace}: ${stale.map((f) => `${f.name} ${f.exists ? 'out of date' : 'missing'}`).join(', ')} (crewdeck jobs init or crewdeck up rewrites them)`
    : `jobs workspace ${c.jobs.workspace}: CLAUDE.md and .claude/settings.json current` });

  const p = providersStatus(c);
  out.push({ ok: p.ready ? true : null, text: p.message });

  if (presence === null) out.push({ ok: false, text: `Crewdeck isn't running on port ${c.port} (crewdeck up), so no Claude session can pick up Jobs requests yet` });
  else if (!presence.jobs) out.push({ ok: false, text: 'Crewdeck is running without Jobs: restart it (crewdeck up) to load Jobs' });
  else if (presence.connected) out.push({ ok: true, text: 'a Claude session works the jobs lane (crewdeck plugin connected)' });
  else out.push({ ok: false, text: `no Claude session works Jobs${presence.seen ? ` (last seen ${presence.seen})` : ''}: install the crewdeck plugin and open a session in ${c.jobs.workspace}` });
  return out;
}

export const mark = (ok: boolean | null) => (ok === null ? '·' : ok ? '✓' : '✗');
