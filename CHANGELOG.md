# Changelog

What changed for people using Crewdeck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Crewdeck is not released yet: versions below name the `crewdeck` plugin's version and the state of `main`.

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
