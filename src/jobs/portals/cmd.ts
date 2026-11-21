// `crewdeck jobs portals …` (ADR-0008): the signed-in portals. Arguments are only portal ids, fixed words and file
// paths. Profile mode: connect opens a visible window of Crewdeck's browser where the person signs in themselves. Pane
// mode (the default): the person signs in in Claude desktop's browser pane and Claude scans there during Find with
// plan → script → ingest; mark records the sign-in. Crewdeck and Claude never type a password, code or CAPTCHA.
import { loadConfig } from '../../config.ts';
import { openCtx } from '../ctx.ts';
import { flag, positional, textFrom } from '../cli.ts';
import { type Portal, PORTAL_ID, loadPortals } from './catalog.ts';
import { connectPortal, disconnectPortal } from './connect.ts';
import { realLaunch } from './profile.ts';
import { scanPortal } from './scan.ts';
import { INGEST_MAX_BYTES, ingestPage, markPortal, planPortals } from './pane.ts';
import { pageScript } from './page-script.ts';
import { portalsView, testView, togglePortal } from './view.ts';

const say = (s: string) => console.log(s);
const json = (v: unknown) => say(JSON.stringify(v, null, 1));

export const PORTALS_USAGE = `usage: crewdeck jobs portals <verb>
  list [--json]                     the portals Crewdeck can scan signed in, and where each stands
  connect <id> [--signup]           open a window to sign in (or sign up) yourself; it closes once you are signed in
  disconnect <id>                   forget that portal: its cookies leave Crewdeck's browser profile
  test <id> [--json]                one search, one page: what was found, and how (json, jsonld, links)
  on <id> | off <id>                scan it in every sources run, or stop (jobs/sources.md, with a Changes line)
pane mode (jobs.portals_mode: pane, the default; Claude scans in Claude desktop's browser pane during Find):
  plan [--json] [--portal <id>]     the pages to open now, each { portal, url, query, delay_ms }; --portal: one page of one portal, a test
  script <id>                       the JavaScript Claude runs in the portal's page (javascript_tool); it returns { url, signals, jobs }
  ingest <id> --file <f.json> [--page-url <u>] [--test]   store one page's answer (the only write); prints { stored, new, stopped? }
  mark <id> connected|signed-out    record that the person is signed in to it in the pane (or signed out)`;

function portalArg(id: string | undefined): Portal {
  if (!id || !PORTAL_ID.test(id)) throw new Error(`give a portal id (crewdeck jobs portals list)\n${PORTALS_USAGE}`);
  const p = loadPortals().byId.get(id);
  if (!p) throw new Error(`no portal "${id}" (crewdeck jobs portals list shows them)`);
  return p;
}

