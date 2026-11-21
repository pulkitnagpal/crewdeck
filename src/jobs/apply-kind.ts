// How a role is applied to (its apply kind), the playbook's stopping point for each, the buttons Claude never clicks,
// and the page text that proves the person submitted. Detected from the role's addresses (the application form's own
// address first, then the posting's), with a hint from where it came from (LinkedIn's Easy Apply mark, or what Claude
// saw on the page and recorded). Stored on the role (roles.apply_kind) and handed to the Apply chat in its context.
// The jobs-workspace skill's playbooks are written per kind; test/jobs/apply-kind.test.ts checks the skill against this.
import { hostOf, isLinkedinHost } from './fields.ts';

export const APPLY_KINDS = ['linkedin_easy', 'linkedin_external', 'lever', 'greenhouse', 'ashby', 'workday', 'naukri', 'generic'] as const;
export type ApplyKind = (typeof APPLY_KINDS)[number];
/** What older rows (and LinkedIn's own page) say: easy = Easy Apply, external = leaves LinkedIn, unknown = not known. */
export const LEGACY_KINDS = ['easy', 'external', 'unknown'] as const;

export const isApplyKind = (k: unknown): k is ApplyKind => (APPLY_KINDS as readonly string[]).includes(String(k));

/** An employer ATS (or a job site) from its address alone, or null. Fictional examples are in the test fixtures. */
export function kindOfUrl(url: string | null | undefined): Exclude<ApplyKind, 'linkedin_easy' | 'linkedin_external' | 'generic'> | 'linkedin' | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const h = hostOf(url);
  if (!h) return null;
  if (isLinkedinHost(h)) return 'linkedin';
  // jobs.lever.co/<company>/<posting id>[/apply] (and the EU host).
  if (/(^|\.)lever\.co$/.test(h)) return 'lever';
  // boards.greenhouse.io, job-boards(.eu).greenhouse.io; or an employer's own page with Greenhouse's embed (?gh_jid=).
  if (/(^|\.)greenhouse\.io$/.test(h) || u.searchParams.has('gh_jid')) return 'greenhouse';
  // jobs.ashbyhq.com/<company>/<id>[/application]; or an employer's page with Ashby's embed (?ashby_jid=).
  if (/(^|\.)ashbyhq\.com$/.test(h) || u.searchParams.has('ashby_jid')) return 'ashby';
  // <tenant>.wd5.myworkdayjobs.com/…, <tenant>.myworkdaysite.com, wd3.myworkday.com/<tenant>/…
  if (/(^|\.)(myworkdayjobs|myworkdaysite|myworkday)\.com$/.test(h)) return 'workday';
  // www.naukri.com/job-listings-<slug>-<id>: its Apply sends the Naukri profile in one click.
  if (/(^|\.)naukri\.com$/.test(h)) return 'naukri';
  return null;
}

export type KindInput = { url: string; apply_url?: string | null; apply_kind?: string | null };
/** The kind and whether it is known (a LinkedIn posting nobody has looked at yet may be either Easy Apply or not). */
export type Detected = { kind: ApplyKind; sure: boolean };

/**
 * A role's apply kind. The form's own address wins when it is off LinkedIn (a LinkedIn posting whose Apply leads to
 * Lever is applied to on Lever); then the posting's address; on LinkedIn, the hint says Easy Apply or not; elsewhere a
 * hint Claude recorded (a careers page that is Workday underneath) beats `generic`.
 */
export function detectApplyKind(r: KindInput): Detected {
  const hint = String(r.apply_kind ?? '');
  const fromHint = (): ApplyKind | null => (isApplyKind(hint) && !hint.startsWith('linkedin_') ? hint : null);
  const form = r.apply_url ? kindOfUrl(r.apply_url) : null;
  if (r.apply_url && form !== 'linkedin') {
    if (form) return { kind: form, sure: true };
    return { kind: fromHint() ?? 'generic', sure: true };
  }
  const posting = kindOfUrl(r.url);
  if (posting === 'linkedin') {
    if (hint === 'easy' || hint === 'linkedin_easy') return { kind: 'linkedin_easy', sure: true };
    if (hint === 'external' || hint === 'linkedin_external') return { kind: 'linkedin_external', sure: true };
    // Apply leads off LinkedIn to a known site (Claude recorded it): that site's kind.
    const h = fromHint();
    if (h && h !== 'generic') return { kind: h, sure: true };
    return { kind: 'linkedin_external', sure: false };
  }
  if (posting) return { kind: posting, sure: true };
  return { kind: fromHint() ?? 'generic', sure: true };
}

/** The kind to store: only a sure one (an unsure LinkedIn kind leaves the column for Prepare to fill in). */
export const storedKind = (r: KindInput): ApplyKind | null => { const d = detectApplyKind(r); return d.sure ? d.kind : null; };

/** The quiet chip on a pick. */
export const KIND_CHIP: Record<ApplyKind, string> = {
  linkedin_easy: 'Easy Apply', linkedin_external: 'Company site', lever: 'Lever', greenhouse: 'Greenhouse', ashby: 'Ashby',
  workday: 'Workday', naukri: 'Naukri one-click', generic: 'Company site',
};
export const chipFor = (d: Detected) => (d.kind === 'linkedin_external' && !d.sure ? 'LinkedIn' : KIND_CHIP[d.kind]);

