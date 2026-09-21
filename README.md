# Vektor

Eine lokale macOS-App für relationale, tabellarische, Graph- und Snapshot-Daten
in einem projektzentrierten Interface. Eine Quelle aus dem Explorer wird
als echter Tab geöffnet; der gemeinsame Hauptbereich passt seine Werkzeuge
automatisch an das erkannte Datenformat an.

Der frühere Name war **Database Studio**. Die App heißt jetzt **Vektor**;
Bundle-ID, Speicherpfade, Schlüsselbund, Bridge-Namen und API-Protokolle bleiben
für vorhandene Einstellungen und Integrationen stabil. Der Quellordner bleibt
`database-studio`.

## Datenquellen

| Quelle | Ansichten | Schreibmodell |
|---|---|---|
| SQLite, CSV, TSV, JSONL, Excel, Parquet, Arrow | Daten, SQL, Schema, Statistik, Export | Arbeitskopie im Speicher |
| JSON, YAML, XML, TOML, GeoJSON | Dokumentstruktur, Originaltext, Tabelle und weitere Datenansichten | unverändertes Original |
| DuckDB, PostgreSQL, MySQL/MariaDB, MongoDB | Tabellen/Sammlungen; Server über Verbindungsdateien | lesender Import in eine Arbeitskopie |
| `.graph` | Graph, Cypher, Ontologie, Statistik, Import | Datei mit Autosave |
| `.amqrun` / `.amqrun.json` | Hierarchie, Graph, JSON, Statistik | unveränderliches Original |
| Redis RDB | Schlüssel und Phase-X-Projektion | geschützte temporäre Kopie |
| Redis AOF | Erkennung und Diagnose | wird nicht ausgeführt |

Die neuen Formate öffnen im vorhandenen Tab. **Ansicht** bietet dort zusätzlich Datensatz, Tabellenbeziehungen, Diagramme, Pivot, Zeitstrahl, Kalender, Kanban, Karte, Galerie, Vergleich, Datenqualität und Vektoren. Details und Verbindungsdateien: [Dateien öffnen](docs/dateien-oeffnen.md).

Projektordner werden einmal registriert. Der gemeinsame Scanner erkennt die
unterstützten Quellen, validiert binäre Signaturen und gruppiert mehrteilige
Redis-AOF-Speicherstände als eine Quelle.

## Alltagswerkzeuge

- `⌘P` durchsucht alle registrierten Projekte unscharf nach Dateiname, Projekt
  und relativem Pfad. `Enter` öffnet im aktuellen Tab, `⌘Enter` in einem neuen.
- Der Tabellenbereich kann mehrere CSV-, TSV-, JSON-/JSONL- und Excel-Dateien
  zu einer gemeinsamen Arbeitskopie verbinden. Das Schema wird vereinigt,
  fehlende Werte werden als `NULL` ergänzt und Dubletten können anhand frei
  gewählter Spalten entfernt werden.
- Tabellenfilter kombinieren mehrere parametergebundene Bedingungen mit `UND`.
  Fremdschlüsselwerte öffnen per Klick die referenzierte Tabelle und setzen den
  passenden Gleichheitsfilter.
- Änderungen in einer tabellarischen Arbeitskopie oder einem ungespeicherten
  Graphen erscheinen als Punkt im Root-Tab. `⌘W` verlangt vor dem Verwerfen
  eine ausdrückliche Bestätigung; das Öffnen einer anderen Quelle ersetzt
  einen solchen Tab nicht. `⌘S` öffnet den sicheren Export beziehungsweise
  speichert den Graphen.

## Entwicklung

```bash
npm install
npm run dev
npm run typecheck
python3 tests/local_redis_migration.py
```

Die Browser-Vorschau hat bewusst keinen Zugriff auf beliebige lokale Pfade,
Keychain, Redis-Snapshots oder den geschützten API-Port. Diese Fähigkeiten
gehören zum nativen Host. Live Redis ist reine Backend-Mechanik und besitzt
keinen eigenen Arbeitsraum oder Quellenauswahldialog.

## macOS-App bauen

```bash
./build-app.sh --no-install  # nach ./build/Vektor.app
./build-app.sh               # nach /Applications/Vektor.app
```

Das Bundle besitzt eine eigene Identität:

