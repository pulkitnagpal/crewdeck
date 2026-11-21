// `crewdeck jobs portals …` (ADR-0008): the signed-in portals. Arguments are only portal ids and fixed words. Connect
// opens a visible window where the person signs in themselves; Crewdeck never types a password, code or CAPTCHA.
import { loadConfig } from '../../config.ts';
import { openCtx } from '../ctx.ts';
import { flag, positional } from '../cli.ts';
import { type Portal, PORTAL_ID, loadPortals } from './catalog.ts';
import { connectPortal, disconnectPortal } from './connect.ts';
import { realLaunch } from './profile.ts';
import { scanPortal } from './scan.ts';
import { portalsView, testView, togglePortal } from './view.ts';

const say = (s: string) => console.log(s);
const json = (v: unknown) => say(JSON.stringify(v, null, 1));

export const PORTALS_USAGE = `usage: crewdeck jobs portals <verb>
  list [--json]                     the portals Crewdeck can scan signed in, and where each stands
  connect <id> [--signup]           open a window to sign in (or sign up) yourself; it closes once you are signed in
  disconnect <id>                   forget that portal: its cookies leave Crewdeck's browser profile
  test <id> [--json]                one search, one page: what was found, and how (json, jsonld, links)
  on <id> | off <id>                scan it in every sources run, or stop (jobs/sources.md, with a Changes line)`;

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
      const v = portalsView(ctx);
      if (args.includes('--json')) return json(v);
      for (const p of v.portals) {
        const when = p.state === 'paused' ? ` until ${p.paused_until}` : p.last_scan ? `, last scan ${p.last_scan.slice(0, 16).replace('T', ' ')} (${p.last_found ?? 0} found)` : '';
        say(`${p.id.padEnd(10)} ${p.name.padEnd(10)} ${p.state.replace(/_/g, ' ')}${when}${p.enabled ? ', scanned' : ''}  [${p.countries.join(', ')}]${p.verified ? '' : '  (URLs unverified)'}`);
      }
      return;
    } finally { ctx.db.close(); }
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
