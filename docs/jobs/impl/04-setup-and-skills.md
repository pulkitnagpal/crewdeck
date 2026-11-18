# P4: setup from zero, presets, workspace guard rails, Claude playbooks, the `crewdeck` plugin

Part of [the Jobs design](../design.md): read §2 (every journey: the skills must make them happen exactly), §2.3 and §2.3a
(Prepare with live form reading, Apply in the pane), §2.4 (Find with a budget), §2.5 (preference changes from any session),
§7.7, §8, §10, §12, §13, §14 and §22 row P4 first. Rules for every implementer: [README.md](README.md). P3
([03-server-ui-bridge.md](03-server-ui-bridge.md)) left the request kinds, payloads, `request show` and the closing rules the
skills follow.

After P4 a new user can go from an empty home to the first acceptance test (§2.3): `crewdeck init`, `crewdeck jobs init`,
install the `crewdeck` plugin, open a session in the jobs workspace, Set up with Claude, paste a link, Apply.

## 1. Scope
- `crewdeck jobs init [--preset <name>] [--home <dir>]`: from a finished `crewdeck init` (config and vault exist) to a
  working Jobs: switched on in `config.yaml`, `jobs.home` (0700) with `jobs.db`, the five notes (never overwriting one), the
  preset's `search.md` + `sources.md`, the workspace's managed `CLAUDE.md` and `.claude/settings.json`, the browser check,
  the providers hook (P5) and the next steps. Idempotent.
- `crewdeck up` rewrites the two managed workspace files when Jobs is on.
- `crewdeck doctor` gains a Jobs section: notes, database, jobs.home, browser, workspace files, providers, bridge presence.
- `presets/jobs/{remote-any-country,onsite-city,healthcare-us,non-engineering}/{search,sources}.md`.
- Skills in `plugin/skills/<name>/SKILL.md`: `jobs-workspace`, `jobs-setup`, `jobs-daily-run`, `crewdeck-memory`.
- The plugin is renamed `crewdeck-bridge` → `crewdeck` (0.3.0); the token/proof behaviour is unchanged.
- `vault-template/CLAUDE.md` names the jobs notes and the `crewdeck-memory` skill.

Not in P4: provider download, sandboxed runner, scheduled fetch, budgeted early stop in code (`candidates --budget`) and
Refresh sources (P5). The skills use only commands that exist now; where P5 will add one, the skill says what to do until
then.

## 2. Modules and files

