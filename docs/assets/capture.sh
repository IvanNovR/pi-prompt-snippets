#!/usr/bin/env bash
# macOS; run from repository root. Requires installed dev dependencies, Chrome, ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/../.."
node --experimental-vm-modules docs/assets/capture.mjs
out="$PWD/docs/assets/capture-output"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
ffmpeg="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
# A capture-specific Chrome profile, not the user's browser profile. No HOME/XDG overrides.
profile="$(mktemp -d "$out/chrome-profile.XXXXXX")"
trap 'rm -rf "$profile"' EXIT
for html in "$out"/0*.html; do
  python3 docs/assets/capture-browser.py "$chrome" "$profile" "$html"
done
cp "$out/04-selection.png" docs/assets/menu.png
cp "$out/05-preview.png" docs/assets/preview.png
cp "$out/06-widget.png" docs/assets/widget.png
"$ffmpeg" -y -framerate 1/1.5 -pattern_type glob -i "$out/0*.png" \
  -filter_complex '[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse' \
  -loop 0 docs/assets/demo.gif
cp "$out/manifest.json" docs/assets/capture-manifest.json
printf '\nCaptured menu.png, preview.png, widget.png and demo.gif\n'
