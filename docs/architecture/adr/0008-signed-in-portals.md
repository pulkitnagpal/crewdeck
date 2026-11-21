# ADR-0008: Signed-in job portals, scanned by Crewdeck in its own browser profile

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-11-21 |
| Deciders | Crewdeck maintainer (the owner asked for it on 2026-11-21) |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Supersedes | parts of [ADR-0005](0005-linkedin-user-driven.md): signed-in LinkedIn is allowed as an opt-in portal |
| Reversibility | Two-way door (a portal is switched off per person; the profile folder is deleted) |

## Context

Most job portals that matter to a person (India: Naukri, Instahyre, Wellfound, Cutshort, Weekday, foundit, Hirist,
LinkedIn; elsewhere: Indeed, Seek, StepStone…) have no public feed or API: listings sit behind a sign-in. Crewdeck's
v1/v2 sources are public feeds only, so for the owner it scanned 11 remote boards and 37 company feeds and missed every
Indian portal. The owner wants Crewdeck to be the only place they look for jobs, will sign in once to each important
portal (Claude helping, the human typing passwords and codes), and rejected email alerts.

## Decision

1. **A Crewdeck-owned browser profile.** `~/.crewdeck/jobs/portals/profile/`: a persistent Chromium context
   (playwright-core `launchPersistentContext`, the person's own Chrome/Chromium/Brave/Edge from `findBrowser`). Never
   the person's everyday browser profile; never Claude's browser pane (only Claude can drive the pane, which costs tokens).
2. **Connect = the human signs in.** `crewdeck jobs portals connect <id>` opens a visible window of that profile at the
   portal's sign-in (or sign-up) page. The person types passwords, OTPs and solves any CAPTCHA. Crewdeck polls the
   portal's signed-in check and closes the window when it passes. Claude may help register by telling the person what
   to fill; it never types a password, OTP or payment detail, and creates an account only after the person's yes.
3. **Scan = plain code, no tokens.** During a sources run (`runSources`, after planned sources), each connected,
   switched-on portal is scanned: its search URLs (built from the person's targets × places × workplace, see 5) are
   opened in that profile, and jobs are extracted by, in order: the portal adapter's own extractor (JSON responses the page
   itself loads, matched by URL pattern), schema.org JobPosting JSON-LD, then links matching the portal's job-URL pattern
   with their card text. Roles go through `upsertRole` with `source_key = portal:<id>` and then the usual rules, judge
   and picks. Descriptions come from the details step (P1b) when the page allows it, inside the same limits.
4. **Rate limits, conservative by default (per portal, in the catalog):** at most `searches_per_run` searches ×
   `pages_per_search` pages, `delay_ms` jittered ±40% between page loads, at most one scan per `min_hours` (default
   6 h), at most `pages_per_day`. LinkedIn: 3 searches × 1 page, 12–20 s apart, 25 pages a day, 12 h between scans.
   A CAPTCHA, a checkpoint, a sign-in wall, HTTP 429/999 or an empty result where the last scan had many: the portal
   stops at once and pauses (6 h, 24 h, 72 h, escalating; a sign-in wall marks it `needs_sign_in`). Crewdeck never
   tries to get past a challenge: the person reconnects. Scans run only inside a sources run (on demand or the 12 h
   timer), one portal at a time, headless by default (`headful: true` per portal when a portal refuses headless).
5. **What to search.** `portalQueries(profile, portal)`: the person's target titles (first title + up to 2 variants per
   target, at most `searches_per_run` queries), with the portal's own filters for place, remote and recency (last 7
   days) from its URL template. Deterministic, logged in the run state; the setup skill reviews it with the person once.
6. **Catalog as data.** `src/jobs/data/portals.yaml`: id, name, countries, fields, signup/login URLs, signed-in check
   (a URL + a selector or cookie name), search URL template and parameter maps, job-URL pattern, JSON response patterns,
   limits, `risk` note. Adapters with code live in `src/jobs/portals/adapters/<id>.ts` only when data isn't enough.
7. **The person's choices live in their notes.** `jobs/sources.md` items with `portal: <id>` (on/off, order) like other
   sources; connection state (signed in, last scan, pause) in `~/.crewdeck/jobs/state/portals.json`, never in notes.
8. **Company country preference.** `search.md` → `companies: { countries: { only: [iso2], exclude: [iso2] } }`
   ("only non-Indian companies" = `exclude: [in]`). Applied where the company's country is known (company directory,
   feed metadata); the judge brief carries it for the rest (an eligibility rule, quoted from the posting or the
   company's site). The planner picks company feeds and portals to match (an Indian-only portal is skipped when
   `exclude` has `in` and the person works remote abroad).
9. **"From tomorrow…"**: proposal items may carry `effective_from` (a date); approved items wait and apply on the first
   server start or sources run on/after that date (shown as "Starts <date>" in Review).

## Consequences

- Good: every portal the person uses, with their own filters and visibility, at no token cost per scan.
- Bad: automating a signed-in account may break a portal's terms; the person's account carries that risk (said once per
  portal at connect, in plain words). Mitigated by the limits above, stopping at the first challenge, and never
  solving challenges.
- Bad: portal pages change; extraction degrades. Mitigated by three extraction layers and `crewdeck jobs portals test
  <id>` (scan one query, print what was found and how) so a broken adapter is visible on the Sources tab.
- The browser window appears only on connect (and for `headful` portals during a scan).
