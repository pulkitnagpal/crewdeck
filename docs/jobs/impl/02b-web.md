# P2b: everything that touches the web (netguard, guard proxy, browser, link, LinkedIn, form reading, resume PDF)

Part of [the Jobs design](../design.md): read §2.3, §2.3a, §5 D8/D11, §12, §13, §14 and §22 row P2 first. Rules for every
implementer: [README.md](README.md). P2a ([02a-core.md](02a-core.md)) left the interfaces this phase plugs into:
`checkRoleUrl`, `addRole`, `pickPasted`, `setApplyUrl`, `storeFormFields`/`cleanQuestions`, `resumeFileName`/`resumePath`.

## 1. Scope
- **netguard**: the only way Jobs code fetches a web page (SSRF controls of §14).
- **guard proxy**: an in-process HTTP/CONNECT proxy that applies netguard to every request headless Chromium makes.
- **browser**: find a Chromium-based browser, launch it headless through the guard proxy; `crewdeck doctor` reports it.
- **link**: `crewdeck jobs link --url-file f [--force]`: a pasted posting becomes a role picked for today (§2.3 step 3).
- **LinkedIn guest pages** (gated): pasted LinkedIn links (`linkedin_links`) and guest search (`linkedin_search`).
- **form reading**: `crewdeck jobs form <role>` without `--fields-file` reads the application form headlessly.
- **resume**: a generic, data-driven template; `crewdeck jobs resume <role> --variant-file f` renders a PDF with JavaScript
  off and the network blocked.

Not in P2b: `--request <id>` and the queue (P3), skills that drive the pane for forms that can't be read headlessly
(P4), scheduled sourcing and the search's place in Find (P5).

## 2. Modules and API

| File | What |
|---|---|
| `src/jobs/net/netguard.ts` | `guardedFetch(url, opts)` → `{ status, url, headers, body, redirects }`; `isBlockedAddress(ip)`; `checkHost(host, net)` (resolve + check every address); `guardedLookup(net)` (a `net.connect` lookup that refuses blocked addresses); `NetOptions = { resolve?, testHosts? }`; `NetError` with `code` (`blocked`, `scheme`, `timeout`, `too_large`, `redirects`, `http`) |
| `src/jobs/net/guard-proxy.ts` | `startGuardProxy({ net?, allowLinkedin?, denyAll? })` → `{ port, url, blocked[], close() }`: HTTP forward (absolute-URI), CONNECT tunnels and WebSocket upgrades, each host checked; X always refused, LinkedIn unless allowed |
| `src/jobs/browser.ts` | `findBrowser(setting)`, `browserCandidates()`, `installHint()`, `launchGuarded({ setting, net, network: 'guarded' \| 'none', javaScript })` → `{ browser, context, proxy, close() }` (service workers blocked), `renderPdf(htmlFile, pdfFile, opts)` |
| `src/jobs/link.ts` | `readPostingPage(html, at)` (JSON-LD JobPosting, then meta), `link(ctx, { url, force? }, opts)` → `{ id, company, title, apply_kind, closed?, warnings, picked, needs? }` (the API P3 calls with a request payload) |
| `src/jobs/linkedin.ts` | `linkedinJobId`, `canonicalJobUrl`, `parseSearch`, `parseDetail`, `isClosed`, `LinkedinClient` (pace, cap, stop rules), `fetchDetail`, `searchPlan(notes, days)`, `searchLinkedin(ctx, opts)` |
| `src/jobs/read-form.ts` | `readQuestions(page)` (labels, kinds, required, options, button groups, every frame), `readForm(ctx, role, opts)` → stores through `storeFormFields` |
| `src/jobs/resume.ts` + `src/jobs/resume/template.html` + `src/jobs/resume/style.css` | `validateVariant(career, variant)`, `resumeModel(notes, variant)`, `resumeHtml(model)`, `renderResume(ctx, role, variant)`, `pdfPageCount(buf)` |
| `src/jobs/views.ts` | `resumeFileName` sanitising tightened (control characters, reserved characters, leading dots, length) |
| `src/jobs/commands.ts` | `link`, `linkedin search`, `form <role>` (headless when no `--fields-file`), `resume` |
| `src/cli.ts` | `doctor` reports the browser |

