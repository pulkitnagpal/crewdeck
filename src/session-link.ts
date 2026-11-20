// A link that opens a new Claude Code session in a folder, in the Claude desktop app (docs/everywhere.md E11):
// claude://code/new?folder=<absolute path>&q=<prompt>. Claude desktop asks the person to confirm the folder every time
// (a folder from a link is never trusted on its own) and puts the prompt in the message box without sending it.
// Documented at https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link.
import { isAbsolute } from 'node:path';

/** What the new jobs session's message box says: the person presses Enter, and the bridge brings Jobs' requests. */
export const JOBS_SESSION_PROMPT = 'Hello! This is my Crewdeck Jobs session.';
/** Before the job search is set up: sent in the jobs folder, it starts the setup interview (the jobs-setup skill). */
export const JOBS_SETUP_PROMPT = 'Hello! Please set up my Crewdeck job search.';

export function sessionLink(folder: string, prompt?: string): string {
  if (!isAbsolute(folder)) throw new Error('a session folder is an absolute path');
  return `claude://code/new?folder=${encodeURIComponent(folder)}${prompt ? `&q=${encodeURIComponent(prompt)}` : ''}`;
}
