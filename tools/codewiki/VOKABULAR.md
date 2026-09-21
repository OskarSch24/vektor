# Graph-Vokabular: Code-Repositories (codewiki.google)

Vorschlag zur Erweiterung des bestehenden Vokabulars. Nichts wird ersetzt — die neuen
Arten hängen sich an `Source`, `Person`, `Organization`, `Topic` an und folgen den
vorhandenen ID- und Farbregeln.

**Konventionen, die gelten bleiben:** Labels englisch (`Person`, `Page`, `Scene`),
Kantentypen deutsch in `GROSSBUCHSTABEN_MIT_UNTERSTRICH`. IDs über `entityId` /
`urlId` aus `src/lib/graph.ts`, niemals über Zähler.

---

## 0. Was in den echten Daten steht

Ausgepackt: `rpc_react`, `rpc_go`, `rpc_flutter`, `rpc_next`, `rpc_repo1` (RPC `VSX6ub`)
sowie `rpc_home` (RPC `nm8Fsb`) und die Fehlfälle `rpc_linux`, `rpc_bogus`, `rpc_test`.

Struktur einer Repo-Antwort:

```
[0][0] = [slug, commit]                 z.B. ["facebook/react", "0209ef8a…"]
[0][1] = [ section, … ]                 geordnete Liste
[0][4] = [epochSeconds, nanos]          Erzeugungszeit des Wikis
[1]    = [[null, githubUrl], true, 3|4]
[2]    = vollständiges Wiki-Markdown (460 KB bei react)
```

Ein `section` hat 10 Felder:

