# P9 audit: the job journey for any person

Written 2026-11-19, before design v0.4 ([../design.md](../design.md) §24). Every step of the Jobs journey was walked as
nine fictional people and ten cross-cutting cases. Each gap has evidence (file:line, or a design §), who it hurts, a
severity and the fix or decision it became. Decisions D18–D42 are in design §5; phases P9a–P9i in design §22.

## Why

The owner ran Jobs as a new user: a senior engineer in India who wants remote work. Find returned **1 role out of 1,480
fetched postings**:
- the title gate (an exact phrase from `roles.titles`) dropped 1,375, including 281 engineering postings such as "Full
  Stack Engineer", "Tech Lead", "Senior Engineer" and "SRE";
- 92 were remote roles for other countries (a correct drop).

His sources came from a preset or were typed in by hand during the interview. Nothing maps "who I am" to "where to
look":
- the default `jobs/sources.md` is empty;
- the 137 providers in the manifest carry no metadata;
- nothing previews what a search catches;
- Find doesn't explain a tiny result.

The owner's verdict: the product was designed around one user.

## Method

- **Reading.** Read every skill, preset, note template, `src/jobs/*` and `web/jobs/*`.
- **Simulation.** Ran today's title gate (`compileRules` and `prefilter` in `src/jobs/rules.ts`) on realistic titles
  for each person; the results are below.
- **Providers.** Classified all 137 pinned providers plus the 8 excluded ones from upstream
  `docs/SUPPORTED_JOB_BOARDS.md` and each provider's own header and config code (career-ops @ f3b043d, a local
  read-only checkout). The draft catalog is [../../../src/jobs/data/sources-catalog.yaml](../../../src/jobs/data/sources-catalog.yaml).

Every person is fictional.

### The people

| Key | Person | Wants |
|---|---|---|
| **E** | Senior backend/AI engineer, India | Remote only (open to India), INR a year |
| **N** | Registered nurse, Columbus, Ohio | On site, night shifts, USD an hour, state licence |
| **A** | Accountant, Berlin | Hybrid, German C1 + English, EUR a year, German forms and CV conventions, postings in German |
| **R** | Retail store manager, Pune | On site, INR a month, Hindi/Marathi, no LinkedIn presence |
| **T** | Secondary maths teacher, Manchester | On site, GBP, QTS, term-time contracts |
| **G** | New marketing graduate, Manila | Hybrid, PHP a month, no work experience (internships, projects, education) |
| **W** | Warehouse associate / delivery driver, Texas | Part-time or shifts, hourly, driver's licence, maybe no resume |
| **S** | Career switcher after a 3-year break | Teacher → UX designer |
| **F** | Freelance translator, Spain | Remote, day rate or per word, EU clients |

Cross-cutting cases: **X1** no resume, **X2** resume in another language, **X3** postings not in English, **X4**
several unrelated target roles, **X5** willing to relocate, **X6** needs visa sponsorship, **X7** accessibility,
**X8** knows target employers but not boards, **X9** a country with no provider coverage, **X10** non-developer.

### What today's title gate does (simulated, `src/jobs/rules.ts:107,192`)

| Person: titles | Passes | Dropped |
|---|---|---|
| E: `backend engineer, ai engineer` | Senior Backend Engineer | Software Engineer, Backend · Full Stack Engineer · Tech Lead · Senior Engineer · SRE · Staff Engineer - AI Platform · Backend Developer · ML Engineer · Engineer II, Backend Services |
| N: `registered nurse` | Registered Nurse (RN) ICU | RN - Night Shift · Staff Nurse - Med/Surg · Nurse, Registered - Nights · RN Case Manager |
| A: `accountant, buchhalter` | Buchhalterin (m/w/d) · Senior Accountant | Finanzbuchhalter (m/w/d) · Bilanzbuchhalter\*in · Accounting Specialist · Mitarbeiter Rechnungswesen (m/w/d) |
| T: `maths teacher` | Maths Teacher (MPS) | Teacher of Mathematics · Mathematics Teacher · Teacher of Maths - Maternity Cover |
| W: `warehouse associate, delivery driver` | Delivery Driver - Part Time | Warehouse Worker · Package Handler · Associate, Warehouse (Nights) · CDL-A Driver · Material Handler |
| F: `translator` | Freelance Translator EN>ES | Traductor/a inglés-español · Localization Specialist (Spanish) · Translation Project Manager |