/** Where each playbook stops and hands the click to the person (the jobs-workspace skill says the same, word for word). */
export const STOP_AT: Record<ApplyKind, string> = {
  linkedin_easy: 'the Easy Apply step whose button says "Submit application"',
  linkedin_external: 'the employer site\'s own stop, after re-detecting its kind',
  lever: 'the "Submit application" button at the end of the Lever form',
  greenhouse: 'the "Submit application" (or "Submit") button at the end of the Greenhouse form',
  ashby: 'the "Submit application" button at the end of the Ashby form',
  workday: 'the Review step: "Submit" is the person\'s',
  naukri: 'before Naukri\'s Apply button (the person clicks it); after it, before the recruiter questions\' final Submit or Save',
  generic: 'the form\'s Review or Submit page',
};

/** What the page says once the person submitted: the evidence for `crewdeck jobs applied`. */
export const SUBMITTED_TEXT: Record<ApplyKind, RegExp> = {
  linkedin_easy: /application sent|your application was sent/i,
  linkedin_external: /application (submitted|received|sent)|thank(s| you) for (applying|your application)/i,
  lever: /application submitted|thanks? (you )?for applying/i,
  greenhouse: /thank you for applying|application (has been )?(received|submitted)/i,
  ashby: /application (was )?(submitted|received)|thanks? (you )?for applying/i,
  workday: /application submitted|successfully submitted|thank you for applying/i,
  naukri: /\bapplied\b|successfully applied|application sent/i,
  generic: /thank(s| you) for (applying|your application)|application (received|submitted|sent)/i,
};
/** The same, as the words a person reads (the skill and the context show these). */
export const SUBMITTED_WORDS: Record<ApplyKind, string> = {
  linkedin_easy: '"Application sent"', linkedin_external: 'the employer site\'s confirmation', lever: '"Application submitted"',
  greenhouse: '"Thank you for applying"', ashby: '"Application submitted"', workday: '"Application submitted"', naukri: '"Applied"',
  generic: '"Thank you for applying" or "Application received"',
};

/**
 * Buttons Claude never clicks: they send the application. Matched against a click target's visible text (trimmed). The
 * first group holds everywhere; `kinds` narrows one to the sites where that word submits (Naukri's "Apply" sends the
 * profile at once; elsewhere "Apply" only opens the form).
 */
export const NEVER_CLICK: { label: string; re: RegExp; kinds?: ApplyKind[] }[] = [
  { label: 'Submit application', re: /^submit( your| my)? application\b/i },
  { label: 'Send application', re: /^send( your| my)? application\b/i },
  { label: 'Submit', re: /^submit\b/i },
  { label: 'Send', re: /^send$/i },
  { label: 'Finish', re: /^finish( application)?$/i },
  { label: 'Complete application', re: /^complete( your)? application$/i },
  { label: 'Confirm and submit', re: /^confirm( and| &) (submit|send|apply)/i },
  { label: 'Apply now (Naukri)', re: /^apply( now)?$/i, kinds: ['naukri'] },
  { label: 'I am interested (Naukri)', re: /^i am interested$/i, kinds: ['naukri'] },
  // Naukri TopTier (signed in, checked 2026-11-21): its one-click button reads "Quick apply".
  { label: 'Quick apply (Naukri)', re: /^quick apply$/i, kinds: ['naukri'] },
  { label: 'Save (Naukri questions)', re: /^save$/i, kinds: ['naukri'] },
  { label: 'Envoyer', re: /^envoyer\b/i },
  { label: 'Soumettre', re: /^soumettre\b/i },
  { label: 'Postuler (final)', re: /^(envoyer|valider) (ma|la) candidature$/i },
  { label: 'Bewerbung absenden', re: /^bewerbung (absenden|abschicken|senden|einreichen)$/i },
  { label: 'Absenden', re: /^(absenden|abschicken|einreichen)$/i },
  { label: 'Enviar', re: /^enviar\b/i },
  { label: 'Invia', re: /^invia\b/i },
  { label: 'Versturen', re: /^(versturen|verzenden|indienen|sollicitatie (versturen|verzenden))$/i },
  { label: 'Skicka', re: /^skicka( ansökan)?$/i },
];

/** The never-click rule that a click target's text matches for this kind, or null (the click is allowed). */
export function neverClick(text: string, kind?: ApplyKind | null): string | null {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const hit = NEVER_CLICK.find((n) => (!n.kinds || (kind && n.kinds.includes(kind))) && n.re.test(t));
  return hit ? hit.label : null;
}

/** The never-click patterns for one kind, as the Apply context shows them (source text of each regex). */
export const neverClickFor = (kind: ApplyKind) => NEVER_CLICK.filter((n) => !n.kinds || n.kinds.includes(kind)).map((n) => ({ label: n.label, pattern: n.re.source }));

/** What the Apply chat is told about how this role is applied to. */
export function applyContext(r: KindInput) {
  const d = detectApplyKind(r);
  return {
    kind: d.kind, sure: d.sure, chip: chipFor(d), stop_at: STOP_AT[d.kind], submitted: SUBMITTED_WORDS[d.kind],
    never_click: neverClickFor(d.kind),
  };
}
