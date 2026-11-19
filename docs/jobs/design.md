# Crewdeck Jobs: design

Status: **v0.4 designed** (2026-11-19). P0–P8 are built. The owner's first run as a new user found a search built
around one person (1 role from 1,480 postings). v0.4 (§24, decisions D18–D42, phases P9a–P9i) makes every step work
for any person: any role, field, country, language, currency, workplace and seniority. The audit behind it is
[impl/09-generic-audit.md](impl/09-generic-audit.md).
Branch: `feat/jobs-module` (off `main` @ `2261134`). Changelog at the end.

This is the living design for the Jobs module. Small implementer docs (`docs/jobs/impl/NN-*.md`) are written
from §22 after approval. Each must be executable by an agent that has read only this doc and that implementer doc.

---

## 1. Intent

**What exists today.** Crewdeck is a local web workspace shown in Claude desktop's browser pane. It has:
- Notes (SilverBullet over a Markdown vault);
- Boards (Backlog.md);
- local apps in the rail;
- a bridge that delivers page requests to the right Claude session.

A separate private "Job Agent" app proved the job flow for one person.

**Goal.** Jobs becomes a first-party Crewdeck module for **anyone**: any role, seniority, location, workplace type,
country and currency.
- **Every user, including the person who built it, starts as a new user.** They set up their own profile, Claude
  learns from what they say and do, and nothing about any particular person is in the code.
- **Everything Claude knows about the user lives in one place:** their vault, as notes they can read and edit in
  Crewdeck → Notes. Job search preferences, career facts, remembered answers, writing style and "not interested"
  reasons are all notes. Machine state (the tracker database, generated PDFs) stays in `~/.crewdeck/jobs/`.

**Done means:**
- A stranger clones the public repo and runs setup. Claude interviews them and writes their notes.
- They paste a job link from any company and Claude prepares it and fills the form in the browser pane from their
  notes; they review and click Submit.
- What they tell Claude along the way is remembered and reused.
- The repo contains no personal data, and CI fails if any appears.

**The owner's acceptance test** is exactly this, run as a new user (§2.2).

## 2. User journeys (end to end)

These are the contract. Every one has a test (§19) and works the same for every user.

### 2.1 Where everything lives

| What | Where | Written by |
|---|---|---|
| Who you are: name, contact, links, education, standard answers ("notice period", "years of experience") | `vault/me/profile.md` (frontmatter + free text) | You in Notes, or Claude via `crewdeck jobs me set …` |
| Your career: resume sections and the fact bank (every bullet Claude may use) | `vault/me/career.md` | Claude from your resume file or interview, with your approval; you in Notes |
| What you want: titles, places, workplace (remote/hybrid/on-site), pay, languages, employment type, exclusions, daily counts | `vault/jobs/search.md` (frontmatter + a dated **Changes** log in your words) | You in Notes or the Jobs page; Claude via `crewdeck jobs pref set … --because-file` |
| What Claude learned from you: answers in your words, facts you added, style rules, "not interested" reasons | `vault/jobs/memory.md` | `crewdeck jobs` commands only (each item keeps your quote and date) |
| Where to look for jobs: boards and company watchlist | `vault/jobs/sources.md` | Preset at setup; you or Claude |
| What happened: "Applied to …" lines | `vault/journal/YYYY-MM-DD.md` (appended) | Crewdeck |
| Risky switches (LinkedIn, Easy Apply, email drafts) | `~/.crewdeck/config.yaml` → `jobs.features` | **Only you**: Jobs page toggles or an interactive terminal (§12) |
| Roles, scores, statuses, form questions, answer versions, outreach records | `~/.crewdeck/jobs/jobs.db` (SQLite) | `crewdeck jobs` CLI and the Jobs page |
| Tailored resume PDFs, per-role scratch files | `~/.crewdeck/jobs/out/<role>/` | CLI |

All of it is on your machine. Notes are plain Markdown and open in SilverBullet and Obsidian. The vault's
`CLAUDE.md` tells every session these locations.

### 2.2 First run (any new user)
1. `npm ci`, `crewdeck init` (vault, SilverBullet), `crewdeck jobs init`.
   - `jobs init` enables Jobs, creates `jobs/` and `me/career.md` notes from templates, and downloads and verifies
     the job-board providers.
   - It also checks for a Chromium-based browser and prints how to install one if missing, then prints the
     jobs workspace folder.
2. Install the `crewdeck` plugin in Claude desktop and open a session in the jobs workspace folder. Jobs shows
   "Claude connected" once the bridge claims the lane (presence, §9).
3. Jobs shows **Set up with Claude**. Clicking it queues a `setup` request, and the session runs the `jobs-setup`
   skill:
   - Claude asks for a resume file. It can be dropped in `vault/raw/` or given by path; it is read as data.
   - Claude proposes resume sections and facts, word for word from the resume, and writes them after the user
     confirms.
   - Then it interviews for the search: target titles, where (cities and/or remote-from regions), workplace,
     pay floor with currency and period, languages, employment types, licences, sponsorship, exclusions, and
     daily picks.
   - Every write goes through validated CLI commands. Claude ends with `crewdeck jobs check`, and Jobs shows a
     summary.
4. The user can review and edit any of it in Notes at any time.

**v0.4:** the interview gains a "where to look" step (catalog suggestions, employers resolved, an honest coverage
line), a fetch-once preview loop and paths for people with no resume, no experience yet or a career break (§24.4,
§24.10).

### 2.3 Paste a job link (the first acceptance test)
1. The user pastes any posting URL in Jobs → **Add link**. The server validates the URL, refuses X and
   LinkedIn-unless-enabled, and queues a `link` request.
2. The jobs session claims it.
3. It runs `crewdeck jobs link --request <id>`. The URL comes from the server, never through the shell. The
   command fetches the page through the SSRF guard (§14), reads JobPosting JSON-LD/meta, adds the role and
   picks it for today. Cooldown, already-applied and company-already-in-progress come back as warnings, and
   Claude asks the user.
4. **Prepare:** every question is known before the user is asked to approve anything.
   - `crewdeck jobs form <role>` reads the application form headlessly; questions are stored per role.
   - **Forms that can't be read headlessly:** this covers Notion and other JS-built forms, LinkedIn Easy Apply
     and anything behind the user's sign-in.
     - Claude reads them live instead, in a background tab of Claude desktop's browser pane.
     - It opens the application, steps through it reading each page's questions, and records them with
       `crewdeck jobs learn`. It presses Next only between pages of questions, never on Review or Submit.
     - Then it closes the tab, so nothing is filled yet.
   - `crewdeck jobs draft <role> --brief …` fills what the profile and memory already answer and lists the rest.
     Profile answers (name, email, phone, …) are stored as approved answers with a `profile:` source, so they
     never show as first-time questions.
   - Claude drafts the rest from facts and memory only. `draft --answers` runs the **citation check**, and
     anything unsupported becomes a **first-time question**.
   - `crewdeck jobs resume <role> --variant-file …` selects facts by id and renders a PDF.
5. Jobs shows the role.
   - Answers carry their sources ("your resume", "your words, 12 Nov").
   - First-time questions sit on top.
6. The user answers first-time questions on the page (typing or picking an option) or in chat. **Each answer is
   remembered** in `jobs/memory.md` with the user's quote and reused on every later form (§8).
7. The user clicks **Apply**. It is enabled once every required question has an answer. Everything else is
   §2.3a.
8. After submitting, the user clicks **I submitted it**, or confirms Claude's "I see the confirmation page: mark
   applied?":
   - the status becomes `applied`;
   - the company cooldown starts;
   - a journal line is added;
   - open requests for the role close.

### 2.3a Apply: what happens and what the user sees
Example: the user found a LinkedIn Easy Apply role (or any company posting) in Crewdeck → Jobs and clicks
**Apply**.

| | Crewdeck (Jobs page) | Claude desktop |
|---|---|---|
| 1 | Queues an `apply` request; the role's **apply panel** opens: "Waiting for Claude" (or the "no Claude session on Jobs" banner, §2.9) | The jobs session's bridge claims the request (idle-only) |
| 2 | Panel: "Opening the application" | Claude opens a **new tab in the same browser pane**, next to the Crewdeck tab. LinkedIn Easy Apply: the posting in the user's own signed-in LinkedIn, then **Easy Apply**. "Apply on company site": Claude follows Apply to the company's ATS, or uses the stored `apply_url` |
| 3 | Live progress lines ("Step 2 of 4: filled 6 fields") and an **Open the form** button that brings that tab to the front | Per page: Claude reads the questions → `fill-plan --request <id> --fields-file …` → fills exactly the plan → re-reads to check → Next, only to another page of questions |
| 4 | A question that wasn't seen in Prepare appears in the panel as a first-time question with an answer box; the request waits (`needs you`) | Claude stops on that page and closes the request as `needs you: <question>`. Once the user answers in Crewdeck (remembered, §8), Crewdeck queues `apply` again and Claude continues from where the form is |
| 5 | **Resume:** the panel shows the tailored PDF with **Reveal in Finder** / **Download** | Easy Apply: Claude selects a resume already uploaded to LinkedIn when one matches; otherwise the upload is left to the user (the pane can't attach files) |
| 6 | "Your turn: review the form tab and click Submit" | Claude stops at the Review/Submit page and **never clicks it** |
| 7 | The user switches to the form tab, reviews, clicks Submit, then **I submitted it** in Crewdeck. If Claude sees the confirmation page, the panel offers "Mark applied" | — |
| ✕ | Sign-in, checkpoint, CAPTCHA, "restricted", or a limit (`daily_quick_apply`, cooldown): the panel says why and what to do | Claude stops at once and doesn't retry |

The user never types answers into the job site, and never leaves Claude desktop: Crewdeck, the form tab and
the chat are all there. LinkedIn Easy Apply needs `linkedin.easy_apply` on (§12). Without it, Apply on a
LinkedIn role opens the posting for the user and shows the answers to copy.

### 2.4 Find jobs (manual or daily)
Fetching costs no tokens: it is code making HTTP calls. Tokens go on Claude reading postings (judging) and preparing
picks. So fetching runs on a schedule, and the button spends Claude only on what can still pass.

1. **Collect (scheduled, no Claude):**
   - Crewdeck's server runs `crewdeck jobs source` on a timer (default every 12 h, `jobs.fetch_every`; also on
     demand with **Refresh sources**).
   - It runs the sandboxed providers, plus LinkedIn guest search if enabled.
   - The rule prefilter runs straight after.
   - Jobs shows "N new roles since <time>".
2. **Rank (code, no Claude):** every surviving role gets a cheap score from the notes:
   - title match to `roles.titles` and seniority;
   - skills overlap with `me/career.md`;
   - freshness;
   - source quality (pasted > LinkedIn > ATS boards > aggregators).

   Roles with no description get their detail fetched only if they rank in the top 50. Companies with a remembered
   company-wide rule (for example "requires regular travel") are dropped here.
3. **Find N jobs** (or the daily run):
   - Claude judges candidates **in rank order, in batches of 10, and stops once N pass**.
   - The eligibility first pass uses a small, fast model (a subagent with a light model); the full model is used
     only to prepare picks.
   - It never judges the same role twice, and a company-wide verdict is remembered as a `company_rule` in
     `jobs/memory.md`.
4. `pick` (one per company, cooldown, daily count), then prepare each pick as in 2.3 step 4. Progress lines show
   live on the page.

Budget (enforced by `crewdeck jobs candidates --budget`): at most 40 postings judged per Find. The panel shows how
many were judged and how many remain in the pool.

**v0.4:** sources are fetched and ranked in the user's priority order (§24.2). When a Find returns fewer than N, the
page shows the funnel and one-click fixes (§24.7).

