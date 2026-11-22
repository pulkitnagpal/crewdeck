// Connect = the person signs in (ADR-0008 §2): a visible window of Crewdeck's portal profile at the portal's sign-in
// (or sign-up) page. The person types passwords and codes and solves any check; Crewdeck never fills a field. It polls
// the portal's signed-in check every 3 s for up to 15 minutes, records the connection and closes the window.
// Disconnect clears that portal's cookies and site data from the profile and forgets its state; the profile stays.
import type { Portal } from './catalog.ts';
import { type Launch, isSignedIn } from './profile.ts';
import { updatePortal } from './state.ts';

export const POLL_MS = 3000;
export const CONNECT_TIMEOUT_MS = 15 * 60_000;

export type ConnectResult = { ok: boolean; outcome: 'connected' | 'closed' | 'timeout' | 'error'; why?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function connectPortal(home: string, portal: Portal, o: { launch: Launch; signup?: boolean; pollMs?: number; timeoutMs?: number; now?: () => Date; sleep?: (ms: number) => Promise<void> }): Promise<ConnectResult> {
  const wait = o.sleep ?? sleep;
  const now = o.now ?? (() => new Date());
  let b;
  try { b = await o.launch(portal, { headless: false, signIn: true }); } catch (e: any) { return { ok: false, outcome: 'error', why: String(e?.message ?? e).slice(0, 300) }; }
  try {
    const page = await b.newPage();
    // Already signed in (a reconnect after a pause): the check passes without the person doing anything.
    await page.goto(o.signup ? portal.signup_url : portal.login_url).catch(() => {});
    const deadline = Date.now() + (o.timeoutMs ?? CONNECT_TIMEOUT_MS);
    for (;;) {
      if (b.closed()) return { ok: false, outcome: 'closed', why: 'the window was closed before signing in finished' };
      if (await isSignedIn(b, portal).catch(() => false)) {
        updatePortal(home, portal.id, (p) => {
          // Signing in again is the person's answer to a stop: the pause and the sign-in flag go.
          const { pause: _p, needs_sign_in: _n, last_error: _e, ...rest } = p;
          return { ...rest, connected: true, connected_at: now().toISOString() };
        });
        return { ok: true, outcome: 'connected' };
      }
      if (Date.now() >= deadline) return { ok: false, outcome: 'timeout', why: `not signed in after ${Math.round((o.timeoutMs ?? CONNECT_TIMEOUT_MS) / 60_000)} minutes` };
      await wait(o.pollMs ?? POLL_MS);
    }
  } finally { await b.close(); }
}

/** Forget a portal: its cookies and site data leave the profile (when a browser is there), its state leaves the file. */
export async function disconnectPortal(home: string, portal: Portal, o: { launch?: Launch } = {}): Promise<{ ok: true; cleared: boolean; why?: string }> {
  let cleared = false, why: string | undefined;
  if (o.launch) {
    try {
      const b = await o.launch(portal, { headless: true });
      try { await b.clearPortal(); cleared = true; } finally { await b.close(); }
    } catch (e: any) { why = String(e?.message ?? e).slice(0, 300); }
  }
  // The day's page count stays: disconnecting and reconnecting doesn't reset the daily cap.
  updatePortal(home, portal.id, (p) => (p.day ? { day: p.day } : {}));
  return { ok: true, cleared, ...(why ? { why } : {}) };
}
