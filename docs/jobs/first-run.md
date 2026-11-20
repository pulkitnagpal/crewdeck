# First run: from zero to your first application (v3)

This walks a brand-new user through Crewdeck on a Mac, in the Claude desktop app, one step at a time. Each step says
what you do, what you should see, and what to do if you don't. It takes about 30 minutes, most of it the interview with
Claude. Linux works the same way (the differences are noted). You never need a terminal.

**What you need:** a Mac (or Linux) computer, the [Claude desktop app](https://claude.ai/download) with a plan that
includes its Code tab, Chrome, Brave or Edge, an internet connection, and your resume if you have one (no resume is
fine too).

`crewdeck …` commands mentioned below are ones Claude runs for you; in Terminal they are `~/.crewdeck/bin/crewdeck …`.

## 0. Starting fresh if you used Crewdeck before

Skip this if you never ran Crewdeck. To start over as a brand-new user, move your old data aside. **Never delete it**:
these moves are backups you can put back. In a Code session, ask Claude to do this for you, or in Terminal:

```bash
~/.crewdeck/bin/crewdeck service uninstall
mv ~/.crewdeck ~/.crewdeck.backup-$(date +%Y%m%d)
mv ~/Crewdeck/vault ~/Crewdeck/vault.backup-$(date +%Y%m%d)
mv ~/Crewdeck/jobs ~/Crewdeck/jobs.backup-$(date +%Y%m%d)
```

To go back later: uninstall the service the same way, move the new folders aside, and move the backups back. Your
project repos keep their boards (`backlog/` lives in each repo).

## 1. Add Crewdeck to Claude

In the Claude desktop app, open the **Code** tab. Click **+** next to the message box → **Plugins** → **Add
marketplace**, enter `pulkitnagpal/crewdeck`, then **Add plugin** → **crewdeck** (scope: user). (The desktop app
doesn't take `/plugin` commands typed in the message box; in Claude Code in a terminal, `claude plugin marketplace add
pulkitnagpal/crewdeck` and `claude plugin install crewdeck@crewdeck` do the same.)

**You should see** crewdeck in the plugin list as installed.

**If not:**
- macOS asks to install the "command line developer tools": click **Install** and wait for it to finish, then add the
  marketplace again. Claude uses them (git) to fetch plugins; Crewdeck itself doesn't.
- "a marketplace called crewdeck is already added": you added it before; install **crewdeck** from it.

## 2. Type /crewdeck and click Set up Crewdeck

Start a **new** Code session (a plugin loads in sessions started after it was installed), in any folder, and type
`/crewdeck`.

**You should see** a panel beside the chat: **Welcome to Crewdeck**, what setup does, and **Set up Crewdeck**. Click
it. The panel shows each step:
1. Downloading Node (about 50 MB, from nodejs.org; checked against its published checksum before it is used).
2. Downloading Crewdeck (from its GitHub release; checked the same way).
3. Installing what Crewdeck needs (a minute or two).
4. Setting up your notes (`~/Crewdeck/vault`), Jobs, the job-board providers and the background service (Crewdeck
   starts when you log in, and comes back by itself if it stops).
5. Starting Crewdeck.

Then the panel shows **Today**: your to-dos (empty for now), **Jobs** with **Set up my job search**, and buttons to open
Crewdeck. Crewdeck itself is at **http://crewdeck.localhost:4848** (Claude's browser pane or any browser).

**If not:**
- A step says it could not download: check your internet connection and click **Try again**: setup carries on where it
  stopped. Nothing half-downloaded is ever used.
- "✗ no Chromium-based browser": install Chrome, Brave or Edge; Jobs needs one to read forms and print resume PDFs.
- Something else already uses port 4848: setup picks the next free port and says so (the panel follows it).

## 3. Set up my job search

Click **Set up my job search** in the panel (the Jobs page has the same button, **Open in Claude**). Claude desktop asks
you to confirm the folder `~/Crewdeck/jobs` (it always asks for a folder that comes from a link), and opens a new chat
there with "Hello! Please set up my Crewdeck job search." in the message box. Press Enter.

This chat is Claude's job-search workspace: it works on Jobs only from here, with its own safety rules (Claude Code's
sandbox), and the Jobs page shows **Claude connected** while it is open.

**If not:**
- Nothing opens: Claude desktop must be installed (your browser may ask once to open it). Or start a Code session by
  hand and pick the folder `~/Crewdeck/jobs` in its folder chooser.
- Linux: Bash refuses to run in this folder without `bubblewrap` and `socat` (the jobs folder's sandbox): install them.

## 4. Open Crewdeck

Click **Open Crewdeck** in the panel, or ask Claude to "open Crewdeck" (it opens the page in Claude's browser pane).
The rail on the left has **Notes** (your files on the left, **Today** and formatting buttons at the top) and **Jobs**.

On **Jobs → Today** you see the setup card while the interview runs, and your picks once Find has run. The interview
(step 5) happens in the job-search chat.

## 5. Set up with Claude (the interview)

The hello you sent in step 3 starts the interview. (From the Jobs page, **Set up with Claude** does the same: a toast
in the session, "Crewdeck: 1 request for jobs", and the card says **Claude is setting up Jobs with you in the chat**.) Answer in your
own words and your own language. Claude proposes, you confirm; it writes nothing you didn't say yes to.

If you clicked before the session was open, the card says **Waiting for a Claude session** ("No Claude session is
connected yet…"): open it (step 4) and the setup starts there by itself, or click **Cancel**.

The interview, in order:
1. **Your work.** *With a resume:* give its path, or drop the file into `~/Crewdeck/vault/raw/` (PDF, Word export,
   Markdown or text). Claude reads it as data and proposes your resume sections and **facts**, word for word, one per
   bullet. *Without one:* Claude asks about every job you have done, paid or not (employers, a family business, gig
   work, caring, volunteering), and writes facts from your answers after you confirm each. Starting out, changing field
   or coming back after a break each have their own path (projects and internships; a new field with its skills; a
   career break shown as a break).
2. **Who you are:** name, contact, links, education, standard answers such as your notice period and right to work.
   It never stores ID, bank or tax numbers (you type those into forms yourself).
3. **The kinds of job you want**, in your words, with the titles postings use (in every language you would work in),
   your level, where (cities, or where you can work remotely from; cities you would move to), workplace, and how you
   work (employment types, shifts, hours).
4. **Where to look.** Claude runs `crewdeck jobs sources suggest`, tells you the coverage line in plain words ("17 job
   boards fit remote work from India…", or "Crewdeck has no job board that fits United States for healthcare…" and what
   still works), and asks which employers you would like to work for: it checks each careers page. LinkedIn can be
   placed in your list; switching it on stays yours (step 13).
5. **Fetch once, then preview.** It fetches the new sources once (it can take a few minutes) and shows what your
   choices catch on real postings: how many pass, per kind of job, the near misses and why postings drop. It proposes
   changes (title variants, for example) and previews each before writing it. With nothing fetched yet (no providers,
   Node < 25, or no board for your field) it says so and moves on; paste links later.
6. **The rest:** pay floor (currency and period: a year, a month, a day, an hour), languages and levels, licences, what
   to exclude, daily picks, time zone, and the cooldown after applying.
7. **Check:** `crewdeck jobs check`, and a closing line from the real numbers.

Claude may ask permission for its first commands: it runs `~/.crewdeck/bin/crewdeck jobs …`, the one command its
sandbox lets out. Once your profile has a first name and your search at least one kind of job, the card gives way to
**Today**.

What it wrote, in your vault (open them in **Notes**; edit anything):

| Note | Now holds |
|---|---|
| `me/profile.md` | Who you are, links, education and standard answers |
| `me/career.md` | Resume sections and the fact bank |
| `jobs/search.md` | What you want, and a **Changes** log starting today |
| `jobs/sources.md` | Where to look, in priority order |
| `jobs/memory.md` | Empty until you tell Claude things along the way |

**If not:** requests arrive only when the session is idle; if Claude stops, the card says why and **Set up with
Claude** works again.

## 6. Review your sources

Open **Sources**. **You should see** the coverage line at the top (what is covered for you, and what isn't), then
**Yours**: your sources in order, each with its last fetch ("Not fetched yet…", "34 roles, 12 new, 10 kept by your rules · 2 h ago", or
what went wrong). Use **Move up** / **Move down** to change the order (the first is fetched first and its roles rank
a little higher; order never changes what your rules drop), the switch to stop fetching one without removing it, and
**Remove**. Below: **Add a company** (its name and careers page, then **Add and check**: Crewdeck checks which system runs it, for
example "Workday: 20 roles on a one-page test", or offers **Ask Claude** to find its real jobs page), **Add a web
address**, and the
**Catalog** (filter by region, field and kind; **Add** puts a source at the end).

## 7. Review your preferences

Open **Preferences**: kinds of job (name, titles and variants, skills), title matching, level, where, how you work,
pay, languages, exclusions and daily picks. Change anything and the **Preview** panel shows what the change would catch
on postings already fetched ("46 pass (now 31)") before you click **Save**. Saving logs each change under **Changes**
in `jobs/search.md`, like telling Claude.

## 8. Find jobs

1. The top bar shows "N new roles since …". Crewdeck fetches every 12 hours (`jobs.fetch_every`); **Refresh sources**
   fetches now. Fetching is plain code: no tokens. Your rules then drop what clearly doesn't fit, and the rest is
   ranked by title, skills, freshness and your sources' order.
2. Click **Find 5 jobs** (5 is your daily picks). Claude judges candidates best first, in batches of 10, and stops once
   5 pass; at most 40 postings per Find. Progress lines show on the page.
3. The picks appear in **Today**, one per company, each prepared as in step 9.

**Why so few?** When a Find picks fewer than you asked for, Today shows the funnel ("1,480 fetched → 202 passed your
rules → 10 judged → 3 fit"), the rule that dropped most, the sources that returned nothing, and one-click changes to
try ("Add 5 title variants: 186 more pass"). A change opens Preferences filled in, with its preview; nothing is saved
until you click **Save**.

**If not:** "Job boards not set up": `crewdeck jobs providers install`. "needs Node 25 or newer": restart `crewdeck up`
with Node 25. "No fetched roles are waiting to be judged": click **Refresh sources** first, or paste links.

## 9. Paste a link, and Prepare

Copy the link of any posting (the company's own careers page works best) into **Paste a job link** and click **Add
link**. **You should see** "Link sent to Claude", then Claude working: it reads the posting, adds the role, picks it
for today and **prepares** it:

- it reads the application form (headless, or in a background tab of the pane for forms that need a real browser) and
  notes the form's language: answers are drafted in that language, citing your facts (through translations you
  approved when the form isn't in your facts' language);
- it fills what your profile and memory already answer and drafts the rest from your facts (each answer shows its
  sources); anything it can't support becomes a **first-time question** for you;
- sensitive questions (salary expectations, date of birth, gender, nationality…) are yours to answer; ID, bank and tax
  numbers are never filled or stored: you type them into the form yourself;
- it renders a tailored resume PDF from your facts (in the language and conventions you chose).

First-time questions sit at the top of the role, marked **First time**. Answer each on the page or in the chat: it is
remembered in `jobs/memory.md` with your words and reused on later forms. **Edit** changes any answer; **Ask Claude**
asks for a rewrite (still cited). **Not interested** asks why and remembers your words.

**If not:** a warning (cooldown, already applied, a role at that company in progress): **Add it anyway** is your call
on the page. "Pasted LinkedIn links are off": see step 13, or paste the company's own posting.

## 10. Apply. You click Submit

Click **Apply**. The apply panel goes through its steps:

1. **Waiting for Claude**, then **Claude is filling the form**: Claude opens the real application in a new tab of the
   browser pane, next to Crewdeck. **Open the form** brings that tab to the front.
2. **What Claude did** lists each step ("Step 1 of 2: filled 4 fields from your answers").
3. A question Prepare didn't see comes back as **Claude needs your answer**; answer it and Claude continues.
4. **Your turn: review the form tab and click Submit.** Claude stops at the review page. It never clicks Submit.

Check every field in the form tab, attach the resume if the site needs an upload (the panel shows the PDF with
**Download** and **Show in Finder**), and **click Submit yourself**. Then click **I submitted it** in Crewdeck (or
**Mark applied** when Claude saw the confirmation page). **You should see** the role marked **Applied**, an "Applied to
…" line in today's journal note, and the company (or, if you chose so, that role) in its cooldown.

Some employers don't use a web form. The panel says so: **Apply in person** (where and when, from the posting, and the
answers to take; then **I applied in person**), an email or a document (the answers to copy), or **This site needs an
account** (create it yourself in the form tab, sign in, then **Continue**: Claude never creates accounts).

**If not:** **Claude stopped** with a reason (sign-in, CAPTCHA, "restricted", a limit): do that part yourself in the
form tab, then **Try again**, or finish the form by hand. Stuck with no progress: **Cancel**; a request whose session
stops answering goes back to the queue after 15 minutes.

## 11. What's stored where

- **Your knowledge: notes in your vault** (`~/Crewdeck/vault`), plain Markdown you can read, edit and back up:
  `me/profile.md`, `me/career.md`, `jobs/search.md`, `jobs/memory.md`, `jobs/sources.md`, and a line per application in
  `journal/`. Nothing about you lives anywhere else.
- **Crewdeck's machine state: `~/.crewdeck/`** (private to you): `config.yaml` (ports, appearance, your risky
  switches), `jobs/jobs.db` (roles, form questions, prepared answers), `jobs/out/` (resume PDFs, scratch files),
  `jobs/providers/` (the job-board code), `jobs/state/` (each source's last fetch, the last Find).
- **Your jobs folder: `~/Crewdeck/jobs`**: only where the Jobs session runs; Crewdeck rewrites its two files on every
  start.

## 12. Change a preference

In any Claude session, say what changed: "I'm OK with hybrid now." **You should see** Claude run `crewdeck jobs pref set
workplace …` with your words, then offer to re-check roles dropped in the last 14 days (`crewdeck jobs refilter --days
14`). In Notes, `jobs/search.md` has the new value and a line under **Changes**. Preferences shows it too, and the next
Find uses it.

## 13. Turn LinkedIn on (optional)

LinkedIn's terms forbid automated access; turning these on can get your IP rate-limited or your account restricted.
Read the README's "Safety and terms of service" first.

1. Jobs → **Settings** → the switch for LinkedIn guest search or pasted LinkedIn job links, then **Yes, switch it on**
   (or **Switch on…** on LinkedIn's row in **Sources**).
2. **You should see** your computer's own dialog asking you to confirm. Click it. The switch turns on.
3. Or in your own terminal: `crewdeck jobs features linkedin_links on` (it asks you to type `yes`, then shows the same
   dialog).

Switching off never asks. Claude can't change these switches.

## 14. Start over safely

To redo the whole first run (to test, or to start a new search from scratch), follow step 0: stop Crewdeck, then
**move** `~/.crewdeck`, `~/Crewdeck/vault` and `~/Crewdeck/jobs` aside with a date suffix. Never delete them; to go back,
move them back. To redo only the interview, keep everything and say "redo my job search setup" in the jobs session: the
setup skill runs again over your current notes, and Claude writes only what you confirm (each change to
`jobs/search.md` is logged under **Changes**).

## Updating Crewdeck

When Claude desktop shows **Update** on the crewdeck plugin's page (Code tab: **+** → **Plugins**), click it and start a
new session. `/crewdeck` then offers **Update Crewdeck**: it downloads and checks the new version like setup did and
restarts Crewdeck on it. Your notes, jobs and boards stay as they are.

## Known gotchas

- **Notes in the wrong theme** (light while the rest is dark, or the other way) on the first load after an older
  Crewdeck: reload the page once; it then follows Claude's light/dark.
- **Notes' file list and buttons** (Files, Today, New page, bold, checkbox, heading, link) appear from the second time
  Notes loads on a new vault: SilverBullet reads Crewdeck's settings page once it has indexed it. Reload Notes once.
- **Open in Claude** needs the Claude desktop app; your browser may ask once whether to open it.
- **`crewdeck.localhost`** works in Chrome, Edge, Brave, Firefox, Safari and Claude's browser pane with nothing set up.
  An address without the port is optional: `crewdeck address --short` (your admin password, once).
- **The plugin loads only in new sessions.** A session that was open before you installed the plugin never connects: start a
  new one in `~/Crewdeck/jobs`.
- **Requests wait for an idle session.** While Claude is answering you, page clicks queue up ("Waiting for Claude");
  they start when it finishes.
- **The first fetch takes minutes** and needs Node 25. Until something is fetched, the preview and Find have nothing
  to work with; pasted links always work.
- **An older Crewdeck still running** keeps port 4848: `crewdeck doctor` says "another Crewdeck answers on port 4848".
- **Fields with no job board** (nursing in the US, retail in India, logistics in Texas, translation…): the coverage line
  says so. Add the employers you want by their careers pages, and paste postings you find.
- **The page is in English**; Claude talks with you in your language, and answers forms in the form's language.

## Done

You have notes Claude wrote with you, sources you chose, an application you submitted yourself, and a search that
learns from what you say. `crewdeck doctor` checks the setup any time; the README's Troubleshooting table covers the
usual problems.
