---
name: crewdeck-open
description: Open Crewdeck (the person's notes, jobs and project boards) from any Claude session, starting it if it isn't running, and show today's to-dos. Use when the person says "open Crewdeck", "start Crewdeck", "show my Crewdeck", "open my notes / jobs / board", or asks what is on their list for today.
---

# Open Crewdeck from anywhere

Crewdeck is a local web app at `http://crewdeck.localhost:4848` (or `http://crewdeck.localhost` once the short address is
set up). It shows the person's notes, Jobs and project boards. It runs in the background when its service is installed,
otherwise only while `crewdeck up` runs.

`crewdeck` is the Crewdeck CLI. If it isn't on the PATH, use `~/.crewdeck/bin/crewdeck` (written the first time Crewdeck
started). If neither exists, Crewdeck isn't set up on this computer: say so, and point at the README's "Let Claude install
it" section. Don't install anything without the person's yes.

1. **The panel beside the chat.** Tell the person they can type `/crewdeck`: it opens the Today panel (today's to-dos,
   what Jobs is waiting on, open tickets) and starts Crewdeck if needed. You can't type it for them.
2. **The full page.** Run `crewdeck open --print` (add `jobs` or `notes` for those views, as in `crewdeck open jobs
   --print`). It starts Crewdeck if it isn't running and prints the address. Then:
   - in Claude desktop, open that address in the browser pane (your browser tool for local pages);
   - anywhere else, run `crewdeck open` (or `crewdeck open jobs`) to open it in the person's default browser.
3. **The jobs session.** Jobs work happens in a Claude Code session opened in the jobs folder. `crewdeck open session`
   opens one in Claude desktop: tell the person to confirm the folder and press Enter on the hello it fills in.
4. **Today's to-dos, asked in words.** They are the `- [ ]` lines of today's journal page in their vault,
   `journal/YYYY-MM-DD.md` (the vault folder is in `crewdeck jobs check`'s first lines, by default `~/Crewdeck/vault`).
   Read them from that file. To add one, add a `- [ ] <their words>` line under the page's `## To do` heading (create
   the page as `# YYYY-MM-DD`, a blank line, `## To do` if it doesn't exist). Change nothing else on the page.

If `crewdeck open` says another program answers on Crewdeck's port, tell the person and stop: never stop another
program yourself. Never run `sudo` for Crewdeck: `crewdeck address --short` prints the steps for the person to run.
