# P9d: search preview and Find's funnel

Part of [the Jobs design](../design.md): read §24.6 (D27), §24.7 (D28), D42, §23 q8 and §22 row P9d first. Rules:
[README.md](README.md). Builds on P9c ([09c-title-matching.md](09c-title-matching.md)): the matcher, `closest`,
`abbreviationsFor`, the `level` rule.

## 1. Scope
- **Preview** (`src/jobs/preview.ts`): the rules of the saved notes, or of the saved notes overlaid with unsaved
  changes, run over the pool (roles first seen in the last `days`, default 14, any status but applied, the 5,000 newest),
  read-only. It reports passes (and the saved notes' count when previewing a change), drops by first reason,
  single-blocker counts by group, near misses on title clustered by head word, examples, per-source counts, how many
  more `broad` would pass, and suggested fixes, each a concrete change with its own count.
- **CLI:** `crewdeck jobs preview [--search-file f] [--days N] [--source key] [--json]`. The search file is a partial
  `jobs/search.md` frontmatter (YAML), merged and validated like `pref set`. An empty pool says so and suggests
  `crewdeck jobs source`.
- **API:** `POST /api/jobs/preview { search?: { <Preferences field>: value }, days? }`: page-only (exact Origin,
  same-origin fetch, JSON, like the actions), read-only (no refresh event), the same field checks as Save.
- **Funnel** (`src/jobs/funnel.ts`): fetched (last 14 days) → after rules by first reason (from `status_reason`) →
  judged (yes / no / unclear) → picked today, plus the judge's top reasons and the sources that returned nothing, and
  the coverage line (D42) when the pool is small. Stored in `state/find.json` with the Find run at every `candidates
  --budget` call and after `pick`; printed as `run.funnel` by `candidates`, so Claude's close line and the page agree.
- **Today:** a **Why so few?** card when the last Find picked fewer than it was asked for: the funnel line, the rules
  line, the preview's first fixes ("Add 4 title variants: 82 more pass") and **See the preview**; each opens Preferences
  with the change filled in and its preview showing. Save writes it with "added from Find's suggestions".
- **Preferences:** a Preview panel beside Save (debounced, "105 pass (now 1)", drops, near misses, fixes that fill the
  form); the Roles card edits targets (name, titles, skills), `match` and `level`.
- **Skill:** `jobs-daily-run` closes a Find with `run.funnel.line`.

## 2. Decisions
1. **Suggestions are relative to what is previewed** (saved notes plus unsaved changes) and counted by re-running every
   rule on the roles that only that group blocks (so a fix's count is exact, not an estimate).
2. **Variants come from clusters:** a dropped title whose words share a target's head word, or 2 of a 3+-word title's
   words, or an abbreviation whose long form ends in a head word ("SRE" → engineer), is a near miss. Its label is the
   title's main part without seniority words ("Senior Engineer" → "Engineer"). The fix adds the top five clusters by
   single-blocked count (≥ 2 each) to the target they came from.
3. **Place fixes only for on-site places** (`location_elsewhere`): a remote posting "only for the US" is a correct drop,
   and the preview never suggests a place the user can't work from.
4. **An fx rate is information, not a fix:** `no_rate` never drops, so the line says which currencies lack a rate.
5. **Posting text never reaches a command line:** suggested `pref set` commands use `--value-file`; the value is printed
   as JSON for the file.
6. **The funnel is computed from the tracker,** not counted during the Find, so it is the same whoever asks.

## 3. Tests
`preview.test.ts`: the owner-shaped fictional pool (1,480 postings, 9 sources): the old phrase gate passes exactly 1
with 1,375 title drops (281 engineering) and 92 place drops; the saved notes pass more; accepting the variant fix
passes ≥ 100 and every place drop stays; read-only (DB and note bytes hashed before and after, CLI and API); overlay
validation errors; empty pool; the 5,000 cap; the time budget. `funnel.test.ts`: the numbers add up, the stored run,
`candidates` output, the close line. UI tests for the card and the Preferences preview; API page-only checks.

## 4. Done (2026-11-20)

**Built**
- `src/jobs/preview.ts`: `previewPool` (last N days, any status but applied, the 5,000 newest), `trackerDrops` (read
  once for the pool), `evaluate`, `overlaySearch` / `searchFileChanges` (the same validation as `pref set` through
  `edit.ts`'s new `overlayFields` / `overlayChanges`, nothing written), `runPreview` (passes and the saved notes' count,
  first reasons, single blockers by group, near-miss clusters, examples, per source, `broad`, fixes with exact counts and
  short labels), `previewLines`.
- `rules.ts`: `prefilter` now takes the first of a lazy `checks` generator; `allDrops` takes one drop per group
  (`RULE_GROUP`). The two place rules that end in a keyword ("<places> only", "<places> are not eligible") run only in
  the window before each keyword, the same leftmost, non-overlapping matches as a whole-text scan: the preview of 5,000
  roles with 2.4 kB descriptions went from 4.9 s to 0.45 s, and the scheduled prefilter gets the same speed-up.
- `crewdeck jobs preview [--search-file f] [--days N] [--source key] [--json]`, which opens the tracker read-only
  (`openJobsDbReadOnly`: no migration, and closing it never checkpoints the WAL into the file, which on Node 22 changed
  the database's bytes though not its rows); `POST /api/jobs/preview` (page-only,
  read-only, Preferences' field checks, field errors as `{ ok: false, issues }`).
- `src/jobs/funnel.ts`: `findFunnel` (fetched, rules by first reason, passed, judged = fits + no + unclear, waiting,
  other, picked today, the judge's top reasons, sources that returned nothing, the coverage line when the pool is
  small), stored in `state/find.json` by `candidates --budget` (as `run.funnel`) and by `pick` (which prints it when
  short).
- Today: the **Why so few?** card (`WhySoFew`) with the funnel, the rules line or the judge's reasons, sources, coverage
  and the preview's first two fixes; a fix opens Preferences with the change filled in. Preferences: targets editor
  (name, titles, skills; families kept), `roles.match`, `roles.level`, the Preview panel and the count in the save bar;
  Save from a Find fix logs "added from Find's suggestions". `PREF_FIELDS` gained `roles.targets`, `roles.match`,
  `roles.level`.
- `jobs-daily-run` §5: a short Find closes with `run.funnel.line` and `rules_line`.
- Tests: `preview.test.ts` (8), `funnel.test.ts` (6), the owner-shaped fixture `test/jobs/owner-fixture.ts`, UI checks
  for the card and the Preferences preview, the rank test's run shape.

**The owner's case (fictional, 1,480 postings, 9 sources):** the v0.3 phrase gate (as a `rules.title_gate` override):
1 passes; title 1,375 (281 of them engineering titles), only for other places 92, workplace 9, excluded word 3. The saved
notes with P9c's matcher: 16 pass ("Software Engineer, Backend", "Engineer II, Backend Services"). Accepting the
suggested variants (full stack engineer, software engineer, engineer, platform engineer, devops engineer): 202 pass; all
92 place drops stay place drops (asserted role by role), and the newly matched engineering roles limited to other
countries drop on place too (142).

**Visual check:** a temp home on port 5317, the in-app browser pane, light and dark: the card, a fix opening
Preferences with "1 change not saved yet · 202 pass (now 16)", the Preview panel, Save writing the Changes line.

**Deviations**
- The funnel's `fetched` counts roles first seen in the last 14 days (the tracker keeps no per-run fetch count);
  `judged` counts every verdict in that window, not only this Find's (the run's own count stays in `run.judged`).
- The fx line is information only (decision 4); place fixes only for on-site places (decision 3).
- The preview reads the notes through the last-valid fallback like the rules do; its read-only test covers the tracker,
  every note and Jobs' state files.

**Deferred**
- The Not interested dialog's drop count (§24.6 "where it shows"): the dialog still saves without a preview.
- The Sources screen (the card's "Open your sources" opens `jobs/sources` in Notes until P9e) and setup's preview loop
  (P9f).
