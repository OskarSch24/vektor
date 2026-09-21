#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
swift generate-icon.swift icon_1024.png

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
mkdir -p "$STAGING/AppIcon.iconset"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  read -r pixels name <<< "$spec"
  sips -z "$pixels" "$pixels" icon_1024.png --out "$STAGING/AppIcon.iconset/$name.png" >/dev/null
done
iconutil -c icns "$STAGING/AppIcon.iconset" -o "$STAGING/AppIcon.icns"
mv "$STAGING/AppIcon.icns" AppIcon.icns
echo "AppIcon.icns aus Variante 02 (Statuslicht) erzeugt."