- App: `Vektor.app`
- Binary: `DatabaseStudio`
- Bundle-ID: `com.oskarschiermeister.databasestudio`
- Application Support: `~/Library/Application Support/Database Studio` (bestehender Speicherpfad)

Beim ersten Start werden bereits vorhandene Projektpfade, Graph-Einstellungen,
Redis-Verbindungen und API-Präferenzen sicher übernommen. Gespeicherte
Redis-Passwörter werden erst nach verifiziertem Schreiben in den neuen
Vektor-Keychain-Dienst aus dem alten Dienst entfernt.

Der lokale Backend-Speicher wird – sobald kein Redis auf dem lokalen Port läuft –
atomar von `~/Library/Application Support/Vault Studio/Local Store` nach
`~/Library/Application Support/Database Studio/Local Store` verschoben. Es
entsteht keine halbe RDB/AOF-Kopie; bei Daten in beiden Ordnern bricht die
Migration ohne Überschreiben ab und wird beim nächsten Start erneut geprüft.

## Lokale Schnittstellen

Vektor hält zwei getrennte Loopback-Listener:

| Port | Auth | Zweck |
|---:|---|---|
| `8793` | Bearer-Token | geschützte Vektor-API |
| `8787` | keine | enger Chrome-Ingest-Vertrag |

Der API-Deskriptor liegt während des Betriebs unter
`~/Library/Application Support/Database Studio/api.json`. Das Token wird separat
als `api-token` mit Dateimodus `0600` dauerhaft gespeichert.

Kanonische Routen:

```text
/api/v1/sqlite/...
/api/v1/graph/...
/api/v1/vault/...
```

Jeder Adapter besitzt eine eigene Schreibfreigabe. SQLite schreibt nur in seine
Arbeitskopie und Graph-Änderungen autosaven. RDB-/AOF-Quellen öffnen als
unveränderliche Arbeitskopien; bestätigungspflichtige Redis-Befehle bleiben auch
über die API gesperrt. Der Redis-Adapter steht Integrationen weiterhin als
Backend zur Verfügung, ist aber kein eigener Zielbereich in der Oberfläche.

Der gemeinsame MCP befindet sich in `../studio-mcp`. Er bietet weiterhin alle
29 kompatiblen `sqlite_*`, `graph_*`, `vault_*` und Status-Werkzeuge. Sämtliche
Aufrufe verwenden ausschließlich den Vektor-Deskriptor.

## Browser-Import

Die mitgelieferte Erweiterung spricht weiterhin ausschließlich den kleinen,
tokenlosen Vertrag auf `127.0.0.1:8787`: `GET /status`, `GET /projects`,
`GET /targets` und `POST /ingest`. Vektor kopiert sie beim ersten Start
in den stabilen Ordner
`~/Library/Application Support/Database Studio/Browser Extension`. Dieser
Ordner kann in `chrome://extensions` über „Entpackte Erweiterung laden“ gewählt
werden und bleibt auch nach App-Updates am selben Ort.

Der Server unterscheidet in der Oberfläche bewusst zwischen „bereit“ (Port
lauscht) und „verbunden“ (eine Browser-Erweiterung wurde tatsächlich gesehen).
Für das richtige Branding und die Verbindungsanzeige muss in Chrome die
mitgelieferte Vektor-Erweiterung geladen sein.

Nach der bewussten Umschaltung kann Vektor den Hintergrunddienst
übernehmen:

```bash
./tools/agent/background-agent.sh install
./tools/agent/background-agent.sh status
./tools/agent/background-agent.sh uninstall
```

Das Installationsskript verweigert den Start, solange ein anderes Programm Port
`8787` besitzt. So laufen nie zwei ingestfähige Prozesse versehentlich auf
demselben Port.

## Öffentliche Fassung · Eigene Zugänge

Dieses Repository enthält **keine Datenbanken, Verbindungsdaten oder Passwörter** — nur die Testdaten unter `tests/fixtures/`. Zugänge zu PostgreSQL, MySQL, MongoDB oder Redis trägst du in Vektor selbst ein; Passwörter landen im macOS-Schlüsselbund, nicht in Dateien.

```sh
npm install
./build-app.sh     # baut die macOS-App
```

*English:* No databases or credentials are included. Server passwords are entered in the app and stored in the macOS keychain. MIT licensed.
