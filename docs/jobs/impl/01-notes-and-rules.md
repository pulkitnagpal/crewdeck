# P1: notes and rules (user knowledge in the vault, compiled rules, pay, gazetteer)

Part of [the Jobs design](../design.md): read §2.1, §2.5, §7, §8, §12 and §22 row P1 first. Rules for every implementer:
[README.md](README.md). This phase adds no server, UI or database code: only the notes Claude and the user share, their
validators, the rules compiled from them and the `crewdeck jobs` commands that read and write them.

## 1. Scope
- Read and write Markdown notes whose structured part is YAML frontmatter, without losing comments, key order or the
  body; atomic writes; a last-valid fallback when the user's edit breaks a note.
- Schema v1 validators for the five notes (§7.2–7.6) with messages that name note, field path and fix.
- A gazetteer with containment, pay parsing and conversion, and the rule compiler + judge brief (§7.8).
- `jobs` section in `~/.crewdeck/config.yaml` (feature switches all off).
- `crewdeck jobs check | rules | judge-brief | me set | pref set | remember | features`.
- Note templates in `vault-template/`, one complete fictional person in `examples/jobs/`, two fixture people in
  `test/fixtures/jobs/people/`.

Not in P1: the database (company cooldown and active-pick drops, `refilter`, `avoid` as a role action: P2), the
`crewdeck-memory` skill text (P4), `jobs init` and presets (P4), provider allow-list from the manifest (P5).

## 2. Modules and API

