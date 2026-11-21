// Portals (ADR-0008): job sites the person signs in to, scanned by Crewdeck in its own browser profile. One compact row
// per portal: name, state, an on/off switch and one button (Connect, Sign in again or Test). The account risk is said
// once, quietly, at a portal's first Connect, with a confirm. Portals that fit the person's countries and fields come
// first; the rest wait behind "More portals". Every change is a page action (connectPortal, disconnectPortal,
// togglePortal, testPortal), the same as `crewdeck jobs portals …`.
import { useState } from 'preact/hooks';
import { html, cls, ago, clock, plural, safeHref, More } from '../lib.js';

export const PORTAL_RISK = 'Crewdeck scans this site with your account at a slow pace; sites may not allow automation and could limit your account.';

const ANY = new Set(['any', 'world', '*']);

/** A paused portal whose pause has run out reads as connected again. */
export function effectiveState(p, now = Date.now()) {
  if (p.state === 'paused' && (!p.paused_until || Date.parse(p.paused_until) <= now)) return 'connected';
  return p.state;
}

/** The state chip and its short muted line, in plain words. */
export function portalLine(p, now = Date.now()) {
  const st = effectiveState(p, now);
  if (st === 'needs_sign_in') return { chip: 'Sign in again', kind: 'warn', text: '' };
  if (st === 'paused') return { chip: `Paused until ${clock(p.paused_until)}`, kind: 'warn', text: '' };
  if (st === 'connected') {
    const bits = [];
    if (p.last_scan) bits.push(`last scan ${ago(p.last_scan, now)}`);
    if (typeof p.last_found === 'number' && p.last_scan) bits.push(`${Number(p.last_found).toLocaleString('en-US')} found`);
    else if (!p.last_scan) bits.push('not scanned yet');
    if (!p.enabled) bits.push('off');
    return { chip: 'Connected', kind: 'ok', text: bits.join(' · ') };
  }
  return { chip: 'Not connected', kind: '', text: '' };
}

/** Does a portal fit the person: one of their countries (or a region holding it) and one of their fields? */
export function fits(p, mine) {
  const countries = (p.countries ?? []).map((x) => String(x).toLowerCase());
  const fields = (p.fields ?? []).map(String);
  const okCountry = !mine.countries.length || !countries.length || countries.some((c) => ANY.has(c) || mine.countries.includes(c)
    || mine.countries.some((m) => (mine.within[m] ?? []).includes(c)));
  const okField = !mine.fields.length || !fields.length || fields.some((f) => ANY.has(f) || mine.fields.includes(f));
  return okCountry && okField;
}

const RANK = { needs_sign_in: 0, connected: 1, paused: 2, not_connected: 3 };
/** The person's portals (connected ones always, then the ones that fit), and the rest. Stable within a state. */
export function splitPortals(portals, mine, now = Date.now()) {
  const order = (list) => list.map((p, i) => ({ p, i })).sort((a, b) => (RANK[effectiveState(a.p, now)] ?? 9) - (RANK[effectiveState(b.p, now)] ?? 9) || a.i - b.i).map((x) => x.p);
  const yours = [], rest = [];
  for (const p of portals) (p.state !== 'not_connected' || fits(p, mine) ? yours : rest).push(p);
  return { yours: order(yours), rest: order(rest) };
}

