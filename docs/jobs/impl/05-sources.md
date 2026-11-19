# P5: job sources (pinned providers, sandbox, scheduled fetching, ranking, token-budgeted Find)

Part of [the Jobs design](../design.md): read §2.4 (scheduled collect, code ranking, early-stop judging with a light model,
company rules), §5 D3/D7, §14 (supply chain), §15 (providers), §16 and §22 row P5 first. Rules for every implementer:
[README.md](README.md). P4 ([04-setup-and-skills.md](04-setup-and-skills.md)) left the hook this phase fills
(`installProviders`/`providersStatus` in `src/jobs/providers.ts`), `jobs init` calling it and `doctor` reporting it.

## 1. Scope
- `scripts/update-providers-manifest.mjs <checkout> <commit>`: the import closure of the allow-listed career-ops providers
  → `src/jobs/data/providers.manifest.json` (repo, commit, MIT text and copyright, `files: {path: sha256}`, `excluded:
  {path: reason}`, the provider ids, which of them detect a careers page, optional imports).
- Install: download each manifest file from `https://raw.githubusercontent.com/<repo>/<commit>/<path>` (base URL injectable
  for tests), verify sha256, write a temp dir, rename it to `<jobs.home>/providers/<commit>/` with `LICENSE`; any mismatch
  aborts and cleans up. `crewdeck jobs providers install|status|verify`; `jobs init` installs (offline → a clear line, init
  still succeeds).
- The sandboxed runner `src/jobs/provider-runner.ts` and the parent `src/jobs/sources.ts`: `crewdeck jobs source [--since N]`
  runs the providers in a `node --permission` child with an empty environment, validates every job, stores it, then LinkedIn
  guest search (gated), then the prefilter, then descriptions for the best-ranked roles that have none.
- Scheduled fetching in the Crewdeck server (`jobs.fetch_every`, default 12h): `crewdeck jobs source` as a child process,
  never overlapping; Jobs shows "N new roles since <time>" and a Refresh sources action.
- Ranking `src/jobs/pipeline/rank.ts` and `crewdeck jobs candidates --budget N --batch 10`: rank order, never re-judges,
  stops once the day's picks are covered; the `jobs-daily-run` skill uses it with a light-model first pass.

Not in P5: journey tests (P6), the security review (P7).

## 2. Modules and API

