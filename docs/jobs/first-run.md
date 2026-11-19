# First run: from zero to a submitted application

This walks a new user through Crewdeck Jobs in the Claude desktop app, one step at a time. Each step says what you do,
what you should see, and what to do if you don't. It takes about 30 minutes, most of it the interview with Claude.

You type commands in a terminal, in the folder where you cloned Crewdeck. `crewdeck …` below means
`node src/cli.ts …` run there (or `crewdeck …` itself after `npm link`). Paths are the defaults; yours may differ if you
passed `--vault` or changed the config.

## 0. Starting fresh if you already had Crewdeck

Skip this if you never ran Crewdeck. To test as a brand-new user, move your old data aside. **Don't delete it**: these
moves are backups you can put back.

1. Stop the running Crewdeck: Ctrl-C in the terminal where `crewdeck up` runs (or stop it where Claude started it).
   `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4848/` should then print `000`.
2. Move the old Crewdeck home and vault aside:
   ```bash
   mv ~/.crewdeck ~/.crewdeck.backup-$(date +%Y%m%d)
   mv ~/Crewdeck/vault ~/Crewdeck/vault.backup-$(date +%Y%m%d)
   ```
   (If your vault was elsewhere, `vault:` in the old `config.yaml` says where.) To go back later: stop Crewdeck, move
   the new folders aside the same way, and move the backups back to their old names.
3. Remove the old plugin and marketplace (the plugin was called `crewdeck-bridge` before 0.3.0; the marketplace has the
   same name as the new one, so it has to go before the new one can be added):
   ```bash
   claude plugin list                      # see what you have
   claude plugin uninstall crewdeck-bridge@crewdeck
   claude plugin marketplace remove crewdeck
   ```
   If `claude plugin list` shows `crewdeck@crewdeck` already, uninstall that too (`claude plugin uninstall
   crewdeck@crewdeck`) so step 2 installs the version from your checkout.

Your project repos keep their boards (`backlog/` lives in each repo); you can add them again with
`crewdeck add-project`.

## 1. Get the code

```bash
git clone https://github.com/pulkitnagpal/crewdeck.git
cd crewdeck
npm ci
```

**You should see** npm finish with "added … packages" and no errors. (To try a branch that isn't merged yet:
`git switch <branch>` before `npm ci`.)

**Node.** `node --version` must say v22.18 or newer. For fetching from job boards it must be **v25 or newer**: from 25,
Node can run the boards' third-party code with no network access of its own. On 22 or 24 everything else works and
sourcing says why it doesn't. On macOS, `brew install node` gives the current release; nvm and fnm work too.

**If not:** on a Node older than 22.18, npm warns `EBADENGINE` and Crewdeck's commands fail to start (it runs its
TypeScript directly, which needs 22.18): install a newer Node and run `npm ci` again.

## 2. Set everything up (one command)

```bash
crewdeck setup
```

(Add `--preset <name>` to start your search from typical boards and settings: `remote-any-country`, `onsite-city`,
`healthcare-us` or `non-engineering`. `--vault <path>` puts your notes somewhere else.)

It does, in order:
- **Crewdeck's home** `~/.crewdeck/` (private: config, the bridge token, SilverBullet) and **your vault**
  `~/Crewdeck/vault`: your notes.
- **Jobs:** the job notes in the vault (`me/profile.md`, `me/career.md`, `jobs/search.md`, `jobs/memory.md`,
  `jobs/sources.md`), the private tracker in `~/.crewdeck/jobs/`, and the job-board providers (downloaded and checked
  file by file).
