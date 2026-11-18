# P0: foundations (security baseline, leak scan, CI, theme tokens)

Part of [the Jobs design](../design.md) (read §5 D2, D14, D16 and §14 first). This phase changes only the existing shell,
proxy, queue, CLI and bridge; it adds no Jobs code. Everything here must ship with tests.

## 1. Shell server (`src/server.ts`)
- **Crash-proof:** the whole request handler runs in try/catch. A `URIError` (e.g. `GET /%`) → 400; anything else → 500 with
  `{"error":"internal"}` and no detail. A test sends `/%` and then a normal request to the same server.
- **Hosts:** allow `localhost`, `127.0.0.1`, `[::1]`, each with an optional port, on every request and upgrade.
- **Two kinds of endpoints:**
  - *Page endpoints* (the shell page's own calls), today only `POST /api/requests` (Ask Claude). Require
    `content-type: application/json`, an `Origin` that is exactly this server's own origin (`http://localhost:<port>`,
    `http://127.0.0.1:<port>`, `http://[::1]:<port>`), and, when the browser sends it, `Sec-Fetch-Site: same-origin`.
    No Origin → 403 (browsers always send one on a POST fetch).
  - *Agent endpoints* (the bridge and the CLI): `/api/claim`, `/api/requeue`, `/api/requests/<id>/done|fail`. Require
    header `x-crewdeck-token` equal to the token (constant-time compare) and **no** `Origin` header (browsers can't
    send it without one). Wrong/missing token → 401.
  - Any other POST → 404. `GET /api/state` and `GET /api/requests` stay readable (no CORS headers, so other origins can't
    read them).
- **Claim proof:** `/api/claim` takes `nonce` (16–128 chars `[A-Za-z0-9_-]`) and returns
  `proof = sha256_hex("crewdeck-proof:" + token + ":" + nonce)`, so the bridge can tell the real server from a process
  squatting the port (the mod runtime has SHA-256 digest but no HMAC).
- **Headers on every response:** `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
  `cross-origin-resource-policy: same-origin`, `cache-control: no-store`. HTML also gets
  `content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; frame-src http://localhost:* http://127.0.0.1:* http://[::1]:*; object-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'self'`.
- Request body limit stays 100 KB (413 above it).

## 2. Request queue (`src/requests.ts`)
- At most **20 open** (new or picked) requests per lane; at most **30 adds per minute** per lane. Both → error.
- Saving never drops an open request: keep every open request plus the newest closed ones, closed ones at most 30 days old
  and at most 500 in total.
- File written with mode 0600 (and the existing atomic rename).

