# Crewdeck Jobs: design

Status: **draft v0.2 for owner review** (2026-11-18). Nothing in this doc is built yet.
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
as career-ops entries. Validation refuses `parser:` entries and unknown providers.

### 7.7 Presets
`jobs init --preset <name>` seeds `search.md` and `sources.md`. Identity and career always come from the user.

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
  `us-nurse` (remote within licensed states, hourly USD, per-diem). Each is a full vault (`me/`, `jobs/`).
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
| P8 | `08-docs-visual.md` | README (setup, safety, terms of service), `docs/design.md`, CHANGELOG, roadmap, screenshots | Owner sign-off; PR opened, no push without asking |

## 23. Open questions for the owner

1. ~~Rename the plugin `crewdeck-bridge` → `crewdeck` now that it carries skills?~~ Done in P4 (0.3.0).
2. Keep Node ≥ 22.18 (D15)?

## Changelog
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
