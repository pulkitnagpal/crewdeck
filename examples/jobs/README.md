# Example: one fictional person's job notes

Sam Example is not a real person. These five notes are a complete, valid setup as it would sit in a Crewdeck vault: a
senior product designer in Lisbon who works remotely from the EU or the UK, or hybrid in Lisbon, paid in euros.

| Note | What it shows |
|---|---|
| [me/profile.md](me/profile.md) | Identity, links, education and standard answers ("notice period: 30 days") |
| [me/career.md](me/career.md) | Resume sections in page order and the fact bank Claude cites, word for word |
| [jobs/search.md](jobs/search.md) | Titles, workplace, places, languages, pay (EUR a month, with exchange rates), exclusions, daily picks, judge notes, and the **Changes** log |
| [jobs/memory.md](jobs/memory.md) | What Claude learned: answers, a preference, a style rule, an "avoid" reason and a company rule, each with Sam's words |
| [jobs/sources.md](jobs/sources.md) | One company's careers page first, then two remote boards, in priority order |

Your own notes start from the commented templates in [vault-template/](../../vault-template/) (`crewdeck init` copies
them into your vault) and are filled in with Claude by the setup interview: see
[docs/jobs/first-run.md](../../docs/jobs/first-run.md).

## Try it

With a throwaway Crewdeck home, so nothing touches your own:

```bash
export CREWDECK_HOME=$(mktemp -d)
node src/cli.ts init --vault "$CREWDECK_HOME/vault"
cp -R examples/jobs/me examples/jobs/jobs "$CREWDECK_HOME/vault/"
node src/cli.ts jobs init --no-providers
node src/cli.ts jobs check          # the notes are valid
node src/cli.ts jobs rules          # the hard drops Sam's notes compile to
node src/cli.ts jobs judge-brief    # what Claude is told when it judges a posting for Sam
```

(`init` downloads SilverBullet into that temp home; the commands after it work offline.)

## Two more people

The journey tests use two more fictional people, each a full vault (`me/` and `jobs/`), to prove the same code works for
very different searches:

- [test/fixtures/jobs/people/berlin-analyst](../../test/fixtures/jobs/people/berlin-analyst/): a data analyst who wants
  on-site or hybrid work in Berlin, with German and English titles, a yearly floor in EUR and a `de-DE` locale.
- [test/fixtures/jobs/people/us-nurse](../../test/fixtures/jobs/people/us-nurse/): a registered nurse who works remotely
  only from the states she is licensed in, per-diem or contract, paid by the hour in USD.

Their journeys (setup, paste a link, prepare, apply, change a preference, not interested, find) are in
[test/jobs/e2e/](../../test/jobs/e2e/).
