// A stand-in for the portals engine's page API (ADR-0008), for the Sources screen's tests only: the same shapes as
// GET /api/jobs/portals and the page actions connectPortal, disconnectPortal, togglePortal and testPortal, over an
// in-memory list. Nothing here opens a browser, reads ~/.crewdeck or reaches a portal. The real engine replaces it.

export type PortalState = 'not_connected' | 'connected' | 'needs_sign_in' | 'paused';
export type PortalView = {
  id: string; name: string; countries: string[]; fields: string[]; state: PortalState; enabled: boolean;
  paused_until?: string; last_scan?: string; last_found?: number; risk: string; signup_url: string; login_url: string; verified: boolean;
};
export type PortalTest = { found: number; by: { json: number; jsonld: number; links: number }; sample: { title: string; company: string; url: string }[]; stopped?: string };
export type StubAnswer = { status: number; json: unknown };

export const STUB_RISK = 'Crewdeck scans this site with your account at a slow pace; sites may not allow automation and could limit your account.';

/** A fictional portal with every field set (override what a test needs). */
export function stubPortal(id: string, o: Partial<PortalView> = {}): PortalView {
  return {
    id, name: id.replace(/(^|-)(\w)/g, (_, s, c) => `${s ? ' ' : ''}${c.toUpperCase()}`), countries: ['in'], fields: ['software'], state: 'not_connected', enabled: false,
    risk: STUB_RISK, signup_url: `https://${id}.example.com/register`, login_url: `https://${id}.example.com/login`, verified: true, ...o,
  };
}

export function createPortalsStub(initial: PortalView[], o: { test?: (p: PortalView) => PortalTest } = {}) {
  const portals = initial.map((p) => ({ ...p }));
  const calls: { name: string; body: any }[] = [];
  const find = (id: unknown) => portals.find((p) => p.id === id);
  const test = o.test ?? ((p: PortalView): PortalTest => ({
    found: 3, by: { json: 2, jsonld: 0, links: 1 },
    sample: [{ title: 'Backend Engineer', company: 'Example Labs', url: `https://${p.id}.example.com/jobs/1` }, { title: 'Data Analyst', company: 'Sample Co', url: `https://${p.id}.example.com/jobs/2` }],
  }));
  const actions: Record<string, (b: any) => StubAnswer> = {
    connectPortal: (b) => {
      const p = find(b.id);
      if (!p) return { status: 400, json: { error: 'unknown portal' } };
      return { status: 200, json: { ok: true, opened: true } };
    },
    disconnectPortal: (b) => {
      const p = find(b.id);
      if (!p) return { status: 400, json: { error: 'unknown portal' } };
      Object.assign(p, { state: 'not_connected', enabled: false }); delete p.last_scan; delete p.last_found; delete p.paused_until;
      return { status: 200, json: { ok: true } };
    },
    togglePortal: (b) => {
      const p = find(b.id);
      if (!p) return { status: 400, json: { error: 'unknown portal' } };
      if (p.state === 'not_connected') return { status: 400, json: { error: `Connect ${p.name} first` } };
      p.enabled = !!b.on;
      return { status: 200, json: { ok: true, enabled: p.enabled } };
    },
    testPortal: (b) => {
      const p = find(b.id);
      if (!p) return { status: 400, json: { error: 'unknown portal' } };
      if (p.state !== 'connected') return { status: 400, json: { error: `${p.name} is not connected` } };
      return { status: 200, json: test(p) };
    },
  };
  return {
    portals, calls,
    view: () => ({ portals: portals.map((p) => ({ ...p })) }),
    /** The engine finishing a sign-in (or a scan hitting a sign-in wall): set a portal's fields. */
    set(id: string, patch: Partial<PortalView>) { Object.assign(find(id)!, patch); },
    /** Answer one request of the page, or null when it isn't a portals call. */
    answer(method: string, path: string, body: any): StubAnswer | null {
      if (method === 'GET' && path === '/api/jobs/portals') return { status: 200, json: this.view() };
      const m = /^\/api\/jobs\/action\/(\w+)$/.exec(path);
      if (method === 'POST' && m && Object.hasOwn(actions, m[1])) { calls.push({ name: m[1], body }); return actions[m[1]](body ?? {}); }
      return null;
    },
  };
}
export type PortalsStub = ReturnType<typeof createPortalsStub>;