### Commands (all `crewdeck jobs …`; URLs only from files, D11)
| Command | What |
|---|---|
| `link --url-file f [--force]` | read the posting (JSON-LD/meta, or LinkedIn's guest page), add the role, pick it for today; JSON out; exit 2 when warnings kept it from being picked |
| `linkedin search [--days N] [--max-requests N]` | guest search from `search.md` (needs `linkedin_search`); cards prefiltered before any detail fetch |
| `form <role> [--url-file f]` | read the application form headlessly (the role's `apply_url`, or the ATS form address of its URL); `--url-file` also stores it as the apply URL |
| `resume <role> --variant-file f` | render the tailored PDF to `<jobs.home>/out/<role>/<file name>` |

### Variant file (`resume --variant-file`)
```json
{ "sections": { "summary": ["summary.design"], "example-studio": ["example-studio.system", "example-studio.research"] },
  "skills": ["Figma", "Design systems"] }
```
`sections` maps a summary/experience/list section id to fact ids in page order; `skills` (optional) picks and orders
skills from `career.md` (default: all, in note order). Sections are printed in `career.md` order; summary, experience
and list sections with no facts selected are left out; skills come from `career.md`, education from `profile.md`.

## 3. Decisions (and where they deviate from or extend the design)
1. **netguard refuses a host if any of its addresses is blocked** (not only the one used), then connects to the checked
   addresses only: Node's `lookup` hook runs inside the connect, so there is no window between check and use. IP
   literals skip DNS, so they are checked before connecting. The whole IPv4-mapped (`::ffff:0:0/96`) and
   IPv4-compatible (`::/96`) ranges are blocked: a job site has no reason to publish them.
2. **Test injection, never configuration**: `NetOptions.testHosts` (name → local address, exempt from the block list)
   and `NetOptions.resolve` (a fake resolver) exist only as library options. No environment variable or CLI flag can
   reach them, so an agent can't point a command at a local service. CLI tests therefore only check refusals; the
   happy paths are tested in-process against local fixture servers.
3. **Own agent, no env proxies**: every request uses a fresh `http(s).Agent` with the guarded lookup, so
   `HTTP(S)_PROXY`/`NODE_USE_ENV_PROXY` never apply. `accept-encoding: gzip, deflate, br`; the 2 MB cap counts
   **decoded** bytes while streaming. One 15 s deadline covers DNS, redirects and the body.
4. **Redirects**: `follow` (≤ 5, each re-checked: scheme, host, every address) or `manual` (LinkedIn: a 3xx is a stop).
5. **Guard proxy** listens on 127.0.0.1 on a random port for one browser's lifetime. Chromium gets
   `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>` (loopback goes through the proxy too,
   where it is refused), plus `--disable-quic` and `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (no UDP
   around the proxy). Refused requests answer 403 and are listed in `blocked` (host and reason). X hosts are always
   refused; LinkedIn hosts unless `allowLinkedin` (no P2b caller sets it: LinkedIn pages are read by plain HTTP
   through its guest API, and Easy Apply forms in the pane).
6. **Browser**: `jobs.browser: auto` tries Google Chrome, Chromium, Brave, Microsoft Edge in the standard macOS
   (`/Applications`, `~/Applications`) and Linux (`/usr/bin`, `/snap/bin`, …) locations; a path setting must exist.
   Not found: an error with the install hint. `playwright-core` is imported only when a browser is launched.
7. **PDF render with the network off**: a deny-all guard proxy (every request refused), JavaScript off, service
   workers blocked, context `offline`, and a CSP `default-src 'none'` in the template. The HTML is written to
   `out/<role>/resume.html` (0600) and loaded from that file.
8. **Resume template is data-driven**: one column, system serif stack (Charter, Iowan Old Style, Georgia, …), no remote
   fonts, no images; an identity header (name, contact line, links shown without `https://`) from `profile.md`; sections
   by kind (summary paragraph, experience entries with title/org/where/dates and bullets, list sections, skills line,
   education from `profile.md`). Fact text is escaped; `**bold**` is the only markup kept.
9. **Variant validation**: unknown section, wrong kind (skills/education take no facts), unknown fact id, a fact of
   another section, a duplicate, more than `max_bullets`, an empty `required` section, a skill not in `career.md` are
   errors listed together; nothing is rendered until the variant is valid.
10. **max_pages**: the PDF is printed to a temp name and its page count read from the file (`/Type /Page` objects);
    over the limit the temp PDF is deleted and the command fails with "N pages; max_pages … is M: select fewer facts".
    Only a PDF within the limit is renamed into place, so a too-long resume is never offered by the apply panel (an
    earlier valid one for the role stays).
11. **link** stores the URL the user pasted (cleaned by `checkRoleUrl`), not the final URL after redirects, so a second
    paste finds the same role. Known ATS postings get `apply_url` = the ATS form address (`applyUrl`). JobPosting
    `baseSalary` becomes `pay_text` (`USD 120000–150000 per year`), `validThrough` in the past or "no longer accepting"
    text marks the posting closed (no role is added). Title or company unreadable → `needs` tells Claude to read the page
    in the pane and use `add-role` + `pick --role`.
12. **LinkedIn link shapes**: `/jobs/view/<id>`, `/jobs/view/<slug>-<id>`, `currentJobId=<id>` on any LinkedIn page
    (collections, search), `/comm/jobs/view/<id>`, country subdomains. The role URL is the canonical
    `https://www.linkedin.com/jobs/view/<id>`. A closed LinkedIn posting returns `closed: true`.
13. **LinkedIn guest client**: 2.5 s between requests (also across one run's search and detail fetches), a request cap
    (default 30, at most 60), and it stops for the whole run at the first 429, 999 or any 3xx (redirect to sign-in);
    404 skips one posting. Search terms = `roles.titles`; places = `places.onsite` + `places.remote_from`
    ("worldwide" → `Worldwide`; none → `Worldwide`); `f_WT` from `workplace` (onsite 1, remote 2, hybrid 3); `f_TPR` from
    `--days` (1 → 24 h, ≤ 7 → week, else month). Cards are checked with P1's compiled rules (title, location, company)
    and skipped when already known, before any detail fetch (at most 40 details). Search results are stored with
    `source: linkedin` straight through `upsertRole` (the pasted-link switch is not needed for search hits).
14. **Form reading** refuses LinkedIn (Easy Apply is read live in the pane, P4) and copy-only hosts (their terms forbid
    automation); a password field or CAPTCHA frame returns `needs: sign-in/CAPTCHA`; no fields found returns `needs`
    with the live-reading instructions (`crewdeck jobs learn`). Hidden, read-only and disabled inputs are skipped;
    `role=combobox` inputs are `combobox`; a lone checkbox is a `checkbox` question with no options; a label seen twice
    is kept once. Every frame is read (cross-origin iframes too, through the proxy).
15. **Easy Apply / copy-only helpers**: already in P2a (`plan.ts` gates, `copyModel`, `applyMode`); nothing new here.
16. **Exit codes for Claude**: `link` exits 2 when warnings kept the role from being picked (like `pick --role`);
    `form` exits 2 when it returns `needs` (fall back to live reading). A navigation failure (DNS, HTTP error page,
    proxy refusal) is a `needs`, not a crash.
17. **Fitness tests** (`test/jobs/web-guard.test.ts`): no `fetch(`, `http(s).request`, `net.connect` or `node:http/net`
    import in `src/jobs` outside `src/jobs/net/`; the browser is launched only in `browser.ts` with the proxy args and
    blocked service workers; the web modules never click, fill, type, press or submit.
18. **`apply_kind`** is accepted by `addRole` (`easy | external | unknown`); `link` sets `external` for company postings
    and LinkedIn's own kind for LinkedIn postings.

## 4. Interfaces left for P3 and P4
- P3: `link(ctx, { url, force })`, `readForm(ctx, role, { url? })`, `renderResume(ctx, role, variant)` take plain objects
  (a request payload); `searchLinkedin(ctx, { days })` for Refresh sources.
- P4 skills: `crewdeck jobs link --url-file`, `form <role>` (falls back to `learn` in the pane when `needs` is returned),
  `resume <role> --variant-file`.
- P5: `searchLinkedin` + `LinkedinClient` for scheduled runs; `guardedFetch` for any fetch outside the provider sandbox.

## 5. Test plan (node --test, local servers and fixtures only, fictional people only)
- `netguard`: block list table (IPv4 ranges, IPv6 ranges, mapped/compatible forms, NAT64, 6to4, scoped link-local);
  a local server on 127.0.0.1 is refused by literal, by `localhost`, by a name resolving to it, and by a name with one
  public and one private address; a redirect from a test host to 127.0.0.1 is refused; redirect limit; oversize decoded
  body (gzip bomb and plain); timeout over a slow body; `HTTP_PROXY` ignored; non-http schemes refused.
- `guard-proxy` + browser: Chromium navigating to `http://127.0.0.1:<port>` and `http://localhost:<port>` is refused
  (the target server sees no request); a page on a test host that fetches a loopback URL never reaches it; X refused.
- `link`: JSON-LD (graph, array, location, remote, salary, closed `validThrough`), meta fallback, `needs`, a local
  fixture posting end to end (role added, picked, ATS apply URL), warnings from `pickPasted`, X refused, LinkedIn off/on
  against a local guest-API fixture (detail, closed, 429 stop).
- `linkedin`: id shapes; card/detail parsing; search plan from the fictional people's notes; gating; stop at 429,
  999, 3xx; pacing; request cap; prefilter before details; known roles skipped.
- `read-form`: fixture forms (fieldset radios, Ashby-style radios, button groups, selects, required marks, char
  limits, iframes, hidden/readonly skipped, combobox) through the guarded browser, stored with `storeFormFields`;
  sign-in page → `needs`.
- `resume`: validation errors; HTML escaping and bold; sections by kind for three fictional people; PDF render (A4 and
  Letter, page count, text present), max_pages overflow deletes the PDF; file-name sanitising. PDF tests skip with a
  message only when no Chromium-based browser is found.
- CLI: `link` refuses a loopback URL and X; `form` usage; `resume` with an invalid variant.

## Done
Built as planned in §2, with the decisions in §3.

- **Code:** `src/jobs/net/{netguard,guard-proxy}.ts`, `src/jobs/{browser,link,linkedin,read-form,resume}.ts`,
  `src/jobs/resume/{template.html,style.css}`; `addRole` takes `apply_kind`; `resumeFileName` sanitising; commands
  `link`, `linkedin search`, `form <role>` (headless), `resume`; `crewdeck doctor` reports the browser.
  `playwright-core` 1.65.1 (exact) added.
- **Tests:** `test/jobs/{netguard,browser,link,linkedin,read-form,resume,web-guard}.test.ts` with local servers only
  (fixture names such as `jobs.example.test` mapped to 127.0.0.1 through `testHosts`), fictional fixture forms in
  `test/fixtures/jobs/forms/` (written new, none copied from the Job Agent), the three fictional people. Real
  headless Chromium (Brave on the build machine) for the proxy, form and PDF tests; they skip with a message only when
  no browser is installed. Whole suite: 263 tests, green with the leak scan; `npm audit --omit=dev --audit-level=high`
  clean.
- **Checked by eye:** the PDFs of the three fictional people (A4 and Letter): one column, serif system fonts, clean
  header and section rules.
- **Deferred:** section headings are English ("Experience", "Skills", "Education"; list sections use their own
  `title`, and `title` also overrides skills/education/summary): a per-user heading setting can come with P4's setup
  if a user asks. LinkedIn search is a command only; scheduled runs and Find are P5. Skills that drive the pane for
  `needs` (live form reading with `learn`) are P4. `--request <id>` for `link`/`form`/`resume` is P3 (the library
  functions already take plain objects).
