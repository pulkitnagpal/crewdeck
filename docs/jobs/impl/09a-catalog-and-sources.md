# P9a: the source catalog and sources v2

Part of [the Jobs design](../design.md): read §24.2 (catalog, the user's list, state, priority, LinkedIn), D18–D22, D25,
D39, D42, §23 questions 3 and 4 (decided), and §22 row P9a first. Rules for every implementer: [README.md](README.md).
The audit behind it: [09-generic-audit.md](09-generic-audit.md) (findings 1.3, 1.4, 2.1, 3.14, 4.1–4.8, 5.3, 7.2).
Employers (resolve, the `source` request) are P9b: [09b-employers.md](09b-employers.md).

## 1. Scope
- **Catalog.** Finish `src/jobs/data/sources-catalog.yaml`: settle every `unsure:` entry against the pinned providers'
  code (installed into a temp home), fix `detect` (it means "a bare careers_url auto-routes here", which is narrower than
  the manifest's `detectors` list), add `fill` rules and `blocked`. A loader with validation (`src/jobs/catalog.ts`) and
  a test that the catalog's ids are exactly the manifest's providers plus its excluded providers.
- **`jobs/sources.md` v2.** One ordered `sources:` list: `key`, `name`, exactly one of `provider` / `careers_url` /
  `url` (+ `fetch: none`, `why`), optional `employer`, `added`, `enabled`, provider option blocks; the LinkedIn mirror row
  (`linkedin: search`). v1 `boards:` then `watchlist:` are read when `sources:` is absent; the first write migrates them.
- **Commands** (`src/jobs/sources-cmd.ts`, dispatched from `crewdeck jobs sources`):
  `list [--json]`, `suggest [--json]`, `add (--provider <id> | --careers-url-file f | --url-file f | --linkedin)
  [--name-file f] [--employer] [--at N]`, `remove <key>`, `move <key> (up|down|first|last|--to N)`, `enable <key>`,
  `disable <key>`. Names and URLs only from files (D11); provider ids and keys are checked words.
- **DB migration v2:** `roles.source_key`, `language`, `visa_text`, `employment_type` (+ an index on `source_key`).
- **Fetch:** the plan follows the list order; `fill` rules fill keys from the notes at fetch time (never written to the
  note); LinkedIn runs at its row's position (providers before it, LinkedIn, providers after, one shared request budget
  and deadline). `crewdeck jobs source --only-new-sources` fetches only sources with no state yet.
- **State:** `state/sources.json` gains `by_key: { <key>: { at, ok, jobs, new, kept, refused, error, ms, why } }` and the
  last five runs per key (`history`).
- **Priority in rank (D21):** `SOURCE_RANK` by kind is replaced by a bonus by position (first +12 → last 0); pasted +15,
  manual/alert +12 as before, an unknown key +3. Never a filter.
- **Providers' extra fields:** `language`, `visaText`, `employmentType` kept through the runner and `cleanJob`.
- **Presets → catalog queries (D39):** the four preset `sources.md` files go; `--preset` stays as a deprecated alias that
  seeds `search.md` and writes `sources suggest`'s proposal for the preset's query as the initial list.
- **Skills:** jobs-setup's "Where to look" uses `sources suggest` / `sources add`; the workspace CLAUDE.md and
  jobs-daily-run say sources change through `crewdeck jobs sources …`. Setup v2 proper is P9f.

Not in P9a: resolve, `set-url` and the `source` request (P9b); title targets' matching (P9c; P9a reads only
`roles.targets[].titles` and `.families`); the Sources screen (P9e).

## 2. Modules

| File | What |
|---|---|
| `src/jobs/data/sources-catalog.yaml` | settled entries; `fill` rules; `blocked` |
| `src/jobs/catalog.ts` | `loadCatalog()`, `catalogIssues()`, `catalogEntry(id)`, `FAMILIES`, `KINDS`, `fillEntry(entry, cat, notes)` |
| `src/jobs/suggest.ts` | `profileOf(notes, query?)`, `suggestSources(notes, query?)` → `{ sources: [{ id, name, score, reasons }], coverage }`, `coverageLine()`, `PRESET_QUERIES` |
| `src/jobs/sources-note.ts` | `sourceItems(raw)` (v2 or v1 merged, keys), `editSources(file, op, ctx)` (Document API, migrate, Changes line), `newKey()` |
| `src/jobs/schema.ts` | sources v2 schema + cross checks (keys, one target, runnable, retired, blocked, mirror once); `roles.targets` (titles, families) |
| `src/jobs/sources.ts` | `sourcePlan` over v2 with keys, fill and skip reasons; segments around LinkedIn; `by_key` state; `only_new` |
| `src/jobs/migrations.ts`, `db.ts` | v2 columns; `upsertRole` stores them |
| `src/jobs/pipeline/rank.ts` | position bonus |
| `src/jobs/setup.ts` | presets as queries |

