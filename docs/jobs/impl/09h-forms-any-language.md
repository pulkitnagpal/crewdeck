# P9h: forms and answers in any language

Part of [the Jobs design](../design.md): read §24.9 (D32, D33), §24.10 (D34, D35), §24.12 (personas), §23 question 5 and
§22 row P9h first. Rules: [README.md](README.md). Builds on P9g (`work_pattern` answers availability grids; the entry
syntax of `rule-words.yaml` is reused for form terms).

## 1. Scope
- **Form terms as data** (`src/jobs/data/form-terms.yaml`, `form-terms.ts`): per language (en, de, fr, es, pt, it, nl,
  plus `en-IN` and `en-PH`) the whole labels each profile key answers, **sensitive** words (salary expectation, CTC,
  Gehaltsvorstellung, pretensión salarial, date of birth, nationality, marital status, religion, caste or category,
  father's or mother's name, height, weight, photo, salutation, gender, EEO …) and **never_fill** words (social security,
  National Insurance, Aadhaar, PAN, Steuer-ID, Sozialversicherungsnummer, DNI/NIE, CPF, codice fiscale, BSN, passport
  numbers, IBAN, bank and routing numbers, tax ids). Short ID words that are ordinary words elsewhere (`PAN`, `NIE`, `TIN`,
  `RG`) count only as a whole label. `fields.ts` builds its profile patterns and its sensitive test from the file.
- **never_fill**: the fill plan skips it ("you type this yourself"); it is never stored as a form question, never
  drafted, never remembered (`remember`, `learn` and first-time answers refuse it), never a profile value (a standard
  answer under such a key is ignored), and `crewdeck jobs check` refuses one in `me/profile.md` or `jobs/memory.md`.
- **sensitive**: only the user's explicit answer fills it; a remembered sensitive answer is kept **for that company**
  unless the user says "use this everywhere" (`answer … --everywhere`). Claude may raise a field (`"sensitive": true` in
  the fields it reads, in a draft, or `learn --sensitive`); code takes the stricter of its own class and Claude's.
- **Answers in the form's language**: the form's language is the page's `lang` (headless read) or Claude's
  `form … --lang xx` / the draft's `language`; it is stored on the role (DB v4 `roles.form_lang`). The brief says it,
  shows approved translations under each fact, and the citation check, when the form's language differs from the
  facts' (`career.language`), accepts a fact only through its **approved** translation (`facts[].tr.<lang>`), comparing
  numbers by value and names against the translation and the original; a fact without one is refused with the reason.
- **Resume conventions**: `resume.language` (facts render through `tr`; one without it stays in its language and is
  listed in `warnings`), localised headings per language with `resume.headings` overrides, an opt-in personal block
  (`resume.personal: [date_of_birth, place_of_birth, nationality, marital_status, driving_licence, languages]`, values from
  `standard_answers`, languages also from `jobs/search.md`), `resume.word` (`CV | resume`: the file name and the page's
  copy), `<html lang>` set.
- **Experience `start`/`end`** (YYYY-MM) and **`profile.references`** `[{ name, role, org, email, phone, relationship }]`.
- **Fill plan**: an `add` action for "Add another <employment/education/reference>" buttons, capped at 10 a page; fields
  in repeated blocks (`group`, `index` from Claude, or a label that names its referee) fill from career.md's jobs (with
  `start`/`end`), the profile's education and referees; a referee's "Name" is never the user's name; availability grids
  from `work_pattern` (only what the user listed; checkboxes may tick several, `A | B`); a cover-letter upload (cover
  letter, Anschreiben, supporting statement, lettre de motivation …) offered once the letter exists.
- **Apply methods** recorded at Prepare: `crewdeck jobs role <id> --apply-method form|email|document|walk_in|chatbot|account_needed
  [--apply-note-file f]` (DB v4 `apply_method`, `apply_note`). The panel shows the answers to copy for email, a document
  or a chat assistant, where and when for a walk-in ("I applied in person"), and for `account_needed` "This site needs an
  account. Create it in the form tab (Claude never creates accounts), sign in, then click Continue".
