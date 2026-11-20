# Roadmap

What is built, what is deferred and why, and what Crewdeck will never do. Dates and order are not promises.

## Built

- [x] Workspace: shell, SilverBullet notes, Backlog.md boards, one theme, a starter vault, apps in the rail.
- [x] Bridge: page requests reach the Claude session that owns the lane, while it is idle; results come back.
- [x] Jobs: setup with Claude, paste a link, Prepare, Apply in the browser pane (you submit), Find within a token
      budget, learning from what you say, presets, risky switches you alone control.
- [x] Security review of the module, with fixes and the residual risks written down.
- [x] Jobs v0.4, Jobs for anyone: a source catalog and the Sources tab, title matching for every field, preview and
      "Why so few?", setup with or without a resume, work pattern and pay periods, forms and answers in any language,
      the whole page at 14 px and AA contrast, seven persona journeys.

## Next

- [ ] **Start an agent on a ticket.** Moving a card to In Progress (or a button) starts a worktree session for it;
      agent status on cards.
- [ ] **Memory skills for the wiki:** ingest a source from `raw/`, answer from the index, a weekly lint.
- [ ] **The owner's acceptance run** of Jobs v0.4 as a brand-new user (first-run.md v2), and fixes from it.

## Deferred

| Item | Why it waits | What would bring it forward |
|---|---|---|
| Import data from the private Job Agent that Jobs grew out of | Every user, its author included, starts fresh as a new user; an import script is optional | A user with history worth keeping asks |
| A packaged installer (Jobs v0.4, D40) | "Let Claude install it" covers non-developers today; an installer is a separate project | Users who can't run Claude desktop's Code tab |
| A mobile client (D40) | Apply happens in the browser pane next to Crewdeck, which needs a desktop | A way to fill forms safely without the pane |
| UI translations (D40) | No translations we can check; strings are English, Claude speaks the user's language | A maintained translation per language |
| New job sources for uncovered markets (Naukri, Indeed, Apna, JobStreet PH, NHS Jobs…) | Providers come from career-ops through the reviewed re-pin, after checking each site's terms | Upstream adds them |
| Windows | Notes runs on a Unix socket, the sandbox and the native dialogs are macOS/Linux; nothing is tested on Windows | Someone to test it; a named-pipe or token story for Notes |
| Multi-user or hosted | Crewdeck is one person's local workspace: one token, one vault, everything on `127.0.0.1` | Never as a cloud service; a shared-machine story would need per-user homes and auth first |
| Backlog.md bind and auth | `backlog browser` (1.55.3) listens on TCP with no Host or Origin check and no auth, so a page spraying local ports could create a task. Crewdeck randomises the port per start and documents the risk. An upstream issue is drafted in [07-security-review.md](jobs/impl/07-security-review.md) (not filed yet) | Upstream adds a Unix socket, a token or Host/Origin checks: then put boards on a socket like Notes |
| A coded filler for hard form families (Workday, iframes) | Filling happens in Claude's browser pane from a fill plan; one filler is easier to keep safe | More than one failed fill in 10 on a family |
| Moving Jobs to its own process | The in-process tracker is small and uses WAL with busy timeouts | The lock test or a user report shows the shell stalling |
| Pane URL allow-listing | "Open only the role's pages" is a prompt-level rule in the pane today | Any observed prompt-injection attempt through the pane |
| Sourcing on Node 22/24 | Only Node 25's permission model keeps the providers off the network | Never with network access; a different sandbox could make it possible |
| Interview prep | Out of scope for the first release | After the application flow is solid |

## Never planned

- **Auto-submit.** Claude prepares and fills; you review and click Submit.
- **Solving CAPTCHAs, typing passwords, signing in for you, creating accounts.**
- **Social actions:** connecting, following, messaging, posting or reacting on LinkedIn or any site. No X.
- **Sending email.** Drafts only, and only when you switch drafts on.
- **Mass applying.** Daily picks, one role per company, cooldowns and caps stay in code.
- **Invented experience.** Answers and resumes use your facts and your words only.
- Accounts, a cloud service or telemetry.
