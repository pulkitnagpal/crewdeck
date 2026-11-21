// A job link the user pasted (design §2.3 step 3): read the posting through netguard (JobPosting JSON-LD first, then
// the page's meta tags), add the role and pick it for today. The user's choice replaces judging, but the safety gates
// stay: an applied role, a company in its cooldown or one with a role in progress come back as warnings, and the role
// is picked only when the user overrides them (force). LinkedIn links go through its guest page, only when switched on.
import { type Ctx, todayOf } from './ctx.ts';
import { checkRoleUrl, applyUrl, atsOf, cleanHost, isLinkedinHost, isXHost } from './fields.ts';
import { type ApplyKind, detectApplyKind } from './apply-kind.ts';
import { type ClientOptions, LinkedinClient, LinkedinStop, fetchDetail, linkedinJobId, storeLinkedinRole } from './linkedin.ts';
import { type NetOptions, NetError, guardedFetch } from './net/netguard.ts';
import { addRole } from './pipeline/roles.ts';
import { getRole } from './db.ts';
import { pickPasted } from './pipeline/pick.ts';
import { HTML_MAX, elements, plainText } from './text.ts';

export type Posting = {
  title?: string; company?: string; location?: string; description?: string; pay_text?: string; posted_at?: string; closed?: boolean; closed_reason?: string;
  /** From schema.org JobPosting (P1b): jobLocationType / jobLocation, applicantLocationRequirements, employmentType, validThrough. */
  workplace?: 'remote' | 'hybrid' | 'onsite'; remote_countries?: string[]; employment_type?: string; valid_through?: string;
};
export type LinkInput = { url: string; force?: boolean };
/** `apply_kind`: how it is applied to (src/jobs/apply-kind.ts). */
export type LinkResult = { id: string; company: string; title: string; apply_kind: ApplyKind; closed?: boolean; warnings: string[]; picked: boolean; needs?: string };
export type LinkOptions = { net?: NetOptions; linkedin?: ClientOptions; day?: string };

