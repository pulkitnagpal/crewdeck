// A link that opens a new Claude Code session in a folder, in the Claude desktop app (docs/everywhere.md E11):
// claude://code/new?folder=<absolute path>&q=<prompt>. Claude desktop asks the person to confirm the folder every time
// (a folder from a link is never trusted on its own) and puts the prompt in the message box without sending it.
// Documented at https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link.
//
// Jobs work runs on demand in a Jobs chat opened in front of the person (ADR-0004 revised, ADR-0006): Find, intake,
// Apply and (ADR-0008 pane mode) a portal's sign-in each open one with a prompt naming that task and its request. The prompts are fixed words and ids only, so the
// panel (plugin/hooks/register.tsx) can check a link against these exact shapes before it opens anything.
import { isAbsolute } from 'node:path';

/** What the new jobs session's message box says: the person presses Enter, and the bridge brings Jobs' requests. */
export const JOBS_SESSION_PROMPT = 'Hello! This is my Crewdeck Jobs session.';
/** Before the job search is set up: sent in the jobs folder, it starts the setup interview (the jobs-setup skill). */
export const JOBS_SETUP_PROMPT = 'Hello! Please set up my Crewdeck job search.';

/** The work a Jobs chat can be opened for. `tell` is intake (P3); `prepare` is one pick prepared on the person's click. */
export type JobsTask =
  | { kind: 'session' }
  | { kind: 'setup' }
  | { kind: 'find'; request: number }
  | { kind: 'apply'; role: string; request: number }
  | { kind: 'prepare'; role: string; request: number }
  /** Quick apply: today's eligible Easy Apply picks, one by one, each stopping at Submit for the person's click. */
  | { kind: 'quick_apply'; request: number }
  | { kind: 'tell'; request: number }
  /** ADR-0008 pane mode: sign in to a portal in Claude's browser pane (or test it), in a Jobs chat in front. */
  | { kind: 'connect'; portal: string; request: number };

const ID = /^[A-Za-z0-9]{1,64}$/;
const REQ = /^[1-9][0-9]{0,9}$/;
/** A portal id in a task prompt: lowercase letters, digits and dashes (the catalog's ids are stricter still). */
export const PORTAL_TASK_ID = /^[a-z0-9-]{1,40}$/;

/** The first message of a Jobs chat opened for a task (the jobs-workspace skill does exactly that task first). */
export function taskPrompt(t: JobsTask): string {
  const req = (n: number) => {
    if (!Number.isInteger(n) || !REQ.test(String(n))) throw new Error('a request id is a positive whole number');
    return String(n);
  };
  const role = (r: string) => {
    if (!ID.test(r)) throw new Error('a role id is letters and digits');
    return r;
  };
  switch (t.kind) {
    case 'session': return JOBS_SESSION_PROMPT;
    case 'setup': return JOBS_SETUP_PROMPT;
    case 'find': return `Crewdeck: run Find request ${req(t.request)}`;
    case 'apply': return `Crewdeck: apply to role ${role(t.role)} (request ${req(t.request)})`;
    case 'prepare': return `Crewdeck: prepare role ${role(t.role)} (request ${req(t.request)})`;
    case 'tell': return `Crewdeck: handle tell request ${req(t.request)}`;
    case 'quick_apply': return `Crewdeck: quick apply (request ${req(t.request)})`;
    case 'connect':
      if (!PORTAL_TASK_ID.test(t.portal)) throw new Error('a portal id is lowercase letters, digits and dashes');
      return `Crewdeck: connect portal ${t.portal} (request ${req(t.request)})`;
  }
}

/** The exact prompt shapes taskPrompt makes, and nothing else (ids alphanumeric). Keep in step with register.tsx. */
const TASK_PROMPTS: [RegExp, (m: RegExpExecArray) => JobsTask][] = [
  [/^Hello! This is my Crewdeck Jobs session\.$/, () => ({ kind: 'session' })],
  [/^Hello! Please set up my Crewdeck job search\.$/, () => ({ kind: 'setup' })],
  [/^Crewdeck: run Find request ([1-9][0-9]{0,9})$/, (m) => ({ kind: 'find', request: Number(m[1]) })],
  [/^Crewdeck: apply to role ([A-Za-z0-9]{1,64}) \(request ([1-9][0-9]{0,9})\)$/, (m) => ({ kind: 'apply', role: m[1]!, request: Number(m[2]) })],
  [/^Crewdeck: prepare role ([A-Za-z0-9]{1,64}) \(request ([1-9][0-9]{0,9})\)$/, (m) => ({ kind: 'prepare', role: m[1]!, request: Number(m[2]) })],
  [/^Crewdeck: handle tell request ([1-9][0-9]{0,9})$/, (m) => ({ kind: 'tell', request: Number(m[1]) })],
  [/^Crewdeck: quick apply \(request ([1-9][0-9]{0,9})\)$/, (m) => ({ kind: 'quick_apply', request: Number(m[1]) })],
  [/^Crewdeck: connect portal ([a-z0-9-]{1,40}) \(request ([1-9][0-9]{0,9})\)$/, (m) => ({ kind: 'connect', portal: m[1]!, request: Number(m[2]) })],
];

/** A Jobs chat's first prompt, read back: the task it names, or null for any other text. */
export function parseTaskPrompt(text: string): JobsTask | null {
  for (const [re, make] of TASK_PROMPTS) {
    const m = re.exec(text);
    if (m) return make(m);
  }
  return null;
}

export function sessionLink(folder: string, prompt?: string): string {
  if (!isAbsolute(folder)) throw new Error('a session folder is an absolute path');
  return `claude://code/new?folder=${encodeURIComponent(folder)}${prompt ? `&q=${encodeURIComponent(prompt)}` : ''}`;
}

/** A Jobs chat link for a task: always the jobs folder. */
export function jobsTaskLink(workspace: string, t: JobsTask): string {
  return sessionLink(workspace, taskPrompt(t));
}

/** A link Crewdeck built: claude://code/new, an absolute folder, and a prompt of exactly one of the task shapes. */
export function isJobsTaskLink(url: string): boolean {
  const m = /^claude:\/\/code\/new\?folder=([^&#\s]+)&q=([^&#\s]*)$/.exec(url);
  if (!m) return false;
  try { return decodeURIComponent(m[1]!).startsWith('/') && parseTaskPrompt(decodeURIComponent(m[2]!)) !== null; } catch { return false; }
}