/** What a test found, in one line: how many and by which layer. */
export function testLine(t) {
  if (!t) return '';
  const by = t.by ?? {};
  const parts = [['json', 'the page\'s data'], ['jsonld', 'job markup'], ['links', 'links']].filter(([k]) => by[k] > 0).map(([k, w]) => `${by[k]} from ${w}`);
  return `${plural(t.found ?? 0, 'job')} found${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function TestResult({ t, name }) {
  const sample = (t.sample ?? []).slice(0, 3);
  return html`<div class="ptest" role="status" aria-live="polite">
    <p class=${cls('small', t.stopped ? 'warn' : t.found ? 'ok' : 'soft')}>${t.stopped ? `Stopped: ${t.stopped}. ` : ''}${testLine(t)}${t.found ? '' : ` on ${name} for your first search`}</p>
    ${sample.length ? html`<ul class="psample">${sample.map((s, i) => {
      const href = safeHref(s.url);
      const label = `${s.title}${s.company ? ` · ${s.company}` : ''}`;
      return html`<li key=${i}>${href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : label}</li>`;
    })}</ul>` : null}
  </div>`;
}

function PortalRow({ p, onAct, say }) {
  const [confirm, setConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [opened, setOpened] = useState(false);
  const [test, setTest] = useState(null);
  const st = effectiveState(p);
  const line = portalLine(p);
  const connected = st === 'connected' || st === 'paused';
  const id = `portal-${p.id}`;

  const connect = async (signup) => {
    setConfirm(false);
    setBusy('connect');
    const r = await onAct('connectPortal', signup ? { id: p.id, signup: true } : { id: p.id });
    setBusy('');
    if (r?.opened) { setOpened(true); say(`A ${p.name} window opened: ${signup ? 'sign up' : 'sign in'} there`); }
  };
  const toggle = async () => { const r = await onAct('togglePortal', { id: p.id, on: !p.enabled }); if (r) say(`${p.name} switched ${p.enabled ? 'off' : 'on'}`); };
  const runTest = async () => {
    setBusy('test'); setTest(null);
    const r = await onAct('testPortal', { id: p.id });
    setBusy('');
    if (r) { setTest(r); say(`${p.name}: ${testLine(r)}`); }
  };
  const disconnect = async () => { setLeaving(false); const r = await onAct('disconnectPortal', { id: p.id }); if (r) { setTest(null); say(`${p.name} disconnected`); } };

  // One button per row: the first Connect asks first (the risk, once); signing in again doesn't.
  let button;
  if (st === 'not_connected') {
    button = html`<button type="button" class="btn small" aria-expanded=${confirm} aria-label=${`Connect ${p.name}`} disabled=${busy === 'connect'} onClick=${() => setConfirm(!confirm)}>Connect</button>`;
  } else if (st === 'needs_sign_in') {
    button = html`<button type="button" class="btn small primary" aria-label=${`Sign in to ${p.name} again`} disabled=${busy === 'connect'} onClick=${() => connect(false)}>Sign in</button>`;
  } else {
    button = html`<button type="button" class="btn small" aria-label=${`Test ${p.name}`} disabled=${busy === 'test' || st === 'paused'} onClick=${runTest}>${busy === 'test' ? 'Testing…' : 'Test'}</button>`;
  }
  const signup = safeHref(p.signup_url);
  return html`<li class=${cls('prow', !p.enabled && 'off')} data-portal=${p.id} data-state=${st}>
    <div class="body">
      <div class="head"><h3 id=${id}>${p.name}</h3>
        <span class=${cls('chip', line.kind)}>${line.chip}</span>
        ${line.text ? html`<span class="small soft">${line.text}</span>` : null}</div>
      ${opened && !connected ? html`<p class="small" role="status"><span class="dot busy" aria-hidden="true"></span> Waiting for you to sign in, in the ${p.name} window</p>` : null}
      ${busy === 'test' ? html`<p class="small soft" role="status"><span class="dot busy" aria-hidden="true"></span> Scanning one search, slowly (up to a minute)</p>` : null}
      ${test ? html`<${TestResult} t=${test} name=${p.name} />` : null}
      ${confirm ? html`<div class="confirm" role="alertdialog" aria-labelledby=${id} aria-describedby=${`${id}-risk`}>
        <b>Connect ${p.name}?</b>
        <span class="small" id=${`${id}-risk`}>${p.risk || PORTAL_RISK}</span>
        <span class="small">A window opens at its sign-in page. You type your password and any codes; Crewdeck never does.</span>
        <div class="row-flex"><button type="button" class="btn primary small" onClick=${() => connect(false)}>Sign in</button>
          ${signup ? html`<button type="button" class="btn small" onClick=${() => connect(true)}>Sign up</button>` : null}
          <button type="button" class="btn quiet small" onClick=${() => setConfirm(false)}>Cancel</button></div>
      </div>` : null}
      ${connected || !p.verified ? html`<${More} summary="Details">
        ${p.verified ? null : html`<span>Not checked against the live site yet: a test shows what it finds.</span>`}
        ${connected ? html`<span>${p.risk || PORTAL_RISK}</span>` : null}
        ${connected ? html`<span><button type="button" class="linkbtn" aria-label=${`Disconnect ${p.name}`} onClick=${() => setLeaving(true)}>Disconnect</button></span>` : null}
      </${More}>` : null}
      ${leaving ? html`<div class="confirm" role="alertdialog" aria-labelledby=${id}>
        <b>Disconnect ${p.name}?</b><span class="small">Crewdeck stops scanning it and forgets the sign-in. Roles already found stay.</span>
        <div class="row-flex"><button type="button" class="btn small danger" onClick=${disconnect}>Disconnect</button>
          <button type="button" class="btn quiet small" onClick=${() => setLeaving(false)}>Cancel</button></div></div>` : null}
    </div>
    <div class="ctl">
      <button type="button" class="switch" role="switch" aria-checked=${p.enabled ? 'true' : 'false'} aria-label=${`Scan ${p.name}`}
        disabled=${st === 'not_connected'} title=${st === 'not_connected' ? 'Connect it first' : undefined} onClick=${toggle}></button>
      ${button}
    </div>
  </li>`;
}

/**
 * The Portals section. `portals` is GET /api/jobs/portals's list (null while unknown or on a Crewdeck without portals:
 * nothing shows). `mine` is the person's countries (with the regions holding them) and fields, from the Sources view.
 */
export function Portals({ portals, mine = { countries: [], within: {}, fields: [] }, onAct = async () => null, say = () => {} }) {
  if (!Array.isArray(portals) || !portals.length) return null;
  const { yours, rest } = splitPortals(portals, mine);
  const row = (p) => html`<${PortalRow} key=${p.id} p=${p} onAct=${onAct} say=${say} />`;
  const needs = portals.filter((p) => effectiveState(p) === 'needs_sign_in').length;
  return html`<section class="card section portals" aria-labelledby="portals-title">
    <header><h2 id="portals-title">Portals${needs ? html` <span class="soft">· ${needs} to sign in again</span>` : null}</h2>
      <p class="soft">Job sites you sign in to once. Crewdeck scans them slowly with your account.</p></header>
    ${yours.length ? html`<ul class="plist2" aria-label="Portals for you">${yours.map(row)}</ul>` : html`<p class="small soft">None fits your countries and fields yet.</p>`}
    ${rest.length ? html`<${More} summary=${`More portals (${rest.length})`}><ul class="plist2" aria-label="More portals">${rest.map(row)}</ul></${More}>` : null}
    <${More} summary="How it works">
      <span>Connect opens a window of Crewdeck's own browser at the site's sign-in page. You sign in there; Claude and Crewdeck never type a password or code.</span>
      <span>Switched-on portals are scanned during each fetch, a few searches at a slow pace. At the first challenge or sign-in wall Crewdeck stops and waits for you.</span>
    </${More}>
  </section>`;
}