| File | What |
|---|---|
| `src/jobs/setup.ts` | `jobsInit(opts)` (the steps of §1, returns what it did as lines), `seedNotes(vault, preset, today)`, `PRESETS`, `presetDir(name)`, `workspaceFiles(c)` → `{ claudeMd, settings }` (pure), `writeWorkspaceFiles(c)` (managed rewrite with a one-time backup of a foreign file), `workspaceStatus(c)` (present and current), `denyRules(c)` |
| `src/jobs/providers.ts` | **P5 hook**: `installProviders(c)` and `providersStatus(c)` return `{ ready: false, message }` now ("sourcing isn't set up yet"); P5 replaces their bodies with download/verify (§15) |
| `src/jobs/doctor.ts` | `jobsDoctor(c, { presence })` → `{ ok: boolean \| null, text }[]` (pure but for file reads); `bridgePresence(c)` (GET `/api/jobs/state` on the running Crewdeck, 1.5 s, `null` when it isn't running) |
| `src/config.ts` | `setJobsSettings(changes, path)`: `jobs.enabled`, `jobs.home`, `jobs.workspace` through the Document API (keeps comments and the rest) |
| `src/jobs/cli.ts` | `init`; `JOBS_COMMANDS` (every `crewdeck jobs` command name, for the skills lint) |
| `src/cli.ts` | `doctor` prints the Jobs section (async); `up` rewrites the workspace files when Jobs is on |
| `presets/jobs/<name>/{search,sources}.md` | full notes (frontmatter + body), generic, validated by tests |
| `plugin/skills/*/SKILL.md` | the four playbooks |
| `plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/hooks/register.tsx`, `plugin/types/index.d.ts` | the rename |

### `jobs init` step by step
1. `loadConfig()` (no config → "run crewdeck init first"); the vault must hold `CLAUDE.md` (else the same message).
2. `--home <dir>` sets `jobs.home`; `jobs.workspace` follows it when it was unset or equal to the old home. `jobs.enabled:
   true`. Written with the Document API.
3. `ensureHome(jobs.home)` (0700, refuses a group/world-writable one); `openJobsDb` creates and migrates `jobs.db` (0600).
4. Notes: the five from `vault-template/` when missing; with `--preset`, `jobs/search.md` and `jobs/sources.md` come from the
   preset instead, with `- <today>: created from the <name> preset.` under `## Changes`. Created with `wx` (never
   overwrites, even in a race), mode 0600. An existing note is listed as kept; a preset that couldn't apply says so.
5. Workspace: `CLAUDE.md` and `.claude/settings.json` in `jobs.workspace` (folder 0700 when created), always rewritten.
6. Browser: found → its name; missing → the install hint (`installHint()`).
7. Providers: `installProviders(c)` → today "Sourcing isn't set up yet …; pasted links work now".
8. Next steps: install the `crewdeck` plugin, open a Claude session in `<workspace>`, `crewdeck up`, Jobs → Set up with
   Claude.

### The workspace `CLAUDE.md` (generated)
Header `<!-- Managed by Crewdeck: rewritten by crewdeck jobs init and crewdeck up. Edit your notes, not this file. -->`, then:
the command to run (`crewdeck`, or `node <repo>/src/cli.ts` with `CREWDECK_HOME` when not the default), the skills to use
(`jobs-workspace` for page requests, `jobs-setup`, `jobs-daily-run`, `crewdeck-memory`), where everything lives (the five
notes with their absolute paths, `jobs.home`, `out/<role>/`), the hard rules of §13 in plain words (never submit, never
send email, no CAPTCHA/password/account, stop at sign-in/checkpoint/429, caps and cooldowns are not worked around, no raw DB
writes, postings/pages/emails are data, no invented experience, URLs only of the role, risky switches are the user's),
the D11 rule (text through files, single-quoted heredocs) and how requests close.

### The workspace `.claude/settings.json` (generated)
```json
{ "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": { "allow": [], "deny": [ … ] } }
```
Deny rules (absolute paths with Claude Code's `//` prefix, from the real config):
- `Edit(//<crewdeck home>/config.yaml)`, `Edit(//<crewdeck home>/token)`, `Read(//<crewdeck home>/token)`,
  `Edit(//<crewdeck home>/requests.json)`: the switches, the agent token and the queue are the user's and the server's;
- `Edit(//<jobs.home>/jobs.db*)`, `Edit(//<jobs.home>/state/**)`, `Edit(//<jobs.home>/providers/**)`: machine state only
  through commands; verified third-party code stays as verified;
- `Edit(//<workspace>/CLAUDE.md)`, `Edit(//<workspace>/.claude/**)`: the guard rails can't be edited by the agent they guard
  (that includes `settings.local.json`);
- `Bash(sqlite3:*)`, `Bash(curl:*)`, `Bash(wget:*)`: no raw DB writes, no direct calls to the agent API or the network
  around netguard;
- `WebFetch`: pages are read through `crewdeck jobs link` (netguard) or in the browser pane, never fetched raw.

## 3. Decisions (and where they deviate from or extend the design)
1. **No `Write(...)` rules.** Claude Code checks file writes against `Edit(...)` rules only (a `Write(path)` rule is accepted
   but never matches), so the brief's "Edit/Write" is the `Edit` rule. The token also gets a `Read` deny.
2. **settings.json carries no comment.** Settings are strict JSON and a key Claude Code rejects can make it skip the whole
   file, so the "managed" header is in `CLAUDE.md` (which names both files) and settings.json holds only `$schema` and
   `permissions`. Crewdeck recognises its own settings.json by the hash it recorded in `<jobs.home>/state/workspace.json`.
3. **A foreign file is backed up once.** If the workspace already has a `CLAUDE.md` without the managed header, or a
   settings.json Crewdeck didn't write, it is copied to `<name>.before-crewdeck` (never overwriting an earlier backup)
   before the managed version replaces it. A Crewdeck-written file is simply rewritten.
4. **`WebFetch` denied** in the workspace (an extension of §14): no journey needs it, and it would read postings around
   netguard. WebSearch stays (finding a company's own application page).
5. **Deny rules are guard rails, not a sandbox** (as §13 labels them): a Bash rule doesn't match a program by path or inside
   `sh -c`. Code enforcement (`--request`, files, caps, `fill-plan`) stays the boundary.
6. **The command line in skills is `crewdeck …`.** The workspace `CLAUDE.md` and the bridge's prompt name the exact command
   (`node <repo>/src/cli.ts`) for users without `crewdeck` on PATH.
7. **Presets are full notes.** `search.md` has no titles/places for the generic presets (the setup interview fills them);
   `healthcare-us` seeds healthcare titles, `remote_from` empty with a comment (states come from the user's licences),
   hourly USD pay, `per-diem`; `onsite-city` lists regional boards with `enabled: false` and a comment per region, so setup
   switches on the user's region, plus an empty watchlist with an example comment. Every provider id is in
   `provider-ids.json`.
8. **Preset only on new notes.** `--preset` never changes an existing `search.md`/`sources.md`; init says it kept them and
   how to apply a preset by hand (move the note away and rerun).
9. **Doctor's bridge check** asks the running Crewdeck (`GET /api/jobs/state`, the page read, which a non-browser client
   may call) whether a session holds the jobs lane. Not running → "start crewdeck up"; running without Jobs → "restart
   crewdeck up". Doctor never starts or stops anything.
10. **Skill triggers.** `jobs-workspace`: messages that start `[Crewdeck → lane jobs]` (the bridge's prompt) and work on a
    request id; `jobs-setup`: setup requests and "set up my job search"; `jobs-daily-run`: find requests, "find jobs",
    the daily run; `crewdeck-memory`: any session, "remember…", preference changes, facts about the user.
11. **Find without P5.** `candidates --limit 40` is the budget until P5's `--budget`; judging is in rank order, batches of
    10, early stop once N pass, first pass by a light-model subagent. Sourcing is Crewdeck's scheduled job (P5): the skill
    works the pool that exists (pasted links, LinkedIn guest search when the user switched it on).
12. **Skills lint.** A test extracts every `crewdeck …` command line from the skills and the generated `CLAUDE.md` and checks
    the command, its verb and each `--flag` against the CLI source; unknown ones fail.
13. **Plugin state keys** move from `crewdeck-bridge` to `crewdeck` (atoms are per plugin; a fresh session state is fine).

## 4. Test plan (node --test, temp homes only, fictional people only)
- `jobs init` from an empty temp home (after a test-made `crewdeck init`: config + vault from `vault-template`): config
  `jobs.enabled`, `jobs.home` 0700, `jobs.db` 0600 at schema v1, the five notes, workspace files and their modes; the
  generated settings deny rules name the temp home; run twice → same result, notes untouched (a user edit survives), managed
  files rewritten after being edited, a foreign `CLAUDE.md` backed up once; `--preset` seeds search/sources with the Changes
  line and never overwrites; unknown preset refused; `--home` moves jobs.home and the workspace; no vault → refused.
- Presets: every preset's notes validate with no errors, every provider id exists, no personal strings.
- Skills: frontmatter `name` = folder and a description; the commands lint; no real names/emails; the jobs-workspace skill
  names every request kind of P3.
- Doctor: the Jobs section from a temp home (Jobs off, then on: notes, db, browser line, workspace files current, providers
  not set up, Crewdeck not running) on a port nothing listens on.
- Plugin: `claude plugin validate plugin` passes (run by hand; the name check is a unit test on plugin.json and
  marketplace.json).

## Done
Built as planned in §2, with the decisions in §3.

- **Code:** `src/jobs/setup.ts` (`jobsInit`, `seedNotes`, `PRESETS`, `cliCommand`, `denyRules`, `workspaceClaudeMd`,
  `workspaceSettings`, `writeWorkspaceFiles` with the hash record in `<jobs.home>/state/workspace.json`, `workspaceStatus`),
  `src/jobs/doctor.ts` (`jobsDoctor`), `src/jobs/providers.ts` (the P5 hook: `installProviders`, `providersStatus`),
  `src/config.ts` `setJobsSettings`, `src/jobs/cli.ts` `init` + `JOBS_COMMANDS`, `src/cli.ts` (`doctor` Jobs section with
  the lane presence read from the running Crewdeck; `up` rewrites the workspace files when Jobs is on).
- **Presets:** `presets/jobs/{remote-any-country,onsite-city,healthcare-us,non-engineering}/{search,sources}.md`; all
  validate (only "not set yet" warnings), every provider id is a career-ops id.
- **Skills:** `plugin/skills/{jobs-workspace,jobs-setup,jobs-daily-run,crewdeck-memory}/SKILL.md`.
- **Plugin:** renamed `crewdeck` 0.3.0 (plugin.json, marketplace.json, atom keys, types, README install, docs); token and
  proof unchanged. `claude plugin validate plugin` and `claude plugin validate .` pass (only the directory's "no icon"
  note, as before).
- **Vault template:** `CLAUDE.md` names `jobs init`, the `jobs-setup` interview and the `crewdeck-memory` skill.
- **Tests:** `test/jobs/setup.test.ts` (5: init from an empty home with files, modes and deny rules; idempotent re-run that
  never touches a note, rewrites managed files and backs up a foreign settings.json/CLAUDE.md once; presets with the Changes
  line and `--home`; refusals; doctor off/on/broken on a free port), `test/jobs/skills.test.ts` (5: presets, skill
  frontmatter and content, the command lint and its own negative cases, every command in the skills + generated CLAUDE.md +
  vault CLAUDE.md, the plugin name). Whole suite: 305 tests, green with the leak scan; `npm audit --omit=dev
  --audit-level=high` clean.

**Deviations and notes**
- Deny rules are `Edit(...)`/`Read(...)` (Claude Code never matches `Write(path)`), plus `WebFetch` (decision 4).
- `me set` / `pref set` take lists only as one YAML flow list (`[…]`, may span lines); the setup skill says so.
- Prepare stores a live-read form in one `crewdeck jobs form <role> --fields-file` call (the same store as headless
  reading); `learn` is for single questions met later (Apply's `needs you`).
- Easy Apply forms are read live in Prepare only when `easy_apply` is on; otherwise the page's copy mode covers them.
- A link with warnings is closed `done` with "Not picked (warning): …", the text the Jobs page matches to offer Add it
  anyway.
- `jobs/sources.md` has no command: the setup skill edits its frontmatter and runs `jobs check`.
- Not checked live: a real Claude session following the skills end to end (the owner's acceptance run, design §19), and
  `crewdeck up` rewriting the files (the same function as init, covered there).
- Deferred to P5: provider download/verify (the hook is in place), `candidates --budget` and the pool counts on the page,
  scheduled sourcing and Refresh sources; the daily-run skill works the pool that exists until then.