- **Your jobs folder** `~/Crewdeck/jobs`: the folder you open a Claude session in to work on Jobs. Crewdeck writes a
  `CLAUDE.md` (the hard rules) and `.claude/settings.json` (Claude Code's sandbox) there and rewrites them on every
  start, so don't edit them.
- **The `crewdeck` plugin** in Claude (from this checkout, so it always matches): it brings your clicks on the Jobs
  page into that session and carries the Jobs skills.

**You should see** a list of ✓ lines ending with:
```
✓ installed the crewdeck plugin in Claude (it loads in new sessions)

Done. Now:
  1. Start Crewdeck: crewdeck up   (leave it running)
  2. Open http://localhost:4848 (in Claude desktop: ask Claude to open it in the browser pane) and click Jobs.
  3. In Claude desktop, start a new Code session in the folder ~/Crewdeck/jobs
     and say hello. Then click "Set up with Claude" on the Jobs page: Claude interviews you there.
```
(Full paths in place of `~`.) Running it again is safe: it never overwrites a note you changed.

**If not:**
- The SilverBullet download needs internet and `unzip`.
- "no Chromium-based browser": install Chrome, Chromium, Brave or Edge (or set `jobs.browser` in the config to its
  full path). Jobs needs one to read forms and print resume PDFs.
- The providers line failed (offline, GitHub down): pasted links still work; run `crewdeck jobs providers install`
  later.
- The plugin line failed: "claude is not on PATH" means Claude Code's command line isn't installed; in Claude desktop
  use + → Plugins → Add marketplace with the path of your checkout, then install `crewdeck`. "a marketplace called
  crewdeck is already added from somewhere else": see step 0.3, then run `crewdeck setup` again.

`crewdeck doctor` checks everything; until the next step its last line is "✗ Crewdeck isn't running on port 4848".
(Prefer separate steps? `crewdeck init`, then `crewdeck jobs init [--preset …]`, then install the plugin by hand:
`claude plugin marketplace add /path/to/crewdeck` and `claude plugin install crewdeck@crewdeck --config port=4848`.)

## 3. Start Crewdeck and open it in Claude's browser pane

Either:

- **From a terminal:** `crewdeck up` (with Node 25 if you want job-board sourcing). It prints
  `Crewdeck on http://localhost:4848  (notes: …; projects: none yet)` and keeps running. Then, in the Claude desktop
  app's Code tab, open the browser pane and go to **http://localhost:4848** (or ask Claude "open http://localhost:4848
  in the browser").
- **From Claude:** add the `.claude/launch.json` from the README ("Run it from the Claude desktop app") to a folder you
  open in Claude Code and ask Claude to "start crewdeck". It starts the server and opens the pane.

**You should see** the Crewdeck page: a rail on the left with **Notes** and **Jobs** (a **Board** per project once you
add one), in the same light or dark as Claude. Notes shows your vault's home page. Jobs shows a **Set up Jobs** card with
"No Claude session" and your jobs folder.

![The setup card on a new install](../img/jobs-setup-light.png)

**If not:**
- `EADDRINUSE`: something else uses 4848 or 4849 (an older Crewdeck?). Stop it, or change `port` and
  `silverbullet.port` in `~/.crewdeck/config.yaml`.
- Notes is blank: wait a few seconds on first start (it indexes the vault). The browser pane logs a service worker error
  for Notes; that is harmless.
- Notes is light while the rest is dark (or the other way) on the very first load after an older Crewdeck: reload the
  page once; it then follows Claude's light/dark.

## 4. Open a Claude Code session in your jobs folder

In Claude desktop's Code tab, start a new session and pick the folder `~/Crewdeck/jobs` (the setup card shows it;
**Copy** puts it on your clipboard). Trust the folder when Claude Code asks, then say hello.

