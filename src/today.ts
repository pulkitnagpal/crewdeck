// The Today panel's data (docs/everywhere.md E7–E9): today's to-dos from the journal page, tickets from each project's
// Backlog.md folder. Plain files the person also edits in Notes, Obsidian or a board: we read them as data, add one
// line or flip one checkbox, and never rewrite anything else.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Project } from './config.ts';

export type Todo = { line: number; done: boolean; text: string };
export type Ticket = { project: string; id: string; title: string; status: string };

/** The machine's local date, YYYY-MM-DD: the journal page people expect for "today". */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const journalPath = (vault: string, date: string) => {
  if (!DATE.test(date)) throw new TodayError('a date is YYYY-MM-DD');
  return join(vault, 'journal', `${date}.md`);
};

const CHECKBOX = /^(\s*[-*+] \[)([ xX])(\] )(.*)$/;
const HEADING = /^##\s+to[- ]?dos?\s*$/i;

export class TodayError extends Error {}

/** Every checkbox line of the page, with its 1-based line number. */
export function todosOf(vault: string, date: string): Todo[] {
  const file = journalPath(vault, date);
  if (!existsSync(file)) return [];
  const out: Todo[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((l, i) => {
    const m = CHECKBOX.exec(l);
    if (m) out.push({ line: i + 1, done: m[2] !== ' ', text: m[4].trim() });
  });
  return out;
}

/** One line of the person's words: no line breaks or control characters, at most 300 characters. */
export function cleanTodo(raw: unknown): string {
  if (typeof raw !== 'string') throw new TodayError('a to-do is text');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(raw)) throw new TodayError('a to-do is one line');
  const t = raw.trim();
  if (!t) throw new TodayError('a to-do needs some text');
  if (t.length > 300) throw new TodayError('a to-do is at most 300 characters');
  return t;
}

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Add `- [ ] text` under the page's "## To do" heading (after its last checkbox), creating the page or heading if needed. */
export function addTodo(vault: string, date: string, raw: unknown): Todo[] {
  const text = cleanTodo(raw);
  const file = journalPath(vault, date);
  const item = `- [ ] ${text}`;
  if (!existsSync(file) || !readFileSync(file, 'utf8').trim()) {
    writeAtomic(file, `# ${date}\n\n## To do\n${item}\n`);
    return todosOf(vault, date);
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  const h = lines.findIndex((l) => HEADING.test(l));
  if (h < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '## To do', item, '');
  } else {
    // After the heading's run of checkboxes (blank lines inside the run don't end it; a heading or other text does).
    let at = h + 1;
    for (let i = h + 1; i < lines.length; i++) {
      if (CHECKBOX.test(lines[i])) at = i + 1;
      else if (lines[i].trim() !== '') break;
    }
    lines.splice(at, 0, item);
  }
  writeAtomic(file, lines.join('\n'));
  return todosOf(vault, date);
}

/** Tick or untick one to-do, named by its line and its text: a page edited since the panel drew is refused, not guessed. */
export function setTodo(vault: string, date: string, line: unknown, text: unknown, done: unknown): Todo[] {
  if (!Number.isInteger(line) || (line as number) < 1) throw new TodayError('line is a line number');
  if (typeof done !== 'boolean') throw new TodayError('done is true or false');
  const file = journalPath(vault, date);
  if (!existsSync(file)) throw new TodayError('today\'s page has no to-dos');
  const lines = readFileSync(file, 'utf8').split('\n');
  const m = CHECKBOX.exec(lines[(line as number) - 1] ?? '');
  if (!m || m[4].trim() !== text) throw new TodayError('the page changed since this list was drawn: refresh and try again');
  lines[(line as number) - 1] = `${m[1]}${done ? 'x' : ' '}${m[3]}${m[4]}`;
  writeAtomic(file, lines.join('\n'));
  return todosOf(vault, date);
}

const DONE = /^(done|completed|closed|cancel+ed)$/i;
const ACTIVE = /^(in[ -]?progress|doing|started|review|in review)$/i;

/** Open tickets of every project's board (backlog/tasks/*.md frontmatter), in progress first, at most `limit`. */
export function ticketsOf(projects: Pick<Project, 'name' | 'path'>[], limit = 8): { tickets: Ticket[]; more: number } {
  const all: Ticket[] = [];
  for (const p of projects) {
    const dir = join(p.path, 'backlog', 'tasks');
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const n of names) {
      let fm: any;
      try {
        // Regular files of a sane size only: a symlink, FIFO or device here would otherwise block or leak (review #5).
        const st = lstatSync(join(dir, n));
        if (!st.isFile() || st.size > 256_000) continue;
        const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, n), 'utf8'));
        fm = m ? parseYaml(m[1]) : null;
      } catch { continue; }
      if (!fm || typeof fm !== 'object') continue;
      const status = String(fm.status ?? '');
      if (DONE.test(status)) continue;
      all.push({ project: p.name, id: String(fm.id ?? n.replace(/\.md$/, '')).slice(0, 40), title: String(fm.title ?? '').slice(0, 200), status: status.slice(0, 40) });
    }
  }
  all.sort((a, b) => Number(ACTIVE.test(b.status)) - Number(ACTIVE.test(a.status)) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { tickets: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}
