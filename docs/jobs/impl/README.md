# Rules for every Jobs implementer (read before any phase)

The design is [../design.md](../design.md); it wins over anything here except the safety rules. Each phase has its own
doc in this folder (`NN-name.md`), written by that phase's implementer **before** coding, from design §22's row.

## Repository and process
- Repo: this one, branch `feat/jobs-module`. Commit at the end of the phase (and at
  safe points), message ending with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  **Never push**, never change remotes, never open PRs.
- Node ≥ 22.18, TypeScript run directly (type stripping: no parameter properties, no enums, no namespaces; `import type`
  for types). No build step. Tests: `node --test` files under `test/` (`npm test` also runs the leak scan). Keep
  everything green; add tests for every behaviour you add.
- Dependencies: only what the design allows (preact, htm, playwright-core, yaml already). Pin exact versions
  in package.json, update package-lock with `npm install`. Run `npm audit --omit=dev --audit-level=high`.
- Code style: match the existing files (small modules, short comments that say why, plain names).
- Update `docs/jobs/design.md` changelog with one line per phase, and the phase doc's "Done" section with what was built
  and anything deferred.

## Never
- Personal data in the repo: tests, fixtures, docs and examples use **fictional people only** (example.com emails,
  phone numbers containing 1234567). The pre-commit leak scan must pass; never weaken it to pass.
- Touch the owner's real data: not `~/.crewdeck/` (use a temp `CREWDECK_HOME` in tests and manual runs), not
  `~/Crewdeck/vault`, not the private Job Agent checkout (read it to port code; never write there).
  Don't start, stop or kill servers on ports 4747-4949 (the owner's running Crewdeck and Job Agent).
- Use LinkedIn, X or any real job site in tests: tests use local fixtures and local HTTP servers only.
- Write code that clicks Submit, sends email, solves CAPTCHAs or types passwords. `test/source-guard`-style checks apply.
- Put page/posting text into shell commands; run child processes with `execFile`/`spawn` argument arrays only.

## Porting from the private Job Agent
Source to port: the private Job Agent checkout named in your brief, `src/` (its tests in `test/`). Port behaviour and
tests, not its personal assumptions: anything about one country, currency, time zone, employer, name or resume
layout becomes a setting from the user's notes (design §7). Rename `ja` commands to `crewdeck jobs <cmd>`.

## Where things live (design §2.1, §6)
- Code `src/jobs/`, UI `web/jobs/`, skills `plugin/skills/`, note templates `vault-template/jobs/` and
  `vault-template/me/career.md`, presets `presets/jobs/`, fictional examples `examples/jobs/`.
- User knowledge = vault notes (`me/profile.md`, `me/career.md`, `jobs/search.md`, `jobs/memory.md`,
  `jobs/sources.md`); machine state = `<jobs.home>` (default `~/.crewdeck/jobs`: `jobs.db`, `out/`, `providers/`).
