// The user's own Chromium-based browser, run headless for two jobs: reading application forms and printing the resume.
// It never goes online on its own: every request passes the guard proxy (netguard), loopback included, service workers
// are blocked, and the PDF render runs with JavaScript off and the network off (design §14). playwright-core is loaded
// only when a browser is launched, so `crewdeck doctor` and the CLI stay light.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext } from 'playwright-core';
import type { NetOptions } from './net/netguard.ts';
import { type GuardProxy, proxyArgs, startGuardProxy } from './net/guard-proxy.ts';

export type FoundBrowser = { name: string; path: string };

const MAC_APPS: [string, string][] = [
  ['Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
  ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
];
const LINUX: [string, string[]][] = [
  ['Google Chrome', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']],
  ['Chromium', ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']],
  ['Brave', ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave']],
  ['Microsoft Edge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']],
];

/** Where `auto` looks, in order: Chrome, Chromium, Brave, Edge in the standard places. */
export function browserCandidates(platform = process.platform, home = homedir()): FoundBrowser[] {
  if (platform === 'darwin') return MAC_APPS.flatMap(([name, rel]) => [{ name, path: join('/Applications', rel) }, { name, path: join(home, 'Applications', rel) }]);
  if (platform === 'linux') return LINUX.flatMap(([name, paths]) => paths.map((path) => ({ name, path })));
  return [];
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/** The browser for `jobs.browser`: `auto` (first found) or an explicit path (must exist). Null when none. */
export function findBrowser(setting = 'auto', o: { platform?: string; home?: string; exists?: (p: string) => boolean } = {}): FoundBrowser | null {
  const exists = o.exists ?? isFile;
  if (setting && setting !== 'auto') return exists(setting) ? { name: setting.split('/').pop() ?? 'browser', path: setting } : null;
  return browserCandidates(o.platform as NodeJS.Platform, o.home).find((c) => exists(c.path)) ?? null;
}

/** What to tell a user without one. */
export function installHint(platform = process.platform): string {
  const where = platform === 'darwin' ? 'Install Google Chrome, Chromium, Brave or Microsoft Edge into /Applications'
    : platform === 'linux' ? 'Install one with your package manager (for example: sudo apt install chromium, or Google Chrome from google.com/chrome)'
      : 'Install Google Chrome, Chromium, Brave or Microsoft Edge';
  return `${where}, or set jobs.browser in ~/.crewdeck/config.yaml to the full path of a Chromium-based browser.`;
}

export function requireBrowser(setting = 'auto'): FoundBrowser {
  const b = findBrowser(setting);
  if (b) return b;
  throw new Error(setting !== 'auto' ? `jobs.browser points to ${setting}, which does not exist. ${installHint()}` : `No Chromium-based browser found (needed to read forms and print resumes). ${installHint()}`);
}

/** The browser's environment without proxy variables (the guard proxy is its only way out). */
function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_proxy$/i.test(k) && !/^no_proxy$/i.test(k)) env[k] = v;
  return env;
}

const QUIET = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-default-apps', '--disable-extensions', '--disable-domain-reliability', '--metrics-recording-only', '--mute-audio'];

export type Guarded = { browser: Browser; context: BrowserContext; proxy: GuardProxy; found: FoundBrowser; close(): Promise<void> };

/**
 * A headless browser whose every request goes through the guard proxy. `network: 'none'` refuses everything (PDF
 * render); `javaScript: false` turns page scripts off.
 */
export async function launchGuarded(o: { setting?: string; net?: NetOptions; network?: 'guarded' | 'none'; javaScript?: boolean; allowLinkedin?: boolean } = {}): Promise<Guarded> {
  const found = requireBrowser(o.setting);
  const proxy = await startGuardProxy({ net: o.net, allowLinkedin: o.allowLinkedin, denyAll: o.network === 'none' });
  let browser: Browser | undefined;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: found.path, headless: true, args: [...proxyArgs(proxy), ...QUIET], env: browserEnv(), timeout: 30_000 });
    const context = await browser.newContext({
      serviceWorkers: 'block', javaScriptEnabled: o.javaScript ?? true, offline: o.network === 'none', acceptDownloads: false,
      userAgent: undefined, locale: 'en-US',
    });
    const b = browser;
    return { browser: b, context, proxy, found, close: async () => { await b.close().catch(() => {}); await proxy.close(); } };
  } catch (e) {
    await browser?.close().catch(() => {});
    await proxy.close();
    throw e;
  }
}

/** Number of pages in a PDF Chromium wrote (its page objects). */
export function pdfPageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/**
 * Print a local HTML file to PDF: JavaScript off, network off (deny-all proxy, offline context, and only the file
 * itself may load). Returns the page count.
 */
export async function renderPdf(htmlFile: string, pdfFile: string, o: { setting?: string; paper: 'A4' | 'Letter' }): Promise<{ pages: number; blocked: string[] }> {
  if (!existsSync(htmlFile)) throw new Error(`no such file: ${htmlFile}`);
  const g = await launchGuarded({ setting: o.setting, network: 'none', javaScript: false });
  try {
    const page = await g.context.newPage();
    const self = pathToFileURL(htmlFile).href;
    const refused: string[] = [];
    await page.route('**/*', (r) => (r.request().url() === self ? r.continue() : (refused.push(r.request().url()), r.abort('blockedbyclient'))));
    await page.goto(self, { waitUntil: 'load', timeout: 30_000 });
    const pdf = await page.pdf({ path: pdfFile, format: o.paper, preferCSSPageSize: true, printBackground: true });
    return { pages: pdfPageCount(pdf), blocked: [...refused, ...g.proxy.blocked.map((b) => b.host)] };
  } finally { await g.close(); }
}
