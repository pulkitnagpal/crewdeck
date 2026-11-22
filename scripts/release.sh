#!/bin/sh
# Build the Crewdeck download that /crewdeck's one-click setup installs (docs/everywhere.md E13):
#   dist/crewdeck-<version>.tar.gz, from the committed tree at HEAD, without the plugin (it is installed through Claude,
#   and leaving it out lets the plugin pin this file's checksum without a loop), the tests and the screenshots.
# Prints the SHA-256 to pin as APP_SHA256 in plugin/hooks/install-script.ts. Publishing it is a separate, manual step:
#   gh release create v<version> dist/crewdeck-<version>.tar.gz --title v<version> --notes-file <notes>
set -eu
cd "$(dirname "$0")/.."
VERSION="$(sed -n "s/^export const CREWDECK_VERSION = '\(.*\)'$/\1/p" plugin/hooks/install-script.ts)"
[ -n "$VERSION" ] || { echo "no CREWDECK_VERSION in plugin/hooks/install-script.ts" >&2; exit 1; }
[ -z "$(git status --porcelain -- . ':(exclude)plugin')" ] || { echo "commit your changes first (outside plugin/)" >&2; exit 1; }
mkdir -p dist
OUT="dist/crewdeck-$VERSION.tar.gz"
git archive --format=tar --prefix="crewdeck-$VERSION/" HEAD -- . ':(exclude)plugin' ':(exclude)test' ':(exclude)docs/img' ':(exclude).github' \
  | gzip -n -9 > "$OUT"
printf '%s  %s\n' "$(shasum -a 256 "$OUT" | cut -d' ' -f1)" "$OUT"
