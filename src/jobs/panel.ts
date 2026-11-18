// The apply panel (design §2.3a): what the Jobs page shows for one role's Apply, from the role and its latest apply
// request. Claude closes an apply request with one of three kinds of result, which the skills (P4) follow:
//   "needs you: <question>"   a question the form asks that has no answer yet; the request waits for the user
//   "submitted: <what it saw>" Claude sees the site's confirmation page: the page offers Mark applied
//   anything else             Claude stopped at Review/Submit: the user's turn
// and fails it with the reason when it had to stop (sign-in, CAPTCHA, restricted, a limit).
import type { Progress, Request } from '../requests.ts';

export type PanelState = 'ready' | 'copy' | 'waiting' | 'filling' | 'needs_you' | 'your_turn' | 'confirmation' | 'stopped' | 'applied';
export type Panel = {
  state: PanelState; request: number | null; connected: boolean; progress: Progress[];
  question?: string; reason?: string; seen?: string; applied?: string | null; copyReason?: string;
};

export const NEEDS_YOU = /^needs you:\s*/i;
export const SUBMITTED = /^submitted:\s*/i;

export function applyPanel(i: {
  status: string; apply: { mode: 'fill' | 'copy'; reason?: string }; applied?: string | null;
  request?: Request | null; connected: boolean;
}): Panel {
  const r = i.request ?? null;
  const base = { request: r?.id ?? null, connected: i.connected, progress: (r?.progress ?? []).slice(-15) };
  if (i.status === 'applied') return { ...base, state: 'applied', applied: i.applied ?? null };
  if (i.apply.mode === 'copy') return { ...base, state: 'copy', copyReason: i.apply.reason };
  if (!r) return { ...base, state: 'ready' };
  const result = String(r.result ?? '').trim();
  switch (r.status) {
    case 'new': return { ...base, state: 'waiting' };
    case 'picked': return { ...base, state: 'filling' };
    case 'failed': return { ...base, state: 'stopped', reason: result || 'Claude stopped without saying why: ask in the chat.' };
    default:
      if (NEEDS_YOU.test(result)) return { ...base, state: 'needs_you', question: result.replace(NEEDS_YOU, '').trim() || 'a question on the form' };
      if (SUBMITTED.test(result)) return { ...base, state: 'confirmation', seen: result.replace(SUBMITTED, '').trim() };
      return { ...base, state: 'your_turn', reason: result || undefined };
  }
}
