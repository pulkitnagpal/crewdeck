// The one-click setup behind /crewdeck's "Set up Crewdeck" (docs/everywhere.md E13). The plugin runs this with `sh -s`
// and shows its STEP lines in the panel. It needs only what macOS ships (curl, tar, shasum, unzip): no git, no Node, no
// terminal. Every download is checked against a SHA-256 pinned here before anything in it runs.
//
//   ~/.crewdeck/runtime/node-v<NODE>-<platform>/   Node, from nodejs.org (its SHASUMS256.txt digests)
//   ~/.crewdeck/app/<VERSION>/                    Crewdeck, from its GitHub release (the asset's digest), npm ci'd
//   then: crewdeck setup --from-plugin --service  the vault, Jobs, the background service (the plugin is already in)
//
// Test hooks (the person's own environment only): CREWDECK_HOME, CREWDECK_VAULT, CREWDECK_PORT, CREWDECK_NO_SERVICE=1, and
// CREWDECK_NODE_URL / CREWDECK_NODE_SHA256 / CREWDECK_APP_URL / CREWDECK_APP_SHA256 to install from local copies.

export const CREWDECK_VERSION = '0.12.0'
export const NODE_VERSION = '25.9.0'

/** nodejs.org/dist/v25.9.0/SHASUMS256.txt */
export const NODE_SHA256: Record<string, string> = {
  'darwin-arm64': 'e479f3c469d3d9303a44f00a8ea37a3788395d171bb8059c48a4bbbd2e371b59',
  'darwin-x64': '7d737b53ce191142bfa1c17cfa5b070d96e84eebf76b8dd06d84981cbdc3f7e3',
  'linux-arm64': '8fb4283301b8c720fc9f18bffff0f659e72cc14d0cf207a3bb411808aaa73a57',
  'linux-x64': '134e55b2408448a219760fe04dc44d6851f9de8a79549021ffd870e9082d9e7b',
}

/** The release asset crewdeck-<VERSION>.tar.gz (scripts/release.sh prints it). */
export const APP_SHA256 = 'efac72dd7db9e661e11a41f490da188f490314a942b4ffd4f35fb56e9f7c6caa'

export const APP_URL = `https://github.com/pulkitnagpal/crewdeck/releases/download/v${CREWDECK_VERSION}/crewdeck-${CREWDECK_VERSION}.tar.gz`

const nodeShas = Object.entries(NODE_SHA256).map(([p, h]) => `    ${p}) NODE_SHA=${h} ;;`).join('\n')

export const INSTALL_SH = `#!/bin/sh
# Crewdeck setup (from the crewdeck plugin's /crewdeck). Safe to run again.
set -eu
umask 077
step() { printf 'STEP %s\\n' "$*"; }
fail() { printf 'FAIL %s\\n' "$*"; exit 1; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
fetch() { curl -fsSL --retry 2 --connect-timeout 20 -o "$2" "$1" || fail "could not download $1: check your internet connection"; }

CREWDECK_HOME="\${CREWDECK_HOME:-$HOME/.crewdeck}"
VERSION=${CREWDECK_VERSION}
NODE_VERSION=${NODE_VERSION}
case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) fail "Crewdeck runs on macOS and Linux" ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) fail "unsupported processor $(uname -m)" ;; esac
PLATFORM="$OS-$ARCH"
case "$PLATFORM" in
${nodeShas}
  *) fail "no Node build for $PLATFORM" ;;
esac
NODE_SHA="\${CREWDECK_NODE_SHA256:-$NODE_SHA}"
NODE_URL="\${CREWDECK_NODE_URL:-https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$PLATFORM.tar.gz}"
APP_SHA="\${CREWDECK_APP_SHA256:-${APP_SHA256}}"
APP_URL="\${CREWDECK_APP_URL:-${APP_URL}}"

mkdir -p "$CREWDECK_HOME"
chmod 700 "$CREWDECK_HOME"
TMP="$(mktemp -d "$CREWDECK_HOME/.setup.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

RUNTIME="$CREWDECK_HOME/runtime/node-v$NODE_VERSION-$PLATFORM"
if [ -x "$RUNTIME/bin/node" ]; then
  step "1/5 Node $NODE_VERSION is already here"
else
  step "1/5 Downloading Node $NODE_VERSION (about 50 MB)"
  fetch "$NODE_URL" "$TMP/node.tar.gz"
  [ "$(sha256 "$TMP/node.tar.gz")" = "$NODE_SHA" ] || fail "the Node download does not match its checksum: nothing was installed"
  mkdir -p "$CREWDECK_HOME/runtime" "$TMP/node"
  tar -xzf "$TMP/node.tar.gz" -C "$TMP/node" --strip-components 1
  rm -rf "$RUNTIME"
  mv "$TMP/node" "$RUNTIME"
fi
PATH="$RUNTIME/bin:$PATH"
export PATH

APP="$CREWDECK_HOME/app/$VERSION"
if [ -f "$APP/.installed" ]; then
  step "2/5 Crewdeck $VERSION is already here"
else
  step "2/5 Downloading Crewdeck $VERSION"
  fetch "$APP_URL" "$TMP/app.tar.gz"
  [ "$(sha256 "$TMP/app.tar.gz")" = "$APP_SHA" ] || fail "the Crewdeck download does not match its checksum: nothing was installed"
  mkdir -p "$TMP/app"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/app" --strip-components 1
  step "3/5 Installing what Crewdeck needs (a minute or two)"
  (cd "$TMP/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error >"$TMP/npm.log" 2>&1) || { tail -5 "$TMP/npm.log"; fail "installing Crewdeck's packages failed"; }
  mkdir -p "$CREWDECK_HOME/app"
  rm -rf "$APP"
  mv "$TMP/app" "$APP"
  : > "$APP/.installed"
fi

step "4/5 Setting up your notes, Jobs and the background service"
set -- setup --from-plugin --service
[ "\${CREWDECK_NO_SERVICE:-}" = 1 ] && set -- setup --from-plugin --no-service
[ -n "\${CREWDECK_VAULT:-}" ] && set -- "$@" --vault "$CREWDECK_VAULT"
[ -n "\${CREWDECK_PORT:-}" ] && set -- "$@" --port "$CREWDECK_PORT"
CREWDECK_HOME="$CREWDECK_HOME" node "$APP/src/cli.ts" "$@"

step "5/5 Starting Crewdeck"
URL="$(CREWDECK_HOME="$CREWDECK_HOME" node "$APP/src/cli.ts" open --print | tail -1)"
printf 'DONE %s\\n' "$URL"
`