/** Every <meta> tag's name/property → content (attribute order doesn't matter). Linear: tags found with indexOf. */
function metas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const open = /<meta\b/gi;
  for (let m; (m = open.exec(html));) {
    const gt = html.indexOf('>', m.index);
    if (gt < 0) break;
    open.lastIndex = gt + 1;
    const attrs: Record<string, string> = {};
    // A real meta tag is short; a 4000-character one is not worth reading.
    for (const a of html.slice(m.index + 5, Math.min(gt, m.index + 4000)).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in out)) out[key] = plainText(attrs.content);
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): any[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const isPosting = (n: any) => n && typeof n === 'object' && list(n['@type']).some((t) => String(t).toLowerCase() === 'jobposting');

/** JobPosting nodes anywhere in a JSON-LD value (arrays, @graph, nesting). */
function postings(v: any, depth = 0): any[] {
  if (!v || typeof v !== 'object' || depth > 5) return [];
  if (Array.isArray(v)) return v.flatMap((x) => postings(x, depth + 1));
  if (isPosting(v)) return [v];
  return postings(v['@graph'], depth + 1);
}

function placeOf(l: any): string {
  const a = l?.address ?? l;
  if (typeof a === 'string') return a.trim();
  const country = typeof a?.addressCountry === 'object' ? str(a.addressCountry?.name) : str(a?.addressCountry);
  return [str(a?.addressLocality), str(a?.addressRegion), country].filter(Boolean).filter((x, i, all) => all.indexOf(x) === i).join(', ');
}

/** "USD 120000–150000 per year" from schema.org MonetaryAmount; the pay parser reads it like posting text. */
function payOf(s: any): string {
  if (!s || typeof s !== 'object') return str(s);
  const v = s.value && typeof s.value === 'object' ? s.value : { value: s.value };
  const cur = str(s.currency ?? v.currency);
  const min = str(v.minValue ?? v.value), max = str(v.maxValue);
  const unit = str(v.unitText ?? s.unitText).toLowerCase();
  if (!min && !max) return '';
  const range = min && max && min !== max ? `${min}–${max}` : min || max;
  return `${cur ? `${cur} ` : ''}${range}${unit ? ` per ${unit}` : ''}`.trim();
}

const CLOSED_TEXT = /no longer accepting applications|this (job|position|posting|role) (is no longer available|has (been filled|expired|been closed))|(job|posting) (has )?expired|position (has been )?filled|no longer (open|available) for applications/i;
const iso = (s: string) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

/** Best-effort posting fields from a page: JSON-LD JobPosting first, then meta tags. `at` decides validThrough. */
export function readPostingPage(html: string, at = new Date()): Posting {
  // Hostile input (E6): at most HTML_MAX characters, and every scan below is linear (text.ts).
  const page = String(html ?? '').slice(0, HTML_MAX);
  const visible = plainText(page);
  const closedText = CLOSED_TEXT.exec(visible)?.[0];
  for (const el of elements(page, 'script')) {
    if (!/\btype\s*=\s*["']?application\/ld\+json\b/i.test(el.tag.slice(0, 2000))) continue;
    let j: any;
    try { j = JSON.parse(el.inner.trim()); } catch { continue; }
    const n = postings(j)[0];
    if (!n) continue;
    const org = typeof n.hiringOrganization === 'string' ? n.hiringOrganization : n.hiringOrganization?.name;
    const remote = list(n.jobLocationType).some((t) => /telecommute|remote/i.test(String(t)));
    const places = list(n.jobLocation).map(placeOf).filter(Boolean);
    const remoteFrom = list(n.applicantLocationRequirements).map((r) => str(r?.name ?? r)).filter(Boolean);
    const location = [remote ? `Remote${remoteFrom.length ? ` (${remoteFrom.join(', ')})` : ''}` : '', ...places].filter(Boolean).join(' · ');
    const until = Date.parse(str(n.validThrough));
    const expired = Number.isFinite(until) && until < at.getTime();
    const hybrid = list(n.jobLocationType).some((t) => /hybrid/i.test(String(t)));
    const workplace = hybrid ? 'hybrid' : remote ? 'remote' : places.length ? 'onsite' : undefined;
    const employment = list(n.employmentType).map((t) => plainText(str(t))).filter(Boolean).slice(0, 5).join(', ');
    return {
      title: plainText(str(n.title ?? n.name)) || undefined, company: plainText(str(org)) || undefined, location: location || undefined,
      description: plainText(str(n.description)) || undefined, pay_text: payOf(n.baseSalary) || undefined, posted_at: iso(str(n.datePosted)),
      closed: expired || !!closedText, closed_reason: expired ? `the posting expired on ${str(n.validThrough).slice(0, 10)}` : closedText ? `the page says "${closedText}"` : undefined,
      workplace, remote_countries: remoteFrom.length ? remoteFrom.map((x) => plainText(x).slice(0, 100)).slice(0, 60) : undefined,
      employment_type: employment ? employment.slice(0, 100) : undefined, valid_through: iso(str(n.validThrough)),
    };
  }
  const meta = metas(page);
  const title = meta['og:title'] || meta['twitter:title'] || plainText(elements(page, 'title').next().value?.inner ?? '');
  return {
    title: title || undefined, company: undefined, description: meta['og:description'] || meta.description || undefined,
    closed: !!closedText, closed_reason: closedText ? `the page says "${closedText}"` : undefined,
  };
}

const NEEDS = 'Title and company could not be read from the page. Read it in the browser pane, then add it with `crewdeck jobs add-role --role-file <f>` (source "pasted") and pick it with `crewdeck jobs pick --role <id> --request <the link request id>`.';

/** Paste a link: the request payload P3 hands over is exactly { url, force? }. */
export async function link(ctx: Ctx, input: LinkInput, o: LinkOptions = {}): Promise<LinkResult> {
  if (!input || typeof input !== 'object' || typeof input.url !== 'string') throw new Error('a link request is { url, force? }');
  const raw = input.url.trim(), force = input.force === true;
  const day = o.day ?? todayOf(ctx);
  let host = '';
  try { host = cleanHost(new URL(raw).hostname); } catch { throw new Error('that is not a web address'); }
  if (isXHost(host)) throw new Error('X links are never used: paste the company\'s own posting');

  if (isLinkedinHost(host)) {
    const lid = linkedinJobId(raw);
    if (!lid) throw new Error('That LinkedIn page is not a job posting. Paste the job\'s own link (linkedin.com/jobs/view/…).');
    if (!ctx.features.linkedin_links) throw new Error('Pasted LinkedIn links are off: the user can switch them on in Jobs → Settings (or paste the company\'s own posting)');
    let d;
    try { d = await fetchDetail(new LinkedinClient({ ...o.linkedin, net: o.linkedin?.net ?? o.net, maxRequests: 1 }), lid); }
    catch (e: any) { throw new Error(e instanceof LinkedinStop ? e.message : `LinkedIn could not be read: ${e.message}`); }
    if (!d) throw new Error('LinkedIn does not show that posting (removed, or it needs sign-in). Paste the company\'s own posting instead.');
    const lkind = detectApplyKind({ url: raw, apply_kind: d.apply_kind }).kind;
    if (d.closed) return { id: '', company: d.company, title: d.title, apply_kind: lkind, closed: true, warnings: ['the posting is closed: LinkedIn says it is no longer accepting applications'], picked: false };
    const { id } = storeLinkedinRole(ctx, d, 'pasted');
    const warnings = pickPasted(ctx, id, day, force);
    return { id, company: d.company, title: d.title, apply_kind: lkind, warnings, picked: !warnings.length };
  }

  const url = checkRoleUrl(raw, ctx.features);
  const kind = detectApplyKind({ url }).kind;
  let page;
  try { page = await guardedFetch(url, o.net); }
  catch (e: any) { throw new Error(e instanceof NetError ? `The page could not be read: ${e.message}` : e.message); }
  if (page.status === 404 || page.status === 410) return { id: '', company: '', title: '', apply_kind: kind, closed: true, warnings: [`the page answered HTTP ${page.status}: the posting was probably removed`], picked: false };
  if (page.status < 200 || page.status > 299) throw new Error(`The page answered HTTP ${page.status}. If it opens in your browser, read it in the pane and use crewdeck jobs add-role.`);
  const p = readPostingPage(page.body, ctx.clock());
  // Greenhouse sends closed postings back to the board with ?error=true.
  const final = new URL(page.url);
  if (!p.closed && final.searchParams.get('error') === 'true' && atsOf(page.url) === 'greenhouse') Object.assign(p, { closed: true, closed_reason: 'the job board says the posting is gone' });
  if (p.closed) return { id: '', company: p.company ?? '', title: p.title ?? '', apply_kind: kind, closed: true, warnings: [`the posting is closed: ${p.closed_reason}`], picked: false };
  if (!p.title || !p.company) return { id: '', company: p.company ?? '', title: p.title ?? '', apply_kind: kind, warnings: [], picked: false, needs: NEEDS };
  const ats = atsOf(url);
  const { id } = addRole(ctx, {
    url, title: p.title, company: p.company, location: p.location, description: p.description, pay_text: p.pay_text, posted_at: p.posted_at,
    source: 'pasted', apply_url: ats === 'ashby' || ats === 'lever' ? applyUrl(url) : undefined,
  });
  const warnings = pickPasted(ctx, id, day, force);
  return { id, company: p.company, title: p.title, apply_kind: detectApplyKind(getRole(ctx.db, id)).kind, warnings, picked: !warnings.length };
}
