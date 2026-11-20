# P9i: journeys and docs

Part of [the Jobs design](../design.md): read §24.12 (test plan, personas), §24.13 (reach D40, accessibility D41,
honesty D42) and §22 row P9i first. Rules: [README.md](README.md). Builds on P9a–P9h: every command the journeys run,
the Sources and Preferences screens, setup v2, the form terms.

## 1. Scope
- **Persona journeys** (`test/jobs/journeys.test.ts`): the seven people of §24.12, each on its own temp home from the
  empty templates, through the commands Claude runs: the setup interview's notes (`me set`, `pref set` with the user's
  words from files), `sources suggest` and its coverage line, the sources the person picks (LinkedIn placed, never
  switched on), fetch once (it says why it can't run on a fresh home), postings (pasted with `add-role`, or stored as a
  fetch would with their source key and structured fields), the preview (`finish`: `jobs check` clean, every kind of
  job passing ≥ 1), the rules posting by posting (`prefilter`), Find within a budget (`candidates --budget` with the
  funnel, a scripted judge, the funnel line, `pick`), Prepare (the form's language, `form` questions with ID numbers
  not stored, the `draft` brief in the form's language, `fill-plan`), and the apply panel's state. Outputs are captured
  per person (`$CREWDECK_JOURNEYS/<key>.txt`).
- **The owner's acceptance re-run** (`test/jobs/owner-acceptance.test.ts`) as the engineer from the audit, from zero:
  v0.4 notes through the CLI, the catalog's remote boards with LinkedIn placed first, his first run's pool (1,480
  postings, `owner-fixture.ts`'s new `seedOwnerPool`), the preview's variants previewed then accepted, the rules role
  by role, LinkedIn first vs last, and a Find of 5.
- **D41 for the rest of the page**: `web/jobs/jobs.css`'s base type in rem with nothing under 0.875 rem and secondary
  text in `--soft` (AA in both themes), so the top bar, Today (queue, role, apply panel, Why so few?, the Not
  interested dialog), Applications, What Claude knows, Settings (and its confirm) and the setup card meet it like
  Sources and Preferences already did. `test/jobs/a11y-ui.test.ts` checks every screen in light and dark in a headless
  Chromium (texts ≥ 14 px, contrast ≥ 4.5, every control labelled, none out of the Tab order, a Tab walk over the top
  bar and a role); the audit helpers moved to `test/jobs/ui-audit.ts`, shared with `sources-ui.test.ts`.
- **Docs**: README (who it's for, "Let Claude install it", plain requirements, what's stored where, Sources),
  `docs/jobs/first-run.md` v2, `examples/jobs/` as v0.4 notes, CHANGELOG, `08-pr-description.md` for P9a–P9i, the
  roadmap, two new screenshots.
- **A fresh-user rehearsal** on a temp home (below), and the fixes it led to.

## 2. Decisions
1. **Journeys run through the CLI, postings pasted or stored as a fetch would.** A real sandboxed fetch needs Node 25
   and installed providers; `sources-v2` and `resolve` test that path with fixture providers. The journeys run the same
   on Node 22.18 and 25.
2. **The setup helpers are shared**, not copied: `test/jobs/setup-helpers.ts` (from `setup-v2.test.ts`; `posting` now
   returns the role id).
3. **G's seniority drop** uses "Senior Marketing Associate" (a title of hers with a senior word); "Senior Marketing
   Manager" drops on title, which is right for someone who wants marketing associate roles.
4. **The top bar takes two rows up to 1440 px** (was 1280): with 14 px type the one-row bar no longer fits below that.
   Find stays on the tabs' row down to a 720 px frame (tighter tab padding).
5. **The example is a v0.4 note**; v1 notes stay covered by `berlin-analyst` and `us-nurse` (`roles.titles`,
   `boards:`-era shapes are tested in `sources-v2`).

## 3. Tests
- `journeys.test.ts` (7): one per persona, outputs captured.
- `owner-acceptance.test.ts` (1).
- `a11y-ui.test.ts` (4): every screen in light, in dark; the keyboard; the setup card and top bar for a new user.
- `ui-layout.test.ts`: the pane at 720 px as well as 900; the wide test at 1600.
- `ui.test.ts`: Today's empty states, the setup card's waiting, cancel and failure states.
- `schedule.test.ts`: "No sources yet" in the top bar; `state.sources.listed`.
- `setup.test.ts`: the setup line for a new vault; doctor with another Crewdeck on the port.
- `forms-any-language.test.ts`: accented resume labels.

## 4. Done (2026-11-20)

**Built:** everything in §1. `npm test`: Node 25 638 tests, 636 pass, 2 skipped; Node 22.18 638, 624 pass, 14 skipped
(from 623; 15 new).

**Persona journeys** (each ends with `jobs check` clean, every kind of job passing, the funnel line adding up):
- **E** in-backend-remote: 17 remote boards proposed ("…limited to the US or Europe"), LinkedIn placed first and off;
  6 postings → 3 pass (a USD range converted to INR passes, a low one drops on pay, "US only" drops on place); 2 fit,
  2 picked; an English form (Expected CTC sensitive, PAN never filled); panel ready.
- **N** us-nurse-nights: no US nursing board, said plainly; the hospital added by its careers page; 6 → 3 pass (a $30
  bottom drops on the $38 floor, "Nursery Assistant" and Toronto drop); the day-shift posting judged no; Monday's
  availability "Overnight" from her night shifts, SSN never filled; with `cooldown_scope: role`, another unit at the
  same hospital passes after she applied to one.
- **A** de-accountant: Arbeitsagentur proposed with keywords from her titles; "Finanzbuchhalter (m/w/d)",
  "Bilanzbuchhalter*in" and "Buchhalterin (m/w/d) Teilzeit" pass, "Steuerfachangestellte" and München drop; the German
  form: Anrede, Geburtsdatum and Gehaltsvorstellung sensitive, Steuer-ID never filled; the brief says to answer in
  German citing English facts through approved translations.
- **R** in-retail-pune: no Indian job board, said plainly; a Darwinbox-shaped careers page added; "₹3-4 LPA" against a
  ₹30,000 monthly floor passes, "₹2.4 LPA" drops, Mumbai drops; the Indian form (Aadhaar, PAN never filled; Father's
  name, marital status sensitive); the panel shows the walk-in with where and when.
- **G** ph-graduate: Kalibrr proposed (never JobStreet); "Marketing Associate (Fresh Grad)" passes, "Senior Marketing
  Associate" drops on level, Cebu on place; SSS number never filled.
- **W** us-warehouse-noresume: facts from his answers and a career break; a structured `PART_TIME` passes and
  `FULL_TIME` drops; Saturday "Evening" from his shifts; job 1 filled from his notes and "Add another employment"
  pressed once.
- **F** es-translator: European boards (WTTJ first); "Traductor/a inglés-español" at €5,000 a month passes against a
  €200 day rate, €3,000 a month drops, a per-word posting is kept for the judge, "EU only" passes from Spain, a US-only
  one drops; the Spanish form (DNI/NIE never filled, pretensión salarial sensitive, "Currículum" an upload).

**The owner's acceptance re-run:** the notes as setup writes them pass 16 of 1,480; the preview's fix ("Add 5 title
variants: 186 more pass") previewed with `--search-file`, then saved: **202 pass**. All 259 postings limited to another
country are dropped, the 92 with his own titles on place (`other_only`). LinkedIn's roles in the first 40 candidates:
6 when it is first, 2 when last; passes unchanged. Find: one batch of 10 judged, 5 picked (one per company, his "Senior
Backend Engineer" first): "1,480 fetched → 202 passed your rules → 10 judged → 10 fit".

**D41, per screen** (`a11y-ui.test.ts`, `sources-ui.test.ts`; light and dark; 0 texts under 14 px, 0 under 4.5:1,
0 unlabelled controls, 0 out of the Tab order): top bar (on every screen), Today (Why so few?, the queue, a role with
a first-time question and the apply panel, the Not interested dialog), Applications, What Claude knows (each of its
five tabs), Settings and its confirm, the setup card (and its waiting state), Sources, Preferences, the apply panel's
walk-in and account-needed states. Before the CSS change the same check found the top bar at 13 px on every screen, 22
small texts on What Claude knows and 24 on Settings, and contrast down to 3.5:1 (`--muted` text in light).

**The rehearsal** (a brand-new home in the scratchpad: `CREWDECK_HOME=<tmp>/home node src/cli.ts setup --vault
<tmp>/Crewdeck/vault --no-plugin`, which put the jobs folder at `<tmp>/Crewdeck/jobs`; ports moved to 5461/5462 in
that home's config before `crewdeck up`; the Jobs page in the in-app browser pane, light and dark, at 800 px):

Fixed:
1. `crewdeck setup` on a new vault said "✓ kept your me/profile.md, …": it now says "job notes ready for setup to fill
   in" for notes that are still the template.
2. The top bar before any source said "0 new roles waiting · fetched just now" with **Refresh sources** (a fetch with
   nothing to fetch): it now says **No sources yet** with **Open Sources** (`state.sources.listed`).
3. **Set up with Claude** with no session connected said "Waiting for Claude to start the setup" forever: it now says
   "Waiting for a Claude session" and what to do, with **Cancel**; a cancel no longer shows as a red "Setup stopped".
4. Sources before setup said "Add the suggested ones from the catalog below" with nothing suggested: it now says
   setup proposes some.
5. The Preferences preview with nothing fetched pointed at **Refresh sources** (absent before sources exist): it says
   where sources come from.
6. Today's empty state after setup said "click Find 5 jobs" with nothing fetched: it now points at Sources or
   **Refresh sources** first.
7. The D41 pass on the rest of the page (above); the top bar's two rows up to 1440 px and tighter tabs so Find stays
   beside them at the pane's width (at 800 px Find had a row of its own, and "No sources yet" was cut to "No…").
8. A Spanish "Currículum *" upload was planned as a plain file, not the resume (accents weren't folded).
9. `crewdeck doctor` reported another Crewdeck's session as this one's when another home's server held the port: it now
   says "another Crewdeck answers on port N (its notes: …), not this one".

Open (not in scope, or for the owner to decide):
- The shell around Jobs (rail labels 10.5 px, breadcrumb and "Open alone" 11–12 px, `--muted`) is outside the Jobs
  page's D41 pass.
- Fixed after P9i: Notes' home now names `me/preferences.md` "Other things Claude should remember" and links the job
  search notes; the coverage line names fields in plain words ("software and IT"), with a test; the no-session banner
  says to start a Code session in that folder and that `crewdeck setup` installs the plugin. (The banner and the setup
  card don't show together: the banner is hidden while setup is needed.)
- The other screenshots in `docs/img/` predate P9i's type sizes (only the setup card and Sources were retaken).
- The doctor check above was found because a `doctor` run on a second rehearsal home, still on the default port,
  read the owner's running Crewdeck on 4848 once (`GET /api/jobs/state`, read-only, nothing sent or changed). That
  home was moved to 5463/5464 straight after.

Screenshots of the rehearsal: `before-*`, `after1-*` and `after-*` PNGs (light and dark, every screen) in the session's
scratchpad, and the D41 shots from `CREWDECK_SHOTS=<dir> node --test test/jobs/a11y-ui.test.ts`.

**Deviations**
- Decisions 1–5 above.
- `posting()` in the shared helpers returns the role id (setup-v2 ignores it).

**Deferred (v0.4 overall)**: a packaged installer, a mobile client and UI translations (D40); providers for uncovered
markets (only through career-ops and the reviewed re-pin); a resume photo; reading repeated form blocks headlessly;
full-date employment fields; an `authorized_in` rule from structured visa fields and a rule for a posting's own hours;
rule words beyond seven languages; gathering the page's strings in `web/jobs/strings.js` for later translations
(§24.13; the UI stays English); drag to reorder; the shell's own D41 pass;
retaking the older screenshots.
