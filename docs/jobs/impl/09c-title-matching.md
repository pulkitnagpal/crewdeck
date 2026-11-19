# P9c: title matching for every field

Part of [the Jobs design](../design.md): read §24.1, §24.5 (D26), §23 q8 (default `match: words`), §24.12 and §22 row
P9c first. Rules: [README.md](README.md). The audit behind it: [09-generic-audit.md](09-generic-audit.md) (findings 2.3,
3.1, 3.7, 6.1–6.3, 7.1, 7.3, 15.3 and the simulation table). Builds on P9a (`roles.targets` with titles and families,
LinkedIn's first three titles per target).

## 1. Scope
- **`roles.targets`** gains `skills`; `roles.match: words | broad | off` (default `words`) and `roles.level: entry |
  experienced | senior | any` (default `any`). `roles.titles` (v1) is still read, as one more target.
- **One matcher** (`src/jobs/titles.ts`) for the gate (`prefilter`), rank (which target, how exactly, its skills) and
  LinkedIn's search terms. The title gate's regex is gone unless the user overrides `rules.title_gate` (then their
  regex is used, as before).
- **Data, not per-language code:** `src/jobs/data/title-words.yaml` (en, de, fr, es, pt, it, nl): seniority words and
  their class, stop words and prepositions, endings (plural/gendered suffixes, vowel swaps), gender markers, compound
  languages, abbreviations.
- **Drop reasons that help:** a title drop names the closest target word ("title "Full Stack Engineer" is not one of your
  titles (close to engineer: Backend engineer)"); a level drop names the word.
- **Corpus test** of ≥ 400 fictional titles for the nine audit personas with expected pass/fail, every title from the
  audit's simulation table among them, plus the v1 rule: the same notes as `roles.titles` pass everything the old phrase
  gate passed.

Not in P9c: preview, near-miss suggestions on real postings and the funnel (P9d); the Preferences targets editor (P9d);
setup's variant interview (P9f).

## 2. How a title is read (`readTitle`)
1. `plain` + lower case (accents folded). Gender markers removed: bracketed letter sets (`(m/w/d)`, `(f/m/x)`, `(h/f)`,
   any bracket holding only single letters joined by `/ , | .`), the bracketed phrases in the data (`(all genders)`,
   `(gn)`), and word endings joined by `* : / _ · (` (`Buchhalter*in`, `Lehrer:in`, `Traductor/a`, `Comptable(e)`,
   `Directeur/rice`).
2. Split into words on anything that isn't a letter or digit (`&`, `/`, `-`, `,`, brackets …). Requisition ids (a word
   with three or more digits) are dropped.
3. Seniority words (and two-word phrases such as "entry level", "fresh grad") are set apart with a canonical form and a
   class (`entry`, `student`, `senior`, `mid`). `lead` (and the other words marked `end_role`) at the end of the title
   stays a role word ("Tech Lead").
4. Stop words are dropped. The **main part** (before ` - `, ` | `, `,` or a bracket) gives the head word and the
   near-miss label (P9d).

## 3. When a target title matches (`matchTitle`)
- Every word of the target title appears among the posting's words, in any order. Seniority words in the posting never
  block; a seniority word the user wrote in a target ("staff nurse", "tech lead", "senior accountant") is matched like
  any word (canonical forms: `sr` = `senior`).
- A target word matches a posting word when equal, or the posting word is the target word plus an **ending** from the
  data (en `s es ing`, de `in innen en n e s es`, fr `e s es x ne nes se`, es/pt `a as s es os`, it/nl …), or a **vowel
  swap** (`enfermero` ↔ `enfermera`, `vendeur` ↔ `vendeuse`). "nurse" matches "nurses", never "nursery".
- **Compound tails** (de, nl, sv, da, no, fi): when the posting's language or one of the user's languages compounds, a
  target word of 5+ letters also matches the tail of a longer word ("buchhalter" ⊂ "Finanzbuchhalter").
- Words under 4 letters and **abbreviations** in the data (RN, SRE, CNA, CDL …) match only as whole words.
- **v1 `roles.titles`** keep their old reach: each of their words also matches the start of a longer word (the old
  gate had no end boundary). That makes v1 a strict superset of the old phrase gate (tested on the corpus).
- **Modes:** `words`; `broad` also keeps a title sharing a target's head word (ranked below); `off` keeps every title.
- **Level:** `entry` drops titles with a `senior`-class word; `experienced` drops `student`-class words; `senior` drops
  `entry` and `student`; `any` drops nothing. A seniority word the user wrote in one of their titles never drops.
- **Rank:** an in-order match (the old phrase) scores 30 − 3 × the variant's position (≥ 10), any order 4 less, broad 8;
  skills are career.md's plus the matched target's.

## 4. Decisions
1. **Union of languages.** The matcher reads every language's words at once (a German posting on a remote board, an
   English one in Berlin); only compound tails depend on the language, because they are the one rule that widens a lot.
