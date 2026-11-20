// crewdeck jobs propose | proposals | tell (P3, "Tell Crewdeck"): intake's only way to change the person's notes is a
// proposal file, checked here and stored by the running server, which applies items only as the design allows (the
// person's own words for low-risk kinds; everything else waits for Approve). Text and JSON only through files written
// with the Write tool, never the command line or stdin.
import { flag, positional, textFrom } from './cli.ts';
import { agentCall } from '../agent-client.ts';
import { checkProposal } from './proposals.ts';

const say = (s: string) => console.log(s);

/** A file's text, never stdin ("-") and never a value on the command line. */
function fileOnly(args: string[], name: string, usage: string): string {
  const f = flag(args, name);
  if (!f) throw new Error(usage);
  if (f === '-') throw new Error(`--${name} takes a file written with the Write tool, not stdin`);
  return textFrom(f, `--${name}`);
}

type View = { id: number; origin: string; summary: string; status: string; items: { n: number; line: string; reason: string; status: string; auto: boolean; done: string | null; error: string | null }[] };
const show = (p: View) => {
  say(`proposal ${p.id} (${p.origin}): ${p.summary}`);
  for (const it of p.items) say(`  ${it.n}. [${it.auto && it.status === 'approved' ? 'applied' : it.status}] ${it.line}${it.done && it.status === 'approved' ? ` — ${it.done}` : ''}${it.error ? ` — not applied: ${it.error}` : ''}`);
};
const itemArg = (v: string | undefined) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error('the item is its number (crewdeck jobs proposals list shows them)');
  return Number(v);
};

export const PROPOSE_USAGE = 'usage: crewdeck jobs propose --file <proposal.json> ({ origin: person|quoted|fetched, summary, request?, items: [{ kind, payload, reason, evidence? }] })';
export const PROPOSALS_USAGE = 'usage: crewdeck jobs proposals list [--json] | approve <id> [item] --quote-file <f with the person\'s yes, in their words> | reject <id> [item]';
export const TELL_USAGE = 'usage: crewdeck jobs tell --text-file <f>';

export async function propose(args: string[]) {
  if (positional(args).length) throw new Error(`${PROPOSE_USAGE} (nothing on the command line but the file)`);
  const t = fileOnly(args, 'file', PROPOSE_USAGE);
  let raw: unknown;
  try { raw = JSON.parse(t); } catch (e: any) { throw new Error(`--file: not valid JSON (${e.message})`); }
  const proposal = checkProposal(raw); // refused here, before anything reaches Crewdeck
  const p = await agentCall('/api/proposals', { op: 'propose', proposal }) as View;
  show(p);
  const pending = p.items.filter((i) => i.status === 'pending').length;
  say(pending ? `${pending} item${pending === 1 ? '' : 's'} wait for the person: Approve or Reject on the Jobs page (Today) or in the panel` : 'nothing waits for approval');
}

export async function proposals(args: string[]) {
  const [verb, id, item] = positional(args);
  if (verb === 'list') {
    const v = await agentCall('/api/proposals', { op: 'list' });
    if (args.includes('--json')) return say(JSON.stringify(v, null, 1));
    if (!v.pending.length) say('no proposals waiting');
    for (const p of v.pending) show(p);
    return;
  }
  if ((verb !== 'approve' && verb !== 'reject') || !/^\d+$/.test(id ?? '')) throw new Error(PROPOSALS_USAGE);
  if (verb === 'reject') return show(await agentCall('/api/proposals', { op: 'reject', id: Number(id), item: itemArg(item) }));
  // Approving from a chat needs the person's own yes, quoted in the note's Changes line.
  const quote = fileOnly(args, 'quote-file', `${PROPOSALS_USAGE}: approving from the chat needs the person's own yes`).trim();
  if (!quote) throw new Error('--quote-file is empty: it holds the person\'s yes, in their words');
  const r = await agentCall('/api/proposals', { op: 'approve', id: Number(id), item: itemArg(item), quote });
  show(r);
  for (const f of r.failed ?? []) say(`not applied: ${f}`);
  if (r.failed?.length) process.exitCode = 1;
}

export async function tell(args: string[]) {
  if (positional(args).length) throw new Error(`${TELL_USAGE} (the text only from the file)`);
  const text = fileOnly(args, 'text-file', TELL_USAGE).trim();
  if (!text) throw new Error('--text-file is empty');
  const r = await agentCall('/api/tell', { text });
  say(`queued tell request ${r.request}: a Jobs chat handles it (prompt "Crewdeck: handle tell request ${r.request}")`);
}
