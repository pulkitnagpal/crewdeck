# P2a: core data and pipeline (database, knowledge base, drafting, fill plan, pipeline commands, views)

Part of [the Jobs design](../design.md): read §2.3–2.7 (and §2.3a), §5 D9/D11, §7, §8, §9, §13, §16 and §22 row P2 first.
Rules for every implementer: [README.md](README.md). P2 is split in two:

- **P2a (this doc):** the tracker database and its migrations, the knowledge base (answers in the DB, memory in the
  vault), the drafting brief and citation check, the fill plan, the pipeline commands (prefilter, candidates, judge,
  pick, applied, not interested, refilter, add-role, outreach) and the view models the Jobs page (P3) will render.
- **P2b (next):** netguard, `link` (paste a link, read JobPosting), LinkedIn posting reads, headless form reading behind
  the guard proxy, resume template + PDF. P2a leaves the interfaces listed in §5.

## 1. Scope
- `src/jobs/db.ts` + `src/jobs/migrations.ts`: SQLite through `node:sqlite` (loaded lazily, only when a Jobs command or
  view needs it) at `<jobs.home>/jobs.db`, WAL, `busy_timeout` 8000 ms for the CLI and 250 ms for the server
  (`{ server: true }`), migrations by `PRAGMA user_version`. Home 0700, database files 0600.
- Knowledge base (`src/jobs/kb/`): question index (FTS5), per-role form fields, answer versions, corrections, undo;
  memory lives in `jobs/memory.md` through P1's `memory.ts`, facts in `me/career.md`, profile values in `me/profile.md`.
- Drafting (`src/jobs/draft/`): code fills what the profile and memory already answer, the brief lists the rest for
  Claude, `draft --answers` stores Claude's answers after the citation check.
- Fill plan (`src/jobs/plan.ts`) for the pane, with the copy-only, password/CAPTCHA and Easy Apply gates.
- Pipeline commands (`src/jobs/pipeline/`) and views (`src/jobs/views.ts`), all under `crewdeck jobs …`.

Not in P2a: anything that fetches the network (P2b), the server, SSE, queue and `--request` (P3), skills (P4), sourcing
and the code ranking's budgeted early stop (P5).

## 2. Modules and API

| File | What |
|---|---|
| `db.ts` | `openDb(path \| ':memory:', { server? })`, `openJobsDb(home, { server? })`, `dbFile(home)`, `tx(db, fn)` (`BEGIN IMMEDIATE`, nest-safe), `now()`, `roleId(url)`, `companyId`, `upsertRole`, `addEvent`, `setStatus`, `STATUSES` |
| `migrations.ts` | `MIGRATIONS` (v1), `migrate(db)` (idempotent; refuses a database newer than the code), `SCHEMA_VERSION` |
| `time.ts` | `zoneOf(tz)`, `dayIn(tz, date)`, `dayBounds(tz, day)` → UTC ISO `[start, end)`, `addDays(day, n)` |
| `ctx.ts` | `Ctx = { db, vault, home, features, clock }`, `openCtx(config)`, `notesOf(ctx)`, `todayOf(ctx)`, `tzOf(ctx)`, `memoryFile(ctx)` |
| `fields.ts` | `norm`, `SENSITIVE`, `profileValues(profile)` (flat `key → value`, the `profile:<key>` namespace), `profileFields(profile)` (anchored label patterns → value + key), URL rules (`checkRoleUrl`, `isLinkedinHost`, `isLinkedinJobUrl`, `isXHost`, `copyOnlyHost`, `applyUrl`, `atsOf`) |
| `kb/questions.ts` | `slugKey`, `ensureQuestion`, `ensureField`, `kbKind`, `cleanQuestions(raw)`, `storeFormFields(db, role, profile, fields)` |
| `kb/cite.ts` + `data/terms.yaml` | `checkAnswer(answer, ctx)`, `numbersIn`, `termsFor(extra)` |
| `kb/ops.ts` | `currentAnswers`, `resolveField`, `autoAnswer`, `citeContext`, `changeAnswer`, `editAnswer`, `remember` (note + apply to open fields), `answerFirstTime`, `undoLast`, `knowledge` |
| `kb/learn.ts` | `learnField` (a question met on a live form, optionally answered) |
| `draft/prompt.ts`, `draft/draft.ts` | `DRAFT_SCHEMA`, `buildPrompt`, `prepareDraft`, `applyDraft`, `draftRole` |
| `plan.ts` | `answerFor`, `fillPlan(fields, answers, profile)`, `planForRole(ctx, role, fields, pageUrl?)` |
| `pipeline/roles.ts` | `addRole`, `setApplyUrl`, `addQuestion`, `setRoleStatus` |
| `pipeline/prefilter.ts` | `runPrefilter(ctx)`, `refilter(ctx, days)` |
| `pipeline/pick.ts` | `plainText`, `rankScore`, `candidates`, `judge`, `pick`, `pickPasted` |
| `pipeline/apply.ts` | `markApplied` (cooldown, journal line), `notInterested`, `appendJournal` |
| `pipeline/outreach.ts` | `addContact`, `checkMessage`, `addMessage`, `markSent`, `recordFollowup`, `followups` |
| `views.ts` | `todayView`, `applicationsView`, `knowledgeView`, `canApprove`, `copyModel`, `sourceLine`, `money`, `resumeFileName` |
| `commands.ts` | the P2a `crewdeck jobs …` commands (wired from `cli.ts`) |

