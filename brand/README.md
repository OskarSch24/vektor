# Database Studio – ausgewähltes App-Icon

Ausgewählt: **02 Statuslicht** aus den Detailvarianten vom 12. September 2026.

`icon-source.png` ist eine unveränderte Kopie von
`../design/logo-studies-2026-09-12/09-Detailvarianten/02-Statuslicht.png`.

`bash tools/build-icon.sh` erzeugt aus der Quelle das macOS-Icon mit den
bestehenden Kachelmaßen, abgerundeten Ecken und transparentem Außenrand:
`icon_1024.png` und `AppIcon.icns` in der Projektwurzel.
`build-app.sh` führt diesen Schritt automatisch aus.

Die Oberfläche verwendet dieselbe Quelle über `BrandIcon.tsx` in der
Titelleiste und im Startbereich. Vite bündelt das Bild mit relativer URL
für den nativen `app://`-Host.

Die vorherigen Icon-Dateien und Build-Skripte liegen unter `previous/`.