2. **No auto-expansion.** Abbreviations in the data say which words are whole-word only and let the preview propose them
   (P9d); the gate matches only what the user listed (D26: explainable, no fuzzy matching).
3. **v1 keeps its reach** rather than inherit the stricter word rule: "never fewer passes" is binding, so a v1 `nurse`
   still passes "Nursery Assistant" until the user moves it into a target. Targets use the strict rule.
4. Seniority words in targets count: a user who writes "senior accountant" means it, and `level` covers the rest.

## 5. Tests
`test/jobs/titles.test.ts`: reading (markers, compounds, swaps, seniority, stop words, abbreviations), level, modes,
rank, LinkedIn terms; `test/jobs/title-corpus.test.ts` over `test/fixtures/jobs/title-corpus.yaml` (nine personas,
≥ 400 titles) and the v1 superset check against the old phrase regex; existing rule, rank and LinkedIn tests unchanged.

## 6. Done (2026-11-20)

**Built**
- `src/jobs/data/title-words.yaml` (en, de, fr, es, pt, it, nl; sv/da/no/fi as compound-only): seniority words with
  canonical forms and classes, `end_role`, stop words and prepositions, endings and vowel swaps, gender brackets,
  joiners and endings, abbreviations with their long forms.
- `src/jobs/titles.ts`: `readTitle`, `cleanTitle`, `titleMatcher`, `matchTitle` (exact / words / broad), `wordHit`,
  `levelBlock`, `closest`, `abbreviationsFor`, `targetsOf`, `searchTerms`, `describeMatcher`.
- Schema: `roles.targets[].skills`, `roles.match` (words | broad | off, default words), `roles.level` (entry |
  experienced | senior | any, default any).
- `compileRules` carries the matcher (`titles`, `titleGate`); `prefilter` drops on `title_gate` (the reason names the
  closest head word and target) and on the new `level` rule after `title_exclude`; `rules.title_gate` (the user's regex)
  still replaces the gate. `describeRules` and the judge brief name the targets and the level.
- Rank uses the matcher (in order 30 − 3 × position, any order −4, broad 8) and the matched target's skills; LinkedIn's
  terms come from `searchTerms`; the Today setup check and the Knowledge view read targets.
- Tests: `titles.test.ts` (13), `title-corpus.test.ts` (19) over `test/fixtures/jobs/title-corpus.yaml`: **445 titles**
  (258 expected passes, 187 expected fails) for E 45/24, N 33/22, A 35/21, R 20/20, T 24/20, G 20/20, W 33/20, S 20/20,
  F 28/20 (pass/fail), in English, German, Spanish and French; every title of the audit's simulation table passes, and
  for each person the v1 titles pass everything the old phrase gate passed over the whole corpus.

**Deviations**
- Seniority words a user writes in a target are matched (decision 4); the design's "never the role match" holds for
  postings: their seniority words never block.
- v1 `roles.titles` keep the old prefix reach (decision 3), so "never fewer" holds literally; the stricter word rule
  applies to `roles.targets`. "Nursery Assistant" drops for every persona whose titles are targets.
- Abbreviations accept a plural `s` ("RNs").
- "staff" is set apart with no level class ("Staff Nurse", "Staff Accountant" are not senior roles).

**Deferred**
- The near-miss suggestions, preview and funnel: P9d. Proposing variants in the interview: P9f.
