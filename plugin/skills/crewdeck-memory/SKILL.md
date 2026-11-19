---
name: crewdeck-memory
description: Keep what the user tells you in their Crewdeck vault, in their own words. Use in any Claude session when the user says "remember…", changes a job-search preference ("I'm OK with hybrid now", "raise my pay floor"), states a fact about themselves or their work, gives a style rule for answers, says they're not interested in something, or corrects their profile.
---

# Remember it in the user's notes

Everything Claude knows about the user lives in their vault as notes they can read and edit (Crewdeck → Notes). This skill
routes what they say to the right note, through commands that validate it, with **their exact words** kept as the reason
or quote. It works in any session, not only the jobs workspace.

`crewdeck` is the Crewdeck CLI: on the PATH after `npm link` in the Crewdeck checkout, otherwise
`node <checkout>/src/cli.ts`. `crewdeck jobs check` prints where the notes are (the vault). If Crewdeck isn't set up on this
machine, say so and keep nothing.

## The rule for every write
Their words and anything else that isn't a fixed word or number go into files written with the **Write tool**, never
into the command line, and never through a heredoc or `echo` (their words could end it early). `<T>` is a scratch
folder written out in full (in the jobs workspace: `<jobs home>/out/tmp`). For example, write `I'm OK with hybrid now`
to `<T>/quote.txt` with the Write tool. Run each `crewdeck` command as its own Bash call (in the jobs workspace's
sandbox only a plain call, with no `cd`, `&&`, variables or redirects, reaches Crewdeck).
After writing, run `crewdeck jobs check`. If a value is refused, the message names the field and the fix.

## Where each thing goes

| The user says | Command |
|---|---|
| A job-search preference: titles, places, workplace, pay, languages, employment types, licences, sponsorship, exclusions, daily picks | `crewdeck jobs pref set <field> --value-file <T>/value.txt --because-file <T>/quote.txt` (e.g. field `workplace`, value `[remote, hybrid]`). It updates `jobs/search.md` and logs a dated line with their words under `## Changes`. Then offer: "Want me to re-check roles dropped in the last 14 days?" and on yes `crewdeck jobs refilter --days 14` |
| Their answer to a question forms ask ("my notice period is one month") | `crewdeck jobs remember --kind answer --key notice_period --text-file <T>/text.txt --quote-file <T>/quote.txt`: reused on every later form with that question |
| A fact about themselves or their work ("I led a team of five") | `crewdeck jobs remember --kind fact --text-file <T>/text.txt --quote-file <T>/quote.txt`: answers may cite it |
| A general preference about jobs that isn't a setting ("I prefer small teams") | `crewdeck jobs remember --kind preference --text-file … --quote-file …` |
| A style rule for answers ("keep answers under 80 words") | `crewdeck jobs remember --kind style --text-file … --quote-file …`: drafts follow it; drafts that aren't their own edits are redrafted |
| Not interested in a kind of job ("no agency roles") | `crewdeck jobs remember --kind avoid --text-file … --quote-file …` (add `--title-words-file` with words such as `agency` only if they want titles with that word dropped outright) |
| Not interested in one role on the Jobs page | `crewdeck jobs not-interested <role> --reason-file <T>/quote.txt` |
| Something true of every role at one company | `crewdeck jobs remember --kind company_rule --scope company --company-file <T>/company.txt --text-file … --quote-file …` |
| Their own details (new phone, new city, a link) or a standard answer | `crewdeck jobs me set identity.phone --value-file <T>/value.txt`, `crewdeck jobs me set standard_answers.notice_period --value-file …` |
| A new resume bullet | only with their approval of the exact words: add it to `facts` in `me/career.md` with `crewdeck jobs me set facts --value-file …` (the whole list as one YAML flow list `[{ id: …, text: "…" }, …]`, existing facts unchanged) |
| Anything else to remember (not about the job search) | append to `me/preferences.md` in the vault, in their words, with the date, as the vault's `CLAUDE.md` says |

- `text` is the item in plain words; `quote` is exactly what they said. An answer needs a `--key` (snake_case question key);
  a new answer for the same key replaces the old one, which stays in history.
- Never store a guess, and never store something they said about another person as their own.
- Made a mistake? `crewdeck jobs undo` takes back the last answer change or memory; `crewdeck jobs remember --retire m-N`
  retires one item (kept, marked retired).
- Confirm in one line what you stored and where ("Noted in jobs/search.md: workplace remote → remote, hybrid").