| File | What |
|---|---|
| `scripts/update-providers-manifest.mjs` | `importsOf(src)` (a lexer: static, re-export and dynamic imports; comments, strings, templates and regex literals skipped), `buildManifest({ read, list, commit, license })`, `gitReader(checkout, commit)` (`git ls-tree`/`git show` at the commit, read only) |
| `src/jobs/data/providers.manifest.json` | generated; never edited by hand |
| `src/jobs/providers.ts` | `loadManifest()`, `providersDir(c)`, `installProviders(c, { base?, net?, manifest? })`, `providersStatus(c)` (quick: marker + files present), `verifyProviders(c)` (every sha256), `PROVIDER_IDS`, `EXCLUDED_IDS` |
| `src/jobs/provider-runner.ts` | the child: reads its job from stdin, verifies every file, `module.registerHooks` resolve/load hooks, imports the needed providers, runs each entry with a timeout, prints JSON lines; `normalizeJob(job, provider)` (the old runner's, with the Hacker News title split) |
| `src/jobs/sources.ts` | `sourcePlan(notes, manifest)`, `runnerArgs(dir)`, `runProviders(ctx, plan, opts)`, `cleanJob(raw)`, `runSources(ctx, opts)`, `readSourcesState(home)`, `parseEvery("12h")` |
| `src/jobs/schedule.ts` | `createSourceScheduler({ everyMs, run, state, … })`: the server's timer (no overlap, refresh on demand) |
| `src/jobs/pipeline/rank.ts` | `rankScore(row, notes, at)`, `rankRoles(ctx)` (company rules drop), `fetchDescriptions(ctx, { top, net })`, `findRun` state, `budgetedCandidates(ctx, { budget, batch, need, start })` |
| `src/jobs/commands.ts` | `source`, `providers install\|status\|verify`, `candidates --budget N --batch K [--need N] [--start]`; `judge` counts verdicts into the open Find run |
| `src/jobs/api.ts` | the scheduler (only when providers are installed), `sources` in `/api/jobs/state`, page action `refreshSources` |
| `web/jobs/screens/topbar.js` | "N new roles since <time>" + Refresh sources |
| `plugin/skills/jobs-daily-run/SKILL.md` | the budgeted loop |

## 3. Decisions (and where they deviate from or extend the design)
1. **Manifest from git objects.** The script reads `git show <commit>:<path>`, never the working tree, so its hashes are the
   bytes raw.githubusercontent.com serves for that commit. The repo is `career-ops-hq/career-ops` (the checkout's origin).
   At `f3b043d` the closure is 137 providers and 166 files (≈2 MB), checked against V8's own module parser
   (`vm.SourceTextModule` static requests matched the lexer on every file).
2. **Exclusions** (with reasons in the manifest): `providers/local-parser.mjs` (runs commands), `providers/_registry.mjs`
   (imports a whole folder), `lib/yaml-document.mjs` (npm `js-yaml`), `providers/_profile-keywords.mjs` and the seven
   providers that import it (`gupy`, `jobbankca`, `jobscz`, `mycareersfuture`, `platsbanken`, `pracecz`, `vdab`). Exclusion
   propagates: every file on the import chain to an npm package is excluded, naming the chain.
3. **Optional dynamic imports.** `_http.mjs` and `_connection-scope.mjs` load `undici` only for proxy egress or a connection
   scope the runner never opens. They stay in the closure (listed under `optional_imports`); the runner's hook refuses the
   package anyway. Any other bare non-built-in import, or a dynamic import of a computed specifier, fails the script.
4. **Denied built-ins** (script and hook): `child_process`, `cluster`, `worker_threads`, `inspector`, `wasi`, `repl`, `vm`,
   `v8`, `module`, `trace_events`, `sqlite`, `http2`. The permission model also refuses processes and workers.
5. **The allow-list replaces `provider-ids.json`.** `sources.md` validation uses the manifest's `providers`; an excluded id
   gets its reason ("needs the npm package js-yaml"). The `onsite-city` preset drops `jobbankca`, `mycareersfuture`,
   `platsbanken`, `vdab` and `jobscz` (excluded); their regions keep the watchlist and LinkedIn.
6. **Install** goes through netguard (`guardedFetch`: SSRF checks, no proxy variables, 2 MB per file, 15 s), six files at a
   time, into `<jobs.home>/providers/.tmp-<random>/` (0700), each file's raw bytes checked against its sha256 before it is
   written (netguard now also returns the body's `bytes`, so a BOM or odd encoding can't change the hash). LICENSE is
   checked against the manifest's copy. Then `installed.json` (commit, time, file count), the tree sealed read-only (files
   0400, folders 0500) and one rename to `providers/<commit>/` (an earlier install for the same commit is replaced; other
   commits are removed after success). Any failure removes the temp dir and names the file and why.
7. **Status vs verify.** `providersStatus` (doctor, server) checks the marker and that every listed file exists;
   `verifyProviders` re-hashes every file. The runner verifies every file itself before importing anything, and the load
   hook hashes the exact source it hands to V8, so a file changed after the check still can't run.
8. **`module.registerHooks`, not `module.register`.** The synchronous in-thread hooks (Node ≥ 22.15) need no loader worker
   (which the permission model would refuse without `--allow-worker`) and see every import, static and dynamic. `resolve`
   allows built-ins outside the denied list and `file:` URLs listed in the manifest inside the providers dir; everything
   else (bare packages, `data:`, `http:`, unlisted files, paths outside) throws. `load` returns the verified source.
9. **Child flags** (checked on this Mac with Node 25.9; CI runs 22 and 24). *Superseded in P7 pass B: never `--allow-net`,
   sourcing needs Node ≥ 25, the providers' fetches go through the parent; see [07-security-review.md](07-security-review.md).*
   `node --permission --allow-fs-read=<providers/<commit>> --allow-fs-read=<provider-runner.ts> [--allow-net]
   --disallow-code-generation-from-strings --max-old-space-size=512 <provider-runner.ts> <providers/<commit>>`, `env: {}`.
   - No `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`.
   - `--allow-net` is added only where Node has it (25+, where the permission model also gates the network; on 22/24 the
     network is not part of the model). Detected with `process.allowedNodeEnvironmentFlags`.
   - Type stripping works on the `.ts` runner under `--permission` (it only needs the read grant for its own file). The
     runner imports nothing but `node:` built-ins, so one file grant is enough.
   - No eval or `new Function` in the closure (grep at this commit), so code generation from strings is off.
10. **Disk caching** is not needed: `_http-cache` writes only inside `withHttpCache`, which the runner never opens. The one
    cache providers use is `ctx.idCache` (board ids a careers page reveals): an in-memory map per provider for the run.
    `url-key.mjs` reads `data-static/aggregator-domains.txt` only for helpers no provider in the presets calls; outside
    the grant it is a caught ENOENT.
11. **Runaway pages.** `ctx.maxPages` is 10 (themuse would otherwise page up to 1500, jobstreet 500, neogov 200); each entry
    has a 90 s timeout and at most 2000 jobs; the whole child is killed after 15 min. Entries run 4 at a time.
12. **Output channel.** *Superseded in P7 pass B: the protocol is on fd 3 with a per-run nonce; stdout and stderr are
    only logged.* The runner keeps a private reference to `process.stdout.write` and sends `console.*` to stderr before
    importing providers, so a provider's log line can't corrupt the protocol: JSON lines `{"t":"job"|"entry"|"fatal"|"done"}`.
    The parent ignores anything else, caps lines (50 000) and bytes (64 MB), and validates every job: url http(s), ≤ 2000
    chars, no credentials, not X, LinkedIn only when `linkedin_links` is on; title 1–300; company ≤ 200 (empty → the entry's
    name for careers pages, else "Unknown"); location ≤ 500; description ≤ 200 000; pay text ≤ 200; posted_at a real date
    not in the future (+1 day). Bad jobs are counted, never stored.
13. **Source labels**: `ats` for a company's own board (a `careers_url` entry or any watchlist entry), `board` for boards
    (aggregators). `pasted`, `linkedin` stay as before.
14. **Entries** passed to providers are the `sources.md` objects with primitive values only (strings ≤ 2000, numbers,
    booleans, string lists), `enabled: false` skipped. A careers_url entry without `provider` loads the manifest's
    `detectors` (providers whose source defines `detect`) in alphabetical order, as career-ops routes.
15. **Details for the best roles.** After the prefilter, the top 50 ranked unjudged roles with an empty description get
    their posting page through netguard (4 at a time, skipping LinkedIn and X) and `readPostingPage`; a closed posting
    becomes `expired`, a found description is stored, then the prefilter runs again (descriptions can reveal drops).
16. **Ranking** (`rank.ts`, replaces `pick.ts`'s `rankScore`): title match (30 → 10 by position), seniority (15 → 5), skills
    overlap with `career.md` (5 each, ≤ 25), freshness (15/10/6/3/0 for 3/7/14/30 days), source (pasted 15, manual/alert 12,
    linkedin 10, ats 8, board 5), pay (ok 8, unclear/no rate 3, unlisted 2, below floor 0), a description present +5.
    Company rules (`company_rule` memory items) drop the role (`prefiltered_out`, "company_rule: …") before it is ranked.
17. **Find runs.** `candidates --budget N --batch K` keeps a small state file (`<jobs.home>/state/find.json`: started, budget,
    judged ids). `--start` begins a new Find; without it a run older than 6 h starts fresh. `judge` adds the stored verdicts'
    roles to the open run. The answer is `{ batch, run: { budget, judged, remaining, need, passed, done, why } , pool }`:
    `passed` counts companies with an eligible, pickable role (same filter as `pick`); `done` once `passed ≥ need`, the budget
    is spent or the pool is empty, and then `batch` is empty. Budget ≤ 40, batch 1–20. `candidates --limit` still works.
18. **Scheduling** lives in the server (`createJobsApi`) when Jobs is on and providers are installed: the first run 2 min
    after start when the last one is older than `fetch_every` (or none), then every `fetch_every` after the last finish.
    It spawns `node <repo>/src/cli.ts jobs source` (argument array, the server's environment with `CREWDECK_HOME`), one at a
    time; Refresh sources while one runs answers "already running". The `source` command writes
    `<jobs.home>/state/sources.json` (last run: times, per-entry counts, errors, LinkedIn, prefilter, details); the
    scheduler adds a failed exit to it. No Claude tokens are spent.
19. **"N new roles since <time>"**: roles that passed the rules and wait for judging, first seen since the last Find request
    was made (or since the first run). The line also shows the last fetch time.
20. **LinkedIn** in `source`: only with `linkedin_search` on, after the providers, with P2b's pace and caps; a stop (429/999/3xx)
    is reported, never retried.

## 4. Provider review (presets, at f3b043d)
Every preset provider requests only through `ctx.fetchJson`/`fetchText` (the career-ops `_ip-guard` SSRF check at DNS time
and for IP literals, `redirect: 'error'`, 10 MB body cap), makes no per-job detail request, and touches no disk, `idCache` or
environment. Hosts:

| Provider | Hosts | Requests | Notes |
|---|---|---|---|
| remotive, remoteok, weworkremotely, workingnomads, nodesk, jobspresso, landingjobs | their own site | 1 | |
| remote-com | apply.remote.com | 1 | |
| himalayas | himalayas.app | ≤ 10 pages (`maxPages`) | |
| jobicy | jobicy.com | ≤ 25 pages (`maxPages`) | |
| 4dayweek, arbeitnow, thehub | their own site | 3 pages by default (ignore `maxPages`) | |
| arbeitsagentur | rest.arbeitsagentur.de | per keyword | needs `arbeitsagentur.keywords`; a public API key in code |
| builtin | builtin.com + 8 regional builtin hosts | queries × categories × pages (≤ 25) | browser user agent |
| jobstreet | id.jobstreet.com / 12 SEEK hosts | up to 500 pages → capped by `maxPages` 10 | |
| nofluffjobs, justjoin | their own site | 5 / 50 pages (ignore `maxPages`) | need a `careers_url` on that site |
| wttj | welcometothejungle.com, then `<appId>-dsn.algolia.net` | 1 + 1 per query | the Algolia host comes from the response (app id pattern-checked) |
| computrabajo | `<cc>.computrabajo.com` | ≤ 3 pages, 2–5 s apart | needs `careers_url` |
| occ | occ.com.mx | queries × states × ≤ 10 pages | needs `queries` |
| itviec | itviec.com | ≤ 10 pages | |
| neogov | governmentjobs.com, schooljobs.com | up to 200 pages → 10 | needs `careers_url` `/careers/<agency>` |
| themuse | themuse.com | up to 1500 pages → 10 | throws on a Cloudflare challenge |

Residual: a provider calling global `fetch` outside `_http` would not get career-ops' DNS guard (none does at this commit);
the sandbox still keeps it away from the user's files, processes and environment.

## 5. Test plan (node --test, local servers and fixture trees only, fictional people only)
- Manifest: the lexer on tricky sources (URLs in strings, commented imports, regex literals, templates, re-exports, dynamic
  imports); a fixture tree: closure includes helpers/lib/root files, excluded providers and their chain, npm users excluded,
  computed dynamic import fails, denied built-in fails; the committed manifest: no excluded file in `files`, every file's
  imports resolve inside `files` or are allowed built-ins/optional (from a re-scan when the checkout is present).
- Install/verify against a local fixture server through netguard `testHosts`: success (dir, LICENSE, modes, marker, status
  ready), a tampered file aborts and leaves no providers dir and no temp dir, a missing file (404), offline (`jobs init`
  still succeeds with the message), verify detects a changed file.
- Runner sandbox (real child with the real flags): reading a file outside the providers dir fails, spawning a process fails,
  importing an unlisted file fails, a bare package import fails, a file changed after install refuses to run.
- Runner end to end: a fixture provider tree + local HTTP server → jobs stored with validation (bad URL, X, oversize title
  refused), a timeout entry, an erroring entry, a provider's `console.log` doesn't corrupt the output, HN title split.
- Scheduling: interval parsing; no overlap (refresh while running); due/not due from the state file; failure recorded.
- Ranking order and company-rule drop; descriptions fetched for the top roles only; budgeted candidates (batches, never
  re-judged, stop once N companies pass, budget spent, `--start`).
- API: `refreshSources` page-only, state shows sources; UI renders the sources line.

## Done
Built as planned in §2, with the decisions in §3.

- **Script and manifest:** `scripts/update-providers-manifest.mjs` (lexer checked against V8's module parser on every file
  of the commit), `src/jobs/data/providers.manifest.json` for `career-ops-hq/career-ops@f3b043d`: 137 providers (121 can
  detect a careers page), 166 files, 11 exclusions with reasons, the MIT text and notice. `provider-ids.json` is gone:
  `sources.md` validation uses the manifest (excluded ids say why); `onsite-city` lost its five excluded boards.
- **Code:** `src/jobs/providers.ts` (manifest, download through netguard, verify, status), `src/jobs/provider-runner.ts`
  (the sandboxed child), `src/jobs/sources.ts` (plan, flags, spawn, validation, `runSources`, state file, `parseEvery`),
  `src/jobs/schedule.ts` (the timer), `src/jobs/pipeline/rank.ts` (score, company-rule drop, descriptions for the top 50,
  Find runs and `budgetedCandidates`; `pick.ts` re-exports `rankScore` and ranks through it), commands `source`,
  `providers install|status|verify`, `candidates --budget/--batch/--need/--start`, `judge` counting into the run,
  `jobs init --no-providers`; the server's scheduler, `sources` in `/api/jobs/state` and the `refreshSources` page action;
  the Jobs top bar's sources line with Refresh sources; the `jobs-daily-run` skill's budgeted loop; netguard returns `bytes`.
- **Checked on this Mac (Node 25.9):** the flags of §3.9 with the type-stripped runner; the real career-ops tree installed
  from a local server serving the pinned commit's git objects (166 files verified), then run in the sandbox against the
  live Remotive board (16 postings) and a careers page routed through the 121 detectors to Greenhouse (an HTTP 404 for a
  made-up board, reported per entry). That manual run is the only one that touched a real site; tests never do.
- **Tests** (`test/jobs/`): `manifest` (lexer, closure, exclusions, failures; the full rebuild of the committed manifest
  when `CAREER_OPS_CHECKOUT` is set, run here and green), `providers` (install, tamper, 404, offline, loopback base refused,
  verify, the committed manifest's invariants), `init-providers` (init offline and online against a fixture server;
  `providers status|verify` CLI), `sources` (flags; the sandbox refusing reads, writes, processes, `process.binding`, env,
  unlisted files and packages; a changed file never runs; the runner end to end with a board, a detected careers page,
  a timeout, an error and console noise; `runSources` storing with labels, refusals and the prefilter; LinkedIn only when on;
  the plan; `cleanJob`; `normalizeJob` incl. the HN split; an early runner death; the CLI; fitness: node: imports only, empty
  env), `rank` (each score factor, company rule drop, descriptions for the top roles once each, budgeted batches, budget,
  enough, pool, 6 h expiry, the CLI), `schedule` (intervals, no overlap, due/not due/not ready, failures, the page's state
  and Refresh sources, the sources line). Whole suite: 341 tests (1 skipped without a checkout), green with the leak scan;
  `npm audit --omit=dev --audit-level=high` clean.

**Deviations and notes**
- The script takes `<checkout> <commit>` (design §15 says `<commit>`): it reads the commit's objects from a local checkout,
  so no network is needed and the result is reproducible.
- `jobs init --no-providers` (new) skips the download; the setup tests use it so they never reach GitHub.
- Source labels are `ats`/`board` by entry (a careers page vs a board), not by provider id; the per-entry provider is in
  the `added` event and the state file.
- `ctx.maxPages` 10 caps paginating providers; five preset providers ignore it (3-50 pages each), bounded by the 90 s entry
  timeout and 2000 jobs per entry.
- "N new roles since <time>" counts from the last Find request (else everything waiting); the tooltip has the next fetch.
- Not run locally on Node 22/24 (only Node 25 here): the permission flags, `registerHooks` and type stripping under
  `--permission` are exercised by the sandbox tests in CI's 22/24 matrix; `--allow-net` is added only where Node has it.
- Not checked by eye: the top bar's new sources line (rendered in tests; Crewdeck on the owner's ports was not touched).
- Deferred: persisting `idCache` between runs (in memory per run now), a per-host request budget across providers.
