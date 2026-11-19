# P9b: employers (resolve a careers page, Claude's help when it can't)

Part of [the Jobs design](../design.md): read §24.2–24.3 (the user's list, Add a company), D16, D24, D42 and §22 row P9b
first. Rules: [README.md](README.md). Builds on P9a ([09a-catalog-and-sources.md](09a-catalog-and-sources.md)): the v2
note, `crewdeck jobs sources …`, `changeSources`, the sandboxed runner.

## 1. Scope
- `crewdeck jobs sources resolve <key> [--json]`: for a source with a careers page (`careers_url`) or a web address
  (`url`), run the detectors in the sandbox (or the provider already named on the entry) and a **one-page test fetch**,
  ≤ 30 s, through netguard; nothing is stored in the tracker. The result is written to the note at once:
  - read → `provider: <id>` (a `url` becomes `careers_url`; `fetch`/`why` removed) and a Changes line
    "resolved Example Health: Workday, 34 roles on a one-page test";
  - not read → `fetch: none` with `why` ("no provider reads this page: paste its postings, or ask Claude to find its
    jobs page", or the provider's error), so the source stays on the list as "paste its postings".
  On Node < 25 or without installed providers it refuses with the reason and changes nothing.
- `crewdeck jobs sources set-url <key> --url-file f` and `set-url --request <id> --url-file f` (the key from a `source`
  request's payload): Claude found the real jobs page; it replaces the source's address (as `careers_url`, provider and
  `fetch: none` cleared), then Claude runs `resolve` again.
- The **`source` request kind** (D24): a page-only action `findJobsPage { key }` queues it on the jobs lane; `request
  show` adds the source's row as context. The workspace skill gets a `## source` section: open the careers page in a
  background pane tab, follow it to the list of open jobs, write the URL with the Write tool, `set-url --request`,
  `resolve`, close the request with the result line.
- A page-only action `sources { op: add|remove|move|enable|disable|set_url, … }` validated by the same `changeSources`
  as the CLI (so the bytes match), ready for P9e's screen. It never touches `jobs.features`.

Not in P9b: the Sources screen and "Add company → resolve" from the page (P9e: the server will run `sources resolve`
as a child process like the scheduled fetch); setup's employer step (P9f).

## 2. Modules

| File | What |
|---|---|
| `src/jobs/resolve.ts` | `resolveSource(ctx, key, o)`, `resolveCmd`, `setUrlCmd` |
| `src/jobs/sources.ts` | `spawnRunner` takes `maxJobs`; unchanged otherwise |
| `src/requests.ts` | `source` in `JOB_KINDS` |
| `src/jobs/api.ts` | `findJobsPage`, `sources` actions; `contextFor` for `source` |
| `plugin/skills/jobs-workspace/SKILL.md` | `## source` |
| `test/fixtures/jobs/providers/providers/fixture-{workday,greenhouse,neogov}.mjs` | ATS-shaped fixture providers on fictional hosts |

## 3. Decisions
1. **Resolve writes at once.** A user adding a company wants the answer now, and the next scheduled run should not
   discover the failure (audit 4.6). A failure is recorded as `fetch: none` with the reason; resolving again (or
   `set-url`) brings it back.
2. **The test fetch is one page** (`max_pages: 1`), with the runner's own timeout at 30 s and the whole child at 35 s. The
   count is what that page returned, and the line says so.
3. **Fixture providers stand in for Workday, Greenhouse and NEOGOV** in tests: the real career-ops code isn't in the repo
   and tests never reach a real site. They detect fictional hosts shaped like the real ones
   (`<tenant>.wd1.myworkdayjobs.example.test/<site>`, `job-boards.greenhouse.example.test/<slug>`,
   `www.governmentjobs.example.test/careers/<agency>`), all served by the local test server through netguard's test hosts.

## 4. Tests
Workday-, Greenhouse- and NEOGOV-shaped pages resolve with counts and the note gets the provider; an unknown page ends
`fetch: none` with a reason; a `url` source becomes a careers page when read; a provider error is recorded; a host
outside the test hosts is refused by netguard (no network outside it); Node < 25 refuses without changes; `set-url`
(plain and request-scoped, wrong kind refused); the `source` request (page action, kind check, context); the page's
`sources` action writes the same bytes as the CLI; the skill section is linted.

## 5. Done (2026-11-20)

**Built**
- `src/jobs/resolve.ts`: `resolveSource` (detectors or the named provider in the sandbox, `max_pages: 1`, 30 s for the
  entry and 35 s for the child, through netguard, nothing stored), `crewdeck jobs sources resolve <key> [--json]` (exit 2
  when not readable), `crewdeck jobs sources set-url <key> | --request <id> --url-file f`.
- The note is written at once: the provider (a `url` becomes `careers_url`, `fetch`/`why` cleared) or `fetch: none` with
  the reason, each with a Changes line. Refusals (Node < 25, providers missing, a board, LinkedIn, unknown key) leave it
  untouched.
- `source` request kind; page-only actions `findJobsPage { key }` and `sources { op: add|remove|move|enable|disable|
  set_url }` (same `changeSources` as the CLI; the test checks the note's bytes match); `request show` context for
  `source`; X and LinkedIn addresses refused as sources on both paths.
- Skills: jobs-workspace `## source`; jobs-setup's employer step resolves each employer; the workspace CLAUDE.md lists
  the new kind.
- Tests (`resolve.test.ts`): Workday-, Greenhouse- and NEOGOV-shaped pages resolve with one-page counts (20 of 34, 7, 10
  of 23); an unknown page ends `fetch: none` with the reason and resolves after `set-url`; a `url` source becomes a
  careers page; a provider error is recorded; a host outside the test hosts never reaches the local server; refusals;
  the request flow; the page action's bytes equal the CLI's.

**Deviations**
- The fixture providers that stand in for the real ones carry the real ids (`workday`, `greenhouse`, `neogov`) in the
  fixture tree, so what resolve writes validates against the pinned manifest; they read fictional hosts only.
- The count is one page's (the line says "on a one-page test"), not the employer's total.
- A failed resolve marks the source `fetch: none` (design: "stays on the list as paste its postings"); resolving again
  or `set-url` brings it back.

**Deferred**
- Resolve from the page ("Add company → Workday · 34 open roles" on the Sources screen): P9e runs `sources resolve` as a
  child process from the server, like the scheduled fetch.
- Setup v2's full employer interview: P9f.