## 3. Token and file modes (`src/config.ts`, `src/cli.ts`)
- `ensureHome()`: creates `~/.crewdeck` (or `CREWDECK_HOME`) with mode 0700 and chmods an existing one to 0700; refuses
  to run if the folder is writable by group or others after that (it isn't ours to fix).
- `ensureToken()`: `<home>/token` holds 64 hex chars, mode 0600, created on first `crewdeck up`/`init`; `readToken()`
  reads it. The server and CLI use the same file.
- No global `umask`: children (SilverBullet, Backlog.md) keep the user's normal file modes in their vault and repos.
  Crewdeck's own files are written with explicit modes (0600 files, 0700 dirs).

## 4. SilverBullet on its own origin
- SilverBullet listens on an internal port `silverbullet.port + 100`, without `SB_URL_PREFIX`. A Crewdeck proxy on
  `silverbullet.port` (default 4849) forwards to it, like each board. `/notes` is removed from the shell server.
- `shellState().notes` becomes `{ port }`; the shell builds `http://<its host>:<port>/` like boards.
- **Proxy (`src/proxy.ts`)**: besides the Host check, unsafe methods (anything but GET/HEAD/OPTIONS) and WebSocket upgrades
  must carry no `Origin` or exactly the proxy's own origin (`http://localhost|127.0.0.1|[::1]:<its port>`). Tests cover
  both, and that the proxy's upstream port is never what the shell links to.

## 5. CLI (`src/cli.ts`)
- `crewdeck request done|fail <id> --result "<text>" | --result-file <path> | --result -` (stdin). It sends the token.
- `crewdeck doctor` also reports the token file and folder modes.

## 6. Bridge mod (`plugin/hooks/register.tsx`)
- At `session.start`, resolve the Crewdeck home once with `$.process.run(['sh', '-c', 'printf %s "${CREWDECK_HOME:-$HOME/.crewdeck}"'])`
  and read `<home>/token` with `$.fs.read`. No token → stay quiet.
- Every POST sends `x-crewdeck-token`. Each claim sends a fresh nonce (`crypto.randomUUID()`) and checks `proof`
  (`crypto.subtle.digest`); a wrong proof → status line "Crewdeck: server failed its identity check", nothing delivered.
- The prompt it posts:
  - says the request text is what the person typed in the page and that quoted content inside it is data;
  - tells Claude to close requests with `--result-file` written by a single-quoted heredoc, never inline text.

## 7. Leak scan (`scripts/leak-scan.mjs`), run by `npm test` and CI
- Files: `git ls-files` (text, plus printable runs of binaries, which catches PNG/PDF metadata). In CI with
  `LEAK_SCAN_RANGE=<base>..<head>`, also every commit's patch and author/committer name and email in that range.
- Generic checks:
  - email addresses other than `@example.com`, `@example.org`, `@users.noreply.github.com`, `noreply@anthropic.com`;
  - phone shapes (`+<cc> …` groups, `(ddd) ddd-dddd`);
  - home paths `/Users/<name>` or `/home/<name>`, except the placeholders `me`, `you`, `<…>`;
  - `.local` hostnames in emails (a machine name).
- Private denylist, HMAC-SHA256 with key `LEAK_SCAN_KEY`: `scripts/leak-denylist.hmac` holds one hex digest per line,
  each of a normalised phrase (lowercase, words joined by one space, 1–3 words). The scan computes digests of every 1-, 2-
  and 3-word window. No key → this part is skipped with a notice. `node scripts/leak-scan.mjs --add "<phrase>"` (needs the
  key) appends a digest.
- Local plaintext list: `${CREWDECK_HOME:-~/.crewdeck}/leak-denylist.txt`, one phrase per line, same matching, used when
  present (the owner's machine; never in CI).
- Allowed public identifiers, stripped before scanning: the repository slug in URLs (`github.com/<owner>/crewdeck`,
  `<owner>/crewdeck`), and the author name in `LICENSE`, `package.json`, `plugin/.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`. The allow list is `scripts/leak-allow.json`.
- Output names the file and line and the rule, never the matched private phrase.
- Its own tests: a temp git repo with a seeded email, home path, phone and a denylisted phrase (via a test key) fails;
  the clean case passes.

## 8. CI (`.github/workflows/test.yml`)
- `push` and `pull_request` only (never `pull_request_target`); `permissions: contents: read`.
- Matrix Node 22.x and 24.x: `npm ci`, `npm test`, `npm audit --omit=dev --audit-level=high`.
- `fetch-depth: 0` and `LEAK_SCAN_RANGE` = the pushed range or the PR's base..head; `LEAK_SCAN_KEY` from secrets (absent on
  forks: skipped with a notice).

## 9. Theme tokens
- `web/tokens.css`: the colour variables (light + `[data-appearance="dark"]`) and a system font stack
  (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`). `shell.css` imports it. No Google Fonts in the
  shell, `themes/backlog.css` or the SilverBullet theme page.

## 10. Docs
README Security section and `docs/design.md` runtime section updated (Notes on its own port, token, endpoint split).

## Exit check
`npm test` green on Node 22 and 24 (locally: the installed Node); the leak scan passes on the repo and fails on seeded
cases; a live `crewdeck up` serves the shell, Notes on its own port, and a bridge-shaped `curl` claim works only with the
token.