## 3. Decisions
1. **`detect` follows the code.** The manifest lists every provider whose file contains `detect(`; 30 of them only
   match `provider: <id>` or explicit config, or have no detect at all (builtin's comment matched the regex). The catalog
   says `detect: false` for those, and a test checks `detect: true` ⇒ in `manifest.detectors`.
2. **Confidence grades what Crewdeck acts on** (kind, needs, config, detect, regions, families, workplace, languages). An
   ATS's `note` (who typically uses it) is market knowledge by nature and is labelled as such in the header.
3. **Fill DSL** (data, not code): `fill: { <dotted key>: { from: titles|first_title|onsite_place|country|country_name,
   max?, map?, format?, required? } }`. A key the user set keeps their value. A required fill that can't be made skips
   the source with the reason the Sources screen will show ("needs keywords: they come from your titles; add a title").
4. **Keys** are slugs of the name (or provider), never reused: a new key also avoids every key in the state file's
   history and in the tracker's `roles.source_key`.
5. **v1 → v2 order** is boards then watchlist; watchlist entries become `employer: true`. Generated keys are stable for
   an unchanged v1 note (same input → same keys), so roles fetched before the first save keep their `source_key`.
6. **A missing LinkedIn row** means LinkedIn runs last (as before) when the switch is on.
7. **`blocked: true`** in the catalog (themuse: Cloudflare challenges every request) keeps a source out of suggestions
   and gives a warning in `jobs check`; it may still be added by hand.

## 4. Tests
Catalog ↔ manifest sync, families/regions valid, every `fill` rule; v1 read and merge (bytes unchanged on read, one
migration on first write); validation (unknown/excluded/retired/blocked provider, duplicate keys, two targets, mirror
twice, enabled on the mirror); every command (files only, refusals); suggest for the seven personas (expected sources and
coverage line); priority changes candidate order and never revives a dropped role; plan order and LinkedIn position;
`--only-new-sources`; `by_key` state; migration v2 on a v1 database; presets as queries.

## 5. Done (2026-11-20)

**Built**
- **Catalog settled** against the pinned providers' code (installed into a temp home; every `unsure:` entry and every
  `detect: true` entry read): 32 entries went to `detect: false` (their detect() returns null, matches only
  `provider: <id>` or explicit config, or doesn't exist: builtin, glints, sitemap, wttj, tes, jobstreet, kalibrr, occ,
  google, consider, getro, himalayas, weworkremotely, radancy, rexx, …); `config` gained the keys the code really reads
  (mostly `api` and detail options); regions corrected where the code names hosts or country domains (factorial's 17
  country domains, zoho-recruit's data centres, adp-workforcenow and icims add Canada, nofluffjobs is `pl` only, phenom is
  `world`); coverage lines fixed where the constants disagreed (a16z 6×50, wttj 100/200/1000, telegram since_days
  uncapped, …). The glints discrepancy: the manifest lists it as a detector because its file has a `detect()`, which
  always returns null: `detect: false`. `blocked: true` for themuse; `fill` rules for arbeitsagentur, builtin, occ, wttj,
  apple, google, amazon, jobstreet (market host + site key by country), glints (country code), kalibrr.
  **Confidence: before 59 high / 75 medium / 11 low; after 65 high / 77 medium / 3 low** (collage, comeet, flowxtra:
  nothing in their code names a country). Every medium/low entry says what the code could not confirm.
- `src/jobs/catalog.ts` (loader, `catalogIssues`, `fillEntry`, `userTitles`, `userCountries`), `src/jobs/suggest.ts`
  (scoring, coverage line, `PRESET_QUERIES`), `src/jobs/sources-note.ts` (v2 reader/writer, migration, keys, shared
  `listSources`/`changeSources`), `src/jobs/sources-cmd.ts` (`crewdeck jobs sources list|suggest|add|remove|move|enable|
  disable`), schema v2 for `jobs/sources.md` plus `roles.targets` (titles, families), DB migration v2, the plan in list
  order with fills and skip reasons, LinkedIn at its position (two sandbox runs sharing one budget and deadline),
  `by_key` state with kept counts and five runs of history, `--only-new-sources`, the position bonus in rank, providers'
  language/visa/employment type kept, presets as catalog queries, the v2 vault template and example, skills and docs.
- Tests: `catalog.test.ts` (sync with the manifest, detect, confidence, each fill rule), `suggest.test.ts` (the seven
  personas E N A R G W F with their sources and coverage lines), `sources-v2.test.ts` (v1 read and merge, validation,
  every command and refusal, key reuse, plan, priority vs rules, migration v2, provider fields, a sandboxed fetch in
  priority order with per-source state and `--only-new-sources`), updated rank/schema/setup/skills/sources tests.

**Deviations**
- Doc name: this file follows design §22 (`09a-catalog-and-sources.md`), not the brief's `09a-sources.md`.
- `roles.targets` is accepted now (titles and families only) because suggest needs the targets' families; P9c adds
  variants, `match:` and the matcher. LinkedIn guest search already uses each target's first three titles (D22).
- Fill DSL is data in the catalog (`from`, `max`, `map`, `format`, `required`) instead of per-provider code.
- A missing LinkedIn row means LinkedIn runs last (as before) and ranks last.
- `add --url-file` writes `url` + `fetch: none` + a "not checked yet" reason; P9b's `resolve` turns it into a careers
  page or keeps it as "paste its postings".
- The non-engineering preset is the query `families: [any]` (general boards only).

**Deferred**
- `resolve`, `set-url` and the `source` request: P9b. The Sources screen and its page action UI: P9e. Setup v2's
  interview flow around `suggest`: P9f. Title matching over targets in the gate and rank: P9c.
- Boards that need a search URL (computrabajo, nofluffjobs, justjoin) are not proposed by `suggest`; they can be added
  by hand with their URL.