### Schema v1 (`PRAGMA user_version = 1`)
- `companies(id, name, key unique, domain, cooldown_until, note)`.
- `roles(id, company_id, title, url unique, apply_url, apply_kind, location, description, source, pay_text, pay_min,
  pay_max, pay_currency, pay_period, pay_status, status, status_reason, eligibility, evidence, score, posted_at,
  first_seen, updated_at, picked_on)`; `status` and `eligibility` are CHECK-constrained; pay numbers are in the user's
  currency and period at the time (`pay_currency`, `pay_period` say which).
- `contacts(id, company_id, name, title, email, email_verified, linkedin_url, source, created_at)` (no `x_url`).
- `messages(id, role_id, contact_id, channel email|linkedin, body, gmail_draft_id, status draft|sent, created_at, sent_at)`.
- `events(id, role_id, kind, detail, at)`, `questions(id, role_id, text, answer, asked_at, answered_at)`.
- KB: `kb_questions(canonical_key unique, kind, text)`, `question_wordings` + `question_fts` (FTS5, porter, kept in step by
  triggers), `form_fields(role_id, ord, section, label, kind, required, options_json, char_limit, question_id)`,
  `answers(… status first_time|drafted|approved, version, fact_ids_json)`, `corrections`, `undo_log`.
- Indexes on the columns every view filters by (`roles(status)`, `roles(company_id)`, `events(role_id, kind)`, …).

### Commands (all `crewdeck jobs …`; untrusted text only through files or stdin)
| Command | What |
|---|---|
| `prefilter` | P1 rules + company cooldown + one active pick per company over `new` roles; records pay |
| `refilter --days N` | re-checks `prefiltered_out` roles dropped in the last N days against the current notes; brings back what passes |
| `candidates [--limit N]` | unjudged roles that passed, ranked from the notes, descriptions as clipped plain text (JSON; N ≤ 40) |
| `judge --results-file f` | `[{ role, eligible: yes\|no\|unclear, score, evidence, reason? }]` |
| `pick [--n N] [--day D]` / `pick --role <id> [--force]` | daily picks (one per company, idempotent per day) / a role the user chose |
| `status <role> <status> [--reason-file f]`, `event add <role> --kind k --detail-file f`, `question add <role> --text-file f` | tracker edits |
| `applied <role>` | status, cooldown, journal line |
| `not-interested <role> --reason-file f [--title-words-file f]` | skip, `avoid` memory item, optional title words via `pref set` |
| `add-role --role-file f` (JSON or `-`) | a role found elsewhere: `{ url, title, company, location?, description?, pay_text?, source? }` |
| `role <id> --apply-url-file f` | the application form's own address |
| `form <role> --fields-file f` | store the questions read from a form (P2b adds headless reading when no file is given) |
| `draft <role> --brief out.json` / `--answers f` | the two halves of drafting |
| `answer <role> --question Qn --text-file f (--quote-file f \| --claims-file f [--instruction-file f])` | the user's own answer (remembered) / Claude's rewrite (citation check) |
| `learn <role> --label-file f [--answer-file f] [--quote-file f] [--options-file f] [--claims-file f]` | a question met on a live form |
| `remember …` (P1) | now also applies the item to open forms |
| `undo`, `knowledge <words> \| --query-file f` | undo the last answer change or memory; search what Claude knows |
| `fill-plan <role> --fields-file f [--page-url-file f]` | what to put in each field read on the live form |
| `contact add --file f`, `message add\|check <role> …`, `message sent <id>`, `followups`, `followup done <id> nudge\|final` | outreach records (gated) |
| `view today [--role id] \| applications \| knowledge [--tab t]` | the view models as JSON (what P3 renders) |

## 3. Decisions (and where they deviate from or extend the design)
1. **Lazy `node:sqlite`.** Loaded with `createRequire` inside `openDb`, so `crewdeck` without Jobs never loads it; the
   one-time experimental warning on Node 22 is filtered for that load only.
