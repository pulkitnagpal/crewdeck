# P9f: setup interview v2

Part of [the Jobs design](../design.md): read §24.4 (D24, D25, D27), §24.10 (D34), §24.12 (personas), §23 questions 6
and 8, D42 and §22 row P9f first. Rules: [README.md](README.md). Builds on P9a–P9e: `sources suggest|add|resolve|set-url`,
the coverage line, `source --only-new-sources`, the title matcher and `roles.targets`, `crewdeck jobs preview`, the
Sources screen.

## 1. Scope
- **`jobs-setup` rewritten** in the design's order: (1) resume or no resume as equal paths, plus the starting-out,
  changing-field and career-break situations; (2) who they are, with right to work as a standard answer; (3) their
  career, word for word; (4) the kinds of job (targets with titles in every local language, variants, abbreviations and
  families, explained by how the matcher reads titles), level, where (moving, right to work), workplace, how they work;
  (5) where to look: `suggest` with its coverage line said plainly, LinkedIn placed but never switched on, employers added
  and resolved; (6) fetch once with `--only-new-sources`, then the preview loop (`by_target`, near misses, suggestions;
  each change previewed with `--search-file` before it is written); (7) pay, languages, licences with where,
  exclusions, picks, time zone, the cooldown proposed by field; (8) `jobs check` and a closing line from real numbers.
- **Setup card** copy: with or without a resume, where to look, the preview, honest about fields with no board; review on
  the Sources and Preferences tabs. D41 type sizes on the card.
- **`jobs-daily-run`**: priority (judge in the order `candidates` gives, never reorder; LinkedIn at its place) and the
  close line built from `run.funnel` in a fixed order (picks, funnel line, the cause, sources that returned nothing).
- **`crewdeck-memory`**: a new kind of job or titles (`roles.targets`, the whole list kept, previewed first); where to
  look (`sources add|remove|move|enable|disable|resolve`, LinkedIn placed only).
- **`jobs-workspace`**: the setup close line.
- Small code the interview needs: `preview` reports `by_target` (passes per kind of job, also printed as "By kind of
  job"); `sections[].break: true` lets a career break have no organisation; the vault template shows `roles.targets`
  and `roles.level`; the Sources screen says what the proposal needs before setup instead of "boards fit anywhere".

Not in P9f (P9g): `work_pattern`, `relocate_to`, `authorized_in`, `cooldown_scope`, `per_company`, new employment types.
The skill writes shifts, hours, moving and right to work into `judge_notes` in the user's words (moving cities also into
`places.onsite`, which is what `relocate_to` will do); a comment in `schema.ts` marks where those fields arrive.

## 2. Decisions
1. **Variants are written per target.** The preview's variant fix carries `pref` paths such as `roles.targets[0].titles`,
   so `pref set` changes that target's titles and nothing else on it; the skill uses them as given.
2. **The cooldown proposal is the skill's**, from the design's list (14 days for healthcare, education, retail,
   hospitality-food and logistics-transport; 60 otherwise). It is a proposal the user confirms; no code applies it, and
   scope by role waits for P9g.
3. **A career break** is `{ kind: experience, title: Career break, break: true, dates }`: the schema accepts no `org` only
   with `break: true`, so a missing organisation elsewhere is still caught. Informal work gets the organisation the user
   would name ("Self-employed", the app).
4. **Fetching on a fresh home** can't run (no providers, or Node < 25): the skill says so in plain words and goes on;
   pasted postings and the page's preview work meanwhile.

## 3. Tests
`setup-v2.test.ts`: three people from the empty templates, every step through the CLI commands the skill names, values
and the user's words from files:
- **E** (backend engineer, India, remote, resume): targets, level, remote from India; `suggest` proposes remote boards
  and the line says "remote work from India for engineering-it"; LinkedIn placed first and not switched on; the fetch
  says why it can't run; six pasted postings; the first preview passes 2, its variant fix previewed (`--search-file`:
  4, was 2) and written per target; ends with 4 passing and the US-only posting still dropped.
- **N** (RN, Columbus, nights, hourly): no board (`suggest` empty, the coverage line says so and what still works); the
  hospital's careers page added, `resolve` refused on a fresh home with the note unchanged; nights in `judge_notes`;
  USD 38 an hour, bottom of range; 14-day cooldown; the two night RN postings pass, "Nursery Assistant" and Toronto drop.
- **W** (warehouse and driving, Houston, no resume): sections and facts from his answers, gig work as "Self-employed", a
  career break with `break: true` (and an experience without an organisation still refused); two targets; licences
  with where; each target passes.
Each ends with `crewdeck jobs check` at "0 errors, 0 warnings" and `preview --json` showing ≥ 1 pass per target.
`skills.test.ts` checks the skill's steps and order, the cooldown rule, the daily run's sources line and the memory
skill's targets and sources rows, and the command lint covers every new line. `sources-ui.test.ts` checks the setup card
(no text under 14 px, AA contrast, light and dark); `sources-screen.test.ts` the pre-setup Sources message.

## 4. Done (2026-11-20)

**Built:** everything in §1. `npm test`: Node 25 537 tests, 535 pass, 2 skipped; Node 22.18 537, 523 pass, 14 skipped.

**Visual check:** a new user's temp home on port 5334 in the in-app browser pane: the setup card in dark and light,
reached and sent with the keyboard only (Tab to **Set up with Claude**, Enter: "Waiting for Claude to start the setup");
the Sources tab before setup says what the proposal needs.

**Deviations**
- `preview` gained `by_target` (not in the design's output list): setup needs to see that each kind of job catches
  something, and Find's preview can show it later.
- `sections[].break` arrives here rather than with P9h's other career fields, because the career-break path needs it.
- The vault template now leads with `roles.targets`; `roles.titles` stays as "more titles".

**Deferred**
- P9g's fields (above), with the skill's `judge_notes` stand-ins to move into them then.
- `docs/jobs/first-run.md` v2 and the README: P9i.
- A real fetch inside the scripted setup (it needs the sandbox and installed providers; P9a/P9b test that path with
  fixture providers on Node 25).
