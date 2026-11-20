# P9g: work pattern, pay and rules data

Part of [the Jobs design](../design.md): read §24.8 (D29–D31, D36, D37), D38, §24.12 (personas), §23 question 6 and §22
row P9g first. Rules: [README.md](README.md). Builds on P9a (`roles.employment_type` stored from JSON-LD and providers),
P9c (the title matcher, `roles.level`), P9d (preview, funnel), P9f (setup v2, whose `judge_notes` stand-ins move into
the real fields here).

## 1. Scope
- **Pay (D29):** `pay.period` is `year | month | week | day | hour`; `pay.hours_per_week` and `pay.days_per_week` drive
  every conversion (else the most of `work_pattern.hours_per_week`, else 40 hours over 5 days). `pay.per_unit` is the
  user's words for per-word or per-project rates: printed in the brief, never a floor. A posting paid per word, page,
  line, project, visit … (any of the catalog languages) is `unclear` with that reason, never compared with the floor.
  An ambiguous currency sign that can be the user's own ("Rs." for someone paid in INR) is read as theirs.
- **Work pattern (D30):** `work_pattern: { hours_per_week: { min, max }, shifts, shifts_avoid, term_time_only }`, shifts
  from `day | evening | night | weekend | rotating | on-call`. The judge's, with "never infer what the user didn't list".
