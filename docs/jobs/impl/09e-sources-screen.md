# P9e: the Sources screen

Part of [the Jobs design](../design.md): read §24.2–24.3 (the user's list, the screen), D16, D22, D23, D24, D41, D42 and
§22 row P9e first. Rules: [README.md](README.md). Builds on P9a ([09a-catalog-and-sources.md](09a-catalog-and-sources.md):
the v2 note, `changeSources`, `listSources`, `suggest`), P9b ([09b-employers.md](09b-employers.md): `resolve`, the
`source` request, the page's `sources` action) and P9d ([09d-preview-and-funnel.md](09d-preview-and-funnel.md): Find's
card).

## 1. Scope
- **A Sources tab** between Today and Applications (`#sources`), from `GET /api/jobs/sources`:
  - **Yours**, in priority order: name, kind, provider, regions, "not verified"; the last fetch from
    `state/sources.json` `by_key` ("34 roles, 3 new, 12 kept by your rules · 2 h ago", or the error or skip reason in
    plain words); **Move up / Move down** buttons; an on/off switch; **Remove** with a confirm. A page Crewdeck can't read
    shows why, **Ask Claude to find the jobs page** (the `source` request) and **Check again**.
  - **LinkedIn's row** moves like any source. Its state is `jobs.features.linkedin_search`; **Switch on…** opens the
    same two-step confirm as Settings and then the native dialog (the existing `feature` action). Links and Easy Apply
    are shown beneath. The note never gets an `enabled` for it. Without a row, "Place LinkedIn in your list" adds one.
  - **Add a company** (name + careers page) and **Add a web address**: the `sources` add, then a check in the sandbox;
    "Checking … (up to 30 seconds)" then "Example Health: Workday · 20 open roles on a one-page test", or "isn't
    readable" with **Ask Claude to find the jobs page**, or why it couldn't be checked here (Node, providers).
  - **Catalog**: "Suggested for you" (from `suggest`, minus what's in the list) and every offerable entry, filtered by
    region (the user's countries first), field and kind, with "Show sources that need a careers page" off by default.
    Blocked, retired and unrunnable entries are never offered; the LinkedIn entry is the row above.
  - **The coverage line** (D42) at the top, `suggest`'s own line. When no board fits and nothing fetchable is on, it is
    the card's subject ("No job board covers you yet") with Add a company, Place LinkedIn, Paste a job link.
  - **Where this lives**: the list in `jobs/sources.md` (Notes), what each fetch found in Crewdeck's state file, LinkedIn's
    switch in Settings.
- **Server**: `GET /api/jobs/sources` (a page read, like the other views); a page-only action `resolveSource { key }`
  that runs `crewdeck jobs sources resolve <key> --json` in a child (like the scheduled fetch), two at a time, one per
  source, and keeps the answer in memory for the screen (an hour).
- **Find's card**: "Open your sources" opens this screen (it opened the note).
- **P9d fix**: Preferences Save keeps a target's keys the form doesn't edit and every comment (see §3.4). The Not
  interested dialog previews how many passing roles the title words drop (§24.6).

## 2. Modules

| File | What |
|---|---|
| `src/jobs/sources-view.ts` | `sourcesScreen(ctx, …)`: rows (`listSources` + labels, resolve state), catalog, suggestions, coverage, filters |
| `src/jobs/api.ts` | `GET /api/jobs/sources`, `resolveSource` action and its child runner (`JobsApiOptions.resolve` for tests); `prefs` passes each target's place; Today carries `exclude_title_words` |
| `src/jobs/notes.ts` | `mergeListInDoc`: a list of maps updated in place (nodes reused) |
| `src/jobs/edit.ts` | `Change.keep/owns`; Changes lines for targets on one line |
| `src/jobs/sources-note.ts` | the template's empty `sources: []` becomes a block list on the first add |
| `web/jobs/screens/sources.js` | the screen; `lastLine`, `filterCatalog`, `inRegion`, `poss` |
| `web/jobs/screens/today.js` | `dropLine` and the Not interested preview; Find's card opens Sources |
| `web/jobs/screens/preferences.js`, `topbar.js`, `app.js`, `jobs.css` | targets keep `at`; the tab; wiring; the screen's rem-based styles |

## 3. Decisions
1. **The page action keeps its P9b name.** Design §24.3 names `POST /api/jobs/action/sources { op: … }`: that is exactly
   the `sources` action P9b built (same `changeSources` as the CLI). The screen calls it; no second writer. Checking a
   page is a separate action, `resolveSource`, because it runs for up to 35 s in the background while the add returns
   at once.
2. **Resolve runs in a child**, never in the server: the sandbox, netguard and the provider files stay out of the
   long-lived process, exactly as for the scheduled fetch. When it can't run here (Node < 25, providers not installed)
   the reason comes back at once and the note is untouched; the source stays in the list and is tried at the next fetch.
3. **Keyboard first.** Move up/Move down are real buttons; after a move, focus returns to the same button of the moved
   row once the list shows the change (or to its other button at an end), so Enter keeps moving it. Each change is
   announced in a polite live region ("Example GmbH moved to position 1 of 3").
4. **Preferences keeps what it doesn't show.** The view gives each target `at`, its index in the note (only when the
   note itself was read, not the last-valid copy). Save sends it back; `setFields` reuses that YAML node and sets only
   `name`, `titles`, `families`, `skills` (an empty one removes the key), so hand-written keys and comments stay, even
   when targets are reordered or one is removed. A fix from the preview or Find's card takes `at` by position (same
   targets, same order). A target without `at` is new. Empty `families`/`skills` are no longer written.
5. **D41 on this screen**: rem type with nothing under 14 px, secondary text in `--soft` (`--muted` is 3.7:1 on white),
   labelled controls, live regions; checked in a real browser in both themes (not the rest of the page: P9i).
6. **A missing `jobs/sources.md`** is not an error on this screen (the first add creates it from the template).

## 4. Tests
`sources-screen.test.ts`: the view (order, `by_key`, offerable catalog, suggestions and coverage = `suggest`'s, region
options, read guard); a new user without the note; `resolveSource` (page-only, background, one per source, two at a time,
answers and refusals); the default child on a home that can't run it; on Node 25 a real add → resolve of a
Workday-shaped fixture page and an unreadable one through the sandbox; the screen rendered in Node (rows, LinkedIn row
without a note switch, bare coverage, filters, last-fetch lines); the drop line; Preferences keeping hand-written keys,
comments and order. `sources-ui.test.ts` (headless Chromium): keyboard-only reorder and switch, then the note's bytes
equal the CLI's for the same changes on a twin; LinkedIn's row → confirm → native dialog asked once, config switched, the
note unchanged; no text under 14 px and AA contrast for every text in light and dark.

## 5. Done (2026-11-20)

**Built:** everything in §1. `npm test`: Node 25 532 tests, 530 pass, 2 skipped; Node 22.18 532, 518 pass, 14 skipped
(the sandboxed add-company test needs Node 25).

**Visual check:** a temp home on port 5333 in the in-app browser pane, dark and light, keyboard only (Tab to Move up,
Enter, Enter: focus follows; at the top it moves to Move down); add a Workday-shaped company (checking → "Workday · 20
open roles"), an unreadable one (→ Ask Claude → "Claude is looking for its jobs page"). Full-page screenshots in both
themes come from `CREWDECK_SHOTS=<dir> node --test test/jobs/sources-ui.test.ts`.

**Deviations**
- The resolve action is `resolveSource` beside the design's `sources` action (decision 1).
- The coverage line is always at the top, as the design says; it becomes the card's subject only when nothing fits.
- The catalog's coverage text is shown as written in the catalog (it is factual but sometimes technical).
- Preferences keeps unknown keys on targets only (the field the form rewrites as a list of maps); languages entries are
  still `{ name, level }`.

**Deferred**
- Drag to reorder (optional in the design): buttons only.
- The rest of the page's D41 pass (top bar, Today, Preferences use 11–13 px): P9i.