**You should see** within a few seconds: the session's status line reads `Crewdeck · jobs`, and the Jobs page says
**Claude connected** (the card's "not connected yet" turns into "Claude connected").

**If not:**
- Still "No Claude session": check `claude plugin list` shows `crewdeck@crewdeck` enabled, and that the plugin's `port`
  is Crewdeck's port. Restart the Claude app if a session started before the plugin was installed. Send any message in
  the session to wake it: the bridge checks in every few seconds.
- "Crewdeck: server failed its identity check": Crewdeck isn't running on that port, or it restarted with a new token.
  Start it, then send a message.
- On Linux, Bash refuses to run here without `bubblewrap` and `socat` (the jobs folder's sandbox): install them.

## 5. Set up with Claude

Click **Set up with Claude** on the Jobs page. Keep your resume file handy (PDF, Word export, Markdown or text).

**You should see** a toast in the session ("Crewdeck: 1 request for jobs") once it is idle, and Claude starts the
`jobs-setup` interview in the chat:

1. It asks for your resume: give its path, or drop it into `~/Crewdeck/vault/raw/`. It reads it as data.
2. It proposes who you are (name, contact, links, education, standard answers such as notice period) and your career:
   resume sections and **facts**, word for word from your resume. You correct, drop or add; it writes only what you
   confirm.
3. It interviews you for the search, a few questions at a time: titles, where (cities and/or where you can work remotely
   from), workplace, pay floor with currency and period, languages, employment types, licences, sponsorship,
   exclusions, how many picks a day.
4. It ends with `crewdeck jobs check`. Once your profile has a name and your search has titles, the setup card gives way
   to **Today**.

What it wrote, in your vault (open them in **Notes**; edit anything):

| Note | Now holds |
|---|---|
| `me/profile.md` | Your identity, links, education and standard answers |
| `me/career.md` | Resume sections and the fact bank |
| `jobs/search.md` | What you want, and a **Changes** log starting today |
| `jobs/sources.md` | Where to look, in priority order (filled in the interview from `crewdeck jobs sources suggest`) |
| `jobs/memory.md` | Empty until you tell Claude things along the way |

**If not:** the card says "Waiting for Claude to start the setup" while the session is busy: requests arrive only when
it is idle. If Claude stops, the card says why; click **Set up with Claude** again. Claude may ask permission for its
first commands: it runs `~/.crewdeck/bin/crewdeck jobs …` (the one command the sandbox lets out).

## 6. Paste a job link

Copy the link of any posting (the company's own careers page works best) into **Paste a job link** at the top of Jobs
and click **Add link**.

**You should see** "Link sent to Claude", the status line "Waiting for Claude: Add a job link", then Claude working.
Claude reads the posting, adds the role, picks it for today and **prepares** it:

- it reads the application form (headless, or for forms that need a real browser, in a background tab of the pane, only
  stepping between pages of questions);
- it fills what your profile and memory already answer, drafts the rest from your facts (each answer shows its
  sources), and turns anything it can't support into a **first-time question**;
- it renders a tailored resume PDF from your facts.

It closes the request with something like "Example Co — Product Designer is ready: 9 answered, 2 questions for you".
The role appears in **Today** with its answers.

**If not:**
- A warning (cooldown, already applied, a role at that company in progress): Claude asks in the chat; **Add it anyway**
  is your call on the page.
- "Pasted LinkedIn links are off": see step 11, or paste the company's own posting.
- The posting needs sign-in: Claude stops and says so. Sign in yourself in the pane, then ask Claude to continue.

## 7. Answer first-time questions

First-time questions sit at the top of the role, marked **First time**. Answer each on the page (type, or pick an
option) or tell Claude in the chat. Each answer is remembered in `jobs/memory.md` with your words and reused on every
later form. **Edit** changes any answer; **Ask Claude** asks for a rewrite (it must still cite your sources).

**You should see** the Apply box's "first time" count go to 0 and **Apply** become clickable.

## 8. Apply, then you click Submit

Click **Apply**.

**You should see** the apply panel go through its steps:

1. **Waiting for Claude**, then **Claude is filling the form**. Claude opens the real application in a new tab of the
   browser pane, next to Crewdeck. **Open the form** brings that tab to the front, so you can watch.
2. **What Claude did** lists each step ("Step 1 of 2: filled 4 fields from your answers").
3. If the form asks something Prepare didn't see, the panel shows **Claude needs your answer** with a box. Answer it;
   Claude continues where the form is.
4. **Your turn: review the form tab and click Submit.** Claude stopped at the review page. It never clicks Submit.

![Your turn](../img/jobs-narrow-light.png)

Now switch to the form tab, check every field, attach the resume if the site needs an upload (the panel shows the PDF
with **Download** and **Show in Finder**), and **click Submit yourself**. Then click **I submitted it** in Crewdeck (or
**Mark applied**, if Claude saw the confirmation page).

**You should see** the role marked **Applied**, an "Applied to …" line in today's journal note, and the company in its
cooldown (60 days by default, `schedule.cooldown_days`).

**If not:**
- **Claude stopped** with a reason (sign-in, CAPTCHA, "restricted", a limit): do that part yourself in the form tab,
  then **Try again**, or finish the form by hand. Claude doesn't retry on its own.
- Stuck on "filling" with no progress: **Cancel** closes the request; a request whose session stops answering goes back
  to the queue after 15 minutes on its own.

## 9. Find jobs within a budget

Sourcing needs the providers (step 2), sources in `jobs/sources.md`, and Crewdeck running on Node 25+.

1. The status strip shows "N new roles since …". Crewdeck fetches every 12 hours (`jobs.fetch_every`); **Refresh
   sources** fetches now. Fetching is plain code: no tokens. Your rules then drop what clearly doesn't fit, and the rest
   is ranked by title, skills, freshness and your sources' order.
2. Click **Find N jobs** (N is your daily picks). Claude judges candidates best first, in batches of 10, and stops once
   N pass; at most 40 postings per Find. Progress lines show on the page.
3. The picks appear in **Today**, one per company, each prepared as in step 6.

**If not:** "Job boards not set up": `crewdeck jobs providers install`. "need Node 25 or newer": restart `crewdeck up`
with Node 25. "0 new roles": `crewdeck jobs sources list` shows each source's last fetch; `crewdeck jobs sources suggest`
proposes more (see the README, "Where to look").

## 10. Change a preference

In any Claude session, say what changed: "I'm OK with hybrid now."

**You should see** Claude run `crewdeck jobs pref set workplace …` with your words, then offer to re-check roles
dropped in the last 14 days (`crewdeck jobs refilter --days 14`). In Notes, `jobs/search.md` has the new value and a
line under **Changes**: `- 2026-11-20: workplace: remote → remote, hybrid. "I'm OK with hybrid now."` The Preferences
tab shows it too, and the next Find uses it.

## 11. Turn LinkedIn on (optional)

LinkedIn's terms forbid automated access; turning these on can get your IP rate-limited or your account restricted.
Read the README's "Safety and terms of service" first.

1. Jobs → **Settings** → switch **Pasted LinkedIn job links** (or another) on.
2. **You should see** your computer's own dialog asking you to confirm. Click it. The switch turns on.
3. Or in your own terminal: `crewdeck jobs features linkedin_links on` (it asks you to type `yes`, then shows the same
   dialog).

Switching off never asks: the same toggle, or `crewdeck jobs features linkedin_links off`.

**If not:** no dialog appears on Linux without `zenity` or `kdialog`: the page shows a one-time code instead; type it
into `crewdeck jobs features …` in a terminal within 10 minutes. Claude can't change these switches.

## Done

You have notes Claude wrote with you, an application you submitted yourself, and a search that learns from what you
say. `crewdeck doctor` checks the setup any time; the README's Troubleshooting table covers the usual problems.
