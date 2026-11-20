// Form questions the user's profile answers (me/profile.md), the questions never guessed (sensitive), and the rules for
// the web addresses a role may have. Nothing here is about one person: every value comes from the profile note.
import type { JobsFeatures } from '../config.ts';
import type { Profile } from './schema.ts';
import { classOf, keyClass, labelKey, profileRows } from './form-terms.ts';

/** A question label, compared loosely: lowercase, no required-marks, no trailing colon or question mark. */
export const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim().replace(/[\s:?]+$/, '');

/**
 * Questions that are never guessed: only the user's explicit answer (or an exact standard answer) fills them. The words
 * are data, per language (data/form-terms.yaml, D32); never_fill questions (ID, bank and tax numbers) count too.
 */
export const SENSITIVE = { test: (label: string) => classOf(label) !== null };
/** Government ID, bank and tax numbers: always skipped, never drafted or stored (D32). */
export const NEVER_FILL = { test: (label: string) => classOf(label) === 'never_fill' };

const words = (key: string) => key.replace(/_/g, ' ');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The education line forms mean by "school": the most recent one. */
function latestEducation(p: Profile) {
  return [...p.education].sort((a, b) => (b.end_year ?? 0) - (a.end_year ?? 0))[0];
}

/**
 * Every profile value under its source key (`profile:<key>` in answers and citations): identity fields, links by name,
 * the latest education, a composed full name and location, and every standard answer.
 */
export function profileValues(p: Profile): Record<string, string> {
  const id = p.identity, out: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim(); };
  // A standard answer under an ID, bank or tax key is never used, even when the note has one (`jobs check` refuses it).
  for (const [k, v] of Object.entries(p.standard_answers)) if (keyClass(k) !== 'never_fill') put(k, v);
  const e = latestEducation(p);
  if (e) { put('school', e.school); put('degree', e.degree); put('discipline', e.discipline); put('start_year', e.start_year); put('end_year', e.end_year); }
  for (const [k, v] of Object.entries(id.links)) put(k, v);
  for (const k of ['first_name', 'last_name', 'email', 'phone', 'city', 'region', 'country'] as const) put(k, id[k]);
  put('preferred_name', id.preferred_name || id.first_name);
  if (id.first_name && id.last_name) put('full_name', `${id.first_name} ${id.last_name}`);
  if (!out.location) put('location', [id.city, id.region || id.country].filter(Boolean).join(', '));
  return out;
}

export type ProfileField = { re: RegExp; key: string; value: string; exact: boolean };

/**
 * Whole-label pattern → profile value. Patterns are anchored on purpose: "Referrer email", "Years of experience with
 * Rust" or "City you would relocate to" must not get the user's own values. `exact` entries (a standard answer whose
 * words are the whole label) may fill a sensitive question; the broader patterns never do.
 */
export function profileFields(p: Profile, opts: { withEmpty?: boolean } = {}): ProfileField[] {
  const v = profileValues(p);
  // Whole labels per profile key in every language (data/form-terms.yaml); "website" falls back to the portfolio link.
  const rows: [RegExp, string][] = profileRows().map(({ key, re }) => [re, key === 'website' && !v.website ? 'portfolio' : key]);
  // Links by their own name: linkedin, github, behance, …
  for (const k of new Set([...Object.keys(p.identity.links), ...(opts.withEmpty ? ['linkedin', 'github'] : [])])) rows.push([new RegExp(`^${esc(labelKey(words(k)))}( profile)?( url| link| profile url)?$`), k]);
  const out: ProfileField[] = rows.filter(([, k]) => opts.withEmpty || v[k]).map(([re, key]) => ({ re, key, value: v[key] ?? '', exact: false }));
  // Every standard answer also fills the question that is exactly its words ("notice period", "work authorization").
  for (const k of Object.keys(p.standard_answers)) if (v[k]) out.push({ re: new RegExp(`^${esc(labelKey(words(k)))}$`), key: k, value: v[k], exact: true });
  return out;
}