The gate is a phrase match: the words must be adjacent and in order, and the match is anchored at a word start. It
fails in four ways:
- **Word order:** "Teacher of Maths".
- **Synonyms and abbreviations:** "RN", "SRE", "Package Handler".
- **German compounds:** "Finanzbuchhalter".
- **Other languages:** "Traductor".

It also has no end boundary, so "nurse" would pass "Nursery Assistant" when the target is just "nurse".

### What the providers cover (from the catalog draft)

145 entries: 64 ATS, 35 boards, 17 single employers, 14 field boards, 5 aggregators, 5 national services, 5 feeds;
8 can't run in the sandbox. 79 need a `careers_url`, and 17 need configuration (keywords, queries).

| Person | Board-wide sources that fit | Honest coverage |
|---|---|---|
| E | Remote boards (remotive, himalayas, weworkremotely, jobicy, workingnomads, nodesk, 4dayweek, remoteok) | Fair. Most remote postings are restricted to the US or EU, so many drop on place |
| N | None. neogov covers public health agencies, one agency per entry | Hospital ATSes (workday, icims, taleo, phenom, oraclecloud, ultipro) per employer only |
| A | arbeitsagentur (needs keywords, 100 per keyword), arbeitnow, join/personio/softgarden/rexx employers | Best-covered country |
| R | None | Indian HRMS (darwinbox, keka, turbohire, zoho-recruit) per employer; no Indian job board at all |
| T | tes (whole UK teaching board) | Good for teaching; no NHS/Civil Service-style public board |
| G | kalibrr (Indonesia-heavy), techinasia | Very thin; jobstreet has no Philippines host in the provider |
| W | amazon (needs config) | No hourly/logistics board; employers' ATSes only |
| S | Remote/tech boards for UX | Fair for remote; on-site depends on employers |
| F | None for translation | Spain: manfred (tech, tiny), factorial per employer |

Fields with no dedicated source anywhere:
- healthcare
- care and social work
- trades and construction
- hospitality and food
- retail
- creative work and translation
- legal
- office and admin

## Severity

- **B (blocks):** the person can't get a useful result at this step.
- **D (degrades):** they get one, but worse, or only with expert edits.
- **C (cosmetic):** wording or polish.

The "Fix" column names the design decision (D-number), or says **deferred** with the reason.

