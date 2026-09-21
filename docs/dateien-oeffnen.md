# Dateien in Vektor öffnen

Neue Dateitypen öffnen sich im vorhandenen Tab: im Explorer anklicken oder über
„Datei öffnen“. Es gibt keinen zusätzlichen Hauptbereich.

| Datei | Anzeige beim Öffnen |
|---|---|
| JSON, JSONL, NDJSON | Struktur bei Objekten, Tabelle bei Datensatzlisten |
| YAML, YML, TOML, XML | Struktur mit aufklappbaren Feldern und unverändertem Originaltext |
| GeoJSON | Dokumentstruktur; über „Ansicht → Karte“ räumlich anzeigen |
| Parquet | Tabelle; unterstützte Kompression wird automatisch gelesen |
| Arrow IPC, Feather V2 (`.arrow`, `.ipc`, `.feather`) | Tabelle |
| DuckDB (`.duckdb`) | Tabellen als lesende lokale Arbeitskopie |
| `.dbconnection.json` / `.dbconnection` | Tabellen oder Sammlungen einer Serverdatenbank als lesende lokale Arbeitskopie |

Im Tab „Daten“ bietet **Ansicht** zusätzlich Datensatz, Tabellenbeziehungen,
Diagramm, Pivot, Zeitstrahl, Kalender, Kanban, Karte, Galerie, Vergleich,
Datenqualität und Vektoren an. Die Auswahl gilt für die geöffnete Quelle.
Struktur und Originaltext bleiben beim Wechsel zwischen offenen Quellen erhalten.

Die Tabellenanzeige nutzt ihre vorhandene Seitennavigation. Auswertungen laden
standardmäßig bis zu 10.000 Zeilen; der Umfang ist auf 1.000 oder 100.000 umstellbar.
Die Oberfläche zeigt geladene und vorhandene Zeilen ausdrücklich an. Diagramme,
Pivot, Kalender, Galerie und Vektoren begrenzen zusätzlich ihre sichtbaren Elemente.
Vektoren werden nach Kosinusähnlichkeit verglichen; das Diagramm zeigt zwei wählbare
Originaldimensionen, keine errechnete Clusterzuordnung.

Für Vergleiche eine zweite Datendatei öffnen und einen eindeutigen Schlüssel
wählen. Doppelte oder fehlende Schlüssel werden als Fehler gemeldet. Der Vergleich
bezieht sich auf den angezeigten Datenumfang; bei einem Ausschnitt ist er kein
vollständiger Datenbankvergleich.

## Serverdatenbanken

Eine Verbindungsdatei benennt den Server. Beispiel für PostgreSQL:

```json
{
  "provider": "postgresql",
  "host": "localhost",
  "port": 5432,
  "database": "meine_datenbank",
  "user": "mein_benutzer",
  "limit": 10000
}
```

Unterstützte `provider`: `postgresql`, `mysql`, `mariadb`, `mongodb`.
Die Vorgabeports sind 5432, 3306 und 27017. MongoDB kann alternativ `uri` verwenden,
auch mit `mongodb+srv://`. `tls: true` aktiviert TLS mit Zertifikatsprüfung.
Bei Bedarf `password` oder `passwordEnv` für eine vorhandene Umgebungsvariable
ergänzen. Vektor schreibt Zugangsdaten nicht selbst in Einstellungen oder Logs.
Eine aus Finder gestartete App erbt keine Variablen aus einer interaktiven Shell.

Mit `tables: ["kunden", "bestellungen"]` lässt sich die Auswahl eingrenzen.
Pro Öffnen werden höchstens 50 Tabellen/Sammlungen geladen; `limit` begrenzt die
Zeilen je Tabelle auf maximal 100.000. Ein Hinweis benennt ausgelassene Daten und
den Lesezeitpunkt. Erneutes Öffnen liest den Server neu. SQL und Exporte arbeiten
anschließend auf der lokalen SQLite-Arbeitskopie. Serverseitiges Schreiben und ein
beliebiger SQL-Editor für den Server gehören nicht zu diesem Dateibetrachter.

Die native App enthält Node.js und die Treiber. In Cortex nutzt der Host dieselbe
Datenlaufzeit im benachbarten Vektor-Projekt. Die reine Browser-Vorschau besitzt
keinen direkten TCP-Zugriff; lokale strukturierte und spaltenorientierte Dateien
lassen sich dort trotzdem öffnen.

## Technische Grundlagen

Parser und Treiber: YAML, smol-toml, fast-xml-parser, Apache Arrow, hyparquet samt
Kompressoren, DuckDB Node Neo, node-postgres, mysql2 und MongoDB Node Driver.
Die Offline-Kartengrundlage verwendet Natural Earth über world-atlas.
XML-DTDs und externe Entities werden nicht ausgeführt. Feather V1 und verschlüsselte
Parquet-Dateien gehören nicht zu den unterstützten Formaten.

Dokumentation: [DuckDB Node Neo](https://github.com/duckdb/duckdb-node-neo),
[node-postgres](https://node-postgres.com/features/queries),
[MongoDB-Verbindungsoptionen](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/),
[hyparquet](https://github.com/hyparam/hyparquet).