- **`crewdeck jobs letter <role> --text-file f --claims-file f [--lang xx]`**: a cover letter or supporting statement PDF
  through the citation check (in the letter's language), printed with the resume's template (JS and network off, at most
  two pages) as `<name> <Cover Letter | Anschreiben | …>.pdf` next to the resume.
- Skills: `jobs-workspace` (form language, `sensitive`, groups and `add`, apply method, drafting in the form's language,
  resume skipped with no upload and no experience facts, the letter, never_fill, referees, `--everywhere`), `jobs-setup`
  (never store ID numbers, referees with their permission, `start`/`end`, `language`, resume conventions by country,
  translations approved word for word). Templates show the new keys.

## 2. Decisions
1. **`career.language`** (the facts' own language) is a new key the design implies ("the facts' language"): without it,
   no translation is required (old notes behave as before); setup writes it.
2. **never_fill questions are dropped at storage**, not stored as first-time questions: a required one would otherwise
   block Apply, and storing the label alone invites an answer. The plan and the reader's notes tell the user to type it.
3. **A sensitive answer is company-scoped by default**, including right-to-work questions (D32's wording: salary
   expectations differ per role and country); `--everywhere` is the user's way to share it.
4. **Profile phrases never map one label to two keys** across languages (a test checks the risky ones): German "Name"
   and Portuguese "Nome" are left out, Italian "nome" is the first name, French "nom" the last name.
5. **The availability grid is answered only from listed shifts**: a single choice only when one option fits, "any" only
   when days, evenings and nights are all listed, "not available" only for weekends the user said they can't work.
6. The Preferences screen came to D41 in P9g; here the **apply panel** comes to it too (its new states sit in it).

## 3. Tests
`forms-any-language.test.ts`:
- form-term classes in every language, including ordinary labels that must stay ordinary ("pan-India relocation",
  German "nie", "Job title", "Agency name"), and profile phrases that never collide;
- the four fixtures (HTML in `test/fixtures/jobs/forms/`, the fields as Claude reads them in the test):
  **German** (Vorname, Nachname, E-Mail, Telefon, Kündigungsfrist filled; Anrede, Geburtsdatum, Staatsangehörigkeit,
  Gehaltsvorstellung sensitive; Steuer-ID never_fill; Lebenslauf upload; Anschreiben offered once the letter exists);
  **Indian** (Full Name, Mobile, Email ID, Current Location, Total Experience, Notice Period filled; Father's Name, Date of
  Birth, Current/Expected CTC, Marital Status sensitive; Aadhaar and PAN never_fill though the profile holds fake
  numbers); **US hourly** (availability grid from `work_pattern`: Evening for Monday, Wednesday and Saturday; Gender,
  Race/Ethnicity, Veteran status and Desired pay sensitive; SSN never_fill though the profile holds one);
  **UK school** (Title sensitive, National Insurance never_fill, job 1 filled with its start and "goes on" for the end,
  "Add another employer" × 2 for three jobs, both referees filled with "ask them first", "Add another reference" skipped,
  the next page's blocks get jobs 2 and 3, twelve jobs cap at ten presses);
- never stored (form fields, memory, learn, `me set`, `check`, the plan for the role);
- sensitive company scope and `everywhere`; Claude raising a field and failing to lower one;
- the citation check in German through an approved translation, refusing an unapproved one and a number the translation
  lacks; drafting in German end to end;
- the resume in German (headings, translations, the personal block, the warning, `resume.headings`, `resume.word`);
- the letter refused for unsupported or untranslated claims, rendered in German in headless Chromium and offered for
  the Anschreiben upload; apply methods through the CLI and the panel;
- the four fixtures read headlessly: the page language recorded, ID questions not stored.
Also `sources-ui.test.ts` (the apply panel's walk-in and account-needed states: D41 in both themes), `skills.test.ts`
(the skills' new steps, lint), and the existing suites unchanged.

## 4. Done (2026-11-20)

**Built:** everything in §1. `npm test`: Node 25 623 tests, 621 pass, 2 skipped; Node 22.18 623, 609 pass, 14 skipped.

**Visual check:** a temp home on port 5342 in the in-app browser pane, light and dark: a walk-in role (where and when
from the posting, the answers to take, "I applied in person") and an account-needed role (the sign-up box, Open the
form, Continue).

**Deviations**
- `career.language` (decision 1) and the never_fill drop at storage (decision 2).
- The fixtures' fill plans use the fields as Claude reads them (with `group`/`index` for blocks); the headless reader
  doesn't mark blocks, and the fixtures are also read headlessly to check the labels, the language and that ID questions
  aren't stored.
- An "use this everywhere" control on the page is not built: the user says it to Claude (`answer … --everywhere`).

**Deferred**
- A resume photo (design: privacy and upload path).
- Field-level languages for the page's own copy (the UI stays English, D40).
- Reading repeated blocks headlessly (`group`/`index` come from Claude's live reading for now).
- Date fields that need a full day (`type=date`) for employment history: skipped, the user picks the day.
