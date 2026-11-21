// Crewdeck's own browser profile for signed-in portals (ADR-0008 §1): a persistent Chromium context in
// <jobs.home>/portals/profile (0700), run with the person's own Chrome/Chromium/Brave/Edge, never their everyday profile.
// Every request still goes through the guard proxy, which for a portal admits only that portal's hosts (its own, its
// CDNs, and for the sign-in window its sign-in helpers such as reCAPTCHA): a portal page can't make the browser reach
// this machine, the local network, or any other site. Headless by default; visible for connect and `headful` portals.
//
// Scan and connect code talk to the small PortalBrowser interface below, so tests run them with a fake launcher.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { QUIET, browserEnv, requireBrowser } from '../browser.ts';
import { type GuardProxy, proxyArgs, startGuardProxy } from '../net/guard-proxy.ts';
import type { NetOptions } from '../net/netguard.ts';
import { type Portal, allowedHosts, hostIn } from './catalog.ts';
import type { Captured } from './extract.ts';

export type Loaded = { status: number; url: string };
/** One tab: load a URL, read its HTML, and the JSON responses it loaded since. */
export type PortalPage = {
  goto(url: string): Promise<Loaded>;
  html(): Promise<string>;
  /** JSON responses matching the portal's adapters, captured since the last goto. */
  captured(): Captured[];
};
export type OpenPage = { url: string; has(selector: string): Promise<boolean> };
export type PortalBrowser = {
  newPage(): Promise<PortalPage>;
  /** Cookies on the portal's hosts (names only matter). */
  cookies(): Promise<{ name: string; domain: string }[]>;
  /** The pages open now (the sign-in window's tabs). */
  pages(): Promise<OpenPage[]>;
  /** True once the person closed the window (or the browser went away). */
  closed(): boolean;
  /** Clear the portal's cookies and site data in this profile (disconnect). */
  clearPortal(): Promise<void>;
  /** Hosts the guard refused (shown by `portals test`). */
  blocked(): string[];
  close(): Promise<void>;
};
export type LaunchOptions = { headless: boolean; signIn?: boolean };
export type Launch = (portal: Portal, o: LaunchOptions) => Promise<PortalBrowser>;

export const portalsDir = (home: string) => join(home, 'portals');
export const profileDir = (home: string) => join(home, 'portals', 'profile');

/** The profile folder, private to the person (0700, its parent too). */
export function ensureProfile(home: string): string {
  const dir = profileDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(portalsDir(home), 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

/** Bodies kept per response, and responses kept per page load. */
const BODY_MAX = 3_000_000, KEEP = 50;
const isJson = (ct: string | undefined) => /\bjson\b/i.test(ct ?? '');

function wrapPage(page: Page, portal: Portal): PortalPage {
  let captured: Captured[] = [];
  const patterns = portal.json.filter((j) => j.url).map((j) => { try { return new RegExp(j.url); } catch { return null; } }).filter((r): r is RegExp => !!r);
  page.on('response', (r) => {
    if (!patterns.length || captured.length >= KEEP || !patterns.some((re) => re.test(r.url())) || !isJson(r.headers()['content-type'])) return;
    const list = captured;
    r.text().then((body) => { if (list === captured && body.length <= BODY_MAX && list.length < KEEP) list.push({ url: r.url(), body }); }, () => {});
  });
  return {
    async goto(url) {
      captured = [];
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      // The page's own requests (the JSON layer) arrive after the document: wait for the network to settle, briefly.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      return { status: res?.status() ?? 0, url: page.url() };
    },
    html: () => page.content(),
    captured: () => [...captured],
  };
}

/** Open the profile for one portal: the person's browser, through the guard proxy that admits only the portal's hosts. */
export async function launchPortal(home: string, portal: Portal, o: LaunchOptions & { setting?: string; net?: NetOptions }): Promise<PortalBrowser> {
  const found = requireBrowser(o.setting);
  const dir = ensureProfile(home);
  const proxy: GuardProxy = await startGuardProxy({ net: o.net, allowHosts: allowedHosts(portal, { signIn: o.signIn }) });
  let context: BrowserContext | undefined;
  try {
    const { chromium } = await import('playwright-core');
    context = await chromium.launchPersistentContext(dir, {
      executablePath: found.path, headless: o.headless, args: [...proxyArgs(proxy), ...QUIET], env: browserEnv(), timeout: 30_000,
      serviceWorkers: 'block', acceptDownloads: false, viewport: o.headless ? { width: 1366, height: 900 } : null,
    });
  } catch (e: any) {
    await proxy.close();
    // Chromium refuses a profile another Crewdeck window has open.
    if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(String(e?.message))) throw new Error('Crewdeck\'s portal browser is already open (a sign-in window or a scan): try again when it is closed');
    throw e;
  }
  const ctx = context;
  let gone = false;
  ctx.on('close', () => { gone = true; });
  const mine = (domain: string) => hostIn(domain.replace(/^\./, ''), portal.hosts);
  return {
    async newPage() { return wrapPage(await ctx.newPage(), portal); },
    async cookies() { return (await ctx.cookies()).filter((c) => mine(c.domain)).map((c) => ({ name: c.name, domain: c.domain })); },
    async pages() {
      if (gone) return [];
      return ctx.pages().map((p) => ({ url: p.url(), has: (sel: string) => p.$(sel).then((h) => !!h, () => false) }));
    },
    closed: () => gone,
    async clearPortal() {
      for (const host of portal.hosts) {
        await ctx.clearCookies({ domain: new RegExp(`(^|\\.)${host.replace(/\./g, '\\.')}$`) }).catch(() => {});
      }
      // Local storage and the rest of the portal's site data, through the DevTools protocol (no page is loaded).
      const page = ctx.pages()[0] ?? await ctx.newPage();
      const cdp = await ctx.newCDPSession(page).catch(() => null);
      if (cdp) for (const host of portal.hosts) await cdp.send('Storage.clearDataForOrigin', { origin: `https://${host}`, storageTypes: 'all' }).catch(() => {});
    },
    blocked: () => proxy.blocked.map((b) => b.host),
    async close() { if (!gone) await ctx.close().catch(() => {}); gone = true; await proxy.close(); },
  };
}

/** The launcher for the CLI: the config's browser setting, the real network. */
export const realLaunch = (home: string, setting?: string, net?: NetOptions): Launch => (portal, o) => launchPortal(home, portal, { ...o, setting, net });

/** Signed in: any one of the portal's checks passes (its cookie, an open page's path, a selector on an open page). */
export async function isSignedIn(b: PortalBrowser, portal: Portal): Promise<boolean> {
  const chk = portal.signed_in;
  if (chk.cookie && (await b.cookies()).some((c) => c.name === chk.cookie)) return true;
  if (!chk.url_pattern && !chk.selector) return false;
  let re: RegExp | null = null;
  try { re = chk.url_pattern ? new RegExp(chk.url_pattern) : null; } catch {}
  for (const p of await b.pages()) {
    let u: URL;
    try { u = new URL(p.url); } catch { continue; }
    if (!hostIn(u.hostname, portal.hosts)) continue;
    if (re && re.test(u.pathname)) return true;
    if (chk.selector && await p.has(chk.selector)) return true;
  }
  return false;
}
