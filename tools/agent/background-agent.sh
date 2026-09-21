#!/usr/bin/env bash
#
# Runs Vektor as a login-time background service, so the Chrome extension
# can convert a page without anyone having opened the app first.
#
#   ./tools/agent/background-agent.sh install     # start now and at every login
#   ./tools/agent/background-agent.sh uninstall   # stop and forget
#   ./tools/agent/background-agent.sh status      # is it loaded and listening?
#
# In this mode the app has no dock icon and no window. To get the window,
# open Vektor the normal way (Spotlight, Finder, Dock) — the running
# instance takes it as the request for its UI and comes forward.
set -euo pipefail

LABEL="com.oskarschiermeister.databasestudio.agent"
APP="/Applications/Vektor.app"
BINARY="${APP}/Contents/MacOS/DatabaseStudio"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/Database Studio"
PORT=8787

install_agent() {
  [ -x "$BINARY" ] || { echo "Nicht gefunden: ${BINARY}" >&2
                        echo "Erst bauen:  ./build-app.sh" >&2; exit 1; }
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${PORT} ist bereits belegt. Beende zuerst das lauschende Programm." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"

  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY}</string>
        <string>--background</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <!-- Nur nach einem Absturz neu starten. Beendet der Nutzer die App ueber
         das Menue, bleibt sie beendet, bis er sie wieder oeffnet. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/agent.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/agent.log</string>
</dict>
</plist>
PLIST_EOF

  # bootout first: reinstalling over a loaded agent is otherwise a no-op.
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl kickstart "gui/$(id -u)/${LABEL}"

  echo "Installiert: ${PLIST}"
  echo "Vektor laeuft ab jetzt im Hintergrund und startet bei jedem Login mit."
  status_agent
}

uninstall_agent() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Entfernt. Vektor startet nicht mehr automatisch."
}

status_agent() {
  echo
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "Agent:   geladen"
  else
    echo "Agent:   nicht geladen"
  fi

  if pgrep -f "DatabaseStudio" >/dev/null 2>&1; then
    echo "Prozess: laeuft (PID $(pgrep -f 'DatabaseStudio' | tr '\n' ' '))"
  else
    echo "Prozess: laeuft nicht"
  fi

  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1; then
    echo "Port ${PORT}: erreichbar"
  else
    echo "Port ${PORT}: nicht erreichbar"
  fi
}

case "${1:-status}" in
  install)   install_agent ;;
  uninstall) uninstall_agent ;;
  status)    status_agent ;;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) echo "Unbekannter Befehl: $1  (install | uninstall | status)" >&2; exit 1 ;;
esac