| # | Inhalt | Beispiel |
|---|---|---|
| 0 | Titel | `React Core Library` |
| 1 | Überschriftsebene | 1–4, genau ein Abschnitt je Repo hat Ebene 1 |
| 2 | Kurzbeschreibung (Planungstext, Futur: „This section will detail…") | |
| 3 | Quellpfade, `[[pfad], …]` | `[["/facebook/react/packages/react"]]` |
| 4 | Prosa als Klartext | |
| 5 | dieselbe Prosa **mit Links** | `[\`react\`](%2Ffacebook%2Freact%2FCLAUDE.md#L1)` |
| 6 | immer `1` (Bedeutung unbekannt) | |
| 7 | Blöcke: Diagramm **oder** Tabelle | |
| 8 | immer `null` | |
| 9 | Anker | `#react-core-library-react-elements-and-jsx-runtime` |

Größenordnung und harte Zahlen:

| Repo | Abschnitte | Diagramme | Tabellen | distinkte Pfade in Links | Datei-Links |
|---|---|---|---|---|---|
| facebook/react | 85 | 64 | 11 | 593 | 1 565 |
| golang/go | 105 | 66 | 10 | 849 | 3 038 |
| flutter/flutter | 84 | 57 | 23 | 589 | 1 664 |
| vercel/next.js | 56 | 34 | 13 | 628 | 1 192 |
| ilfenomeno-gif/repo-prompt | 7 | 4 | 3 | 12 | 45 |

**Befunde, die den Entwurf bestimmen — teils gegen die Aufgabenbeschreibung:**

1. **Es gibt keine Verweise auf andere Repos.** Von 7 504 Datei-Links über fünf Repos
   zeigt **kein einziger** aus dem eigenen Repo heraus. Cross-Repo-Kanten fallen also
   *nicht* regelbasiert an (→ Abschnitt 5, offene Frage O-1).
2. **Feld [3] enthält überwiegend Verzeichnisse, keine Dateien** (665 Verzeichnisse
   zu 96 Dateien). Die konkreten Dateien mit Zeilennummer stehen dagegen inline im
   Markdown von Feld [5] (react: 1 009 von 1 565 Links tragen `#L…`).
3. **Die Hierarchie ist rein regelbasiert ableitbar** — über Ebene + Dokumentreihenfolge
   (Stack). Der Anker bestätigt das: jeder Abschnitt ab Ebene 3 trägt den Anker seines
   Elternabschnitts als Präfix (react 69/69, go 90/90). Nur die Ebene-2-Abschnitte
   hängen am Ebene-1-Overview, dessen Anker kein Präfix ist.
4. **Kein Feld nennt Sprache, Technologie, Sterne, Beschreibung oder den Typ des
   Besitzerkontos.** Beschreibung, Avatar und Sternzahl liefert nur das Home-Listing
   (`nm8Fsb`) — und nur für die dort gelisteten Repos.
5. **Repo ohne Wiki:** `rpc_linux`, `rpc_bogus` liefern nur `[null,[[null,githubUrl]]]`.
   Kein Fehler, aber auch kein Inhalt. Der Ingest braucht diesen Zustand als Fall.
6. Feld [4] und [5] sind dieselbe Prosa; [5] ist die verlinkte Fassung. Nur [5] taugt
   als Kantenquelle, nur [4] als Modell-Eingabe.

---

## 1. Knotenarten

### Neu

| Label | Bedeutung | ID-Regel | Farbe |
|---|---|---|---|
| `Repository` | das Repo selbst, Wurzelknoten des Ingests | `urlId('repository', 'https://github.com/<slug>')` → `repository:github.com/facebook/react` | `#30D158` |
| `Section` | ein Wiki-Abschnitt | `` `${repositoryId}${anchor}` `` → `repository:github.com/facebook/react#react-core-library` | `#64D2FF` |
| `CodeFile` | Datei **oder** Verzeichnis im Repo | `urlId('codefile', 'https://github.com' + pfad)` → `codefile:github.com/facebook/react/packages/react` | `#8E8E93` |
| `Technology` | Sprache, Framework, Werkzeug | `entityId('Technology', name)` → `technology:go` | `#FFD60A` |

`Section` folgt exakt dem `Scene`-Vorbild (`pipeline.ts:178`: `rootId` + Fragment).
`CodeFile` nutzt bewusst `urlId` statt `entityId`, weil `entityId` alle `/` zu `-`
verschleift und damit `a/b-c` und `a/b/c` auf dieselbe ID wirft — `urlId` behält den
Pfad. `Repository` ist aus demselben Grund `urlId`, nicht `entityId`.

Zu den Farben: `ASSIGNED_COLORS` hat acht Akzente, davon sind alle acht belegt.
`#30D158` teilt sich Grün mit `Place`, `#64D2FF` Cyan mit `Event`/`Post` — beide
Kollisionen sind in Code-Graphen praktisch folgenlos. `#8E8E93` und `#FFD60A` sind
neu; Präzedenz für Werte außerhalb von `LABEL_COLORS` gibt es bereits (`#737378`
für `Site`, `#A1A1A6` für `Source`).

### Wiederverwendet

| Label | Rolle hier |
|---|---|
| `Source` | zweites Label auf `Repository`, wie `Page`/`Video`/`Post` es tragen |
| `Organization` / `Person` | das GitHub-Konto (`facebook`, `torvalds`) |
| `Site` | `github.com`, wie bei jedem anderen Ingest |
| `Topic` | Konzepte, die ein Modell aus der Abschnittsprosa zieht |
| `Product`, `Work`, `Event`, `Place` | falls in der Prosa genannt — unverändertes Verhalten des KI-Passes |

### Eigenschaften

**`Repository`** — alles regelbasiert außer den drei markierten:

| Eigenschaft | Quelle |
|---|---|
| `name` | `[0][0][0]`, der Slug `facebook/react` |
| `owner`, `repo` | Slug gesplittet |
| `url` | `[1][0][1]`, die GitHub-URL |
| `wikiUrl` | die codewiki-URL |
| `commit` | `[0][0][1]` |
| `wikiGeneratedAt` | `[0][4][0]` als ISO |
| `sectionCount` | `len([0][1])` |
| `capturedAt` | Ingest-Zeit, wie bisher |
| `description`, `stars`, `avatar` | ⚠ nur aus dem Home-Listing, sonst leer |

**`Section`**: `name` (Titel), `level` (1–4), `order` (Index), `anchor`, `brief`
(Feld 2, Planungstext — *nicht* als Beschreibung ausgeben), `text` (Feld 5, verlinkt),
`textPlain` (Feld 4), `diagram` (DOT-Quelltext), `diagramCaption`, `table`
(Markdown-Tabelle), `wordCount`.

**`CodeFile`**: `path`, `name` (Basename), `repo`, `kind` (`file` | `directory`),
`extension`, `language`.

**`Technology`**: `name`, `kind` (`language` | `framework` | `tool`),
`source` (`extension` | `ki`) — analog zum vorhandenen `source: 'hashtag' | 'keyword' | 'ki'`.

---

## 2. Beziehungsarten

| Kantentyp | von → nach | Herkunft |
|---|---|---|
| `VEROEFFENTLICHT_AUF` | `Repository` → `Site` | vorhanden, Präzedenz `heuristics.ts:121` |
| `GEHOERT_ZU` | `Repository` → `Organization` \| `Person` | neu, Owner aus dem Slug |
| `HAT_ABSCHNITT` | `Repository` → `Section` | neu, für jeden Abschnitt |
| `HAT_UNTERABSCHNITT` | `Section` → `Section` | neu, Ebene + Reihenfolge |
| `ENTHAELT_DATEI` | `Repository` → `CodeFile` | neu, jeder Pfad einmal |
| `BESCHREIBT_DATEI` | `Section` → `CodeFile` | neu, aus Feld [3] |
| `ZITIERT` | `Section` → `CodeFile` | neu, aus den Inline-Links in Feld [5]; Eigenschaft `line` |
| `VERWEIST_AUF` | `Section` → `Section` | neu, aus den Anker-Links in Feld [5] |
| `VERWENDET` | `Repository` → `Technology` | neu; Eigenschaft `source` trennt Regel von Modell |
| `NENNT` | `Section` → `Person` \| `Organization` \| `Product` \| `Work` \| `Event` \| `Place` \| `Technology` | vorhanden, Modell |
| `HANDELT_VON` | `Section` → `Topic` | vorhanden, Modell |
| `HAENGT_AB_VON` | `Repository` → `Repository` | neu, **nur Modell** — in den Daten nicht belegt |

Bewusst *nicht* eingeführt: `VERLINKT_AUF` bleibt reserviert für Host-zu-Host-Links
aus dem Web-Pass. `BESCHREIBT` bleibt beim JSON-LD-Pass. `NENNT` und `HANDELT_VON`
werden wiederverwendet, damit ein Blogartikel über React und das React-Repo auf
denselben `Topic`-Knoten laufen.

---

## 3. Die Trennlinie

Jede Art in genau einer Spalte.

### Fällt regelbasiert an — kein Modell, keine Kosten, deterministisch

| Art | Woraus |
|---|---|
| `Repository` | `[0][0]`, `[0][4]`, `[1][0][1]` |
| `Section` | `[0][1][i]`, Felder 0,1,2,4,5,7,9 |
| `CodeFile` | Feld [3] plus die `%2F…`-Links in Feld [5] |
| `Site` | Host `github.com` |
| `Technology` (nur `kind: language`) | Dateiendung → Sprache über eine feste Tabelle (`.go`→Go, `.dart`→Dart, `.rs`→Rust, …) |
| `VEROEFFENTLICHT_AUF` | Host |
| `GEHOERT_ZU` | Slug-Präfix |
| `HAT_ABSCHNITT` | Schleife über `[0][1]` |
| `HAT_UNTERABSCHNITT` | Ebenen-Stack; Anker-Präfix als Gegenprobe |
| `ENTHAELT_DATEI` | Pfad-Präfix = Slug |
| `BESCHREIBT_DATEI` | Feld [3] |
| `ZITIERT` | Regex über Feld [5], `#L(\d+)` → `line` |
| `VERWEIST_AUF` | `#anker`-Links in Feld [5], gegen die Ankerliste geprüft |
| `VERWENDET` mit `source: 'extension'` | Endungen der `CodeFile`-Knoten |

### Braucht ein Modell

| Art | Warum |
|---|---|
| `Topic` | Konzepte stehen nur in der Prosa |
| `Person`, `Organization`, `Product`, `Work`, `Event`, `Place` aus der Prosa | wie bisher im KI-Pass |
| `Technology` mit `kind: framework` \| `tool` | „Bazel", „Turbopack", „Hermes" stehen nirgends als Feld |
| `NENNT` | folgt den extrahierten Entitäten |
| `HANDELT_VON` | folgt den extrahierten Topics |
| `VERWENDET` mit `source: 'ki'` | s. o. |
| `HAENGT_AB_VON` | in den Daten schlicht nicht vorhanden |

### Straddelt die Linie — Entscheidung nötig

**Der Typ des Besitzerkontos.** Ob `facebook` eine `Organization` und `torvalds` eine
`Person` ist, steht in *keiner* codewiki-Antwort. Drei Wege:

| Weg | Bewertung |
|---|---|
| **(a)** ein zusätzlicher Abruf `api.github.com/users/<owner>` → Feld `type` | deterministisch, damit regelbasiert; kostet einen unauthentifizierten Request pro Repo (60/h Limit) — **Empfehlung** |
| (b) immer `Organization` | falsch für jedes persönliche Konto, und ein falsches Label ist in `ASSIGNED_COLORS` und im Schema sichtbar |
| (c) Modell raten lassen | teuer für eine Ja/Nein-Frage und nicht stabil |

Bis (a) entschieden ist, gehört der Owner-Knoten in die Modell-Spalte.

---

## 4. Die geschlossene Liste für die Refinery

Das ist das Ergebnis. Die Refinery **wählt** aus dieser Liste, sie erfindet nichts.
Alles außerhalb wird verworfen — nicht auf `Topic` zurückgefaltet wie in
`ai.ts:623`, denn hier ist der Kontext eng genug, dass ein Fehlgriff ein Fehler ist
und keine Näherung.

### Erlaubte Labels

```
Repository
Section
CodeFile
Technology
Person
Organization
Product
Topic
Work
Event
Place
Site
Source
```

### Erlaubte Kantentypen mit erlaubten Paaren

```
VEROEFFENTLICHT_AUF   Repository → Site
GEHOERT_ZU            Repository → Organization | Person
HAT_ABSCHNITT         Repository → Section
HAT_UNTERABSCHNITT    Section    → Section
ENTHAELT_DATEI        Repository → CodeFile
BESCHREIBT_DATEI      Section    → CodeFile
ZITIERT               Section    → CodeFile
VERWEIST_AUF          Section    → Section
VERWENDET             Repository → Technology
NENNT                 Section    → Person | Organization | Product | Work | Event | Place | Technology
HANDELT_VON           Section    → Topic
HAENGT_AB_VON         Repository → Repository
```

Ein Paar, das hier nicht steht, wird verworfen. Die Liste ist absichtlich klein:
zwölf Kantentypen, dreizehn Labels, davon vier neu.

`ENTITY_LABELS` in `ai.ts:92` müsste um `Technology` wachsen — sonst landet „React"
aus einem Blogartikel auf `Topic` und aus einem Repo-Ingest auf `Technology`, und die
beiden Knoten finden nie zusammen.

---

## 5. Kollisionen

**K-1 · `Page` gegen `Repository`.** Eine codewiki-Seite ist technisch eine Webseite.
→ **Nur `Repository`, nicht `Page`.** Begründung: `rootLabel` in `heuristics.ts:91`
wird aus `payload.kind` gewählt; ein Repo-Ingest ist ein eigener `kind`. Der Knoten
trägt `['Repository', 'Source']` und bleibt damit im Rückgrat des Graphen, ohne dass
`Page` seine Bedeutung („eine gelesene Webseite") verliert. Zweite Entscheidung dazu:
`url` ist die **GitHub-URL**, die codewiki-URL steht in `wikiUrl`. Identität hat das
Repo, codewiki ist nur einer, der es beschreibt — und morgen vielleicht nicht der
einzige. Folgekosten: `SourceKind` in `types/graph.ts` braucht `'repository'`.

**K-2 · `Section` gegen `Topic`.** Abschnittstitel wie „Runtime and Memory Management"
sind Kandidaten für beides. → Titel werden **nie** zu `Topic`. `Topic` bleibt für
Konzepte, die das Modell *innerhalb* der Prosa findet. Sonst verdoppelt sich jede
Gliederung.

**K-3 · `Technology` gegen `Product`/`Topic`.** Ohne Gegenmaßnahme entstehen
`technology:react`, `product:react` und `topic:react` nebeneinander. → `Technology`
kommt in `ENTITY_LABELS`, beide Pässe zielen auf dieselbe ID (s. Abschnitt 4).

**K-4 · Owner-Name gegen Anzeigename.** `entityId('Organization', 'facebook')` ergibt
`organization:facebook`. Eine Nachrichten-Quelle über „Meta" ergibt `organization:meta`.
Die beiden verschmelzen nicht. → Bewusst hingenommen: der Login ist stabil, der
Anzeigename nicht. Anzeigename gehört in eine Eigenschaft, nicht in die ID.

**K-5 · `CodeFile` = Datei und Verzeichnis.** Feld [3] liefert fast nur Verzeichnisse,
die Inline-Links fast nur Dateien. → **Ein Label mit Eigenschaft `kind`**, kein zweites
Label `Directory`. Das Vokabular soll klein bleiben, und die Unterscheidung ist eine
Eigenschaft, keine Art. (Alternative in O-3.)

**K-6 · Knotenzahl.** Ein einziges Repo bringt bis zu 105 `Section` und 849 `CodeFile`.
Fünf große Repos sprengen jede Canvas-Ansicht. → Kein Vokabular-Problem, aber eine
Entscheidung, die vor dem Bauen fällt (O-4).

**K-7 · `Site` für `github.com`.** Ein Hub-Knoten, an dem irgendwann jedes Repo hängt,
sagt wenig — genau das Argument, mit dem `heuristics.ts:212` interne Links verwirft.
→ Trotzdem **anlegen**: eine Kante pro Repo, und die Konsistenz mit jedem anderen
Ingest wiegt schwerer als der eingesparte Knoten.

---

## 6. Offene Fragen

**O-1 · Cross-Repo-Kanten.** Die Aufgabe nennt „Verweise auf andere Repos"; in fünf
Repos gibt es davon null. Entweder ist die Quelle eine andere (Home-Listing? eine
Seite, die wir noch nicht abgerufen haben?), oder `HAENGT_AB_VON` ist von Anfang an
Modell-Arbeit über Manifestdateien (`package.json`, `go.mod`). **Zu klären, bevor
`HAENGT_AB_VON` in die geschlossene Liste geht** — es steht dort derzeit auf Verdacht.

**O-2 · Sind Diagramme Knoten?** Aktuell als `Section`-Eigenschaften vorgeschlagen
(DOT-Quelltext + Bildunterschrift). Dagegen spricht: 64 Diagramme allein in react, und
jedes DOT enthält selbst einen Graphen mit benannten Komponenten („Go Toolchain (go
command)" → „Build Tools (compile, link, cgo)"). Den zu parsen wäre **regelbasiert**
und wäre die dichteste Struktur im ganzen Datensatz — aber es bräuchte ein Label
`Component` und Kanten dafür. **Bewusst zurückgestellt, nicht verworfen.**
Gleiches gilt für die 3–23 Markdown-Tabellen je Repo.

**O-3 · `CodeFile` oder `CodePath`?** Wenn Verzeichnisse dauerhaft die Mehrheit
stellen (665 zu 96), lügt der Name `CodeFile`. `CodePath` wäre ehrlicher, liest sich
in der UI aber schlechter. Meine Empfehlung ist `CodeFile` + `kind` — schwach.

**O-4 · Welche `CodeFile`-Knoten werden überhaupt angelegt?** Drei Zuschnitte:
nur die Pfade aus Feld [3] (~30 je Repo, grob), nur Links mit `#L…`, oder alle
(bis 849). Reine Mengenentscheidung, aber sie bestimmt, ob der Graph benutzbar bleibt.

**O-5 · Fehlende Felder.** `[0][1][i][6]` ist immer `1`, `[0][1][i][8]` immer `null`,
`[1][2]` ist mal `3`, mal `4`. Unbekannte Bedeutung, in fünf Stichproben ohne Varianz
außer bei `[1][2]`. Vorerst ignoriert.

**O-6 · Repo ohne Wiki.** `rpc_linux` und `rpc_bogus` liefern nur die GitHub-URL.
Legt der Ingest dann einen leeren `Repository`-Knoten an (findbar, erweiterbar) oder
gar nichts (kein Rauschen)? Ich neige zu **gar nichts** plus einer sichtbaren Meldung.

**O-7 · Farben.** `#8E8E93` und `#FFD60A` sind neu. `#FFD60A` steht dicht neben
Topics `#FF9F0A` — beide werden häufig nebeneinander auftauchen. Falls das im Canvas
nicht trägt, ist die einfachste Korrektur, `Technology` auf `#FF375F` zu legen und
`Product` weiterziehen zu lassen.
