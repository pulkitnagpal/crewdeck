# Changelog

What changed for people using Crewdeck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Crewdeck is not released yet: versions below name the `crewdeck` plugin's version and the state of `main`.

## [Unreleased] — Jobs v2 P1a: titles are a score

- **Signed-in portals in Claude's browser pane** (plugin 0.9.0, ADR-0008 amended; `jobs.portals_mode: pane`, the
  default): Connect or Sign in on Sources → Portals opens a Jobs chat where you sign in to the site in the pane (or
  import its cookies with the pane's ⋮ menu); Claude reads the portals' search pages there during Find, slowly, and
  stops at the first sign-in wall or check. `jobs.portals_mode: profile` keeps Crewdeck's own browser.
- **Titles never drop a posting any more** (ADR-0003): only eligibility does (places, workplace, employment type, pay
  floor, the title words, companies and industries you excluded, cooldowns). Each posting gets a title fit: your own
  titles first, then synonyms (developer for engineer, product owner for product manager, RN for registered nurse, in
  seven languages), the same occupation family, an adjacent one. Postings that fit none of your kinds of job are
  **other occupations**: ranked last, never judged, counted apart.
- **Your v1 titles become kinds of job** (`roles.targets`, with synonyms) on the next `crewdeck jobs check` or start,
  logged under Changes. Presets write kinds of job.
- **Honest counts**: "7 fits from 2 companies"; a pick set aside at Prepare no longer counts as a fit; the coverage line
  shows whenever fewer than 3 × N passed; Find picks up to N and never pads.
- The judge treats your preferences and notes ("prefer startups") as scoring only, never a "no".

## [0.7.2] (plugin 0.7.3) — Seamless Jobs, a calmer Today

- **Find fetches first** when a source you switched on was never fetched or is over 6 hours old: the request waits for
  fresh postings (LinkedIn's included), so one click is enough.
- **The Jobs chat opens by itself** when you click Find, Prepare or Apply and none is open (Claude desktop asks you to
  confirm the folder once).
- **The `/crewdeck` panel shows what the Jobs chat is doing**, in whichever chat you're in ("Find jobs · reviewing 10 of
  14 · in your Jobs chat", "fetching new postings first", "✓ Find jobs: 2 picked"), and a toast when it finishes.
- **Today, redesigned** for Claude's browser pane: a compact "Why so few?", a two-row header, and the apply panel scrolls.

## [Plugin 0.7.2]

- **Open Crewdeck**, **Open Jobs**, **Today's notes** and the board buttons in Claude desktop now ask Claude to open the
  page in its browser pane (a short message in the chat): Claude desktop doesn't let plugin code drive its browser, and
  0.7.1 fell back to the default browser after a wait. Elsewhere they still open the default browser.
- The plugin's version and the Crewdeck it installs are separate: a plugin-only fix needs no new release.

## [0.7.1] — Boards, the browser pane, small windows

### Added

- **Add this folder as a board** in the `/crewdeck` panel (any Claude session in a git project that isn't a board yet),
  **Open … board** buttons, and a **Boards** item in the rail that explains how to add one while there are none.
- `jobs/sources.md` lists your sources in words (Notes hides the frontmatter that holds them).

### Changed

- The panel opens Crewdeck pages in Claude desktop's own browser pane (the default browser where there is none).
- Every screen fits Claude's narrow and short browser pane: no overflow, no overlapping buttons, even spacing.
- The panel's button rows wrap instead of squeezing.

## [0.7.0] — Two-step onboarding

Installing Crewdeck is now two steps inside the Claude desktop app, with nothing to install by hand
([design E13](docs/everywhere.md)):

1. Add the `crewdeck` plugin (Code tab: + → Plugins → Add marketplace `pulkitnagpal/crewdeck`).
2. Type `/crewdeck` and click **Set up Crewdeck**.

### Added

- **One-click setup in the `/crewdeck` panel**: downloads Node 25.9.0 from nodejs.org and the Crewdeck release from
  GitHub, each checked against a SHA-256 pinned in the plugin before anything runs; installs into `~/.crewdeck`; sets up
  the notes, Jobs and the background service; shows each step; carries on where it stopped after a failure. No git, no
  Node, no terminal.
- **Set up my job search** in the panel opens the job-search chat with "Please set up my Crewdeck job search." ready to
  send, which starts the interview.
- A fresh setup picks free ports when 4848/4849 are taken; the plugin reads the port from Crewdeck's config.
- **Add this folder as a board** in the `/crewdeck` panel, in any Claude session whose folder is a git project that
  isn't a board yet; **Open … board** buttons for each board; a **Boards** item in the rail that says how to add one
  while there are none. `crewdeck add-project` restarts the background service so the board appears.
- Crewdeck pages from the panel open in Claude desktop's own browser pane.
- `scripts/release.sh` builds the release download and prints the checksum to pin.

### Changed

- `jobs/sources.md` shows your sources in words, in order, between `<!-- crewdeck:sources -->` markers that Crewdeck
  rewrites on every change and on start: Notes hides the frontmatter that holds them.
- The SilverBullet download in setup is checked against its release's published SHA-256.
- The README and first-run guide start with the two steps; the source install moved under "From source (developers)".

### Removed

- "Let Claude install it" (the prompt to paste) and the plan for a separate Mac app: the plugin does it all.

## [Unreleased] — Crewdeck everywhere (plugin 0.6.0)

One address, always on, in every Claude session ([design](docs/everywhere.md)).

### Added

- **`http://crewdeck.localhost:4848`**: a name to type, in every browser and Claude's browser pane, with nothing to set
  up (`.localhost` names always mean this computer). `crewdeck address --short` prints the steps for the address
  without a port (`http://crewdeck.localhost`, and `--name crew.deck`), which need your admin password once.
- **Always on**: `crewdeck service install|uninstall|status|restart` runs Crewdeck in the background and starts it at
  login (macOS LaunchAgent, Linux `systemd --user`). `crewdeck setup --service` installs it.
- **Open in Claude**: one click on the Jobs page (or **Start the Jobs session** in the panel, or `crewdeck open session`)
  opens a Claude Code session in your jobs folder in Claude desktop, with a hello ready to send.
- **Notes for newcomers**, with SilverBullet's own features: your files listed on the left, and buttons for Today
  (today's journal page with a To do list), New page, bold, checkbox, heading and links.
- **`crewdeck open [jobs|notes]`** starts Crewdeck if needed and opens it in your browser. Links like `/#jobs` and
  `/#notes/journal/2026-11-20` open that view.
- **`/crewdeck` in every Claude session** (plugin 0.6.0): a Today panel beside the chat with today's to-dos (tick, add),
  what Jobs is waiting on and your open tickets, which starts Crewdeck when it isn't running. `/crewdeck open|jobs|notes`
  open the page; the `crewdeck-open` skill handles "open Crewdeck" said in words.

### Changed

- `crewdeck up` when Crewdeck already runs says where and leaves it alone (it no longer rotates the running one's token
  or fails with `EADDRINUSE`). Every printed address is `http://crewdeck.localhost:<port>`.

## [Unreleased] — Jobs v0.4: Jobs for anyone

The owner's first run as a new user found 1 role in 1,480 postings: the search had been built around one person. v0.4
walks every step as nine fictional people (a nurse on nights, an accountant in Berlin, a store manager in Pune, a new
graduate in Manila, a warehouse worker without a resume, a freelance translator…) and fixes what each of them hit
([the audit](docs/jobs/impl/09-generic-audit.md), [design §24](docs/jobs/design.md)).

### Added

- **Plugin 0.5.0** with the v0.4 skills (setup interview v2, priority-aware daily run, sources and targets in
  memory). `crewdeck setup` now updates an installed plugin instead of keeping the old copy.

- **Where to look, from your notes.** A catalog of every source Crewdeck can fetch (kind, regions, fields, limits,
  confidence), `crewdeck jobs sources list|suggest|add|remove|move|enable|disable|resolve|set-url`, and a coverage line
  that says plainly when no job board covers your field where you live, and what still works. Employers are added by
  their careers page and checked in the provider sandbox; Claude can find a company's real jobs page for you.
- **The Sources tab**: your list in priority order (Move up / Move down, on/off, remove, last fetch), the catalog with
  filters, Add a company, Add a web address, and LinkedIn's row (placed like any source; switching it on stays yours).
- **Title matching for every field**: kinds of job (`roles.targets`) with the titles postings use in any language;
  every word of a title in any order, plurals, gendered and compound forms (Finanzbuchhalter, Traductor/a), abbreviations
  (RN, SRE), seniority words apart, and `roles.level` (entry, experienced, senior).
- **Preview before saving**: `crewdeck jobs preview` and the Preferences **Preview** show what a change would catch on
  postings already fetched, with near misses and suggested fixes. **Why so few?** on Today explains a small Find: the
  funnel from fetched to picked, the rule that dropped most, and fixes to try.
- **Setup v2**: the interview works with or without a resume, for people starting out, changing field or coming back
  after a break; it proposes sources, fetches once and previews until you are happy.
- **How you work and what you earn**: shifts and hours (`work_pattern`), pay per hour, day, week, month or year with
  your hours, per-word or per-project pay kept for the judge, moving (`relocate_to`), right to work (`authorized_in`),
  CEFR language levels, licences with where, more employment types, a cooldown per role or per company.
- **Forms in any language**: form terms in English, German, French, Spanish, Portuguese, Italian, Dutch and Indian and
  Philippine English; answers drafted in the form's language, citing your facts through translations you approved; the
  resume in your chosen language and conventions; referees, employment history blocks and availability grids; walk-in,
  email, document and account-needed apply methods; `crewdeck jobs letter` for a cited cover letter.
- **"Let Claude install it"** in the README: one prompt a non-developer pastes into Claude desktop.
- `crewdeck doctor` says when another Crewdeck (another home) answers on this one's port.

### Changed

- **The whole Jobs page meets a 14 px minimum and AA contrast** in light and dark (rem sizes that follow the browser's
  text size), with every control labelled and reachable by keyboard; checked by headless browser tests on every screen.
  At 1440 px and narrower the top bar takes two rows.
- A new user's page says what to do next: "No sources yet" with **Open Sources** instead of "0 new roles waiting";
  Today's empty state points at the Sources tab or **Refresh sources**; the setup card says when no Claude session is
  connected yet and lets you cancel the request (a cancel no longer shows as "Setup stopped").
- `crewdeck setup` on a new vault says the job notes are "ready for setup to fill in", not "kept your …".
- `jobs/sources.md` is one ordered `sources:` list (v2). Notes written before keep working: `boards:` and `watchlist:`
  are read in that order and merged on the first change.
- A resume upload labelled with an accent ("Currículum", "Currículo", "Résumé") is offered the resume PDF.
- The example notes in `examples/jobs/` are v0.4 notes (a kind of job, level, work pattern, sources v2).
- `docs/jobs/first-run.md` v2: the exact first run on a Mac, from install to Submit, what's stored where, starting over
  safely, and known gotchas.

### Deprecated

- `--preset` on `crewdeck setup` and `crewdeck jobs init`: it now runs the catalog's query for the preset and says
  so. The four preset `sources.md` files are gone. It goes in the next release.

### Security

- ID, bank and tax numbers (social security, National Insurance, Aadhaar, PAN, Steuer-ID, DNI/NIE…) are never filled,
  stored, drafted or remembered, in any language; `crewdeck jobs check` refuses them in your notes. Sensitive answers
  (salary expectations, date of birth, nationality…) fill only from your explicit answer, kept per company unless you
  say "use this everywhere".

## [Unreleased] — 0.3.0

### Breaking changes

- **The plugin is now `crewdeck` (0.4.0), not `crewdeck-bridge`.** It was renamed in 0.3.0 when it took on the skills,
  and bumped to 0.4.0 for the new handshake below. Uninstall the old one, remove and re-add the marketplace, and install
  `crewdeck@crewdeck` (README, "Install the plugin"). The old bridge can't talk to this server.
- **Challenge-first handshake and a token that rotates.** The bridge and the CLI now make Crewdeck prove it knows the
  token (`POST /api/hello`, a hash bound to the port) before they send it, and `crewdeck up` writes a new token on every
  start. Request-scoped agent calls must come from a session in the request's lane.
- **Notes (SilverBullet) runs on a Unix socket** in `~/.crewdeck/run/`, with no TCP port and its shell backend off. The
  Notes proxy (`silverbullet.port`, 4849) is the only way in; nothing listens on `4949` any more. Bookmarks to the old
  internal port stop working.
- **Board internal ports are random** on every start; use the proxied board port Crewdeck shows.
- **Fetching from job boards needs Node 25 or newer** (Node's permission model can keep the providers off the network
  only from 25). The rest of Crewdeck still runs on Node 22.18+.
- **Page endpoints need `Sec-Fetch-Site: same-origin`** from browsers, and the generic `/api/requests` no longer takes
  requests for the `jobs` lane. Scripts that posted to the API as if they were the page stop working.
- `crewdeck jobs pick` and `link` no longer accept `--force`: "Add it anyway" is your choice on the Jobs page.

### Added

- **Jobs**: a job search for any role in any country, in the rail next to Notes and Boards.
  - Setup with Claude (`jobs-setup`): your resume becomes career facts, word for word, after you confirm; an interview
    fills what you want. Everything lands in vault notes you can edit: `me/profile.md`, `me/career.md`,
    `jobs/search.md` (with a dated **Changes** log), `jobs/memory.md`, `jobs/sources.md`.
  - Paste a link, Prepare (form reading, answers from your facts with a citation check, first-time questions, a
    tailored resume PDF), Apply (Claude fills the real form in a tab of the browser pane and stops at Submit), **I
    submitted it** / Mark applied, cooldowns, journal lines.
  - Find N jobs within a budget: scheduled fetching from pinned, sandboxed job-board providers, rule-based drops, code
    ranking, then Claude judges best-first in batches of 10 and stops once N pass (at most 40 per Find).
  - Learning: answers, facts, style rules and "not interested" reasons are remembered with your words and reused.
    Preference changes in any session (`crewdeck-memory`), with `refilter` to bring back roles the change allows.
  - Risky switches (LinkedIn guest search, pasted LinkedIn links, Easy Apply filling, email drafts, LinkedIn message
    text), off by default, changed only by you in Jobs → Settings or your own terminal, confirmed in a native dialog.
  - Presets: `remote-any-country`, `onsite-city`, `healthcare-us`, `non-engineering`.
  - `crewdeck jobs …` CLI (`crewdeck jobs help`), `crewdeck doctor` Jobs checks.
- `crewdeck setup`: one command for a new user (home, vault, Jobs, the jobs folder, the plugin in Claude from the
  checkout). `--help` never runs a command.
- The jobs workspace (`~/Crewdeck/jobs`, a visible folder next to the vault; a workspace left in the hidden jobs home
  moves there on `jobs init`): a managed `CLAUDE.md` with the hard rules and a `.claude/settings.json` that
  runs Claude's Bash in Claude Code's sandbox.
- The request queue grew typed requests, progress lines, presence ("Claude connected"), leases (a stuck request goes
  back after 15 minutes), **Cancel**, and per-kind caps.
- `docs/jobs/first-run.md` (from zero to a submitted application), `docs/roadmap.md`, this changelog, an architecture
  overview in `docs/design.md`, and the repo as a plugin marketplace you can add from a local checkout.

### Changed

- `~/.crewdeck` and Crewdeck's own files are private (0700/0600); a home others can write to is refused.
- A strict Content Security Policy and `Cross-Origin-Resource-Policy` on the shell; system fonts (no Google Fonts).
- `appearance: auto` (the default) follows the system, so Claude desktop's light or dark, everywhere.

### Security

- A security review of the whole module ([docs/jobs/impl/07-security-review.md](docs/jobs/impl/07-security-review.md)):
  SSRF guard for pasted links and headless reading, providers with no network and hash-checked code, file flags
  limited to Jobs' own folders, a value-based citation check, and a leak scan over history and commit messages. Residual
  risks are listed in the README.

## Before 0.3.0 (`main`)

### Added

- 2026-11-18: the bridge (`crewdeck-bridge` plugin 0.1.0): page requests reach the Claude session that owns the lane,
  while it is idle; unfinished ones go back to the queue. The Ask Claude box.
- 2026-11-17: apps in the rail, one theme for every tool, project labels.
- 2026-11-17: the workspace: shell, SilverBullet notes, Backlog.md boards, a starter vault,
  `crewdeck init|add-project|up|doctor`.