/** The profile value for a question label, or undefined. Sensitive labels match only an exact standard answer. */
export function profileAnswer(fields: ProfileField[], label: string, raised = false): ProfileField | undefined {
  const cls = classOf(label);
  if (cls === 'never_fill') return undefined;
  const l = labelKey(label);
  const sensitive = raised || cls === 'sensitive';
  return fields.find((f) => (!sensitive || f.exact) && f.re.test(l));
}

// ---- web addresses ----
const X_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co|twimg\.com)$/i;
const LINKEDIN_HOSTS = /(^|\.)(linkedin\.com|lnkd\.in|licdn\.com)$/i;
/** Sites whose terms forbid automated filling: Crewdeck shows the answers to copy. The user can add more in profile.md. */
export const COPY_ONLY_HOSTS = ['wellfound.com', 'angel.co', 'workatastartup.com'];

/** A host as every comparison sees it: lowercase, no IPv6 brackets, no trailing dots ("x.com." is x.com to DNS). */
export const cleanHost = (host: string) => String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
export const hostOf = (url: string) => { try { return cleanHost(new URL(url).hostname); } catch { return ''; } };
export const isXHost = (host: string) => X_HOSTS.test(cleanHost(host));
export const isLinkedinHost = (host: string) => LINKEDIN_HOSTS.test(cleanHost(host));
export const isLinkedinJobUrl = (u: URL) => /(^|\.)linkedin\.com$/.test(cleanHost(u.hostname)) && /^\/jobs\/view\/\d+\/?$/.test(u.pathname);

/** The copy-only host a URL is on (built in or the user's), or null. */
export function copyOnlyHost(url: string, extra: string[] = []): string | null {
  const h = hostOf(url);
  if (!h) return null;
  return [...COPY_ONLY_HOSTS, ...extra].find((c) => h === c.toLowerCase() || h.endsWith(`.${c.toLowerCase()}`)) ?? null;
}

/**
 * A role's address, checked: http(s) only, no credentials, never X, LinkedIn only as a job posting (/jobs/view/<id>)
 * and only when the user switched pasted LinkedIn links on. Returns the address without its #fragment.
 */
export function checkRoleUrl(raw: string, features: Pick<JobsFeatures, 'linkedin_links'>, what = 'URL'): string {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new Error(`${what} is not a web address`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${what} must start with http:// or https://`);
  if (u.username || u.password) throw new Error(`${what} must not contain a user name or password`);
  // Stored and compared without trailing dots, so "jobs.example.com." and "jobs.example.com" are one role.
  if (/\.$/.test(u.hostname)) u.hostname = cleanHost(u.hostname);
  if (isXHost(u.hostname)) throw new Error('X links are never used: use the company\'s own posting');
  if (isLinkedinHost(u.hostname)) {
    if (!isLinkedinJobUrl(u)) throw new Error('LinkedIn links must be job postings (linkedin.com/jobs/view/<id>)');
    if (!features.linkedin_links) throw new Error('pasted LinkedIn links are off: the user can switch them on in Jobs → Settings');
    u.search = '';
  }
  u.hash = '';
  return u.toString();
}

/** The application form's own address for a posting on a known ATS. */
export function applyUrl(jobUrl: string): string {
  const u = new URL(jobUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const h = cleanHost(u.hostname);
  if (h === 'jobs.ashbyhq.com' && !path.endsWith('/application')) u.pathname = `${path}/application`;
  else if (h === 'jobs.lever.co' && !path.endsWith('/apply')) u.pathname = `${path}/apply`;
  return u.toString();
}

export function atsOf(url: string): 'ashby' | 'greenhouse' | 'lever' | 'workday' | 'linkedin' | 'other' {
  const h = hostOf(url);
  if (h.endsWith('ashbyhq.com')) return 'ashby';
  if (h.includes('greenhouse.io')) return 'greenhouse';
  if (h.endsWith('lever.co')) return 'lever';
  if (h.includes('myworkdayjobs.com')) return 'workday';
  if (isLinkedinHost(h)) return 'linkedin';
  return 'other';
}