2. **busy_timeout** is one of two literal pragmas (CLI 8000, server 250), so no SQL is ever built from values. Foreign keys
   are on (node:sqlite's default); deletes run children first.
3. **Migrations**: each step runs in `BEGIN IMMEDIATE` and re-reads `user_version` inside the transaction, so two
   processes opening a fresh database don't both apply it; a database newer than the code is refused with a message.
4. **Pay columns** store the posting's pay converted to the user's currency and period (`pay_currency`, `pay_period`
   record which); `pay_text` keeps the words. Re-run by `prefilter`/`refilter` when settings change.
5. **Time zones**: every "day" is the user's `schedule.timezone` (system zone when unset). Timestamps are stored as UTC
   ISO; "today" queries use `[start, end)` UTC bounds computed in JS (`time.ts`), never SQL offsets. `picked_on` is the
   local day string.
6. **Profile answers** use flat keys (`profile:email`, `profile:notice_period`, `profile:linkedin`, `profile:school`);
   `profileFields` returns the key with the value, so the source is exact (the old value lookup could miss). Contact
   fields are matched with anchored whole-label patterns; any `standard_answers` key also matches a label that is its
   words ("notice period"). **Sensitive** questions (salary, visa, EEO…) are filled from the profile only on that exact
   match of a `standard_answers` key, never by a broader pattern.
7. **"Name/email shown as first-time" fix**: one `autoAnswer` (memory, then profile) is used by `prepareDraft`,
   `learnField` and `storeFormFields`' callers, so a field recorded from a live form (`learn`) is approved from the
   profile at once with a `profile:` source instead of sitting as first-time.
8. **First-time answers** are remembered as memory `answer` items (key = the question's canonical key, the user's quote):
   choice/logistics/numeric/sensitive/contact questions for every company, written (narrative) answers for that company
   only (they name the company). A new answer for the same key supersedes the old one (P1).
9. **Undo** retires the memory item and restores the items it superseded (new `undoRemember` in `memory.ts`), and deletes
   the answer rows it created; undo rows are tied to their own ids, never "the last row".
10. **Citation terms** come from `src/jobs/data/terms.yaml` (technologies, tools, certifications, clinical and analytics
    terms; `a|b` aliases; short names case-sensitive) plus `career.md` → `terms.extra` (new, optional). Memory items
    citable: `answer`, `fact`, `preference` (not `style`/`avoid`).
11. **Copy-only hosts**: built-in (`wellfound.com`, `angel.co`, `workatastartup.com`) plus `profile.md` →
    `copy_only_hosts` (new, optional). A copy-only role's plan is `{ mode: 'copy', answers }`.
12. **Easy Apply gate**: a LinkedIn host plan needs `features.easy_apply` and `daily_quick_apply > 0`; each role counts
    once per local day (event `quick_apply`); over the cap or switched off, the plan is copy mode with the reason (design
    §2.3a: the user gets the answers to copy).
13. **Fill plan never emits submit/review actions**: actions are `fill | select | choose | upload | skip` only; button,
    submit, password and CAPTCHA fields are `skip` with the reason.
14. **URLs on the command line**: none. `add-role` reads a JSON file, `role` reads `--apply-url-file`, `fill-plan` reads
    `--page-url-file` (D11). Role ids, numbers and fixed words stay arguments.
15. **Not interested**: the reason is an `avoid` memory item (the user's words as text and quote); title words go to
    `roles.exclude_title_words` through P1's `setField` with the reason as the Changes line (so they are visible and
    editable in `search.md`). `pick` also skips judged roles whose title the current rules now exclude.
16. **add-role**: http(s) only, no credentials in the URL, X hosts refused, LinkedIn only `/jobs/view/<id>` and only with
    `features.linkedin_links` on.
17. **Applied**: idempotent; cooldown = `max(existing, now + cooldown_days)`; the journal line
    `- Applied: <company> — <title>` is appended to `journal/<local day>.md` once. Closing the role's open requests is
    P3's server reconciling on role status (D4); nothing in the CLI touches the queue.
18. **Outreach gates**: email needs `features.email_drafts`, a verified address, one per role and at most
    `max_emails_per_day` per local day; LinkedIn text needs `features.linkedin_message_text`. Nothing is ever sent.
19. **`pick --force`** is a CLI flag now; P3 lets it through only when the request carries the user's override (§13).
20. **Ranking** (`candidates`): title match to `roles.titles`, `seniority_prefer`, skills overlap with `career.md`,
    freshness and source quality (pasted > LinkedIn > ATS > other); P5 adds the budgeted early stop.
21. **Company key**: P1's `companyKey` now also drops a trailing web domain (`Example.com` = `Example`), one key for the
    DB and the rules.
22. **Contact fields the profile can't answer** (an empty LinkedIn link) become first-time questions ("not in your profile
    yet") instead of going to Claude: only the user can give their own contact details.
23. **Dates in views** use `pay.locale` (the one locale the notes carry) and `schedule.timezone`, so a de-DE user sees
    "19. Nov."; Intl's no-break spaces are kept.

## 4. Interfaces left for P2b and P3
- P2b `link`: `checkRoleUrl`, `addRole`, `pickPasted(ctx, id, day, force)`, `setApplyUrl`; netguard plugs in before
  `addRole`.
- P2b `form`: `storeFormFields(db, role, profile, fields)` with `FormQuestion[]` (validated by `cleanQuestions`) (the `form --fields-file` path already stores).
- P2b `resume`: `resumeFileName(career, profile)`, `out/<role>/` under `jobs.home`; `todayView` shows the PDF when present.
- P3 `--request <id>`: every command handler takes its inputs as a plain object (`commands.ts` parses files into it), so a
  request payload can be passed instead of files. Views are pure functions of `(ctx, …)`; the server opens the DB with
  `{ server: true }`.

## 5. Test plan (node --test, temp dirs and fictional people only)
- `db`: tables, FTS follows wordings, migrations idempotent (reopen, two connections), newer version refused, file modes
  (home 0700, db 0600), WAL + busy timeouts, upsert keeps one row and never resets status.
- `time`: day bounds and `dayIn` across a UTC midnight for Europe/Berlin and America/Chicago (and DST).
- `kb`: cite (numbers, terms incl. healthcare/analytics, aliases, unknown/superseded ids, posting claims, profile
  sources, `terms.extra`); ops (change refused/stored, company scope, first-time answer reused on a second role, style
  redraft, undo restores the superseded memory); learn (profile fields approved at once, sensitive needs the user).
- `draft`: profile answers stored as approved with `profile:` sources; memory reuse across two roles; Claude asked only
  for the rest; citation failures become first-time; user's changes kept on re-draft; references never get the user's
  own links; the prompt names the person and nobody else.
- `plan`: per-role answers then profile; sensitive/unmatched choices skipped; password/CAPTCHA/submit skipped; no action
  outside the five; copy-only hosts; Easy Apply off/on/cap counted per local day.
- `pipeline`: prefilter with P1 rules + cooldown + active pick; refilter after a preference change; candidates ranking
  and clipping; judge; pick (one per company, idempotent per day, across a UTC midnight in two zones); pickPasted
  warnings and `--force`; applied (cooldown, journal line once, "applied today" in two zones); not interested (avoid
  item, title words in `search.md`, later prefilter drop); add-role URL rules and LinkedIn gate; outreach gates and caps;
  follow-ups by local day.
- `views`: today queue/chips/approvable/sources, money via `pay.locale`/`pay.currency`, applications dates, knowledge
  tabs with note paths.
- `cli`: the commands end to end in a temp home (child processes, files for text), features gating, `remember` applying
  to open forms.
- A grep test: no SQL built by interpolation or concatenation anywhere in `src/jobs`.

## Done
Built as planned in §2, with the decisions in §3.

- **Code:** `src/jobs/{db,migrations,time,ctx,fields,text,plan,views,commands}.ts`, `src/jobs/kb/{questions,cite,ops,learn}.ts`,
  `src/jobs/draft/{prompt,draft}.ts`, `src/jobs/pipeline/{roles,prefilter,pick,apply,outreach}.ts`,
  `src/jobs/data/terms.yaml` (≈250 terms across software, data/analytics, design, business tools, healthcare, finance,
  certifications). P1 changes: `memory.ts` `undoRemember`; schema `profile.copy_only_hosts`, `career.terms.extra` (and
  `me set` roots, templates); `companyKey` drops a trailing domain; `jobs remember` goes through the knowledge base (applies to
  open forms, undoable); `cli.ts` loads the P2a commands lazily.
- **Tests:** `test/jobs/{db,time,cite,kb,draft,plan,pipeline,views,cli-pipeline,sql-guard}.test.ts` (ported from the Job
  Agent's db, cite, kb-ops, draft, pick, outreach, app-data, copy-mode and fill-plan tests, with fictional people only), plus
  migrations, time zones across a UTC midnight (Berlin and Chicago), profile answers stored as approved, memory reuse across
  two roles, not interested + refilter, the journal line, feature gates and the SQL grep guard. Whole suite: 217 tests,
  green with the leak scan; `npm audit --omit=dev --audit-level=high` clean.
- **Deferred:** netguard, `link`, LinkedIn posting reads, headless `form` reading and resume PDF (P2b, interfaces in §4);
  `--request <id>`, closing requests on applied/skipped, the Jobs page (P3); budgeted early-stop judging and a light model
  for triage (P5). Not run on Node 22 locally (Node 25 here); node:sqlite FTS5 and the lazy loader are covered by CI's
  22/24 matrix.