export async function portalsCmd(args: string[]) {
  const [verb, id] = positional(args);
  const c = loadConfig();
  const launch = () => realLaunch(c.jobs.home, c.jobs.browser);
  if (verb === 'list') {
    const ctx = openCtx(c);
    try {
      const v = portalsView(ctx, undefined, c.jobs.portals_mode);
      if (args.includes('--json')) return json(v);
      for (const p of v.portals) {
        const when = p.state === 'paused' ? ` until ${p.paused_until}` : p.last_scan ? `, last scan ${p.last_scan.slice(0, 16).replace('T', ' ')} (${p.last_found ?? 0} found)` : '';
        say(`${p.id.padEnd(10)} ${p.name.padEnd(10)} ${p.state.replace(/_/g, ' ')}${when}${p.enabled ? ', scanned' : ''}  [${p.countries.join(', ')}]${p.verified ? '' : '  (URLs unverified)'}`);
      }
      return;
    } finally { ctx.db.close(); }
  }
  if ((verb === 'connect' || verb === 'test') && c.jobs.portals_mode === 'pane') {
    const p = portalArg(id);
    throw new Error(`${p.name}: portals are in pane mode (jobs.portals_mode), so Claude ${verb === 'connect' ? 'connects' : 'tests'} them in Claude desktop's browser pane: Jobs page → Sources → Portals → ${verb === 'connect' ? 'Connect' : 'Test'}, or ask the Jobs chat (crewdeck jobs portals plan --portal ${p.id}, script, ingest --test)`);
  }
  if (verb === 'connect') {
    const p = portalArg(id);
    const signup = args.includes('--signup');
    say(`${p.name}: ${p.risk}`);
    say(`Opening a window at ${signup ? p.signup_url : p.login_url}. Sign ${signup ? 'up' : 'in'} there yourself (passwords, codes and checks are yours to type); it closes once you are signed in (up to 15 minutes).`);
    const r = await connectPortal(c.jobs.home, p, { launch: launch(), signup });
    say(r.ok ? `${p.name} is connected. Switch it on with crewdeck jobs portals on ${p.id} (or on the Jobs page → Sources).` : `${p.name} is not connected: ${r.why}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (verb === 'plan') {
    const only = flag(args, 'portal');
    if (only !== undefined) portalArg(only);
    const ctx = openCtx(c);
    try {
      const r = planPortals(ctx, { mode: c.jobs.portals_mode, ...(only ? { only } : {}) });
      if (args.includes('--json')) return json(r);
      if (!r.pages.length) say('no portal pages to open now');
      for (const pg of r.pages) say(`${pg.portal.padEnd(10)} after ${Math.round(pg.delay_ms / 1000)} s  ${pg.query}  ${pg.url}`);
      for (const k of r.skipped) say(`  · ${k.name}: ${k.why}`);
      return;
    } finally { ctx.db.close(); }
  }
  if (verb === 'script') return say(pageScript(portalArg(id)));
  if (verb === 'ingest') {
    const p = portalArg(id);
    const file = flag(args, 'file');
    if (!file) throw new Error(`give the script's answer: --file <f.json>\n${PORTALS_USAGE}`);
    // Read like every --…-file flag: only from Crewdeck's own scratch folders (<jobs home>/out/…).
    const text = textFrom(file, '--file');
    if (text.length > INGEST_MAX_BYTES) throw new Error(`--file is over ${INGEST_MAX_BYTES / 1024} KB: not a script answer`);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new Error('--file is not JSON (write the script\'s answer exactly as it came back)'); }
    const pageUrl = flag(args, 'page-url');
    const ctx = openCtx(c);
    try {
      const r = ingestPage(ctx, p, raw, { ...(pageUrl ? { pageUrl } : {}), test: args.includes('--test') });
      json(r);
      if (r.stopped) process.exitCode = 2;
      return;
    } finally { ctx.db.close(); }
  }
  if (verb === 'mark') {
    const p = portalArg(id);
    const how = positional(args)[2];
    if (how !== 'connected' && how !== 'signed-out') throw new Error(`mark ${p.id} connected|signed-out\n${PORTALS_USAGE}`);
    const ctx = openCtx(c);
    try {
      const st = markPortal(ctx, p, how);
      return say(how === 'connected' ? `${p.name} is connected. Switch it on with crewdeck jobs portals on ${p.id} (or on the Jobs page → Sources).` : st.connected ? `${p.name}: marked as needing a sign-in again.` : `${p.name} was not connected; nothing changed.`);
    } finally { ctx.db.close(); }
  }
  if (verb === 'disconnect' && c.jobs.portals_mode === 'pane') {
    const p = portalArg(id);
    await disconnectPortal(c.jobs.home, p);
    return say(`${p.name} disconnected: Claude stops scanning it. To end the sign-in itself, sign out of ${p.name} in Claude's browser pane.`);
  }
  if (verb === 'disconnect') {
    const p = portalArg(id);
    const r = await disconnectPortal(c.jobs.home, p, { launch: launch() });
    return say(`${p.name} disconnected${r.cleared ? ': its cookies and site data are gone from Crewdeck\'s browser' : r.why ? ` (its cookies stay until the next connect: ${r.why})` : ''}.`);
  }
  if (verb === 'test') {
    const p = portalArg(id);
    const ctx = openCtx(c);
    try {
      const r = await scanPortal(ctx, p, { test: true, launch: launch() });
      if (args.includes('--json')) return json(testView(r));
      if (!r.ran) { say(`${p.name}: not run (${r.why})`); process.exitCode = 1; return; }
      say(`${p.name}: ${r.urls[0] ?? '(no page)'}`);
      say(`found ${r.found}: ${r.by.json} from the page's own data (json), ${r.by.jsonld} from JobPosting markup (jsonld), ${r.by.links} from job links (links)`);
      for (const s of r.sample ?? []) say(`  · ${s.title} at ${s.company || '(company not read)'} [${s.by}] ${s.url}`);
      if (r.blocked?.length) say(`hosts the guard kept out: ${r.blocked.join(', ')}`);
      if (r.stopped) { say(`stopped: ${r.stopped}${r.paused_until ? `; paused until ${r.paused_until}` : ''}`); process.exitCode = 1; }
      return;
    } finally { ctx.db.close(); }
  }
  if (verb === 'on' || verb === 'off') {
    const p = portalArg(id);
    const ctx = openCtx(c);
    try {
      const r = togglePortal(ctx, p, verb === 'on');
      return say(r.changed ? `jobs/sources.md: ${r.line}` : `${p.name} is already ${verb}`);
    } finally { ctx.db.close(); }
  }
  if (flag(args, 'help') !== undefined || !verb) return say(PORTALS_USAGE);
  throw new Error(`unknown verb "${verb}"\n${PORTALS_USAGE}`);
}
