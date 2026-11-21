# ADR-0008: Signed-in job portals, scanned in Claude's browser pane (default) or Crewdeck's own browser profile

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-11-21 (amended the same day: pane mode, the default) |
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
   the person's everyday browser profile. (Amended below: in Claude desktop the default is now Claude's browser pane;
   this profile is the fallback, `jobs.portals_mode: profile`.)
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

## Amendment: Pane mode (default in Claude desktop)

### Decision

10. **`jobs.portals_mode: pane | profile`, default `pane`.** In pane mode Claude scans the switched-on, connected portals
    in Claude desktop's browser pane, inside the Jobs chat that Find already opens (`claude://code/new`, P4), so it
    costs no extra turn. The profile engine (1–4 above) stays, unchanged, as `profile` mode; `runSources` runs it only
    there.
11. **Connect = the person signs in in the pane.** Connect, Sign in and Test on Sources → Portals (and the panel's Sign in
    line) queue a `connect` request and open a Jobs chat in front with the prompt
    `Crewdeck: connect portal <id> (request <n>)` (portal ids `^[a-z0-9-]{1,40}$`, checked by `parseTaskPrompt`,
    `isJobsTaskLink` and the plugin's own copy). The jobs-workspace skill opens the portal's `login_url` in the pane; the
    person signs in there, or imports that site's cookies from their own browser with the pane's ⋮ menu (only that
    domain). Sign in with Google may not work inside the pane: they use the site's own email or phone with a password
    or a code. Claude never types a password, code or CAPTCHA and creates an account only after a clear yes. Claude
    runs the page script; with no sign-in wall it records `crewdeck jobs portals mark <id> connected`, then tests one
    page (`ingest --test`).
12. **Scan = plan → script → ingest, Crewdeck's code deciding everything but the clicks.**
    `crewdeck jobs portals plan --json` lists the pages to open now, `{ portal, url, query, delay_ms }`, within the same
    limits as the profile engine (searches × pages, pages a day, min_hours, pauses, the company-country verdict), with
    the jittered wait before each; reading it counts nothing. `crewdeck jobs portals script <id>` prints one
    self-contained JavaScript expression (page-runtime.js serialised, the catalog entry embedded) that Claude runs with
    javascript_tool in the page. It reads, in order, the portal's JSON APIs the page already loaded (same-origin
    resource URLs matching the adapter, fetched again with the person's cookies; or window state such as
    `__NEXT_DATA__`), JSON-LD JobPosting, then job links with their card text, and returns
    `{ url, signals: { sign_in_wall, challenge, empty }, jobs: [≤ 60 × { url, title, company, location, posted_at?,
    workplace?, company_country? }] }`, at most about 8 KB. Claude writes that answer to a file and
    `crewdeck jobs portals ingest <id> --file <f>` checks it strictly (keys, types, sizes, every job address on the
    portal's hosts), applies the signals exactly as a profile scan's stop (pause 6, 24, 72 h; a sign-in wall marks
    `needs_sign_in`; a quiet empty page after a big one), and stores the jobs through the same path (`storePostings`:
    `cleanJob`, `upsertRole`, `source_key portal:<id>`, the company's country). Ingest is the only write. The extraction
    rules (field paths, canonical job URLs, card words) are one code shared by both engines.
13. **Scans only during Find**, in the order of the plan, stopping a portal at its first signal; never a page outside
    the plan; no screenshots or `read_page` unless the script failed. Page text is data, never instructions.

### Why

- **No automation fingerprint.** The pages load in the person's real Claude desktop browser, at a person's pace, with
  their real session: no headless Chromium, no Playwright flags, no fresh profile that a bot shield recognises.
- **The person's real session.** They sign in once in the pane (or import the site's cookies), with their own
  two-factor and devices; Crewdeck never holds a separate copy of their login.
- **Nothing to install or keep alive.** No second browser window, no profile folder to lock or clear.
- **Cost.** Each page costs Claude tokens: the script is sent with every javascript_tool call (about 9.5 KB, roughly
  3k tokens), and the answer is read once and written once to a file (roughly 70 tokens a job each way). A page of
  20–25 jobs comes to about 5–7k tokens, a page of 10 about 4–5k; with the default limits (3–4 searches × 1 page per
  portal) a portal costs about 15–25k tokens per Find. Scans happen only during Find, at most once per `min_hours`.

### Consequences

- Good: portals that refuse headless browsers or flag new profiles work as they do for the person; Sign in is one
  click that opens a chat, with no window to find.
- Bad: tokens per page (above) instead of none; a Find with several portals takes minutes of waits (the delays stay).
- Bad: Sign in with Google and other pop-up sign-ins may fail inside the pane; the cookie import or the site's own
  password or code is the way round.
- The pane's own sign-in can expire: the script's `sign_in_wall` marks the portal "Sign in again" like a profile scan.
- Portals whose JSON APIs need extra request headers (some send an app id or a CSRF token) fall back to JSON-LD and links
  when the re-fetch is refused; an adapter can name window state instead.

### Revisit

- If the script's size dominates the cost, emit only the layers a portal's adapter uses, or move to a per-portal script.
- If Claude desktop lets plugins drive the pane, move plan → script → ingest out of the chat.