### 2.5 Change a preference ("I'm OK with hybrid now")
- **In any Claude session** (the plugin's `crewdeck-memory` skill applies everywhere):
  - Claude runs `crewdeck jobs pref set search.workplace remote,hybrid --because-file <file with the user's words>`.
  - That updates `jobs/search.md` frontmatter and appends a dated line to **Changes**: *2026-11-20: remote → remote,
    hybrid. "I'm OK with hybrid now."*
  - Then it offers `crewdeck jobs refilter --days 14`, which re-checks roles dropped in the last 14 days and brings
    back the ones the new preference allows.
- **In Notes:** edit the frontmatter. The next run validates it. If the note is invalid, Jobs shows the error with
  the field path, and the last valid version stays in effect.
- **On the Jobs page:** the Preferences panel edits the same note through the same validated path.
- **v0.4:** Preferences shows a live **preview** of an unsaved change (what passes and what drops, §24.6) before
  Save.

### 2.6 Not interested
**Not interested** asks why.
- The reason is remembered as the user's words (`kind: avoid` in `jobs/memory.md`), and the judging step must
  respect it on every later run.
- Optional title words become a hard prefilter exclusion in `search.md`.
- The role is skipped and its requests close.

### 2.7 Edit or improve an answer
- **Edit on the page.** This stores the user's text as approved. It is never redrafted behind their back, and a
  correction is recorded.
- **Ask Claude on an answer** (with an instruction) queues `improve`. Claude rewrites from facts and memory
  and saves through the citation check (`crewdeck jobs answer --request <id> --text-file … --claims-file …`).
- **Style rules** ("keep answers under 80 words") are remembered as `kind: style`. Drafts that are not the user's own
  corrections are re-drafted under the new style.

### 2.8 Opt-in features
LinkedIn guest search, pasted LinkedIn links, Easy Apply filling and email drafts are off until the user switches
them on in Jobs → Settings (§12). Each one shows its terms-of-service risk at the switch.

### 2.9 When something is missing
| Situation | What the user sees |
|---|---|
| No Claude session on the jobs lane | Jobs banner: "No Claude session is working Jobs: open one in `<folder>`" with a copy button; requests wait |
| A note fails validation | The exact field and fix; the last valid version is used |
| No browser for headless reading/PDF | `crewdeck doctor` and Jobs show how to install one |
| Provider download or verify fails | `jobs init` / `doctor` say which file and why; sourcing skips providers, links still work |
| Site needs sign-in/CAPTCHA/account | Claude stops and says so; the user signs in or solves it themselves |

## 3. Goals, non-goals, anti-goals

**Goals:** the journeys in §2 for any user; one app (same server, rail, theme); one place for user knowledge (the
vault); safe-by-default risky features; a clean public repo.

**Non-goals (this release):**
- Auto-submit, interview prep, a hosted or multi-user service.
- A plugin framework for third-party modules.
- Importing the old private Job Agent's data. Its owner starts fresh as a new user; an import script is optional
  later work.

**Anti-goals:**
- Any personal string in the repo, its history, CI logs or screenshots.
- Acting as the user on social sites (follow, connect, message, post); scraping X.
- Solving CAPTCHAs, typing passwords, creating accounts, sending email.
- Invented experience.
- Mass-apply behaviour.

## 4. Starting point and critique

### 4.1 Crewdeck (~540 lines)
- `src/server.ts`:
  - shell page, `/api/*`, `/notes/*` proxied same-origin to SilverBullet;
  - Host allowlist (`localhost`, `127.0.0.1`);
  - Origin check (any local port) on POST.
- `src/requests.ts`: a JSON-file queue written only by the server, lanes `cockpit` and `project:<name>`, claim,
  finish and requeue (fails after 3 tries).
- `plugin/` (`crewdeck-bridge`): idle-only delivery and put-back.
- `src/supervisor.ts`: restarts children.
- `web/`: the shell.
- Node ≥ 22.18; CI on Node 22.

### 4.2 The private Job Agent (~4,400 lines, 40 test files), what carries over
- CLI and SQLite tracker.
- Sources (career-ops providers, MIT).
- Rule prefilter, pay parsing, judge/pick, paste-a-link, LinkedIn guest search.
- Outreach records.
- Knowledge base: memory, citation check, answer versions, corrections, undo.
- Headless form reading, the answer-drafting brief, fill plan for the pane, resume PDF.
- Web workspace UI (Preact + htm: Today, apply panel, Applications, What Claude knows).

It was built for one person: the eligibility rules, currency, time zone, title gate, resume layout, file names and
UI copy encode one search. About 30 of its 40 test files contain that person's data. **None of that carries over.**
Every rule becomes a user setting, and every test uses fictional people.

### 4.3 Critique (what changes, bluntly)
- **Two request queues** doing one job → one queue (D4).
- **Mtime polling + a Unix socket** for change notification → `PRAGMA data_version` for the DB and `fs.watch` for
  notes (D10).
- **Free regex filters** are hostile to new users → typed settings compiled to rules, and only near-certain drops
  are rules. Anything subtle (eligibility wording, licences, language level) goes to Claude's judging step with
  the user's words (D5).
- **Ad-hoc schema checks** → versioned migrations, and a **generic** schema v1: currency-neutral pay columns, no
  unused social columns (D9).
- **Shell arguments built from page/posting text** → request ids and `-file`/stdin only (D11).
- **The bridge turns any queued text into a prompt** that says "treat as the person asking". Any local page could
  queue one. The queue becomes an authenticated, typed boundary (D16, §14).
- **Fixed resume layout** → data plus a template (D8).
- **Personal YAML files next to code** → vault notes the user owns (D6).

## 5. Decisions

| # | Decision | Why | Rejected |
|---|---|---|---|
| D1 | Code `src/jobs/`, UI `web/jobs/`, skills `plugin/skills/`, note templates `vault-template/jobs/` + `vault-template/me/career.md`, presets `presets/jobs/` | One toolchain | A separate package for one module |
| D2 | Jobs runs **in-process** in the shell server (`/jobs/`, `/api/jobs/*`); heavy work in CLI processes. Mitigations: WAL (reads never wait), server `busy_timeout` 250 ms with a "busy, retry" response, a top-level try/catch on every request, `node:sqlite` loaded lazily only when Jobs is enabled, and a test that the bridge still claims while a CLI holds a write lock | One process, one origin, shared checks; the server's DB work is small | Child process behind the proxy: viable and kept as the fallback if the lock test or real use shows stalls |
| D3 | Sourcing, form reading and PDF run in CLI processes; sourcing runs providers in a **sandboxed child** (D7) | Isolation from the shell and from the user's files | Background jobs in the server |
| D4 | **One queue** (Crewdeck's), extended with `kind`, `ref`, `payload`, dedupe, progress, presence, per-lane caps; the server reconciles requests of applied/skipped roles on start and on DB change; open requests are never trimmed | One delivery mechanism, one set of rules | Two queues |
| D5 | Settings in `jobs/search.md` compile to rules at load time; only near-certain drops are hard rules; nuanced eligibility goes to the judge with the user's words | Works for nurses, analysts and engineers alike without regex skills | Generated `filters.yaml`; hard-coding every nuance as regex |
| D6 | **User knowledge in the vault** (§2.1); machine state in `~/.crewdeck/jobs/` (0700) | One place the user can see and edit; consistent with Crewdeck's memory model | Separate YAML files in a data folder |
| D7 | Providers downloaded at setup from a pinned career-ops commit; the manifest covers the **full import closure**, each file sha256-verified at download and at load; a resolve hook refuses unlisted files and non-`node:` bare imports; only allow-listed providers are imported; they run in a child process with Node's permission model and an empty environment. Excluded: `local-parser.mjs` and anything needing npm packages | Pinned and verifiable without vendoring; third-party code can't read the user's files | Vendoring; executing the upstream registry over a whole folder |
| D8 | Resume = `me/career.md` sections (kinds: summary, experience, list, skills, education; paper A4/Letter) + facts by id + a generic template → PDF in headless Chromium with JS off and network blocked | Any career shape; "select facts, never write new text" | One fixed layout |
| D9 | Migrations by `PRAGMA user_version`; v1 is a generic schema (`pay_min`, `pay_max` in the user's currency, `pay_period`, `pay_text`; no `x_url`) | Safe upgrades; nothing person-specific in schema | Inheriting the old schema |
| D10 | Live refresh: `PRAGMA data_version` (500 ms) + `fs.watch` on the jobs notes + the server's own writes → SSE | Covers DB and notes; no sockets | Mtime polling + socket |
| D11 | No page or posting text in shell commands: request-scoped commands take `--request <id>`; other text via `-file` or stdin (`--result-file`, `--text-file`), the files written with Claude's **Write tool** (P7: never a heredoc, whose delimiter the text can contain) | Removes shell injection paths | Quoted arguments; heredocs |
| D12 | Playbooks are skills in the public plugin; `jobs init` writes the workspace `CLAUDE.md` and a `.claude/settings.json` with deny rules (§14) | Every user gets the same playbooks and guard rails | Skills in each user's folder |
| D13 | Risky features: switches in `config.yaml` that only the user can change (page toggle, or an interactive terminal: the CLI refuses without a TTY). P7: switching on or raising a number also needs the user's click in a **native dialog** the server (or CLI) shows; with none, the page shows a one-time code for `crewdeck jobs features …` in a real terminal | Prompt injection can't widen the agent's reach; headers and TTYs can be forged by local processes | Switches in a note Claude can write; header-only checks |
| D14 | Leak scan: generic PII patterns + **HMAC-SHA256** denylist (key in a CI secret, never in the repo); scans the tracked tree, the pushed commits' diffs, messages, added blobs and author fields (P7: a new branch against the default branch); a private local hook with a plaintext list | No guessable hashes, covers history | Plain sha256 list; tree-only scan |
| D15 | Node ≥ 22.18 kept; CI matrix 22 and 24; `node:sqlite` FTS5 and the permission model verified in CI; no `import.meta.main`. P7: **job-board sourcing needs Node ≥ 25** (the first Node whose permission model denies the network); on 22/24 it refuses with the reason and everything else works; CI adds 25 | Doesn't raise the floor for the rest; providers never run with network access | Node 25 for everything; sourcing with network on 22/24 |
| D16 | API split: **page endpoints** (same-origin only: exact Origin + `Sec-Fetch-Site: same-origin` (required since P7), JSON body) vs **agent endpoints** (claim, requeue, done/fail/show/progress: require the token in `~/.crewdeck/token`, 0600, new on every `up`; sent only after `POST /api/hello` proved the server with a port-bound hash; request-scoped calls name their cwd and must be in the request's lane). Jobs requests are created only by `/api/jobs/*` actions, never by the generic `/api/requests`. SilverBullet moves to **its own origin** (own proxied port, like boards), on a Unix socket since P7 | A local page or a Notes script can't mint prompts or close requests; a squatter never sees the token | Origin-only checks |
| D17 | The coded Playwright filler, Electron app, MCP server, legacy Today page and headless `claude -p` drafter are **not carried over** (owner approved removal, 2026-11-18) | Filling happens in Claude's pane from `fill-plan`; the CLI covers answer changes | Keeping two fillers |
| D18 | **A source catalog** ships in the repo: `src/jobs/data/sources-catalog.yaml`, read-only, with one entry per provider: kind, regions, role families, workplace, languages, seniority, needs, limits, confidence. It uses one family taxonomy and the gazetteer's region ids. A test keeps it in step with the manifest. `fill` rules derive keywords and queries from the user's targets (§24.2) | Maps "who I am" to "where to look" for any person, and states coverage honestly | Asking Claude to remember boards; metadata inside the manifest (that file is a supply-chain record) |
| D19 | **Storage split, three ways:** the user's selection, order, employers and custom sources in the vault note `jobs/sources.md`; everything available in the repo's catalog; last fetch results in `<jobs home>/state/sources.json` | The user owns and can read their choices in Notes; the catalog is versioned code; machine state stays private | Selection in config.yaml (not the user's note); catalog copied into the vault (goes stale) |
| D20 | `jobs/sources.md` v2: one ordered `sources:` list (position = priority), each entry with a stable `key`; v1's `boards:` and `watchlist:` are still read, and the first save from the Sources screen merges them. Roles record `source_key` (DB migration v2) | Order needs one list; per-source counts need provenance | Two lists plus `priority:` numbers (two orders to reconcile) |
| D21 | **Source priority** affects ranking (a bonus by position; pasted links stay on top), fetch order (earlier sources get the run's caps first) and so what Find judges first. It never overrides a hard rule | The owner wants LinkedIn first; priority should mean "look here first", not "lower my bar" | Priority as a filter; fixed quality by kind (today's `SOURCE_RANK`) |
| D22 | **LinkedIn is listed like any source.** Its entry in `sources.md` mirrors the `linkedin_search` switch (position and state shown); turning it on stays the user-only native confirm (D13), opened from the same row. The row also shows `linkedin_links` and `easy_apply`. Guest search uses each target's first three titles | One list the user can order; the risky switch can't be flipped by editing a note | A note flag that turns LinkedIn on (prompt injection could write it) |
| D23 | **A Sources screen** on the Jobs page: the user's sources in order (move up/down, on/off, remove, last fetch result) and the catalog (filter by region, field, kind; add). It can add an employer's careers page or a custom URL. Writes go through a validated page-only action (same-origin rules, D16) | Sources change after setup; YAML by provider id is for experts | Notes-only editing |
| D24 | **Employers are first-class.** `crewdeck jobs sources resolve` runs the detectors in the sandbox, then a one-page test fetch, and returns the provider and a job count (or "not readable"). If that fails, a `source` request lets Claude find the real jobs page in the pane. An unreadable page stays on the list as "paste its postings" | People know where they want to work before they know any board | Silent failures at the next scheduled run |
| D25 | **Setup gains "where to look"**: `crewdeck jobs sources suggest` scores the catalog from the profile (countries, families, workplace, languages, level) and prints a **coverage line**; the interview then fetches once and previews before the user confirms | The first result shouldn't be a surprise | Presets |
| D26 | **Title matching for every field:** `roles.targets`, each with titles and variants, families and skills. Matching is word-level, in any order. Seniority words are matched apart from role words. Plurals and gendered suffixes pass; compound tails pass (German, Dutch, Nordic); gender markers are stripped. Variants are proposed in the interview and checked against fetched postings. `roles.titles` is still read as one target | The phrase gate dropped 1,375 of 1,480; every field names jobs many ways | Fuzzy/embedding matching (opaque, unexplainable); no gate (judging cost) |
| D27 | **Search preview (dry run):** `crewdeck jobs preview` and `POST /api/jobs/preview` run the rules of the current or an unsaved search over the pool (fetching once when empty). They report what passes, examples, drops by reason, single-blocker counts and title near-misses. Used in setup, in Preferences before Save, and from Find's funnel | Tune before saving, with real postings | Regex dumps (`jobs rules`) as the only feedback |
| D28 | **Find explains a small result** on the page: a funnel (fetched → rules by reason → judged → passed) and one-click fixes that open a preview of the change | "1 found" with no reason looks broken | A line from Claude only |
| D29 | Pay: periods `year, month, week, day, hour`; `pay.hours_per_week` and `days_per_week` drive conversion; `pay.per_unit` (per word, per project) is the judge's text, never a floor | Day rates, part-time and freelancers | 40-hour weeks for everyone |
| D30 | **Work pattern:** `work_pattern` (shifts can/can't, hours a week, term-time only) for the judge and availability questions. Employment types add freelance, fixed-term, seasonal and apprenticeship. A **structured** `employment_type` from JSON-LD or a provider becomes a hard drop when the user excluded it | Shift and hourly work screens on these first | Judge notes only |
| D31 | **Level and languages:** `roles.level` (entry, experienced, senior, any) and years compared by the judge; CEFR levels (A1–C2) accepted; licences may be `{ name, where }` | Graduates, German postings, licensed work | Seniority words alone |
| D32 | **Forms in any language:** form terms (profile fields, sensitive, `never_fill`) move to `src/jobs/data/form-terms.yaml` per language. Claude may raise a field to sensitive, never lower it. Government ID numbers, bank and tax numbers are `never_fill`: always skipped and never stored | German, Indian and US forms ask different personal fields; IDs don't belong in notes | English regexes |
| D33 | **Answers and resumes in the form's language:** drafts answer in the form's language and cite the facts. Facts may carry user-approved translations (`facts[].tr`), and the resume renders in `resume.language` with localised headings and an opt-in personal block | Resumes and forms in German, Spanish or Filipino | English-only output; silent translation of facts |
| D34 | **No resume, entry-level, career switch, career break** are first-class interview paths. They use list sections for projects, volunteering and courses, an `org`-less break entry, and per-target skills. Prepare skips the resume when the form has no upload and there are no experience facts | Many people have no resume or no "experience" yet | One resume-shaped path |
| D35 | **Apply methods beyond one online form:** Prepare records the method (form, email, document form, walk-in, chatbot, account needed). Fill-plan gets a capped `add` for "add another" groups, using experience dates (`start`/`end`). `profile.references` fills reference questions only. `crewdeck jobs letter` renders a cited cover letter PDF | Teachers, nurses and hourly workers rarely meet a one-page form | Stopping at the first unusual form |
| D36 | Cooldown has a scope (`company`, or `role` for large employers) and `per_company` picks; setup proposes defaults by family | One rule built for recruiter-led hiring breaks hospital systems and chains | One global 60-day company cooldown |
| D37 | **Relocation and right to work:** `places.relocate_to` (on-site there passes the rules) and `places.authorized_in` (countries the user may work in without sponsorship) | "Willing to relocate" and "needs a visa" are common and decidable | A yes/no sponsorship flag only |
| D38 | Rule words (workplace, travel, place restrictions, industries) and the gazetteer's states and regions become per-language data for the languages the catalog covers | Cheap drops and correct reasons for non-English postings | English regexes plus the judge |
| D39 | **Presets become catalog queries** (`--preset` stays a deprecated alias for one release); the four preset `sources.md` files are removed | Four presets can't describe everyone, and several of their entries can't fetch | Fixing and keeping four hand-made lists |
| D40 | **Reach:** a "Claude installs it" path and plain requirements in the README. It says plainly that Crewdeck needs a desktop computer. The UI stays English in v0.4, with strings gathered in one module (translations deferred); Claude talks in the user's language; "CV" or "resume" follows the user | Most job seekers aren't developers; honest about what isn't there | A packaged installer now; unchecked machine translations |
| D41 | **Accessibility baseline** for every Jobs screen: rem-based type with 14 px body text at minimum, AA contrast in both themes, everything usable by keyboard (reordering by buttons, not drag only), status in live regions | The UI uses 11–13 px fixed sizes | Per-screen fixes later |
| D42 | **Coverage honesty:** when the catalog has no board for the user's country and field, setup, the Sources screen and Find say so, name what does work (employers' pages, LinkedIn if they switch it on, pasted links), and never invent a source | An empty Today must not look like a bug | Silence |

## 6. Architecture

```
Claude desktop
├── chat: Claude sessions (every one has the crewdeck plugin: bridge + skills)
│     ├── any session: crewdeck-memory skill → updates vault notes through `crewdeck jobs me|pref|remember`
│     └── session in the jobs workspace folder owns lane "jobs" (bridge claims while idle, with the token)
│           └── runs `crewdeck jobs …` (CLI: link, form, draft, resume, fill-plan, learn, source, judge…)
│               and drives the browser pane to fill forms (never Submit)
└── browser pane → http://localhost:4848  (Crewdeck shell process)
      ├── /             shell: rail (Notes · Boards · Jobs), Ask Claude
      ├── /jobs/*       Jobs UI (same origin as the API)
      ├── /api/*        page endpoints (same-origin) · agent endpoints (token)
      └── frames: Notes → SilverBullet on its own proxied port; Boards → own proxied ports
data: vault/{me,jobs,journal}/*.md   ~/.crewdeck/{config.yaml, token, requests.json}   ~/.crewdeck/jobs/{jobs.db, out/, providers/}
```

## 7. The notes (schema v1)

### 7.1 Format
- Each note is Markdown with YAML frontmatter. Crewdeck reads and writes only the frontmatter keys it owns.
- It writes with the `yaml` Document API, so comments and key order survive, and replaces the file atomically.
- The note body (free text, the Changes log) is the user's.
- `tags`, `aliases` and other SilverBullet keys are ignored.
- An unknown key gets a "did you mean …" warning, not an error, so users can keep their own frontmatter.
- Errors name the note, the field path and the fix. On error the last valid version is used and Jobs shows a banner.

### 7.2 `me/profile.md`
```yaml
---
tags: me
identity: { first_name: Ada, last_name: Example, email: ada@example.com, phone: "+49 30 1234567",
            city: Berlin, country: Germany, links: { linkedin: "", github: "", website: "" } }
standard_answers:          # your words for recurring questions; sensitive ones only fill an exact question
  current_title: Data Analyst
  years_experience: "6"
  notice_period: 1 month
  work_authorization: EU citizen
education: [ { school: Example University, degree: MSc, discipline: Statistics, end_year: 2018 } ]
---
# About me
(free text)
```

### 7.3 `me/career.md`
```yaml
---
tags: me
resume: { file_name: "{first_name} {last_name} Resume.pdf", paper: A4, max_pages: 2 }
sections:                  # page order
  - { id: summary, kind: summary }
  - { id: example-gmbh, kind: experience, title: Senior Data Analyst, org: Example GmbH, where: Berlin, dates: "2022 – now", max_bullets: 6, required: true }
  - { id: certs, kind: list, title: Certifications }
  - { id: skills, kind: skills }
  - { id: education, kind: education }
facts:                     # every bullet Claude may use, word for word; ids are section.slug
  - { id: summary.analytics, text: "Analyst with six years of ...", tags: [analytics] }
  - { id: example-gmbh.dashboards, text: "Built **40** dashboards used by ...", tags: [bi] }
  - { id: certs.gcp, text: "Google Cloud Professional Data Engineer (2024)" }
skills: [SQL, Python, Looker]
---
```
Validation: a fact's id prefix is a section id of kind summary, experience or list; ids are unique.

### 7.4 `jobs/search.md`
```yaml
---
tags: jobs
roles:
  titles: [data analyst, analytics engineer, Datenanalyst]   # a title must contain one
  seniority_prefer: [senior, lead]                            # ordering, not a filter
  exclude_title_words: [intern, sales]
workplace: [onsite, hybrid]                                    # remote | hybrid | onsite
places:
  onsite: [Berlin]                                             # cities (commute area is a judge note)
  remote_from: []                                              # countries/regions/states you can work from; "worldwide" accepts anywhere
languages: [{ name: English, level: fluent }, { name: German, level: conversational }]
employment_types: [full-time]                                  # full-time | part-time | contract | per-diem | internship
licenses: []                                                   # e.g. "RN (Texas)"; judge checks posting requirements
needs_sponsorship: false
exclude: { companies: [], industries: [gambling], travel: frequent }   # travel threshold: none | occasional | frequent
pay: { currency: EUR, floor: 55000, period: year, rule: top_of_range, unlisted: keep, locale: de-DE,
       fx: { USD: 0.92 }, fx_updated: 2026-11-01 }             # period: year | month | hour
schedule: { timezone: Europe/Berlin, daily_picks: 5, cooldown_days: 60 }
judge_notes: Prefer product companies over agencies.           # your words for the judge
---
# Job search
## Changes
- 2026-11-18: created during setup.
```

### 7.5 `jobs/memory.md` (what Claude learned, all in the user's words)
```yaml
---
tags: jobs
items:
  - { id: m-1, kind: answer, key: notice_period, text: "1 month", quote: "one month notice", scope: all, created: 2026-11-18 }
  - { id: m-2, kind: avoid, text: "No agency roles", quote: "I don't want agency roles", scope: all, created: 2026-11-19 }
  - { id: m-3, kind: style, text: "Keep answers under 80 words", quote: "...", scope: all, created: 2026-11-19 }
---
```
Kinds:
- `answer` (reused for the same question everywhere);
- `fact` (a new fact about the user, citable);
- `preference`;
- `style`;
- `avoid`.

Items are never deleted, only superseded (`superseded_by`), so undo and history work.

### 7.6 `jobs/sources.md`
This note holds the `boards:` and `watchlist:` lists in frontmatter (provider id or `careers_url`), the same shape
as career-ops entries. Validation refuses `parser:` entries and unknown providers. **v0.4:** one ordered `sources:`
list with keys, custom sources and a LinkedIn mirror entry (§24.2); v1 lists are still read.

### 7.7 Presets
`jobs init --preset <name>` seeds `search.md` and `sources.md`. Identity and career always come from the user.
**v0.4:** presets become catalog queries (D39, §24.11).

| Preset | Seeds |
|---|---|
| `remote-any-country` | Remote boards |
| `onsite-city` | Regional boards plus a watchlist |
| `healthcare-us` | Healthcare titles, state-level places, hourly pay, licences |
| `non-engineering` | General boards |

### 7.8 Compiled rules
`crewdeck jobs rules` prints them.

**Hard drops** (near-certain only):
- the title has none of `roles.titles`, or has an `exclude_title_words` / avoid title word;
- a workplace kind the user excluded is stated in the location field;
- "not/excluding <place>" for every acceptable place;
- "<place> only / must reside in <place>" for places outside the user's acceptable set. This uses a gazetteer with
  containment (city ⊂ state/region ⊂ country ⊂ EU/EMEA/APAC/Americas), so "EU only" passes for Berlin;
- an industry word;
- travel above the threshold;
- pay below the floor (any currency/period, converted);
- company cooldown or an active pick.

**Judged by Claude, not dropped by rules:** unclear location rules, language level, licence and sponsorship
requirements, employment type, seniority fit, avoid reasons, judge notes.

**v0.4:** the title gate becomes word-level matching over targets and variants (§24.5); work pattern, structured
employment type, relocation and right to work join the rules and the brief (§24.8).

`judge-brief` prints these as plain instructions built from the notes. `location_noise`-style tokens are part of
the compiler. A `rules:` key in `search.md` can override a compiled regex by name (validated).

## 8. Learning loop

| Signal | Stored | Used |
|---|---|---|
| The user answers a first-time question (page or chat) | `memory.md` item (`answer`, their quote) + approved answer row | Filled directly on every later form with the same question key (wording variants matched through the question index) |
| The user edits an answer | Approved answer + correction row | Never redrafted; similar questions get it as a "past answer" in drafting briefs |
| The user states a fact ("I led a team of 5") | `memory.md` `fact` | Citable in answers (passes the citation check) |
| Style instruction | `memory.md` `style` | In every drafting brief; non-corrected drafts are redrafted |
| Not interested + reason | `memory.md` `avoid` (+ optional title words in `search.md`) | Judge must apply it; title words are hard drops |
| Preference change | `search.md` frontmatter + Changes log | Next prefilter/judge; `refilter` brings back dropped roles |
| New question met on a live form | Question + per-role field (`learn`) | Asked once as first-time, then remembered |

## 9. Requests, lanes, presence, progress

```ts
type Request = { id; lane; text; status: 'new'|'picked'|'done'|'failed'; by?; result?; tries; created; updated;
  kind?: 'find'|'link'|'apply'|'improve'|'setup'; ref?: string; payload?: object; progress?: {at, text}[] };
```
- **Lanes.** `jobs` = a session whose cwd is inside `jobs.workspace`, checked before projects.
- **Who creates jobs requests.** Only `/api/jobs/action/*` creates them, after validating the payload per kind.
  The generic `/api/requests` (the Ask box) refuses `jobs` and stores plain text only.
- **Dedupe and caps.**
  - The same open `(lane, kind, ref, payload)` returns the existing request.
  - At most 20 open requests per lane.
  - Adds are rate-limited to 30 a minute.
  - Open requests are never trimmed.
  - Payloads are cleared when a request closes.
  - Closed requests are kept for 30 days.
- **Delivery.**
  - Challenge first (P7): the bridge and the CLI send a nonce alone (`POST /api/hello`) and check
    `sha256("crewdeck-proof:<token>:<nonce>:<port>")` before the token leaves them; the token rotates on every `up`, and
    the bridge re-reads it when the proof stops matching.
  - Request-scoped agent calls (show, progress, done, fail) carry the caller's cwd; only a session of the request's lane
    may make them.
  - The prompt it posts says the payload is data and the person's intent is the request kind.
  - Values from postings are quoted. URLs are never printed; Claude reads them with
    `crewdeck jobs request show <id>`.
- **Presence.** The server records each lane's last claim; a busy session's bridge claims with `take: false` every 4 s
  (a heartbeat). Jobs shows "Claude connected" (a claim in the last 10 s) or the "open a session in …" banner. A picked
  request or a progress line is not presence (P7).
- **Leases (P7).** A picked request whose session hasn't claimed or reported progress for 15 minutes goes back to
  the queue (tries + 1; failed after 3). The bridge puts back what it held when it loads again. The page's **Cancel**
  closes a waiting or stuck request as failed ("Cancelled on the page").
- **Caps (P7).** 20 open and 30 adds a minute per lane **and kind** (plain text is its own kind), so links can't
  block an Apply.
- **Closing.**
  - `crewdeck request done|fail <id> --result-file f` (or stdin).
  - An apply that needs the user closes as done with `needs you: …`; the question sits on the role.
  - Unclosed requests go back after the turn; a request fails after 3 tries (unchanged).
- **Progress.** `crewdeck progress <id> --text-file f`, kept as the last 50 lines per request. Jobs shows them
  per role through `ref`.

## 10. Playbooks

| Skill | Purpose |
|---|---|
| `jobs-workspace` | Works `find`, `link`, `apply`, `improve` and `setup` requests per §2; ends each with done/fail |
| `jobs-setup` | The first-run interview: reads the resume as data, proposes sections and facts, interviews for the search, writes via validated commands, runs `jobs check` |
| `jobs-daily-run` | Sourcing → prefilter → judge → pick → prepare, with progress lines |
| `crewdeck-memory` | In any session: route "remember…" and preference changes to the right note through commands, quoting the user |

Skills are generic: "the user", fields from the notes, no examples about real people. The workspace `CLAUDE.md`
(generated) holds the hard rules (§13) and the note locations.

## 11. UI

**Screens** (ported from the Preact + htm workspace to `web/jobs/`):
- Today: queue and role detail, with answers, sources and first-time questions.
- Apply panel: state and progress.
- Applications.
- What Claude knows: tabs for Profile, Career, Search, Memory and Answers, each linking "Open in Notes".
- Preferences: an editor over `search.md`.
- Settings: feature switches with risk text.
- **v0.4:** Sources: the user's sources in priority order and the catalog (§24.3); a Find funnel on Today (§24.7);
  the preview in Preferences (§24.6).

**Delivery:**
- `preact` and `htm` are served from `node_modules` by an explicit file map, with no build step.
- `api.js` does fetch + SSE.
- Theme from the shared `web/tokens.css`.
- No Google Fonts: system font stack.

**Top bar:** Find N jobs, Add link, an agent strip (connected / working / waiting / last lines).

**First run:** the setup card (§2.2).

**Copy:** generic. Money and dates use `pay.locale` and `schedule.timezone`.

## 12. Risky capabilities (opt-in, user-only switches)

| Feature | Default | Limits in code |
|---|---|---|
| LinkedIn guest search | off | 2.5 s pace, request cap, stop at the first 429/999/3xx |
| Pasted LinkedIn job links | off | `/jobs/view/<id>` and `currentJobId` only |
| Easy Apply filling | off | `daily_quick_apply` ≤ 25, counted by `fill-plan` |
| Email drafts (Gmail) | off | Verified address, 1 per role, ≤ 20 a day; drafts only |
| LinkedIn message text | off | Text only; the user sends |

Switches live in `config.yaml` `jobs.features`. They change only via a Jobs → Settings toggle (a page POST) or
`crewdeck jobs features …` in an interactive terminal; the CLI refuses without a TTY. Since P7, switching one on or
raising its number also needs the user's click in a native dialog (macOS `osascript`, Linux `zenity`/`kdialog`);
without one, the page answers with a one-time code (10 minutes, single use, three tries, kept as an HMAC under the
token) that the terminal command asks for. Switching on with the daily number at 0 sets it to a default (Easy Apply 5,
drafts 10). The server re-reads the switches from `config.yaml` on every view and action.
The README states the terms-of-service risk plainly.

## 13. Hard rules: how each is enforced

Labels: **code** = enforced by Crewdeck code; **guard** = Claude Code deny rules in the generated workspace
settings; **prompt** = skill and `CLAUDE.md` instruction only.

| Rule | Enforcement |
|---|---|
| Never submit a form | prompt (skills), plus `fill-plan` never emits submit/review actions (code), plus the E2E asserts submit untouched. Claude drives the pane, so this is ultimately a prompt-level rule |
| Never send email | code (no send path; drafts only) |
| No CAPTCHA, password or account creation | `fill-plan` skips password/CAPTCHA fields (code); stop-and-tell (prompt) |
| Stop at 429 / sign-in / checkpoint | code in `linkedin.ts`, `link.ts`; prompt for the pane |
| Caps, one per company, cooldown | code (`pick`, `prefilter`, `link` warnings). P7: no `--force` flag at all; the user's "Add it anyway" exists only in a link request's payload (`link --request`, `pick --role <id> --request <id>`, and only for that request's posting). `status` by hand never reaches `picked` (only `pick`) or `applied` (only `applied`); `prepared` only from `picked`; a prefiltered role comes back only through `refilter` |
| Risky switches | code (page or TTY, plus a native dialog or a page-issued code) + guard (deny Edit on `~/.crewdeck/config.yaml`; the sandbox can't write it) |
| No raw DB writes | guard (deny `Bash(sqlite3:*)`; the sandbox can't write `jobs.db`) + prompt |
| No exfiltration from the pane | prompt (open only the role's URLs; never put facts in URLs) + the user's permission mode. A residual risk, stated in the README |
| Postings are data | code (`--request`, `-file`: P7 reads only real paths inside Jobs' home or workspace, never the token or config) + prompt |
| No invented experience | code (fact ids validated; citation check; unknown → first-time question). P7: numbers compared by value ("1,5" is 1.5, never 15; "5M" only when the M is attached; number words in English, German, French, Spanish, Portuguese), and every sentence is checked against the user's own sources; only a sentence that is a company claim citing the posting may use the posting |

## 14. Threat model and controls

**Assets:** notes with PII; answers; the user's signed-in browser sessions; their machine and Claude usage.

**Attackers:**
- (a) another web page or local web app;
- (b) a malicious posting or page read by the agent;
- (c) compromised upstream code;
- (d) a repo reader;
- (e) a local process squatting the port.

**Data flow out of the machine:**
- notes, facts and answers go to **Anthropic** (Claude reads them);
- answers and the resume go to **the job site** the user applies to;
- email drafts go to **Gmail** (opt-in);
- search titles and places go to **LinkedIn** (opt-in);
- provider files come from **GitHub** (nothing sent).

| Threat | Control |
|---|---|
| DNS rebinding | Host allowlist `localhost`, `127.0.0.1`, `[::1]` (new: `[::1]`) on every request, proxy forward and upgrade, on **all** Crewdeck ports including the SilverBullet and board proxies. P7: SilverBullet has no TCP port (Unix socket in `~/.crewdeck/run`, 0700; `SB_SHELL_BACKEND=off`); each Backlog.md board gets a random internal port per launch, never in `/api/state` (Backlog.md 1.55.3 has no socket, auth or Host check: residual risk in the README) |
| CSRF / cross-origin prompt minting (a) | D16: page endpoints need exact own Origin + `Sec-Fetch-Site: same-origin`, JSON body; reads refuse a browser without same-origin/none Fetch Metadata; agent endpoints need the token; no CORS headers; SilverBullet on its own origin; Ask box text is plain and lane-limited |
| A prompt-injected agent forging page calls (b) | P7: the jobs workspace's settings run Claude's Bash in Claude Code's **sandbox**: no network (`allowedDomains` empty, loopback names in `deniedDomains`, no local binding, no Unix sockets), `allowUnsandboxedCommands: false`, `failIfUnavailable: true`, OS-level denyRead of the token and denyWrite of config, queue, wrapper, tracker and guard rails; only `~/.crewdeck/bin/crewdeck jobs|request|progress *` is excluded (it can do what the agent endpoints allow); deny rules for raw sockets, ssh, `script`/`expect`, `osascript`, `open`. Risky switches need a native dialog. Residual: unsandboxed local processes can forge any header (README) |
| Port squatting (e) | Challenge first (P7): `/api/hello` proves the server (port-bound) before the bridge or CLI sends the token; the token rotates on every `up` |
| Crash by malformed URL | Top-level try/catch → 400 (e.g. `/%`); test |
| XSS | Preact escaping; no `innerHTML`/`dangerouslySetInnerHTML` with data (grep test); hrefs only http(s); CSP `default-src 'self'; script-src 'self' 'sha256-<importmap>'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`; `nosniff`; `Cross-Origin-Resource-Policy: same-origin` on the shell too |
| Path traversal | Fixed roots + `startsWith(root + sep)` after `realpath`; resume by role id regex; P7: every `crewdeck jobs` file flag (`--*-file`, `--value-file`, `draft --brief/--answers`) and, in the jobs workspace, `request done --result-file`/`progress --text-file` take only real paths (links resolved) inside `<jobs.home>` or the jobs workspace, never `~/.crewdeck/token` or `config.yaml` (`src/files.ts`); elsewhere those two never read Crewdeck's own files |
| SSRF (pasted links) | `netguard`: http(s) only; DNS lookup inside the connect (every address checked, the connection pinned to a checked address); blocklist incl. `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `::/128`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `2001:db8::/32`, IPv4-mapped (`::ffff:0:0/96`), -translated (`::ffff:0:0:0/96`) and -compatible; manual redirects ≤ 5 re-checked; one 15 s deadline incl. body; **decoded** body cap 2 MB while streaming; proxy env vars ignored |
| Headless browser reaching local services | All Chromium traffic via an in-process guard proxy using `netguard` (`--proxy-server`, `--proxy-bypass-list=<-loopback>`), service workers blocked, WebSockets through the proxy; PDF render with JS off and network off |
| Prompt injection (b) | Data never in shell; prompts mark data; user-only switches; deny rules; caps in code; apply needs the user's click; residual risk documented |
| Shell injection | `execFile` only; `--request` ids; `-file`/stdin; skills and the bridge prompt write text with the Write tool, never heredocs (P7) |
| SQL injection | Prepared statements; FTS terms `[a-z0-9]` quoted; grep test for interpolated SQL |
| Supply chain (c) | D7 (closure manifest, verify at download and load, resolve hook, allow-list, sandboxed child with `--permission` and **no network** on Node ≥ 25, its fetches made by the parent through netguard, a frozen `getBuiltinModule` and no WebAssembly compiler, protocol on a private fd with a per-run nonce, read-only provider dir, empty env; P7, §15); `npm ci`; `npm audit --omit=dev --audit-level=high`; new deps only preact, htm, playwright-core |
| Data at rest | Crewdeck's own files written with explicit modes (dirs 0700, files 0600; no global umask, so SilverBullet/Backlog.md keep normal modes in the user's vault and repos); `~/.crewdeck` 0700; refuse a group/world-writable `jobs.home`; payloads cleared on close |
| Leaks (d) | D14; tests refuse to run unless `CREWDECK_HOME` is a temp dir; screenshots only from a temp home with fixtures; P7: the leak scan also reads commit bodies, UTF-16 files and every blob a push adds, knows North American numbers without +1, and scans a new branch against the default branch (§17) |

## 15. Providers (supply chain detail)

**Manifest** (`src/jobs/data/providers.manifest.json`):
- the repo, the pinned commit and the MIT notice;
- every file in the import closure of the allow-listed providers (providers, `providers/_*.mjs` helpers, and
  the `lib/` and root modules they import);
- each file's sha256;
- the excluded list with reasons (`local-parser.mjs`: runs commands; `js-yaml` users: npm dependency).

`scripts/update-providers-manifest.mjs <commit>` computes the closure by parsing imports and fails on any bare
import other than `node:`/built-ins.

**Download** goes to a temp dir, every file is verified, and the dir is renamed to `providers/<commit>/` together
with LICENSE. Any mismatch aborts.

**Run (P7: Node ≥ 25 only):**
- Sourcing needs **Node 25 or newer**: only from 25 does Node's permission model deny the network (and have
  `--allow-net`). On Node 22/24 `crewdeck jobs source` and the server's timer refuse with that reason ("boards: not run
  (job-board providers need Node 25 or newer …)"), `doctor` says so, and pasted links, Prepare and Apply still work.
- `crewdeck jobs source` spawns
  `node --permission --allow-fs-read=<providers dir> --allow-fs-read=<runner> --disallow-code-generation-from-strings
  src/jobs/provider-runner.ts` with an empty environment and **no `--allow-net`**: no sockets (TCP, UDP, Unix), no DNS,
  no processes, workers or writes.
- The runner verifies hashes, installs resolve/load hooks (`module.registerHooks`) that refuse unlisted files, bare
  imports and the denied built-ins (`vm`, `module`, `worker_threads`, `child_process`, `inspector`, `wasi`, …), wraps and
  freezes `process.getBuiltinModule` with the same denylist, removes WebAssembly's compile/instantiate/Module, and only
  then imports the needed provider ids (explicit ones from `sources.md` plus the ATS detectors for `careers_url`).
- **Fetch through the parent.** The runner replaces the global `fetch` (which career-ops' `_http.mjs` helpers call) with
  one that sends `{ url, method, headers, body, redirect }` to the parent over fd 3. The parent makes the request with
  `guardedFetch` (SSRF checks on the host and every redirect, 15 s, 5 redirects, 10 MB decoded body, GET/HEAD/POST only,
  POST bodies ≤ 1 MB, hop-by-hop headers dropped; at most 8 in flight, 2000 requests and 256 MB per run) and answers on
  fd 4; `redirect: 'error'` (career-ops' default) refuses a 3xx as undici would.
- **Protocol on fd 3, not stdout.** Jobs, entry results and fetches go to the parent as `<nonce> <json>` lines; the nonce
  is per run, sent on stdin and never visible to providers, so a line a provider writes (stdout, the console, or fd 3
  itself) is dropped. The runner writes them with a `writeSync` captured before any provider loads, so no patched
  prototype sees the nonce. stdout and stderr are only a log tail. The parent validates every field before writing the DB.
- Providers that need disk caching get an in-memory shim; their behaviour is reviewed per provider in the impl doc.

**Upstream risk:** if the pinned commit vanishes, `jobs init` reports it and links still work. Re-pinning is a
reviewed PR.

## 16. Concurrency and idempotency

| Concern | Handling |
|---|---|
| Server + CLIs on one DB | WAL; CLI `busy_timeout` 8 s; server 250 ms + retry response; multi-row writes in `BEGIN IMMEDIATE` |
| Notes written by CLI while open in SilverBullet | Read-modify-write of frontmatter only, atomic rename; SilverBullet reloads changed files |
| Double delivery / double clicks | Single-writer queue with synchronous claim; put-back only by the claimer; dedupe; UI disables while pending |
| Pick / applied / learn / memory | Idempotent per day / `max()` cooldown / `insert or ignore` / supersede, never delete |

## 17. Leak prevention and CI

- **`scripts/leak-scan.mjs`.** It runs on the tracked tree and on `git log -p` plus author/committer emails for
  the commits being pushed or PR'd. It checks for:
  - generic email patterns, apart from `example.com`/`example.org`, `noreply@anthropic.com` and the declared
    package author;
  - phone shapes;
  - home-directory paths;
  - the HMAC denylist, keyed by the `LEAK_SCAN_KEY` CI secret. It is skipped with a notice when the secret is
    absent (forks); the generic checks always run.
  - P7: North American numbers without +1 (one separator style, area code and exchange 2-9; versions, dates,
    SSN-shaped ids and bare 10-digit ids don't match), UTF-16 text with or without a BOM (and UTF-16 runs in binaries),
    whole commit messages (`%B`), and every blob the pushed commits add (a file added then removed is still read). A
    new branch (all-zero `before`) is scanned against the default branch (`LEAK_SCAN_DEFAULT_BRANCH`, else
    `origin/HEAD`, `main`, `master`), or whole when there is none.
- **Local hook.** `scripts/pre-commit` uses a private plaintext list (`~/.crewdeck/leak-denylist.txt`).
- **CI.** Push and same-repo `pull_request` only, never `pull_request_target`. Node 22, 24 and 25 (25 runs the provider
  sandbox; 22/24 assert that sourcing refuses): `npm ci`, the leak scan as its own step (the only one with
  `LEAK_SCAN_KEY`), the tests without the key, `npm audit`. `actions/checkout` and `actions/setup-node` are pinned by
  full commit SHA (v4.4.0), without persisted credentials.

## 18. Out of scope for now

Importing old Job Agent data (optional later); auto-submit; multi-user; Windows.

## 19. Testing and acceptance

- **Fictional people only.** The fixtures are `example`, `berlin-analyst` (on-site/hybrid, EUR, German titles) and
  `us-nurse` (remote within licensed states, hourly USD, per-diem). Each is a full vault (`me/`, `jobs/`). **v0.4**
  adds seven personas and their journey tests (§24.12).
- **Unit tests.** Ported from the Job Agent for every module that carries over, plus:
  - the note read/write tests (comments preserved, validation messages, last-valid fallback);
  - compiled rules per profile, including gazetteer containment;
  - netguard;
  - the token and origin split;
  - crash-proofing.
- **Journey tests (E2E, per fictional person).** Each runs on a temp home with a fixture provider (through the real
  sandboxed runner) and local HTML posting/form fixtures served by a test server:
  - setup via commands;
  - paste a link (2.3);
  - prepare: form read, draft with fixture output, citation check, first-time question, then answering it so
    memory reuses it on a second role;
  - fill-plan, applied by a test-only Playwright driver, asserting submit untouched;
  - applied: cooldown and journal line;
  - preference change and refilter (2.5);
  - not interested (2.6);
  - find (2.4).
- **Owner acceptance (manual).**
  - The owner sets up from zero as a new user via `jobs-setup`.
  - Then he pastes a real posting link; Claude prepares it and fills it in the pane, and he submits.
  - Then he changes a preference in chat and sees it in Notes and in the next run.
- **Visual check.** Screenshots from a temp home with fictional data: rail, Today, apply panel, Applications,
  What Claude knows, Preferences, Settings, setup card; light and dark.

## 20. Dead code (owner approved removal, 2026-11-18)

**Not carried over to Crewdeck, and removed from the private Job Agent repo:**
- the Electron app and its build;
- the MCP server and desktop extension;
- the coded Playwright filler (only `answerFor` is kept);
- the legacy Today page;
- the headless `claude -p` drafter;
- the socket notifier;
- one-off importers;
- request kind `review`, `x_url` and channel `x`;
- the tests tied to them.

The exact file list is in the private repo's commit.

## 21. Risks and revisit triggers

| Risk | Trigger to revisit |
|---|---|
| Pane-only filling fails on some form families (iframes, Workday) | More than one failed fill in 10 on a family → consider a coded adapter for it |
| In-process DB stalls the shell | The lock test or a user report → move Jobs to a supervised child behind the proxy |
| Upstream providers vanish or drift | Download failure, or more than 20% of sources erroring → re-pin or fork |
| Prompt injection through the pane | Any observed attempt → tighten deny rules and add pane URL allow-listing |

## 22. Work breakdown

The first acceptance test (§2.3 for a new user) is reachable after P4.

| Phase | Implementer doc | Scope | Exit check |
|---|---|---|---|
| P0 | `00-foundations.md` | Security baseline on the existing shell: try/catch, `[::1]`, token + page/agent split, exact Origin + `Sec-Fetch-Site`, SilverBullet on its own origin, file modes, CSP headers, queue caps; leak scan + CI matrix; tokens.css (new deps arrive with the phase that uses them) | Tests for each control; CI green on 22/24 |
| P1 | `01-notes-and-rules.md` | Note read/write (frontmatter, atomic, last-valid), schemas and validators, `me/pref/remember` commands, compiled rules + gazetteer, pay, `jobs check`, `rules`, `judge-brief` | Rule tests on three fictional people |
| P2 | `02-core.md` | DB v1 + migrations, link + netguard, form reading (guard proxy), KB (memory in notes, answers in DB), draft brief + citation check, resume template + PDF, fill-plan, learn, avoid, refilter, outreach (gated) | Ported unit tests green |
| P3 | `03-server-ui-bridge.md` | `/api/jobs/*`, SSE (data_version + fs.watch), queue extension, presence, bridge token handshake, UI port + rail + preferences/settings/setup screens, the apply panel (§2.3a: progress, Open the form, first-time questions mid-apply, resume reveal, Mark applied) | Server and UI tests |
| P4 | `04-setup-and-skills.md` | `jobs init`, presets, note templates, workspace CLAUDE.md + settings.json, skills, rename the plugin to `crewdeck` | **First acceptance test possible** |
| P5 | `05-sources.md` | Providers manifest, download/verify, sandboxed runner, scheduled fetch, code ranking, budgeted early-stop judging with a light model (§2.4), LinkedIn (gated), find/daily | Sandbox tests; sourcing on fixtures |
| P6 | `06-e2e.md` | Journey tests for two fictional people | E2E green with outputs |
| P7 | `07-security-review.md` | `/security-review`, multi-lens review on the diff, fixes | Findings + fixes + tests |
| P8 | `08-docs-visual.md` | README (setup, safety, terms of service), `docs/design.md`, CHANGELOG, roadmap, screenshots | Owner sign-off; PR description ready, no push or PR without asking. **Done** (2026-11-19), awaiting the owner's acceptance run |

**v0.4 (Jobs for anyone).** Each phase is one coherent commit with its own implementer doc (`09a-…` to `09i-…`), written
before coding from §24 and the audit. The order matters: P9a–P9d fix the 1-of-1,480 search, and P9e–P9f put it in
front of the user. A phase may start once the one before it is committed.

| Phase | Implementer doc | Scope | Exit check |
|---|---|---|---|
| P9a | `09a-catalog-and-sources.md` | **Catalog and sources v2.** Finalise `sources-catalog.yaml` (add `fill` rules; review `unsure:` entries against fixtures), loader + validation, a test that catalog ids = manifest providers + excluded. `sources.md` v2 (ordered `sources:`, keys, custom entries, LinkedIn mirror, v1 read), its validator and Document-API writer. `crewdeck jobs sources list\|suggest\|add\|remove\|move\|enable\|disable` (value files only). DB migration v2 (`roles.source_key`, `language`, `visa_text`, `employment_type`). Per-source state in `state/sources.json`; `jobs source --only-new-sources` (setup's first fetch). Fetch in priority order, LinkedIn at its position. Rank bonus by position (D21). Keep providers' `language`/`visaText`. Presets → catalog queries; the four preset `sources.md` files removed (D39) | `suggest` returns the expected sources and coverage line for the seven persona fixtures. A v1 note reads and merges unchanged. Priority changes the candidate order on a fixture pool and never revives a dropped role. Every `fill` rule has a test. `npm test` green |
| P9b | `09b-employers.md` | **Employers.** `crewdeck jobs sources resolve <key>` (detectors only, then a one-page test fetch in the sandbox, ≤ 30 s), a `source` request kind for Claude-assisted resolution (open the careers page in a background pane tab, follow it to the jobs list, write the URL with `sources set-url`, resolve again), custom URL outcomes (`fetch: auto` or `none` with a reason), the workspace skill's `source` section | Fixture careers pages on the local test server: a Workday-, a Greenhouse- and a NEOGOV-shaped page resolve with counts; an unknown page ends `fetch: none` with a reason; no network outside netguard |
| P9c | `09c-title-matching.md` | **Title matching** (§24.5): `roles.targets`, `match: words\|broad\|off`, seniority words apart, stems and compound tails, gender markers, abbreviations as variants, `roles.level`, per-target skills in rank; one matcher shared by the gate, rank and LinkedIn terms. Title words data `src/jobs/data/title-words.yaml` (en, de, fr, es, pt, it, nl to start) | A corpus test of ≥ 400 fictional titles across the nine personas (en/de/es/fr) with expected pass/fail, including every title in the audit's simulation table; v1 `roles.titles` gives the same or more passes, never fewer |
| P9d | `09d-preview-and-funnel.md` | **Preview and funnel** (§24.6, §24.7): `crewdeck jobs preview [--search-file] [--days] [--json]`, `POST /api/jobs/preview` (page, read-only, ≤ 5,000 roles, ≤ 1 s budget), single-blocker counts, near-miss clusters, suggested fixes as concrete `pref set` changes, the Find funnel stored with the run and shown on Today, the Preferences preview. Find's close line uses the server's funnel | The owner's case as a fixture (1,480 postings: 1 passes before; after accepting the suggested variants ≥ 100 pass with the same place drops). The funnel numbers add up. A preview never writes the DB or notes (test) |
| P9e | `09e-sources-screen.md` | **Sources screen** (§24.3): Yours (ordered, up/down buttons, on/off, remove, last fetch), Catalog (filters region/field/kind, add), Add company, Add custom URL, the LinkedIn row opening the native confirm; page action `POST /api/jobs/action/sources` (validated, same-origin) | UI and server tests; keyboard-only reorder; light/dark screenshots in a temp home; a page write produces the same note bytes as the CLI for the same change |
| P9f | `09f-setup-v2.md` | **Setup interview v2** (§24.4, §24.10): `jobs-setup` rewritten (where to look, employers, coverage line, fetch once, preview loop, targets and variants, work pattern, level, relocation and right to work, no-resume / entry-level / switcher / break paths), setup card copy, `jobs-daily-run` (priority, funnel close), `crewdeck-memory` (targets, sources) | Skill command lines linted against the CLI (existing lint). A scripted setup through commands for three personas (E, N, W) ends with `jobs check` clean and a preview that passes ≥ 1 fixture posting per target |
| P9g | `09g-work-pay-rules.md` | **Work pattern, pay and rules data** (§24.8, D29–D31, D36–D38): pay periods and hours, per-unit text, `work_pattern`, employment types and the structured drop, CEFR, licences with `where`, `relocate_to`, `authorized_in`, cooldown scope and `per_company`, per-language rule words and new states/regions, the judge brief updates, `exclude.travel: off` | Rule and pay tests per persona: N's nights and hourly floor; W's 24 h/week and a monthly-posted wage; F's day rate and a per-word posting kept for the judge; A's "Deutsch C1" and "Homeoffice"; T's term-time; R's monthly INR and LPA; refilter round trips |
| P9h | `09h-forms-any-language.md` | **Forms and answers in any language** (§24.9, D32–D35): `form-terms.yaml` (profile fields, sensitive, never_fill; en, de, fr, es, pt, it, nl, plus the India and Philippines English variants), Claude-raised sensitivity, never-fill skip, answers in the form's language, `facts[].tr`, `resume.language`/headings/`personal`, `resume.word`, references, experience `start`/`end`, fill-plan `add`, apply method, `crewdeck jobs letter` | Form fixtures: a German form (Anrede, Geburtsdatum, Gehaltsvorstellung, Steuer-ID → sensitive/never_fill), an Indian form (Aadhaar, PAN, Father's name, Current/Expected CTC), a US hourly form (availability grid, EEO, SSN), a UK school form (references, employment history with "Add another"). Citation check green on German answers citing English facts with an approved translation |
| P9i | `09i-journeys-docs.md` | **Journeys and docs** (§24.12, §24.13): persona journey tests, README (who it's for, the storage split, Sources, "Claude installs it"), first-run.md v2, examples, accessibility pass (D41), visual check | All persona journeys green with captured outputs; leak scan; owner's acceptance re-run as the engineer from the audit |

## 23. Open questions for the owner

1. ~~Rename the plugin `crewdeck-bridge` → `crewdeck` now that it carries skills?~~ Done in P4 (0.3.0).
2. Keep Node ≥ 22.18 (D15)?
Questions 3–8 were answered with reversible defaults on 2026-11-19 while the owner was away, so the build could go on;
each can be changed later without a migration the user notices.

3. **v0.4: sources.md shape (D20).** Decided (default): one ordered `sources:` list replacing `boards:`/`watchlist:`.
   Old notes keep working: the two lists are read as an ordered list (boards first, then watchlist) and merged into
   `sources:` on the first save.
4. **v0.4: presets (D39).** Decided (default): the four preset `sources.md` files go; `--preset` stays one release as a
   deprecated alias that runs the matching catalog query and says so.
5. **v0.4: translated facts (D33).** Decided (default): yes, a fact may carry translations the user approved word for
   word (`facts[].tr.<lang>`), proposed by Claude and confirmed like any fact; never written without the user's yes.
6. **v0.4: cooldown defaults by field (D36).** Decided (default): 60 days per company stays the default; setup proposes
   14 days with `scope: role` for healthcare, education, retail, hospitality and logistics, and the user confirms.
7. **v0.4: reach (D40).** Decided (default): "Claude installs it" for this release; a packaged installer and UI
   translations are deferred (roadmap).
8. **v0.4: title matching default (D26).** Decided (default): `words` (with the variants setup proposes from real
   postings); the preview shows how many more `broad` would catch, and the user can switch.

## 24. Jobs for anyone (v0.4)

### 24.1 What changes and why
The owner's run showed that a search built from one person's habits fails everyone else. The phrase title gate kept "Senior
Backend Engineer" and dropped "Software Engineer, Backend". The sources came from four presets, some of which can't
fetch. Nothing said why the result was tiny. The audit ([impl/09-generic-audit.md](impl/09-generic-audit.md)) walks
every step as nine fictional people, from a nurse on nights in Ohio to a store manager in Pune and a freelance translator
in Spain. It found the gaps below. Nothing here changes the safety model (§13, §14). New page writes are page-only
actions (D16), new commands take `--…-file` values (D11), and LinkedIn stays a user-only switch (D13).

Principles:
- **The notes say who the user is.** Code proposes from them: sources from the catalog, title variants from real
  postings, fixes from the funnel. The user confirms every change, and it is written through the validated paths.
- **Show before saving.** Any change to what the search catches can be previewed on real postings first.
- **Say what isn't covered.** An empty result explains itself, and no source is ever invented.

### 24.2 Sources: the catalog, the user's list, the state
**Where things live (D19).** Sources are stored in three places with three owners:

| What | Where | Who writes it |
|---|---|---|
| Everything Crewdeck can fetch: each provider's kind, regions, fields, needs, limits | `src/jobs/data/sources-catalog.yaml` in the repo (read-only, versioned with the provider manifest) | Crewdeck developers, in a reviewed PR when the providers are re-pinned |
| The user's choice: which sources, in which order, their employers and custom URLs, the LinkedIn row's position | Vault note `jobs/sources.md` (readable and editable in Notes) | The user (Sources screen, Notes) and Claude, through `crewdeck jobs sources …` |
| What happened at the last fetches: count, new, kept after the rules, errors, when, how long | `<jobs home>/state/sources.json` (0600) | Crewdeck's fetch run |

The README says this in one paragraph under "Where your knowledge lives".

**The catalog (D18).** One entry per provider (137 runnable plus 8 that can't run in the sandbox, marked
`runnable: false` with the reason), plus Crewdeck's own `linkedin` entry. The fields:

| Field | Meaning |
|---|---|
| `id` | career-ops provider id |
| `name` | human name |
| `kind` | `board`, `aggregator`, `ats` (one employer per entry), `national` (public employment service), `field` (one sector), `employer` (one company's site), `feed` (a generic reader) |
| `needs` | `none`, `careers_url` (one employer or a search URL) or `config` (board-wide, but needs keys) |
| `config` | the option keys that target it |
| `detect` | whether a careers URL auto-routes to it |
| `regions` | gazetteer ids: `world`, regions such as `european-union` or `southeast-asia`, lowercase ISO countries |
| `families` | the taxonomy below |
| `workplace`, `languages` (ISO 639-1), `seniority` (`any`, `entry`, `experienced`) | what it mostly carries |
| `coverage` | one factual line on limits (caps, truncation, required keys, blocking) |
| `note` | for an ATS: who typically uses it |
| `confidence` (`high`, `medium`, `low`) and `unsure` | uncertain classifications are marked, never guessed silently |
| `retired` | upstream fetch always throws (hidden in the UI) |

Role families (one taxonomy everywhere: catalog, `roles.targets[].families`, the Sources screen filters):
- `engineering-it`, `data`, `product-project`, `design`, `creative-media` (writing, content, translation, arts);
- `marketing`, `sales`, `customer-service`, `finance-accounting`, `legal`, `people-hr`, `office-admin`, `operations`;
- `healthcare`, `care-social`, `education`, `science-research`;
- `engineering-physical`, `trades-construction`, `manufacturing-production`, `logistics-transport`;
- `retail`, `hospitality-food`, `public-sector`;
- `any` (a general board or ATS).

Regions: the gazetteer's ids (places.yaml), so the catalog, the user's places and the rules share one containment model
(`gb` ⊂ `europe` ⊂ `emea` ⊂ `world`).

P9a adds **`fill` rules** for `needs: config` entries: how the keys come from the notes at fetch time, never stored in
the note unless the user overrides them. For example:
- `arbeitsagentur.keywords ← targets' titles (first 5)`;
- `builtin.queries ← targets' titles`;
- `occ.queries ← targets' titles`;
- `wttj ← { query: first title, country: from places }`;
- `amazon.loc_query ← places.onsite`.

An entry the user configured by hand keeps their values.

The draft (committed with this design) also records findings the presets ignored:
- `neogov` needs one agency URL per entry;
- `arbeitsagentur` returns nothing without keywords (at most 100 per keyword);
- `jobstreet` reads Indonesia by default and has no Philippines host;
- `remote-com` is one company's openings, not a remote board;
- `themuse` is blocked by Cloudflare.

**`jobs/sources.md` v2 (D20).**
```yaml
---
tags: jobs
# Where to look, in priority order: the first is fetched first and ranks first. Change it on Jobs → Sources.
sources:
  - { key: linkedin, name: LinkedIn, linkedin: search }      # mirrors Jobs → Settings; switching it on happens there
  - { key: remotive, name: Remotive, provider: remotive }
  - { key: example-health, name: Example Health, careers_url: "https://example.wd1.myworkdayjobs.com/External",
      provider: workday, employer: true, added: 2026-11-20 }
  - { key: arbeitsagentur, name: Bundesagentur für Arbeit, provider: arbeitsagentur }   # keywords filled from your titles
  - { key: example-board, name: Example local board, url: "https://jobs.example.org", fetch: none,
      why: "no provider reads this site: paste its postings" }
  - { key: weworkremotely, name: We Work Remotely, provider: weworkremotely, enabled: false }
---
# Job sources
## Changes
- 2026-11-20: added Example Health (resolved to Workday, 34 open roles).
```
- `key`: a unique slug, generated on add and never reused. Roles store it as `source_key`, and state, counts and
  priority hang off it.
- Exactly one of `provider`, `careers_url` (provider resolved, D24) or `url` with `fetch: none`. Provider-specific
  option blocks stay allowed (open object, as today).
- `linkedin: search` marks the mirror row. It may appear once; its `enabled` is **ignored**, and the switch is
  `jobs.features.linkedin_search` in config.yaml (D13, D22). `jobs check` warns when the note says one thing and the
  switch another ("LinkedIn is switched in Jobs → Settings; this note only orders it").
- v1 `boards:` then `watchlist:` are read in that order when `sources:` is absent. The first write by `crewdeck jobs
  sources …` or the Sources screen writes `sources:` and removes the two old keys, with a line under Changes.
- Validation:
  - unknown provider ids, `parser:` entries and non-http(s) URLs are refused (as today);
  - a `runnable: false` provider is refused with the catalog's `why`;
  - a `retired` one gets a warning.

**Priority (D21).**
- **Rank:** `SOURCE_RANK` by kind is replaced by a bonus by position: the first source gets +12, falling linearly to
  0 at the last. Pasted links keep +15 and an unknown `source_key` gets +3. Freshness, title, skills and pay are
  unchanged.
- **Fetch:** entries run in list order (the runner's 4-way concurrency keeps that order for starts). LinkedIn runs at
  its position, before providers when it is first. When a run cap (2,000 requests, 256 MB, 15 min) is hit, the
  later sources are the ones skipped, and their state says so.
- **Descriptions:** the top-50 description fetch follows rank, so priority applies there too.
- **Never:** priority never revives a dropped role and never changes a rule.

**LinkedIn (D22).** The catalog's `linkedin` entry and the note's mirror row put LinkedIn in the user's list like any
source. It covers three switches:
- `linkedin_search`: guest search, the source itself;
- `linkedin_links`: pasted LinkedIn job links;
- `easy_apply`: Easy Apply filling.

All three stay off by default and are changed only by the user (page toggle with the native confirm, or a terminal,
§12). Guest search sends the first three titles of each target (not every variant) × places, within the unchanged
30-request cap.

**State (D19).** `state/sources.json` gains `by_key: { <key>: { at, ok, jobs, new, kept, refused, error, ms } }` and
the last five runs per key. A source not run because of a cap or the Node version says why.

### 24.3 The Sources screen (D23)
A new tab, **Sources**, between Today and Applications.

- **Yours**, in priority order. Each row shows:
  - the name, its kind (board, employer, LinkedIn …) and its regions;
  - an on/off switch (for LinkedIn: the state of `linkedin_search` and a **Switch on…** button that opens the same
    native confirm; links and Easy Apply shown beneath with their states);
  - **Move up** / **Move down** buttons (keyboard-first; drag is optional sugar);
  - the last fetch: "34 roles, 3 new, 12 kept by your rules · 2 h ago", or the error in plain words with a fix ("needs
    keywords: they come from your titles; add a title" / "this careers page isn't readable: paste its postings");
  - **Remove**.
- **Add**:
  - **A company:** the name and its careers page. The server writes the entry, runs `sources resolve` (code, in the
    sandbox) and shows "Workday · 34 open roles" or "not readable" with **Ask Claude to find its jobs page** (a
    `source` request, D24).
  - **A web address:** any careers or job-board URL. It is resolved the same way; when no provider reads it, it is
    added as "watch it yourself" (`fetch: none`) and Today's paste box accepts its postings.
  - **From the catalog:** below.
- **Catalog**, filterable by region (the user's countries first), field (families) and kind, with "Show sources that
  need a careers page" off by default. Each row shows its coverage line and, when `confidence` isn't high, "not
  verified". **Add** appends to Yours.
- **The coverage line** sits at the top (§24.4), recomputed from the user's notes.

Writes: `POST /api/jobs/action/sources` with `{ op: add|remove|move|enable|disable|set_url, … }`. It is page-only
(exact Origin, `Sec-Fetch-Site: same-origin`, JSON), validated by the same function as the CLI, and writes the note
with the Document API (comments and order kept) and a Changes line. It never touches `jobs.features`: the LinkedIn
button calls the existing feature action.

### 24.4 Setup v2: the interview, with "where to look" (D25, D24, D27)
The `jobs-setup` skill's order becomes:
1. **Resume, or no resume** (equal paths, D34).
2. **Who they are.**
3. **Their career.**
4. **What they want, part one.** The targets: what they'd call each kind of job, then Claude proposes titles and
   variants in every language local postings use, plus the families for each. Then where (cities, remote-from,
   relocation, right to work), workplace, work pattern and level.
5. **Where to look.**
   1. `crewdeck jobs sources suggest --json` scores the catalog from the notes:
      - the countries of `places.*`, `identity.country` and `authorized_in`;
      - the targets' families;
      - the workplace (world-remote boards only when remote is wanted);
      - the languages (a posting language the user reads);
      - the level (entry boards for `entry`).
      Board-wide entries (`needs: none|config`) score; ATS entries are only for employers.
   2. It prints the proposal with a reason per source and a **coverage line**. Claude says the line in the user's
      words, and the user confirms the list and its order.
   3. **Employers:** "Which employers, hospitals, schools or chains would you like to work for?" For each, Claude finds
      the careers page (asking the user, or in a background pane tab) and runs `sources add` then `sources resolve`.
      It reports "Example Health: Workday, 34 open roles" or "Example Stores' careers page isn't readable by
      Crewdeck: paste its postings when you see them".
6. **Fetch once and preview.**
   1. `crewdeck jobs source --only-new-sources` fetches (Node 25+; on older Node, Claude says sourcing waits for Node
      25 and previews later).
   2. `crewdeck jobs preview --json` follows. Claude shows the counts, a few passing titles, the near misses and the
      top drop reasons. It proposes variants or place changes, the user confirms, and it previews again, usually once
      or twice.
7. **What they want, part two:** pay, languages, licences, exclusions, daily picks and cooldown (defaults proposed by
   family, D36).
8. **Check:** `crewdeck jobs check` and a closing summary: "Searching 6 sources for 2 kinds of job; on the last
   fetch, 46 postings passed your rules".

**The coverage line** comes from the code (`suggest`'s `coverage`), so it is the same wherever it shows. It has three
parts:
- **covered:** per (country × family), the sources that cover it;
- **not covered:** the families or countries with no board;
- **what still works:** employers' careers pages through a supported system (named from the catalog's ATS kinds common
  there), LinkedIn guest search if the user switches it on (with the risk sentence), and pasted links.

Examples:
- *"For a nurse in Columbus, Ohio: no job board for nursing in the US runs in Crewdeck. Hospitals' careers pages work
  when they use Workday, iCIMS, Taleo, Oracle or UKG; tell me the hospitals and I'll check each. Public health
  departments: GovernmentJobs (one agency each). LinkedIn search is available if you switch it on."*
- *"For retail in Pune: Crewdeck has no Indian job board. Employers on Darwinbox, Keka, SuccessFactors or Workday can
  be watched; LinkedIn search works without a LinkedIn profile if you switch it on; paste any posting you find."*

### 24.5 Title matching for every field (D26)
```yaml
roles:
  targets:                                   # one per kind of job; v1's roles.titles is read as one target
    - name: Backend engineer                 # the user's own words
      titles: [backend engineer, software engineer, platform engineer, site reliability engineer, SRE,
               full stack engineer, tech lead, AI engineer, ML engineer, backend developer]
      families: [engineering-it, data]
      skills: [Python, Go, Kubernetes, LLM]  # optional: ranks this target's roles (beyond career.md skills)
    - name: Buchhaltung
      titles: [Buchhalter, Finanzbuchhalter, Bilanzbuchhalter, accountant, Mitarbeiter Rechnungswesen]
      families: [finance-accounting]
  match: words                               # words (default) | broad | off
  level: experienced                         # entry | experienced | senior | any
  seniority_prefer: [senior, staff, lead]    # unchanged: ordering
  exclude_title_words: [intern, sales]       # unchanged: hard drops
```

**How a posting title is read** (code, `src/jobs/titles.ts`, data `src/jobs/data/title-words.yaml` per language):
1. **Clean it.** Fold case and accents. Strip gender markers (`(m/w/d)`, `(f/m/x)`, `(h/f)`, `(m/f/d)`, `*in`, `:in`,
   `/in`, `/a`, `(a)`) and bracketed or trailing noise ("- Night Shift", "(Remote)", requisition ids). Split into
   words on space, punctuation, `/`, `-`, `&`.
2. **Set seniority words apart** (senior, sr, junior, jr, lead, staff, principal, head of, chief, trainee, intern,
   graduate, entry level, I–IV, 1–3; per-language lists: Werkstudent, Praktikant …). They feed `seniority_prefer`,
   `exclude_title_words` and `level`, never the role match. "Lead" alone ("Tech Lead") stays a role word when nothing
   else is.
3. **Drop stop words** (of, for, the, and, de, der, die, das, für, del, la, le, du …).

**When a target title matches:**
- **Every word** of it appears in the posting's role words, **in any order**. "maths teacher" matches "Teacher of
  Maths", and "backend engineer" matches "Software Engineer, Backend".
- **A word matches** when it is the posting word, or a prefix of it with at most a 3-letter suffix. "nurse" matches
  "nurses" and "Buchhalter" matches "Buchhalterin"; "nurse" doesn't match "nursery".
- **Compound tail:** in languages that compound (de, nl, sv, da, no, fi; posting language or the user's languages),
  a target word of 5 or more letters also matches the tail of a longer word. "buchhalter" matches
  "Finanzbuchhalter".
- **Abbreviations** match only as whole words and only when listed as variants (RN, LPN, SRE, CDL, HGV, QTS, CNA).
- **Domain words:** one-word targets ("teacher") behave as today, word-level.

**Modes:**
- `words` is the default.
- `broad` also keeps titles that share a target's **head word** (its last role word: engineer, nurse, teacher,
  driver, accountant) and ranks them below exact matches. It costs more judging; `preview` shows how much.
- `off` keeps every title (judge only).

**One matcher** serves the gate, rank (which target matched, and how exactly) and LinkedIn's search terms.

**Variants come from real data.** `preview` lists **near misses**: titles that share a head word with a target, or 2
of its 3 words, grouped and counted ("engineer: Full Stack Engineer 34, Senior Engineer 22, SRE 9"). Setup and Find's
funnel offer them as one-click variants. Claude also proposes variants from its knowledge in setup (local language,
abbreviations, gendered forms), and the user confirms each.

The audit's simulation table becomes a test. With each person's targets and variants (defined in the corpus), every
title the audit lists as wrongly dropped passes, and "Nursery Assistant" and "Head of Maths" still drop. The cost is
accepted: "engineer" also passes "Engineering Manager" (a 3-letter suffix), which the judge and `exclude_title_words`
handle.

### 24.6 Search preview, a dry run (D27)
```
crewdeck jobs preview [--search-file <yaml>] [--days 14] [--source <key>] [--json]
POST /api/jobs/preview   { search?: <unsaved changes as in Preferences>, days? }   (page-only, read-only)
```
- **The pool:** every role first seen in the last `days` (default 14, at most 5,000 newest), any status except
  applied. Nothing is written: no status, pay or note changes (a test asserts DB bytes and notes are unchanged).
- **The rules:** compiled from the saved `search.md` overlaid with `--search-file` or the request's changes, the same
  validation as `pref set`. Invalid input → the field errors, no preview.
- **An empty pool** (setup): the CLI says so and suggests `crewdeck jobs source`; the page shows **Fetch now**
  (the existing Refresh sources). There is no hidden fetch.
- **Output:**
  ```
  1,480 postings from 9 sources (last 14 days)
  Pass your rules: 105   (was 1 with your saved notes)
  Dropped, by first reason: title 1,284 · remote for other countries 87 · workplace 3 · pay 1
  Only one thing stops them: title 281 · place 30 · pay 6
  Near misses on title: engineer → Full Stack Engineer (34), Senior Engineer (22), SRE (9), Tech Lead (8) …
  Passing, e.g.: Senior Backend Engineer — Example Co (Remote, India) · …
  Dropped, e.g. (title): Product Designer — Sample Ltd · …   (place): Backend Engineer — Example Inc ("US only")
  By source: Remotive 312 → 21 · We Work Remotely 280 → 9 · LinkedIn 120 → 40 · …
  ```
  **Single-blocker counts** (roles that fail exactly one rule) drive the suggestions: they are what one change would
  bring back.
- **Suggested fixes** (code, each a concrete `pref set` value with its own preview count):
  - add near-miss variants;
  - add a workplace kind;
  - add a place that many single-blocked postings name and the user's places contain or could contain (shown, never
    applied silently);
  - `pay.unlisted: keep`;
  - an fx rate for a currency that blocked postings (`no_rate`);
  - `match: broad`.

  Each is offered, never applied without the user.
- **Where it shows:**
  - setup (§24.4);
  - Preferences: a **Preview** panel beside Save, updating as the user edits, debounced, with "105 pass (now 1)";
  - Find's funnel (§24.7);
  - the Not interested dialog ("this drops 12 roles in your pool").

### 24.7 Find explains a small result (D28)
At the end of a Find, the server stores the run's funnel with it:
- **fetched:** the pool, last 14 days;
- **after rules:** by first reason, from `status_reason` prefixes;
- **judged:** within the budget;
- **passed, picked.**

When `picked < N`, Today shows a **Why so few?** card:
```
Find 5 jobs: 1 picked
1,480 fetched → 13 passed your rules → 13 judged → 1 fits
Most went at your rules: title 1,375 · remote for other countries 92
  [Add 4 title variants: 82 more pass]   [See the preview]
Sources: 2 of your 9 sources returned nothing (needs keywords; careers page not readable)  [Open Sources]
```
- Each button opens the preview with that change applied, and **Save** writes it through the Preferences path, with
  a Changes line "added from Find's suggestions".
- When rules aren't the cause (the judge failed most of them), the card shows the judge's top three reasons, from the
  stored verdicts.
- When the pool itself is small, it shows the coverage line (§24.4).
- The `find` request's close line is built from the stored funnel by `crewdeck jobs candidates` (`run.funnel`), so
  Claude's sentence and the card agree.

### 24.8 What the user wants: search.md additions (D29–D31, D36, D37)
```yaml
work_pattern:
  hours_per_week: { min: 20, max: 32 }       # judge; pay conversion uses max (or pay.hours_per_week)
  shifts: [night, weekend]                   # day | evening | night | weekend | rotating | on-call: what you can work
  shifts_avoid: [rotating]
  term_time_only: true                       # schools: term-time contracts only
employment_types: [part-time, per-diem]      # + freelance, fixed-term, seasonal, apprenticeship
languages: [{ name: German, level: C1 }, { name: English, level: fluent }]   # CEFR A1–C2 or the words
licenses: ["RN", { name: RN, where: Ohio }, { name: Nurse Licensure Compact }, { name: QTS, where: England }]
places:
  onsite: [Columbus]
  remote_from: []
  relocate_to: [Cincinnati, Cleveland]       # on-site/hybrid there passes the rules; the judge is told
  authorized_in: [United States]             # where you may work without sponsorship
needs_sponsorship: false                     # outside authorized_in
pay: { currency: USD, floor: 38, period: hour, hours_per_week: 36, days_per_week: 3,
       per_unit: "", rule: bottom_of_range, unlisted: keep }   # period: year | month | week | day | hour
schedule: { daily_picks: 8, cooldown_days: 14, cooldown_scope: role, per_company: 3 }
exclude: { travel: off }                     # off (was none) | occasional | frequent
```
**Rules:**
- **Structured employment type.** A posting's structured `employment_type` (JSON-LD `employmentType`, a provider's
  field) outside `employment_types` is a hard drop. Words in a title or description stay the judge's.
- **Relocation.** `relocate_to` joins the on-site place set.
- **Pay.** Conversion uses the user's hours and days. `per_unit` is text for the judge ("€0.08/word minimum"); a
  posting that pays per word is kept as `unclear`.
- **Languages.** CEFR maps to the existing levels for comparison (A1–A2 basic, B1 conversational, B2 professional, C1
  fluent, C2 native-like), and the brief prints both.

**Judge brief:**
- shifts and hours ("fail night-only roles" is never inferred: only what the user listed);
- term-time;
- level ("fail when the posting requires clearly more years than `standard_answers.years_experience`, or a senior
  title for `entry`");
- licences with jurisdiction;
- right to work ("fail postings that require the right to work in a country outside `authorized_in` and say they
  can't sponsor");
- postings in any language, with evidence quoted in the posting's words.

**Cooldown.** `cooldown_scope: role` means the cooldown blocks the same title at the same company, not the whole
company. `per_company` lets `pick` and the active-pick drop allow up to n roles per company. Setup proposes 14 days and
`role` scope for healthcare, education, retail, hospitality and logistics, and 60 days and `company` scope otherwise
(owner question 6).

### 24.9 Forms and answers in any language (D32, D33)
**Form terms as data.** `src/jobs/data/form-terms.yaml` holds, per language (en, de, fr, es, pt, it, nl to start, plus
Indian and Philippine English usages):
- profile-field patterns (`first_name: [first name, given name, Vorname, nombre, prénom, …]`, notice period,
  earliest start …);
- **sensitive** terms (salary expectation, CTC, Gehaltsvorstellung, pretensión salarial; date of birth, Geburtsdatum;
  nationality, Staatsangehörigkeit; marital status, Familienstand; religion; caste/category; father's/mother's
  name; height, weight; photo; Anrede/salutation; gender; EEO);
- **`never_fill`** terms (government ID numbers: SSN, NI number, Aadhaar, PAN, Steuer-ID,
  Sozialversicherungsnummer, DNI/NIE, passport number; bank account, IBAN, routing number; tax numbers).

`fields.ts` builds its patterns from the file.

**Classes:**
- `never_fill` → fill-plan `skip`, reason "you type this yourself". It is never drafted or remembered, and a standard
  answer under such a key is refused by `jobs check` (with a warning to remove it from the note).
- `sensitive` → filled only from the user's explicit answer. A remembered sensitive answer is reused **only for the
  same company** unless the user says "use this everywhere" (salary expectations differ per role and country).
- Claude may mark a field sensitive in the draft (`"sensitive": true`); code takes the stricter of its own class and
  Claude's.

**Answer language.** The brief states the form's language: the page's `lang`, else detected from the labels by
Claude. Claude answers in that language. Claims still cite fact ids. The citation check compares numbers by value (as
today) and names against the cited fact or its approved translation.

**Translated facts** (owner question 5): `facts[].tr: { de: "…" }`, proposed by Claude, approved word for word by the
user like any fact, and written with `me set`. The resume renders `resume.language` (default: the facts' language)
using `tr` where present; a fact without that translation is shown in its original language, and the render warns.

**Resume conventions:**
- `resume.language`;
- `resume.headings` (defaults per language: Berufserfahrung, Ausbildung, Kenntnisse …);
- `resume.personal: [date_of_birth, nationality, languages]` (opt-in; values from `standard_answers`);
- `resume.word: CV | resume` for the UI copy;
- `max_pages` defaults proposed per country (US 1, UK 2, DE 2, IN 2).

A photo is **deferred**: it needs a file in the vault, an upload path and a privacy decision.

### 24.10 People without a resume, at the start, switching or returning; apply methods (D34, D35)
**Interview paths (skill):**
- **No resume:** the interview asks for roles held (including informal work, family business, gig driving), the
  duties in the user's words, shifts, licences and equipment (forklift, CDL class), and builds sections and facts from
  the answers, confirmed the same way.
- **Entry level:** list sections for projects, internships (as experience), coursework, volunteering and student
  societies. `roles.level: entry`. Seniority exclusions are proposed (senior, lead, manager, "5+ years" is judged).
- **Career switcher:** a target for the new field with its own skills (course projects, portfolio pieces as list
  facts). Transferable facts are tagged. The old field may stay as a second target if they want.
- **Career break:** an experience entry `{ kind: experience, title: Career break, break: true, dates: "2022 – 2025" }`
  (no org). An optional fact in the user's words, cited only when they choose. A standard answer for "explain your
  gap" if they want one.

**Prepare:**
- the resume is skipped when the form has no resume upload and career.md has no experience facts;
- Claude records the **apply method** on the role (`form | email | document | walk_in | chatbot | account_needed`):
  - for `document` and `email`, answers are drafted and shown to copy, and email stays the draft-only switch;
  - for `walk_in`, the page shows where and when from the posting;
  - for `chatbot`, the answers are shown to copy;
  - for `account_needed`, the panel shows "This site needs an account. Create it in the form tab (Claude never creates
    accounts), sign in, then click Continue".

**Fill-plan:**
- a capped `add` action (at most 10 per page) for "Add another <employment/education/reference>" buttons;
- entries filled from experience sections with `start`/`end` (YYYY-MM, optional, proposed from `dates`), profile
  education, and `profile.references: [{ name, role, org, email, phone, relationship }]`;
- the user is told these are other people's details and to ask them first;
- references fill reference questions only and are never drafted.

**`crewdeck jobs letter <role> --text-file … --claims-file …`** renders a cover letter or supporting statement PDF
(same template engine, JS off). It goes through the citation check like an answer and is offered for upload fields
labelled cover letter, Anschreiben or supporting statement.

### 24.11 Presets revisited (D39)
The four presets are retired as files. Their `sources.md` lists are wrong in places (§24.2), and their `search.md`
defaults belong to setup.
- `--preset <name>` stays for one release as an alias. It seeds `search.md` defaults (workplace, employment types,
  pay period) and runs `sources suggest` for the notes, writing its proposal as the initial `sources:` list.
  - `remote-any-country` = `workplace: [remote]`;
  - `onsite-city` = `[onsite, hybrid]`;
  - `healthcare-us` = `families: [healthcare]`, country `us`, hourly;
  - `non-engineering` = no family filter beyond `any`.
- `crewdeck setup` prints "presets are being replaced: setup with Claude proposes sources from your profile".

### 24.12 Test plan
**Personas.** Fictional only (example.com, phone numbers with 1234567). Each is a full vault, a fixture pool of about
200 postings, fixture providers through the real sandboxed runner, and local HTML postings and forms on the test
server:

| Fixture | Person | Journey asserts |
|---|---|---|
| `in-backend-remote` | E: engineer, India, remote | Preview before/after variants (the owner's 1,480 case in miniature: titles from the audit); "US only" drops stay; LinkedIn first in priority changes candidate order, not drops; INR conversion of a USD range with fx |
| `us-nurse-nights` | N: RN, Columbus, nights, hourly | `suggest` coverage line names "no nursing board"; employer resolve (a Workday-shaped fixture); "RN - Night Shift" passes; a day-only posting judged no (scripted judge reads `work_pattern`); hourly floor with 36 h; `cooldown_scope: role` lets two units at one hospital through |
| `de-accountant` | A: Berlin, hybrid, German C1 | Compound and gendered titles; arbeitsagentur `fill` keywords from targets; German form (Anrede, Geburtsdatum → sensitive; Steuer-ID → never_fill; Gehaltsvorstellung → sensitive, per company); answers drafted in German citing English facts via `tr`; resume in German headings |
| `in-retail-pune` | R: store manager, no LinkedIn, monthly INR | Coverage line "no Indian job board"; a Darwinbox-shaped employer resolved; "3-4 LPA" vs a monthly floor; Indian form (Aadhaar, PAN → never_fill; Father's name, marital status → sensitive); walk-in apply method shown |
| `ph-graduate` | G: Manila, entry level | `level: entry`: "Senior Marketing Manager" dropped by seniority, "Marketing Associate (Fresh Grad)" passes; facts from projects and internships; resume without experience section renders; PHP monthly |
| `us-warehouse-noresume` | W: Texas, part-time, no resume | Interview-built facts via commands; structured `PART_TIME` passes, `FULL_TIME` drops when excluded; availability grid answered from `work_pattern`; Prepare skips the resume (no upload); "Add another employment" capped `add` |
| `es-translator` | F: Spain, remote, day rate | `pay.period: day` floor vs a monthly posting; a per-word posting kept as unclear; "Traductor/a" passes with a Spanish variant; EU-only passes for Spain |

The existing `example`, `berlin-analyst` and `us-nurse` fixtures keep passing unchanged (v1 notes are read).

**Unit tests:**
- the title corpus (P9c);
- catalog ↔ manifest sync, taxonomy and region ids;
- `sources.md` v1 → v2 merge;
- priority rank;
- preview read-only;
- funnel arithmetic;
- form-terms classes per language;
- never-fill can't be stored;
- pay periods and hours;
- CEFR mapping.

**UI tests:**
- the Sources screen (keyboard reorder, LinkedIn row opens the confirm, add company → resolve states);
- Preferences preview;
- the Why so few? card;
- accessibility checks: no text under 14 px computed, labels and roles present.

**Owner acceptance:** re-run as the engineer from the audit, from zero. Setup proposes sources with LinkedIn
placeable first, the preview shows the near misses, and Find returns N or explains why not.

### 24.13 Reach, accessibility, deferrals (D40–D42)
**Reach:**
- The README opens with who Crewdeck is for today: a desktop computer (macOS or Linux), Claude desktop, about 30
  minutes with Claude. It adds a **"Let Claude install it"** block: the user pastes one prompt into a Claude Code
  session, and Claude runs `git clone`, Node install guidance, `npm ci` and `crewdeck setup`, asking before each step.
- first-run.md v2 starts there.
- The UI stays English; its strings are gathered in `web/jobs/strings.js` for later translations. Claude talks in the
  user's language.

**Accessibility:** D41 applies to every Jobs screen, checked in P9e and P9i.

**Honesty:** D42 applies wherever the catalog has nothing.

**Deferred, with reasons:**
- a packaged installer (a separate project);
- a mobile client (the pane-based apply needs a desktop);
- UI translations (none we can check);
- a resume photo (privacy and upload path);
- new providers for uncovered markets such as Naukri, Indeed, Apna, JobStreet PH or NHS Jobs. They belong upstream in
  career-ops; any provider is added only through the reviewed re-pin (§15), after checking the site's terms.

## Changelog
- **P9e built (2026-11-20):** the Sources screen (Yours with Move up/down, on/off, remove and each source's last fetch;
  Add a company and Add a web address checked in the sandbox with Claude's help when unreadable; the catalog with region,
  field and kind filters and suggestions; LinkedIn's row through the native confirm; the coverage line; where it lives),
  `GET /api/jobs/sources` and the `resolveSource` page action; Find's card opens it. Preferences Save keeps hand-written
  keys and comments on targets; Not interested previews its drop count. Details:
  [impl/09e-sources-screen.md](impl/09e-sources-screen.md).
- **P9d built (2026-11-20):** the search preview (`crewdeck jobs preview`, `POST /api/jobs/preview`; read-only, single
  blockers, near-miss clusters, fixes with exact counts) and Find's funnel stored with the run (`run.funnel`, Today's
  **Why so few?** card, Preferences' Preview panel and targets editor, the daily-run close line). The owner's case as a
  fictional fixture: 1 → 202 passing after the suggested variants, every place drop kept. Details:
  [impl/09d-preview-and-funnel.md](impl/09d-preview-and-funnel.md).
- **P9c built (2026-11-20):** title matching for every field: `src/jobs/titles.ts` and `data/title-words.yaml` (seven
  languages), `roles.targets[].skills`, `roles.match` (default `words`), `roles.level`; one matcher for the gate, the
  `level` rule, rank and LinkedIn's terms; title drops name the closest target word. A 445-title corpus for the nine
  audit people; v1 `roles.titles` never pass fewer than the old phrase gate. Details:
  [impl/09c-title-matching.md](impl/09c-title-matching.md).
- **P9b built (2026-11-20):** employers: `crewdeck jobs sources resolve <key>` (detectors in the sandbox, a one-page test
  fetch ≤ 30 s, the answer written to the note at once: the provider, or `fetch: none` with the reason), `sources
  set-url` (plain or `--request`), the `source` request kind with the page action `findJobsPage` and the workspace
  skill's `source` section, and the page-only `sources` action sharing the CLI's validated writer. Details:
  [impl/09b-employers.md](impl/09b-employers.md).
- **P9a built (2026-11-20):** the source catalog settled against the pinned providers' code (65 high / 77 medium / 3 low;
  `detect` follows the code; `fill` rules; `blocked`), `jobs/sources.md` v2 (ordered `sources:` with keys, LinkedIn
  mirror, v1 read and merged on first write), `crewdeck jobs sources list|suggest|add|remove|move|enable|disable`, DB v2
  (`source_key`, `language`, `visa_text`, `employment_type`), fetch in priority order with LinkedIn at its position,
  per-source state, `--only-new-sources`, the position bonus in rank, presets as catalog queries. Details:
  [impl/09a-catalog-and-sources.md](impl/09a-catalog-and-sources.md).
- **v0.4 (2026-11-19), designed:** Jobs for anyone, from the owner's first run as a new user (1 role from 1,480 postings:
  the title phrase gate dropped 1,375) and an audit of every step as nine fictional people
  ([impl/09-generic-audit.md](impl/09-generic-audit.md)). Added:
  - the source catalog `src/jobs/data/sources-catalog.yaml` (145 entries, draft);
  - the storage split for sources, `sources.md` v2 with priority, LinkedIn as a listed source, a Sources screen;
  - employers resolved to providers;
  - "where to look" in setup with an honest coverage line;
  - word-level title matching over targets and variants;
  - a search preview and Find's funnel;
  - work pattern, pay periods and hours, level, CEFR, relocation and right to work;
  - forms and answers in any language with never-fill IDs, apply methods beyond one form, cooldown scope;
  - presets as catalog queries, reach and accessibility.

  Decisions D18–D42, §24, phases P9a–P9i, owner questions 3–8.
- **Onboarding (2026-11-19):** from the owner's first run as a new user: `crewdeck setup` does init, jobs init and the
  plugin install in one command; the jobs workspace defaults to a visible `~/Crewdeck/jobs` next to the vault (the jobs
  home stays private; its `out/` is an additional directory of the workspace); `--help` never runs a command.
- **P8 (2026-11-19):** docs for a brand-new user ([impl/08-docs-visual.md](impl/08-docs-visual.md)): README rewritten
  (features, requirements with Node 25 for sourcing, quick start, plugin install from a local checkout or GitHub and
  removing `crewdeck-bridge`, where knowledge lives, presets, daily use, preferences, sources, custom rules, risky
  switches, appearance, safety and terms of service, security and residual risks, troubleshooting),
  [first-run.md](first-run.md), top-level `docs/design.md` as the architecture overview, `CHANGELOG.md`,
  `docs/roadmap.md`, the example's README; the repo validated as a plugin marketplace (`claude plugin validate`, an
  install into a throwaway Claude config). Visual check in the real shell and the browser pane, light and dark: the Jobs
  top bar no longer wraps Find onto a row of its own when Claude's status or the sources line is long (a browser layout
  test), and the "your turn" panel no longer repeats the skill's stock sentence. Screenshots refreshed; a fresh clone
  passes on Node 25 and 22.18. Package version 0.3.0.
- **P7 pass B (2026-11-19):** the pipeline and sources from the security review ([impl/07-security-review.md](impl/07-security-review.md)):
  the provider sandbox has no network (Node ≥ 25 required for sourcing; older Node refuses with the reason), its fetches
  made by the parent through netguard over fd 3, protocol lines with a per-run nonce on fd 3, `getBuiltinModule` frozen
  behind the denylist and no WebAssembly compiler; linear HTML scans with a 400 KB cap; more netguard ranges; file flags
  only inside Jobs' home or workspace; no `--force` flags (force only from a link request, `pick --role --request`
  reads it) and restricted status moves; a value-based citation check (locale decimals, attached units, number words,
  own-sources-only sentences); pay differentials skipped, description pay never drops, period-less pay read as a year
  and a month; travel percentages next to "travel" only; industry drops on company or title only; trailing-dot hosts;
  a locked, mtime-checked jobs/memory.md; leak scan (bodies, UTF-16, blobs, NANP, new branches); CI with Node 25, the
  scan as its own keyed step, actions pinned by SHA.
- **P7 pass A (2026-11-19):** the trust boundary from the security review ([impl/07-security-review.md](impl/07-security-review.md)):
  SilverBullet on a private Unix socket with its shell off, random internal board ports, challenge-first agent
  handshake with a port-bound proof and a token rotated on every `up`, lane checks on request-scoped agent calls, the
  jobs workspace's Bash in Claude Code's sandbox with only the `crewdeck` wrapper let out, native confirmation (or a
  page-issued terminal code) for risky switches, leases/heartbeat presence/Cancel, per-kind caps, switches re-read
  from config.yaml, Write tool instead of heredocs, `pick --role --request` in the skill (pass B reads force).
- **P6 built (2026-11-19):** journey tests for the two fictional people (`test/jobs/e2e/`): setup through validated commands,
  the real provider install and sandbox from a local site, budgeted Find with a scripted judge, paste a link through the
  lane and the token, Prepare (form read, draft, citation failure → first-time → remembered and reused), Apply with a
  test-only driver (the plan exactly, submit never touched, needs you → apply again → applied), preference change +
  refilter, Not interested, risky switches, a broken note; ≈ 15 s for both. Fixed from them: a preset now applies after
  `crewdeck init` (untouched template notes), a Yes/No "needs you" answer is remembered for every company, the last-valid
  time says UTC. Details and captured outputs: [impl/06-e2e.md](impl/06-e2e.md).
- **P5 built (2026-11-19):** pinned providers (`scripts/update-providers-manifest.mjs <checkout> <commit>` → a manifest of
  the import closure at career-ops-hq/career-ops@f3b043d: 137 providers, 166 files, js-yaml users and local-parser
  excluded), install through netguard with per-file sha256 into `providers/<commit>/` (read-only, LICENSE),
  `jobs providers install|status|verify`, the sandboxed runner (`--permission`, read grants for the providers and itself,
  empty env, `registerHooks` resolve/load with hashes, no processes/workers/writes), `jobs source` (validation, LinkedIn
  when on, prefilter, descriptions for the top 50), the server's `fetch_every` timer and Refresh sources, code ranking
  with company-rule drops, `candidates --budget` Find runs, the budgeted `jobs-daily-run`. Details and deviations:
  [impl/05-sources.md](impl/05-sources.md) (`--no-providers`, ats/board labels, `maxPages` 10, the onsite-city preset).
- **P4 built (2026-11-19):** `crewdeck jobs init [--preset] [--home]` (Jobs on, private jobs.home + tracker, missing notes
  only, preset search/sources, managed workspace `CLAUDE.md` + `.claude/settings.json` deny rules, browser check, the P5
  providers hook), `doctor` Jobs section, four presets, the skills `jobs-workspace`, `jobs-setup`, `jobs-daily-run`,
  `crewdeck-memory` (every command line linted against the CLI), the plugin renamed `crewdeck` 0.3.0. Details and
  deviations: [impl/04-setup-and-skills.md](impl/04-setup-and-skills.md) (Edit rules cover writes, WebFetch denied, flow
  lists, sources.md edited by hand).
- **P3 built (2026-11-19):** typed requests on one queue (kind/ref/payload/progress, dedupe, payloads cleared on close,
  presence, reconcile, jobs lane before projects, the Ask box can't reach it), the Jobs API in the shell server (lazy;
  page-only actions incl. feature switches, token-only `request show`/progress, SSE from data_version + fs.watch + queue,
  resume route, Show in Finder, busy → 503), request-scoped CLI (`link|answer|fill-plan --request`), the Jobs page in Preact +
  htm (Today, the §2.3a apply panel in every state, Applications, What Claude knows, Preferences, Settings, setup card,
  banners), Jobs in the rail, the bridge's per-lane hint with payload keys only. Details and deviations:
  [impl/03-server-ui-bridge.md](impl/03-server-ui-bridge.md) ("Open the form" opens a new tab; Ask stays cockpit).
- **P2b built (2026-11-19):** netguard (DNS checked inside the connect, every address, mapped/compatible IPv6, 5
  re-checked redirects, one 15 s deadline, 2 MB decoded cap, no env proxies), an in-process guard proxy for headless
  Chromium (loopback through the proxy, no QUIC/UDP around it), browser discovery + `doctor`, `jobs link` (JSON-LD/meta,
  closed postings, pickPasted warnings), LinkedIn guest pages (gated, paced, capped, stop at 429/999/3xx), headless form
  reading, data-driven resume PDF (JS and network off, max_pages). Details and deviations:
  [impl/02b-web.md](impl/02b-web.md) (test-only `testHosts` never reachable from the CLI, LinkedIn/copy-only forms
  return `needs`, English section headings).
- **P2a built (2026-11-19):** tracker DB v1 + migrations (WAL, busy timeouts, 0600), knowledge base (answers in the DB,
  memory in the note, citation check with a generic terms list), drafting brief with profile answers approved as
  `profile:` sources, fill plan (copy-only hosts, Easy Apply cap per local day, never submit), prefilter/refilter, judge,
  pick, applied (cooldown, journal), not interested, add-role, outreach gates, view models. Details and deviations:
  [impl/02a-core.md](impl/02a-core.md) (URLs only from files, contact fields never drafted, dates in `pay.locale`).
- **P1 built (2026-11-19):** notes read/write with last-valid fallback, schema v1 validators, gazetteer, pay, compiled
  rules + judge brief, `crewdeck jobs check|rules|judge-brief|me|pref|remember|features`, `jobs` config section. Details
  and deviations: [impl/01-notes-and-rules.md](impl/01-notes-and-rules.md) (commute distance for on-site cities,
  `exclude.travel` = lowest level that drops, `temporary` employment type, avoid `title_words` in memory).
- **v0.3 (2026-11-19):** from the first real run (one application filled outside Crewdeck, then stopped):
  - §2.3a, exactly what Apply does on LinkedIn Easy Apply and company sites, and what the user sees in Crewdeck;
  - Prepare reads non-headless forms live, so every question is known before Apply;
  - profile answers are stored as answers;
  - §2.4 token budget: scheduled fetching, cheap ranking, early-stop judging, a light model for triage.

  Observed:
  - boards gave 870 new roles but only 2 weak fits, because most arrived with no description;
  - LinkedIn guest search was rate-limited (HTTP 429);
  - Notion forms can't be read headlessly;
  - the bridge plugin was missing in the Claude account in use, so Crewdeck clicks reached nobody.
- **v0.2.1 (2026-11-18):** P0 implementer doc written; explicit file modes instead of a global umask; deps move to the phases that use them; bridge proof is SHA-256 over token and nonce (the mod runtime has no HMAC).
- **v0.2 (2026-11-18):**
  - Owner direction: designed for every user as a new user, including its builder; user knowledge in the vault
    as notes; full journeys (§2); learning loop (§8); old-data import out of scope.
  - From the architecture review: a full provider import closure; a generic schema v1; lock-wait mitigations; a
    richer profile (languages, employment types, pay period, gazetteer containment, licences, sponsorship); a
    healthcare preset; resume list kind and paper size; `fs.watch`; presence; `needs you` closing; stranger setup
    gaps.
  - From the security review: token + page/agent split; SilverBullet on its own origin; sandboxed providers;
    netguard detail and a guard proxy for Chromium; user-only switches; deny rules; honest enforcement labels;
    `--result-file`; HMAC leak scan over history; umask; queue caps; data flow.
  - Dead code removal approved.
- **v0.1 (2026-11-18):** first draft from the inventory of both codebases.
