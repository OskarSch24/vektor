#!/usr/bin/env bash
#
# Builds Vektor into a macOS .app bundle.
#
#   ./build-app.sh                 # build and install to /Applications
#   ./build-app.sh --output ./out  # build into another directory instead
#   ./build-app.sh --no-install    # build into ./build, skip LaunchServices
#
set -euo pipefail

APP_NAME="Vektor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="/Applications"
REGISTER_WITH_FINDER=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --no-install) OUTPUT_DIR="${SCRIPT_DIR}/build"; REGISTER_WITH_FINDER=0; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done

APP_DIR="${OUTPUT_DIR}/${APP_NAME}.app"
cd "$SCRIPT_DIR"

echo "==> 1/5  Frontend bauen"
npm run build

echo "==> 2/5  App-Icon erzeugen"
# Die ausgewählte Variante 02 liegt unverändert unter brand/icon-source.png.
bash tools/build-icon.sh

echo "==> 3/5  Native Swift-Binary kompilieren ($(uname -m))"
swiftc -O -target "$(uname -m)-apple-macosx13.0" \
  -o "${SCRIPT_DIR}/DatabaseStudio" src/native/*.swift

echo "==> 4/5  Bundle zusammenstellen: ${APP_DIR}"
# Das Bundle wird erst daneben aufgebaut und dann hineingespiegelt. Ein
# "rm -rf" auf das .app selbst wuerde das Verzeichnis durch ein neues mit
# anderer Inode ersetzen -- und genau daran haengt das Dock seine angehefteten
# Symbole: es zeigt dann ins Leere und legt beim Start ein zweites Symbol an.
# rsync tauscht nur den Inhalt aus, das .app-Verzeichnis selbst ueberlebt.
STAGING="$(mktemp -d)/${APP_NAME}.app"
trap 'rm -rf "$(dirname "$STAGING")"' EXIT

mkdir -p "$STAGING/Contents/MacOS" "$STAGING/Contents/Resources"
mv "${SCRIPT_DIR}/DatabaseStudio" "$STAGING/Contents/MacOS/DatabaseStudio"
chmod +x "$STAGING/Contents/MacOS/DatabaseStudio"
cp src/native/Info.plist "$STAGING/Contents/Info.plist"
cp AppIcon.icns "$STAGING/Contents/Resources/AppIcon.icns"
cp -R dist "$STAGING/Contents/Resources/"
cp -R extension "$STAGING/Contents/Resources/"
echo "    Datenlaufzeit und Treiber einbetten"
npm ci --prefix tools/data-runtime --omit=dev --no-audit --no-fund
cp -R tools/data-runtime "$STAGING/Contents/Resources/data-runtime"
cp -L "$(command -v node)" "$STAGING/Contents/Resources/data-runtime/node"
chmod +x "$STAGING/Contents/Resources/data-runtime/node"

# Preserve the existing bundle directory so Finder/Dock bookmarks can follow
# the rename. Storage and bundle identifiers intentionally keep their names.
LEGACY_APP_DIR="${OUTPUT_DIR}/Database Studio.app"
if [ ! -e "$APP_DIR" ] && [ -d "$LEGACY_APP_DIR" ]; then
  mv "$LEGACY_APP_DIR" "$APP_DIR"
fi
mkdir -p "$APP_DIR"
rsync -a --delete "$STAGING/" "$APP_DIR/"

# An ad-hoc signature keeps Gatekeeper quiet for a locally built app and is
# required for the binary to keep its TCC permissions across rebuilds.
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null || \
  echo "    Hinweis: Ad-hoc-Signatur fehlgeschlagen (unkritisch)"

if [ "$REGISTER_WITH_FINDER" -eq 1 ]; then
  echo "==> 5/5  Bei macOS LaunchServices registrieren"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f -r "$APP_DIR"
  touch "$APP_DIR"
else
  echo "==> 5/5  Registrierung übersprungen (--no-install)"
fi

echo
echo "Fertig: ${APP_DIR}"
echo
echo "Browser-Import: Erweiterung liegt nach dem ersten Start unter"
echo "                ~/Library/Application Support/Database Studio/Browser Extension"
echo "                und verbindet sich lokal über Port 8787."