- **Employment types (D30):** `freelance`, `fixed-term`, `seasonal`, `apprenticeship` join the list. A **structured**
  `employment_type` (JSON-LD, a provider's field) is a hard drop (`employment_type`, group `employment`) when none of
  the kinds it can mean is wanted; the mapping is data (`rule-words.yaml → employment_types`: `CONTRACTOR` is contract
  or freelance, `TEMPORARY` temporary, fixed-term or seasonal, `INTERN` internship or apprenticeship, `Teilzeit`
  part-time …). Any unknown value (VOLUNTEER, OTHER) and every word in a title or description stays the judge's.
- **Level and languages (D31):** CEFR `A1`–`C2` accepted next to the words, printed with both ("German (C1, fluent)")
  and the mapping; licences are text or `{ name, where }` (a new `alt` shape in the schema language), printed
  "RN (Ohio)"; the brief compares years with `standard_answers.years_experience`.
- **Moving and right to work (D37):** `places.relocate_to` joins the on-site place set (the brief says they'd move);
  `places.authorized_in` is the judge's ("fail postings that require the right to work outside these and say they
  can't sponsor").
- **Cooldown (D36):** `schedule.cooldown_scope: company | role` and `schedule.per_company` (1–10). One tracker module
  (`pipeline/tracker.ts`) is now the only place the prefilter, the preview, `pick`, pasted links and the Find counts
  ask about cooldowns and roles in progress. DB v3 adds `roles.applied_at` (backfilled from the "applied" status
  event).
- **Rule words per language (D38):** `src/jobs/data/rule-words.yaml` holds, for en, de, fr, es, pt, it and nl, the
  workplace words, travel words, place restrictions ("only …", "must reside in", "excluding", "not open to", "are not
  eligible", the filler between place names) and industries; `rule-words.ts` builds the same regex shapes as before
  from them. A hybrid word inside a remote phrase ("100% Homeoffice") is remote only. The gazetteer gains UK nations,
  German, Spanish, Indian, Australian and Philippine states, and countries' names in the catalog's languages.
- **Brief:** shifts and hours, term-time, level and years, licences with where, right to work, moving, per-unit pay,
  CEFR, and "postings in any language: quote the evidence in the posting's words".
- `exclude.travel: off` (v1's `none` still reads as off and validates).
- **Preferences screen:** pay period (five), hours and days a week, per-unit text; a "How you work" card (employment
  types, shifts can/can't, hours, term-time); moving and right to work under Where; the cooldown's scope and roles per
  company under Daily. Optional numbers can be emptied (the key goes); a licence written as a map goes back as the same
  map; every other key and comment stays (Document API).
- Skills: `jobs-setup` writes the real fields (no more `judge_notes` stand-ins; the cooldown proposal is now 14 days with
  `cooldown_scope: role` for the five fields), `crewdeck-memory` routes them, `jobs-daily-run` names them; the vault
  template shows them.

## 2. Decisions
1. **Conversion uses the user's hours, not the posting's.** The design's rule: a monthly wage is compared as if worked at
   the user's hours. W's $2,000 a month is $19.23 an hour at his 24 hours (it would be $11.54 at 40).
2. **Role scope compares whole titles**, folded to words ("RN – ICU Nights" = "rn icu nights"), so two units at one
   hospital pass and a repost of the same title waits. The company's `cooldown_until` is still written at apply, so
   switching the scope back works without a migration.
3. **Employment drops need certainty:** every listed value must be known and none wanted. "FULL_TIME, PART_TIME" passes
   for part-time.
4. **English rule words moved to data with the same shapes** (the existing English cases pass unchanged), plus a guard
   that "only" right after a negation ("not only", "nicht nur") is no restriction.
5. **Separators:** in rule-word entries a space or hyphen matches a space or hyphen; a one-word form is listed apart
   ("onsite"), so German "Homeoffice" (hybrid) never reads as Brazilian "home office" (remote).

## 3. Tests
`work-pay.test.ts`, per persona, every one from its own `search.md` data:
- **N:** "RN - Night Shift" passes; hourly floor with 36 h over 3 days (weekly $1,500 passes, $1,200 drops; a $480 day
  passes, $400 drops); Cincinnati passes through `relocate_to`, Toronto drops; `PART_TIME`/`PER_DIEM` pass, `CONTRACTOR`
  drops, `VOLUNTEER` is the judge's; a day-only posting is never a rule; the brief's shifts, hours, licences with
  where, right to work and moving; role-scoped cooldown lets a second unit through and holds the same title; company
  scope holds both; `per_company: 2` picks two at one hospital and drops a third as `active_pick`.
- **W:** $2,000 a month passes at 24 h (and is below at 40 h), $1,400 drops; `FULL_TIME` drops, `PART_TIME`,
  `TEMPORARY` and "Part-time, Full-time" pass; the brief's 20–24 hours.
- **F:** a day rate against a monthly posting (€2,400 drops, €4,500 passes), €25 an hour = €200 a day; "0,06 € por
  palabra" and "$0.10 per word" are `unclear` with her rate in the reason; Spanish rule words ("solo residentes en
  España" passes, "Solo candidatos residentes en México" drops, "Presencial" is on-site).
- **A:** "Homeoffice möglich" is hybrid, "100% Homeoffice" remote only; "Wohnsitz in Österreich", "nur Bewerber aus der
  Schweiz" drop, "nicht nur in Berlin" doesn't; "Reisebereitschaft" and "regelmäßige Reisetätigkeit" are travel,
  "keine Reisetätigkeit" isn't; "Sportwetten" is gambling; "German (C1, fluent)" in the brief.
- **T:** term-time in the brief, an all-year posting left to the judge, "Scotland only" drops for Leeds, QTS (England).
- **R:** "3-4 LPA" drops on the bottom of the range (₹25,000 a month) and passes on the top; "Rs." is the user's rupee;
  "Maharashtra only" passes for Pune, "Karnataka only" drops.
- **Refilter round trips:** a structured type and a pay drop come back after a preference change and drop again after
  the change back; R's "3-4 LPA" comes back after switching to `top_of_range`, with its monthly pay stored.
Also: `sources-ui.test.ts` (Preferences in Chromium: D41 in light and dark, keyboard-only save), `api.test.ts` (the new Preferences fields, a licence map kept, an emptied number removed, an unknown key and its
comment kept, bad values refused by field), `ui.test.ts` (the new controls), `places.test.ts` (UK nations, new states,
local names), `skills.test.ts` (the setup skill names the fields, no stand-ins), `setup-v2.test.ts` (N and W write
`work_pattern`, `relocate_to`, `authorized_in`, `cooldown_scope`).

## 4. Done (2026-11-20)

**Built:** everything in §1. `npm test`: Node 25 608 tests, 606 pass, 2 skipped; Node 22.18 608, 594 pass, 14 skipped.

**Visual check:** a temp home on port 5342 in the in-app browser pane, light and dark: the Preferences screen's Where,
How you work, Pay and Daily cards; a shift ticked with Space after Tab, saved with Enter, logged under Changes. The
whole Preferences screen now meets D41 (rem type, nothing under 14 px, secondary text in `--soft`), checked by
`sources-ui.test.ts` in a headless Chromium in both themes (every text ≥ 14 px and AA, every control labelled) with a
keyboard-only save.

**Deviations**
- The design writes cooldown keys under `schedule` (`cooldown_scope`, `per_company`), which is what was built (the
  brief's shorthand "scope: company|role" is that key).
- `pay.per_unit` postings are detected by unit words in the pay text, not only by a missing period, so "€0.08/word"
  never reads as a weekly rate.
- The brief also prints the user's years of experience when `roles.level` is `any` (the comparison helps every level).
- `rule-words.yaml` also carries the structured employment-type mapping (one data file for the rules' words).

**Deferred**
- An `authorized_in` hard rule from a provider's structured visa field (`roles.visa_text` is kept but its wording varies
  too much for a near-certain drop); the judge reads it.
- Splitting a posting's own hours ("20 hours a week") into a rule: the judge's for now.
- Per-language rule words beyond the seven catalog languages (sv, da, no, fi, pl …): data-only additions later.
