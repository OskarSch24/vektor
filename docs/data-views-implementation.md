# Daten direkt öffnen

Auftrag: alle am 13.09.2026 markierten Datenansichten und Dateiquellen einbauen.
Präzisierung: kein eigener Bereich; Dateien öffnen im vorhandenen Tab.

## Umsetzung und Abnahme

- [x] JSON, YAML, XML, TOML: Explorer, Öffnen, vollständiger Strukturbaum und Rohtext.
- [x] Parquet und Arrow IPC/Feather: Tabellenimport einschließlich komprimiertem Parquet.
- [x] DuckDB: lesender Dateiimport über mitgelieferte Laufzeit.
- [x] PostgreSQL, MySQL/MariaDB, MongoDB: Verbindungsdatei öffnen, Tabellen/Sammlungen lesen.
- [x] Ansichten innerhalb der Datenanzeige: Datensatz, ER, Diagramme, Pivot, Zeitstrahl, Kalender, Kanban, Karte, Galerie, Vergleich, Qualität, Vektoren.
- [x] Klare Anzeige für begrenzte Datenmengen; Originaldokument bleibt erhalten.
- [x] Format-/Berechnungsregressionen, Browserprüfung, Swift-Build, bestehende Kerntests.
- [x] App bauen und lokal installieren; geprüfte und ungeprüfte Verbindungen dokumentieren.

Die bestehende Arbeitskopie bleibt der gemeinsame Tabellenadapter. Neue Ansichten sind lesend. Es werden keine Zugangsdaten automatisch gespeichert.

## Geprüfter Stand am 13.09.2026

- TypeScript und produktiver Frontend-Build erfolgreich.
- 10 Format-/Berechnungstests, 12 bestehende Filter-/Merge-/Graph-Tests und 11 Cortex-Bridge-Tests bestanden.
- Headless-UI-Prüfung gegen den Produktionsbuild: sämtliche Ansichten, alle neuen lokalen Dateiformate, echter DuckDB-Treiber, mehrere offene Tabs; 1440×900 und 1024×700 visuell geprüft.
- Bestehende praktische Funktionen, Dirty-State und Workbench-Controller bestanden.
- PostgreSQL mit temporärer lokaler Instanz geprüft; inklusive ungewöhnlicher Bezeichner, leerer Tabellen, großer Ganzzahlen und Zeilenlimit. Die Instanz wurde danach beendet und entfernt.
- Native Swift-Brücke mit eingebettetem Node und DuckDB geprüft; Code-Signatur des vollständigen Bundles verifiziert.
- Unter `/Applications/Vektor.app` installiert und Binärdatei, Frontend-Einstieg und Datenlaufzeit mit dem geprüften Build abgeglichen.
- Der zuvor gestartete Vektor-Hintergrundprozess wurde nicht beendet. Die neue Oberfläche wird nach dem Neustart geladen.
- MySQL/MariaDB und MongoDB: Treiber vorhanden; keine echte Serverinstanz für eine Verbindungsabnahme verfügbar.

Eine Sicherung der vorherigen App liegt unter `build/backups/Vektor-before-data-views-20260913-011424.app`.