## 1. Install and setup (`crewdeck setup`, first-run.md §1–4)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 1.1 | N R T G W S F, X10 | Setup assumes a developer: git clone, `npm ci`, Node ≥ 25 for sourcing, a terminal, Claude desktop's Code tab, a folder picker, trusting a folder. A nurse or warehouse worker stops at step 1 | first-run.md §1–4; README Requirements | B | D40: a "Claude installs it" path (paste one prompt into a Claude Code session; Claude runs the commands with the user's approval, explains each step, checks `crewdeck doctor`), plain-language requirements up front. A packaged installer is **deferred** (out of scope for a local Node tool) |
| 1.2 | W R, X10 | Crewdeck needs a desktop computer (Claude desktop, Chromium, Node); many hourly and retail job seekers only have a phone | design §3 non-goals don't say so | B | D40: say so plainly in the README's first lines (who it is for today); a mobile client is **deferred** |
| 1.3 | all | `--preset` names describe one user's world (`remote-any-country`, `healthcare-us`, `non-engineering`), and several preset sources can't fetch as written (1.4) | presets/jobs/*; README Presets | D | D39: presets become catalog queries; setup proposes sources from the profile |
| 1.4 | N A G W | Preset entries that throw or return nothing: `neogov` without careers_url; `arbeitsagentur`, `occ`, `builtin`, `wttj` without keywords/queries; `nofluffjobs`, `justjoin` without a URL; `themuse` blocked by Cloudflare; `jobstreet` defaults to Indonesia although the comment says "Southeast Asia"; `remote-com` is one company's own openings, not a remote board | presets/jobs/healthcare-us/sources.md:7, onsite-city/sources.md:6-17, non-engineering/sources.md:5-9, remote-any-country/sources.md:13; catalog `coverage:` lines | B | D39 + D18 `fill` rules (config filled from the user's titles/places); P9a fixes or removes each entry |
| 1.5 | X7 | Fixed pixel font sizes (11–13 px) don't follow the browser's text size; much copy is 12 px "small soft" | web/jobs/jobs.css (36 rules ≤ 13 px) | D | D41: rem-based sizes, 14 px body minimum, contrast AA in both themes |

## 2. The setup interview (`plugin/skills/jobs-setup/SKILL.md`)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 2.1 | all, X8 | "Where to look" is the last step and only toggles what a preset listed; with no preset, `sources.md` is empty and Claude invents board ids from memory | SKILL.md:79-82; vault-template/jobs/sources.md | B | D25: a catalog-driven step proposes sources from the profile, with an honest coverage line |
| 2.2 | X8 | Employers aren't a first-class input: "add the companies they name to the watchlist" with a careers_url, and nothing checks that any provider reads that page | SKILL.md:80-82; sources.ts:62 skips only a missing URL | B | D24: each employer is resolved (detectors in the sandbox plus a test fetch) or Claude says it can't be read |
| 2.3 | all | Titles are asked once ("target titles … any language postings use") with no variants, no synonyms, no check against real postings | SKILL.md:52-53 | B | D26 (targets with variants) + D27 (preview against fetched postings) inside the interview |
| 2.4 | X1 W R | "Have your resume file ready" leads the card; no-resume is a fallback line. Someone with no resume may think they can't start | setup.js:22,29; SKILL.md:34-37 | D | D34: the card and skill offer "no resume? Claude asks you instead" as an equal path; the interview builds facts from roles, shifts, duties, licences |
| 2.5 | G S | No guidance for an entry-level person (internships, projects, coursework, volunteering, student societies) or a career switcher (transferable facts, a course or portfolio, a break) | SKILL.md §3 | D | D34: skill paths for entry-level, switcher and career break |
| 2.6 | R G, X3 | The interview is English-shaped; nothing says to hold it in the user's language or to write values (titles) in the languages postings use | SKILL.md §4 | D | D40: Claude interviews in the user's language; titles in every language local postings use (D26) |
| 2.7 | N W T | Nothing asks about shifts, hours a week, term-time, or availability: the facts hourly and shift employers screen on first | SKILL.md §4 list | B for N W | D30: a work-pattern question set |
| 2.8 | F | Pay floor offers year, month and hour only; a day rate or per-word rate can't be stated | SKILL.md:60-61; schema.ts:93 | B for F | D29 |
| 2.9 | E N T R | Cooldown is asked as a number, but its meaning (no second role at a company for N days) breaks large employers (hospital systems, chains, academy trusts) | SKILL.md:69-70; pick.ts | D | D36 |
| 2.10 | X5 X6 | Relocation isn't asked; sponsorship is a yes/no with no "where can you work without it" | SKILL.md:65-66; schema.ts:90 | D | D37 |
| 2.11 | all | The interview ends with `jobs check` and `jobs rules` (regexes); the user never sees what their search catches | SKILL.md:84-87 | B | D27: the interview ends with a preview, not a regex dump |

## 3. The notes schema (`src/jobs/schema.ts`, design §7)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 3.1 | all, X4 | `roles.titles` is one flat list for one kind of job; a teacher retraining as a UX designer, or someone open to "store manager or area sales manager", can't keep each target's titles and skills apart | schema.ts:84 | D | D26: `roles.targets` (each with titles, families, skills); `roles.titles` still read |
| 3.2 | F | `pay.period` lacks day and week; per-word and per-project can't be stated | schema.ts:93; pay.ts:8 (`UserPeriod`) | B for F | D29: periods year, month, week, day, hour; `pay.per_unit` text for the judge |
| 3.3 | W N | Pay conversion assumes 40-hour weeks (`HOURS`); a 24-hour-a-week part-timer's monthly floor converts wrongly | pay.ts:19 | D | D29: `pay.hours_per_week` (default 40) and `days_per_week` drive conversion |
| 3.4 | A | Language levels lack CEFR (A1–C2), which is how German postings state them ("Deutsch C1") | schema.ts:33 | D | D31: CEFR accepted and mapped; the judge brief prints both |
| 3.5 | F W T | Employment types lack freelance/self-employed, fixed-term, seasonal and apprenticeship; term-time is a pattern, not a type | schema.ts:34 | D | D30 |
| 3.6 | N W | No field for shifts, hours or availability | schema.ts:84-102 | B for N W | D30: `work_pattern` |
| 3.7 | G | No level: a graduate gets "Senior" and "Manager" roles unless they think to add exclude words; the judge never compares required years with theirs | schema.ts:84; rules.ts:321 | D | D31: `roles.level` + years in the judge brief |
| 3.8 | S | Facts can't live under an education section (only summary, experience, list are citable), so coursework, a thesis or a UX certificate project must be shoehorned into a list | schema.ts:236 | D | D34: the skill proposes list sections (projects, volunteering, courses); education facts stay uncitable by design (degrees come from `profile.education`) |
| 3.9 | S | An experience section requires `org`; a career break or freelance period has none | schema.ts (CROSS career: experience needs title and org) | D | D34: `org` optional when `kind: experience` has `break: true`; the resume prints "Career break" |
| 3.10 | N T W A | Experience `dates` is free text; forms that ask for start/end month per job (Workday, NHS-style, TES) get nothing to fill | schema.ts (sections.dates str) | D | D35: optional `start`/`end` (YYYY-MM) on experience sections |
| 3.11 | T N W | No place for references (name, role, contact), which UK teaching and most hourly forms require | schema.ts profile | D | D35: `profile.references` (filled only on reference questions, never drafted) |
| 3.12 | A R G | No opt-in personal block for CV conventions (date of birth, nationality, languages known, photo) | resume.ts; schema.ts career.resume | D | D33: `resume.personal: [keys]`; a photo is **deferred** (uploads, privacy) |
| 3.13 | X5 X6 | Only `needs_sponsorship`; no `authorized_in` or `relocate_to` | schema.ts:90 | D | D37 |
| 3.14 | all | `sources.md` has two unordered lists; no priority, no stable key, no custom-source shape, no LinkedIn entry | schema.ts sources; design §7.6 | B (owner requirement) | D20, D22 |

## 4. Sources

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 4.1 | all | 137 providers with no metadata: no kind, region, field, workplace, language, "needs careers_url" or limits | providers.manifest.json | B | D18: the catalog (draft committed) |
| 4.2 | R G N W F, X9 | Whole fields and countries have no board, but nothing says so, so an empty Today looks like a broken product | catalog coverage table above | B | D25 + D42: an honest coverage line in setup, on the Sources screen and in Find's funnel |
| 4.3 | E | No order: the owner wants LinkedIn first, then the portals; today source quality is fixed by kind (pasted > linkedin > ats > board) | rank.ts:24 | D (owner requirement) | D21 |
| 4.4 | all | The tracker doesn't record which source a role came from (`source` is only `ats`/`board`), so per-source counts, priority and "what did this board give me" are impossible | sources.ts:63,239; migrations.ts:11 | D | D20: `roles.source_key` (migration v2) |
| 4.5 | all | No per-source result after a fetch: errors are one string per run; the page shows "N new roles" only | sources.ts:253-259; topbar.js sourcesLine | D | D19: per-source state in `<jobs home>/state/sources.json`, shown on the Sources screen |
| 4.6 | X8 | No way to check a careers URL before trusting it: detection happens inside the scheduled run and fails as "no provider recognises this careers page" in a state file nobody reads | provider-runner.ts:210-212 | B | D24: `crewdeck jobs sources resolve` + the Sources screen's Add company |
| 4.7 | all | Board-wide sources needing keywords (arbeitsagentur, builtin, occ, wttj, amazon, google) get none from the user's titles | catalog `needs: config` | B for A | D18 `fill`: keywords and queries derived from targets and places at fetch time |
| 4.8 | E (owner) | LinkedIn is a hidden setting, not a source the user can order or see | Settings screen; design §12 | D (owner requirement) | D22 |
| 4.9 | all | Adding a source means editing YAML in Notes (README "Add a source") | README:179-187 | D | D23: the Sources screen |

## 5. Fetching

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 5.1 | all | Providers' structured `language`, `visaText`, `country` and `locations` are dropped (workplace and eligibility are folded into location, which is good) | provider-runner.ts:50-67; career-ops `_types.js` Job | D | D20/P9a: keep `language` and `visa_text` columns for the judge and the preview |
| 5.2 | W N R | JobPosting `employmentType` (FULL_TIME, PART_TIME, PER_DIEM, …) isn't read from pasted links or providers, so part-time seekers can't filter by it even when it's structured | link.ts:60-90 (no employmentType) | D | D30: store `employment_type` when structured; a hard drop only on a structured value the user excluded |
| 5.3 | E | Run order is plan order, with LinkedIn always after providers; under the run caps (2,000 requests, 15 min) the user's favourite source may be starved | sources.ts:282-298; FETCH_CAPS | D | D21: fetch in priority order, LinkedIn at its position |

## 6. Prefilter rules (`src/jobs/rules.ts`)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 6.1 | all | **Title gate = adjacent phrase** (see the simulation). Word order, synonyms, abbreviations, compounds, gender markers and other languages all fail | rules.ts:32,107,192 | **B** | D26: word-level matching, variants, seniority words apart, compound tails, gender markers stripped; checked against real data (D27) |
| 6.2 | N T | No end boundary: "nurse" passes "Nursery Assistant"; "teacher" passes "Teachers' Pension administrator" | rules.ts:107 (only `B` before) | D | D26: word-prefix rules with a stem limit (plural and gendered suffixes only) |
| 6.3 | all | The title-gate drop reason doesn't name the title or say what was close: "title is not one of your target titles" | rules.ts:192 | D | D28: the reason names the near miss (shared head word) |
| 6.4 | A F R, X3 | Workplace words are mostly English (+ a few Romance); "Homeoffice", "mobiles Arbeiten", "100% remoto", "trabajo desde casa", "work from office" (India) aren't read | rules.ts:38-40 | D | D38: per-language rule words in a data file |
| 6.5 | A F, X3 | Place restrictions ("nur in Deutschland", "solo residentes en España") and travel ("Reisebereitschaft") are English-only regexes; non-English postings fall to the judge (safe, but costs tokens and misses cheap drops) | rules.ts:41-57 | D | D38 |
| 6.6 | R | Indian states (Maharashtra, Karnataka …) and German Länder aren't in the gazetteer; "Pimpri-Chinchwad, Maharashtra" isn't read (kept: safe) | places.yaml (states: US and Canada only) | C | D38/P9g: add states and regions for the countries the catalog covers (IN, DE, AU, MX, BR) |
| 6.7 | N W | Employment type, shifts and hours are judge-only, even when a posting states them in a structured field | rules.ts:461 (design §7.8) | D | D30 |
| 6.8 | E | 92 drops for "remote for other countries" were right, but nothing told the user that remote boards mostly hire in the US and EU | — | D | D28 funnel names it; D25 coverage line warns before setup ends |
| 6.9 | all | A template default `exclude.travel: none` means "off" while the comment says "the lowest travel that rules a job out" | vault-template/jobs/search.md:23; rules.ts:131 | C | P9g: rename the value `off` (with `none` still read) and reword |
| 6.10 | all | Industry words are an English list | rules.ts:62-73 | C | D38 |

## 7. Ranking (`src/jobs/pipeline/rank.ts`)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 7.1 | S, X4 | Skills overlap uses `career.skills` (the old field's skills), so a switcher's UX roles rank low; several targets share one skill list | rank.ts:35 | D | D26: per-target skills rank roles for that target |
| 7.2 | E (owner) | Source quality is fixed by kind; the user's order is ignored | rank.ts:24 | D | D21 |
| 7.3 | all | Title rank uses the same phrase test as the gate | rank.ts:31 | D | D26 (one matcher for gate and rank) |

## 8. Judging (`judgeBrief`, `jobs-daily-run`)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 8.1 | N W T | No shift, hours or term-time eligibility in the brief | rules.ts:286-330 | B for N W | D30 |
| 8.2 | G | "Requires 5+ years" isn't compared with the user's experience; no level | rules.ts:321 | D | D31 |
| 8.3 | N T | "The user lists no licences: fail postings that require a professional licence" is right, but licences are free text with no jurisdiction or compact shape | rules.ts:306-307 | D | D31/P9g: `licenses: [{ name, where?, expires? }]` (strings still read); the brief says "RN (Ohio; Nurse Licensure Compact)" |
| 8.4 | X6 | Sponsorship is binary; "must have the right to work in the UK" for someone authorised only in India isn't decidable | rules.ts:308-309 | D | D37 |
| 8.5 | A, X3 | The brief is English; a German posting is judged fine by Claude, but the brief doesn't say "postings may be in any language; quote evidence in the posting's words" | rules.ts:293-296 | C | P9g wording |

## 9. Picking and cooldowns (`pick.ts`, `prefilter.ts`)

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 9.1 | N W R T | One active role per company and a 60-day company cooldown break large employers: a nurse applies to several units of one hospital system, a driver to several depots, a teacher to several schools of one academy trust | prefilter.ts:12-17; pick.ts:53; template default 60 | D | D36: `cooldown_scope` (company or role), `per_company`, per-family defaults proposed in setup |
| 9.2 | W | Five picks a day suits salaried searches; hourly seekers apply to more, smaller forms | template `daily_picks: 5`; budget 40 judged | C | D36: setup proposes per family; the cap stays 50 |

## 10. Prepare: link, form, drafting, citation, resume

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 10.1 | A R G, X3 | Profile-field patterns are English (`^first name$`, `^notice period$`, …), so "Vorname", "Nachname", "Kündigungsfrist", "Eintrittstermin" get no profile value and become first-time questions on every new wording | fields.ts:48-70 | D | D32: form terms per language in a data file |
| 10.2 | A R G N W | `SENSITIVE` is English and misses common regional fields: marital status, religion, caste/category, father's name, height/weight, photo, "Gehaltsvorstellung", "Geburtsdatum", "Staatsangehörigkeit", "Familienstand", "Anrede". Unmarked, an answer is remembered and reused for every company like a non-sensitive one | fields.ts:10; kb/questions.ts:26 | D (privacy) | D32: multilingual sensitive terms; Claude may raise a field to sensitive in the draft (never lower it) |
| 10.3 | R N W A | Government ID numbers (Aadhaar, PAN, SSN, NI number, Steuer-ID, passport number) and bank details can be filled from an exact standard answer; they would sit in plain text in a vault note | fields.ts:10,90-95 (sensitive fills from an exact standard answer) | D (privacy) | D32: a `never_fill` class: always `skip` ("you type this yourself"), never stored |
| 10.4 | A F, X3 | The drafting brief never says which language to answer in; a German form gets English answers | draft/prompt.ts:26-49 | D | D33: answer in the form's language; citations still point at the facts |
| 10.5 | X2 A | Facts are word for word from the resume; a German CV from English facts (or the other way) is impossible without rewording | design §7.3, D8 | D | D33: user-approved translations of facts (`facts[].tr`); the resume renders in `resume.language` |
| 10.6 | A T G R | Resume headings are English ("Experience" hard-coded; Skills/Education defaults); no "CV" wording; no personal block; length conventions not proposed | resume.ts:104,110,116 | D | D33: `resume.language`, headings per language, `resume.personal` |
| 10.7 | X1 W | Prepare always renders a resume, even when the user has no resume-style facts and the form has no upload | jobs-workspace SKILL.md Prepare step 4 | C | D34: skip the resume when there's no upload field and no experience facts |
| 10.8 | T A | Cover letters and supporting statements come only as text answers; an upload ("Anschreiben", a UK "supporting statement") is skipped as "cover letter (optional)" | plan.ts:47 | D | D35: `crewdeck jobs letter <role>`: a cited letter PDF through the citation check |
| 10.9 | T W N | Repeating groups (employment history "Add another", education history) can't be filled: Claude presses only Next | jobs-workspace SKILL.md apply 3.7; plan.ts:40 | D | D35: a capped `add` action for "add another <entry>" buttons, filled from experience sections with dates |
| 10.10 | T R W | Applications that aren't an online form: a Word/PDF application form (common in UK schools), "email your CV to …", walk-in interviews (common in Indian retail), chatbot apply (hourly chains) | jobs-workspace SKILL.md link/needs | D | D35: Prepare records the apply method; answers are drafted anyway and shown to copy; email stays a draft-only switch |
| 10.11 | all | The citation check knows number words in five European languages only | kb/cite.ts:41-60 | C | D33/P9h: add Hindi/Filipino number words only if real use shows the need; digits always work |
| 10.12 | G S | "Why it fits" and drafting lean on experience bullets; an entry-level person's projects and coursework are fine as list facts but the skill doesn't say to use them | jobs-workspace SKILL.md Prepare 4-5 | C | D34 skill wording |

## 11. Apply, first-time questions, sensitive fields

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 11.1 | N W R T | Most large employers' ATSes (Workday, Taleo, iCIMS, SuccessFactors) need an account per employer; Claude stops at account creation with no clear "create it, then Continue" state | design §2.3a ✕ row; SKILL.md apply 6 | D | D35: the panel's "This site needs an account" state with the steps; Claude continues after the user signs in |
| 11.2 | W N | Availability grids (days × shifts) are choice questions answered from memory once; work_pattern should answer them | plan.ts | D | D30 + D32: work-pattern values as profile sources for availability questions |
| 11.3 | X7 | The apply panel's live states are `role=status`, good; the reorder control the Sources screen needs must not be drag-only | web/jobs/screens/apply.js | C | D41 |

## 12. Mark applied, cooldowns, journal

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 12.1 | N W T | The cooldown starts per company (see 9.1) | pipeline/apply.ts | D | D36 |

## 13. Preference changes and memory

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 13.1 | all | A preference change offers `refilter --days 14` but doesn't show what the change catches before it is saved | design §2.5 | D | D27: Preferences → Preview before Save; refilter after |
| 13.2 | all | A "not interested" title word becomes a hard drop with no preview of how many roles it removes | design §2.6 | C | D27: preview the drop count in the dialog |

## 14. UI wording and screens

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 14.1 | all | No Sources screen | topbar.js:5 SCREENS | B (owner requirement) | D23 |
| 14.2 | all | Find's result is one line from Claude; a tiny result has no explanation or fix | jobs-daily-run SKILL.md §5 | B | D28 |
| 14.3 | A T G R | "Resume" everywhere; UK, Germany, India and the Philippines say CV | setup.js, today.js copy | C | D40: `resume.word` from the user's locale ("CV"), used in copy |
| 14.4 | R G, X3 | The UI is English only | index.html `lang="en"` | D | D40: English UI in v0.4 with strings gathered in one module; localisation **deferred** (no translations we can't check); Claude speaks the user's language |
| 14.5 | all | Preferences says "A posting's title must contain one of your titles", which is true and the source of the 1-of-1,480 result | preferences.js:91 | D | D26/D27: the Roles card edits targets and variants, with a live preview count |
| 14.6 | W | Preferences "Per: a year, a month, an hour" | preferences.js:8 | C | D29 |

## 15. LinkedIn switches

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 15.1 | E (owner) | LinkedIn search can't be placed first among sources | design §12 | D | D21, D22 |
| 15.2 | R | A user without a LinkedIn profile can still use guest search (no account), but setup doesn't say so; forms' "LinkedIn URL" stays empty (fine) | SKILL.md §2; linkedin.ts:127-135 | C | D22 copy |
| 15.3 | E G | Guest search sends titles × places; with targets and variants the cross product grows past the 30-request cap | linkedin.ts:130-135,164 | D | D22: LinkedIn uses each target's primary titles only (at most 3 per target); the cap is unchanged (a risky number) |

## 16. Docs

| # | Who | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 16.1 | all | README "Presets" and "Add a source" describe hand-editing YAML by provider id | README:131-141,179-187 | D | P9i: rewritten around the Sources screen and the catalog; storage split stated (D19) |
| 16.2 | X10 | first-run.md starts with `git clone` | first-run.md §1 | B | D40 |
| 16.3 | all | The examples and fixtures cover three people (`example`, `berlin-analyst`, `us-nurse`) | design §19 | D | §24.12 test plan: seven personas |

## 17. Cross-cutting cases

| # | Case | Gap | Evidence | Sev | Fix |
|---|---|---|---|---|---|
| 17.1 | X1 no resume | Interview path exists but is second-class (2.4); Prepare still renders a resume (10.7) | SKILL.md:36 | D | D34 |
| 17.2 | X2 resume in another language | Facts are kept word for word in that language; answers to an English form would translate them silently; the resume can only be in the resume's language | design D8 | D | D33 |
| 17.3 | X3 non-English postings | Titles (6.1), rule words (6.4-6.5), form terms (10.1-10.3), answer language (10.4) | as cited | B (titles) / D | D26, D38, D32, D33 |
| 17.4 | X4 several targets | One title list, one skill list (3.1, 7.1) | schema.ts:84 | D | D26 |
| 17.5 | X5 relocate | On-site places outside `places.onsite` drop as `location_elsewhere`; there's no "I'd move for this" | rules.ts:217 | D | D37: `places.relocate_to` |
| 17.6 | X6 visa | Binary flag; no "authorised in" list | 8.4 | D | D37 |
| 17.7 | X7 accessibility | Fixed small px fonts (1.5); otherwise labelled controls, aria-live status, focus-visible present | jobs.css; screens | D | D41 |
| 17.8 | X8 knows employers | 2.2, 4.6 | — | B | D24 |
| 17.9 | X9 no coverage | Nothing says so (4.2) | — | B | D42 |
| 17.10 | X10 non-developer | 1.1, 1.2, 16.2 | — | B | D40 |

## Summary by severity

**Blocks (fixed in v0.4):**
- the title gate (6.1);
- no source metadata (4.1);
- no "where to look" from the profile (2.1);
- employers not resolvable (2.2, 4.6);
- keywords not filled for board-wide sources that need them (4.7);
- no preview (2.11);
- Find doesn't explain a small result (14.2);
- no coverage honesty (4.2, 17.9);
- broken preset entries (1.4);
- shifts and hours for N and W (2.7, 3.6, 8.1);
- day and per-word rates for F (2.8, 3.2);
- the owner's Sources screen, priority and LinkedIn-as-source (3.14, 14.1).

**Blocks, partly deferred:**
- developer-only install (1.1): the "Claude installs it" path is in; a packaged installer is deferred;
- desktop-only (1.2): stated plainly; a mobile client is deferred.

**Degrades (fixed in v0.4):** everything else above that is marked D, except the UI translations (14.4: strings
gathered now, translations deferred) and a resume photo (3.12: deferred).

**Cosmetic:** 6.6, 6.9, 6.10, 8.5, 9.2, 10.7, 10.11, 10.12, 11.3, 13.2, 14.3, 14.6, 15.2, done in the phase that
touches the file.