| File | What |
|---|---|
| `src/jobs/notes.ts` | `splitNote`, `readNote`, `writeNoteAtomic`, `setInDoc` (keeps the old node's comment and flow style), `NOTES` (name → vault path), `loadJobNotes(vault, home)` → per note `{ data, issues, source: note \| last-valid \| empty }` plus cross-note issues. Last-valid cache: `<jobs.home>/state/last-valid/<note>.json` (dir 0700, file 0600), written only when the content changed |
| `src/jobs/schema.ts` | A small schema language (`str`, `num`, `bool`, `oneOf`, `list`, `obj`, `map`, `date`), `validate(note, data)` → issues, `normalise.<note>(data)` → typed values with defaults, `schemaAt(note, path)` (for typed `set` values), cross-checks, `didYouMean` |
| `src/jobs/places.ts` + `src/jobs/data/places.yaml` | Gazetteer: regions (with containment), all countries, US states, Canadian provinces, 346 major cities with coordinates. `lookupPlace`, `findPlaces(text)`, `within(a, b)`, `compatible(userPlace, postingPlace, commuteKm)` |
| `src/jobs/pay.ts` | `parsePay(text, { dollar })` → native currency(s), min/max, period; `convertAmount`; `payCheck(text, settings)` → `ok \| below_floor \| unlisted \| unclear \| no_rate`; `findPayText(description)` |
| `src/jobs/rules.ts` | `compileRules(notes)` → named regexes + place sets + pay; `prefilter(posting, compiled)` → `{ keep, rule?, reason? }`; `describeRules(compiled)` (for `jobs rules`); `judgeBrief(notes)` |
| `src/jobs/memory.ts` | `remember(file, input, today)` (ids `m-N`, idempotent, answers auto-supersede the same key), `retire(id)`, `activeMemory(items, company?)` |
| `src/jobs/edit.ts` | `setField(notes, which, path, raw, opts)`: typed coercion from the schema, validate before write, `## Changes` line for `pref set` |
| `src/jobs/cli.ts` | `crewdeck jobs <cmd>`, wired lazily from `src/cli.ts` |
| `src/config.ts` | `jobs` section: `enabled`, `home`, `workspace`, `browser`, `fetch_every`, `features`; `ensureJobsHome`; `setFeature` (Document API, keeps the rest of config.yaml) |

### Commands
- `crewdeck jobs check`: validates all five notes; prints errors and warnings; exit 1 on any error.
- `crewdeck jobs rules`: prints the compiled hard drops (names, sources, patterns) and the place sets.
- `crewdeck jobs judge-brief`: prints the judge brief.
- `crewdeck jobs me set <field.path> <value | - | --value-file f>`: `identity.*`, `standard_answers.*`, `education…`
  go to `me/profile.md`; `resume.*`, `sections…`, `facts…`, `skills` to `me/career.md` (a `profile.`/`career.` prefix is
  also accepted).
- `crewdeck jobs pref set <field.path> <value | - | --value-file f> --because-file <f>`: `jobs/search.md` (an optional
  `search.` prefix is accepted); appends `- <date>: <path>: <old> → <new>. "<the user's words>"` under `## Changes`.
- `crewdeck jobs remember --kind answer|fact|preference|style|avoid|company_rule --text-file f --quote-file f [--key k]
  [--scope all|company --company-file f] [--title-words-file f] [--supersedes m-N]`; `crewdeck jobs remember --retire m-N`.
- `crewdeck jobs features [<name> <on|off|number>]`: prints the switches; changing needs an interactive terminal
  (`process.stdin.isTTY`) and, to switch one on, typing `yes` after the risk text.

Values typed on the command line are short structured values (a path, `remote,hybrid`, `55000`); anything in the user's
words (because, text, quote, company) comes from a file or stdin. Lists are written `a,b,c` or as YAML flow (`[a, b]`,
`[{ name: German, level: fluent }]`).

## 3. Decisions (and where they deviate from or extend the design)
1. **Enrichments to schema v1** (all optional, defaults shown): `places.commute_km` (50), `pay.period` also accepts
   `week`/`day` in postings but the user's own period stays `year | month | hour` as in §7.4; `languages[].level` is one of
   `basic | conversational | professional | fluent | native`; `employment_types` as §7.4 plus `temporary`;
   `memory.items[].title_words` (avoid items only); `identity.preferred_name`, `identity.region`; `education[].start_year`.
2. **`exclude.travel` is the lowest travel level that drops a posting**: `frequent` drops frequent travel,
   `occasional` drops occasional or frequent, `none` (default) drops nothing. Travel stated as a percentage: ≥ 50 % is
   frequent, 1–49 % occasional; "no travel" sentences are ignored.
3. **City-to-city on-site checks use distance.** A posting city farther than `places.commute_km` from every on-site city
   is outside the acceptable set; cities without coordinates only drop when they are in another country. Remote
   postings are checked against `remote_from`, on-site/hybrid against `places.onsite`, unstated against both.
4. **Location drops** (rule `location_elsewhere`, from the old "names only other places"): the posting's location field
   names gazetteer places (reduced to the most specific ones, so "Munich, Germany" is Munich), and none is compatible.
   Unknown words are left to the judge. No noise list is needed because only gazetteer names count.
5. **Ambiguous names** (Cambridge, Georgia, London ON/UK) count as compatible if any reading is; qualifiers narrow them
   ("Cambridge, MA"). Codes of three letters or fewer (US, UK, EU, TX after a comma) match only in capitals.
6. **Pay**: bare `$` is ambiguous: candidates are USD and the user's currency when it is a dollar currency; `¥` is JPY or
   CNY; `kr` is SEK/NOK/DKK. A drop needs every reading below the floor. Amounts with no period are a year only when ≥
   10,000 (else `unclear`, kept for the judge). A currency with no `fx` rate is `no_rate` and kept. `"up to X"` has no
   bottom and `"from X"` no top: the missing end never causes a drop. Hours per year 2080, days 260, weeks 52.
7. **Title gate** is lenient (a title word may continue: `analyst` matches `Datenanalystin`); **exclusions** are whole
   words with an optional plural `s` (`intern` never matches `international`). Accents are ignored everywhere.
8. **Industries** expand a few common names to their usual words (crypto → web3, blockchain…; gambling → betting,
   casino…); any other industry is matched as written.
9. **Rule overrides** (`rules:` in `search.md`): names `title_gate`, `title_exclude`, `remote_words`, `hybrid_words`,
   `onsite_words`, `place_excluded`, `other_only`, `industry`, `travel_frequent`, `travel_occasional`. Each must compile
   (flags `iu`); `place_excluded`/`other_only` must contain a `(?<places>…)` group. Unknown names are errors with "did
   you mean".
10. **Memory**: an `answer` needs a `key`; a new active answer for the same key/scope/company supersedes the old one
    automatically; an identical active item returns the existing id; `company_rule` must be company-scoped. Items are
    written as one-line flow maps. Retire sets `superseded_by: retired`.
11. **Feature switches** are edited with the Document API so the rest of `config.yaml` (and comments) survive; numbers
    are capped (`daily_quick_apply` ≤ 25, `max_emails_per_day` ≤ 20) as validation errors, not silent clamps.
12. **New notes are written 0600**; an existing note keeps its mode. The last-valid cache is machine state (0600).
13. **Missing notes**: `check` reports an error with the fix (copy from `vault-template`, later `jobs init`); `rules` and
    `judge-brief` treat a missing note as empty and say so.
14. **Provider ids** for `sources.md` are validated against the career-ops provider list in
    `src/jobs/data/provider-ids.json` (minus `local-parser`); P5 replaces it with the manifest's allow-list.
15. **SilverBullet keys** ignored at the top level: `tags`, `aliases`, `displayName`, `pageDecoration`, `description`.

## 4. Test plan (node --test, temp dirs only)
- `notes`: round trip keeps comments, key order and the body byte for byte; replacing a value keeps its line comment;
  atomic write leaves no temp file; invalid YAML and invalid values fall back to the last valid version with the error.
- `schema`: messages name note + path + fix; unknown keys warn with "did you mean"; ignored SilverBullet keys; career
  cross-checks (fact prefix, duplicates); memory cross-checks; sources refuse `parser:` and unknown providers; all
  templates, examples and fixtures validate clean.
- `places`: aliases, containment chains, codes only in capitals, state codes after commas, worldwide, ambiguity.
- `pay`: a table over currencies, symbols, units, ranges, periods and number formats; conversion; floor rules
  (top/bottom, unlisted keep/drop, no rate, ambiguous `$`).
- `rules`: per fictional person (example, berlin-analyst, us-nurse) positive and negative postings: title gate and
  exclusions incl. avoid words, workplace, location elsewhere, place excluded, `<place> only` with containment,
  industries, travel, pay floor, companies and company rules, overrides; the judge brief contains the person's
  settings and none of the other people's places.
- CLI (child processes with a temp `CREWDECK_HOME` and vault): `check` exit codes, `pref set` frontmatter + Changes line,
  `me set` typed values and refusal of invalid ones, `remember` ids/supersede/retire, `features` refuses without a TTY,
  `config` jobs defaults and caps.

## Done
Built as planned in §2, with the decisions in §3.

- **Code:** `src/jobs/{notes,schema,places,pay,rules,memory,edit,cli}.ts`, `src/jobs/data/places.yaml` (26 regions,
  200 countries and territories, US states + DC, Canadian provinces and territories, 346 cities with coordinates), `src/jobs/data/provider-ids.json`;
  `src/config.ts` `jobs` section, `normaliseJobs`, `featureValue`, `setFeature`; `crewdeck jobs …` wired lazily in
  `src/cli.ts`.
- **Notes:** templates `vault-template/me/{profile,career}.md`, `vault-template/jobs/{search,memory,sources}.md`;
  `vault-template/CLAUDE.md` routes job preferences and learned answers through the commands. Fictional people:
  `examples/jobs/` (remote/hybrid product designer, EUR per month), `test/fixtures/jobs/people/berlin-analyst/`,
  `test/fixtures/jobs/people/us-nurse/`. All validate with no errors (templates: two "fill me in" warnings).
- **Tests:** `test/jobs/{notes,schema,places,pay,rules,cli}.test.ts` and three new `test/config.test.ts` cases; the
  whole suite is 160 tests, green with the leak scan; `npm audit --omit=dev --audit-level=high` clean.
- **Deferred:** company cooldown and active-pick drops, `refilter`, `not interested` as a role action (P2, need the
  DB); `crewdeck-memory` skill text and `jobs init` copying the templates into existing vaults (P4); provider ids from
  the manifest allow-list (P5); `jobs.enabled` gates nothing yet (the server reads it in P3).
