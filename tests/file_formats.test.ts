import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { parseGraphExchange } from '../src/services/graphFormats';
import { gunzip } from '../src/sqlite/services/importers/compression';
import { detectFormat, importTables } from '../src/sqlite/services/importers';
import { fileTypeForName, workspaceFor } from '../src/workbench/model';

test('new formats route to the right workspace', () => {
  const cases: Array<[string, string, string]> = [
    ['alt.xls', 'excel', 'table'],
    ['libre.ods', 'excel', 'table'],
    ['apple.numbers', 'excel', 'table'],
    ['daten.csv.gz', 'csv', 'table'],
    ['log.jsonl.gz', 'json-table', 'table'],
    ['werte.json.gz', 'json-table', 'table'],
    ['netz.graphml', 'graph', 'graph'],
    ['gephi.gexf', 'graph', 'graph'],
    ['plan.dot', 'graph', 'graph'],
    ['plan.gv', 'graph', 'graph'],
  ];
  for (const [name, fileType, workspace] of cases) {
    assert.equal(fileTypeForName(name), fileType, name);
    assert.equal(workspaceFor({ name, fileType: fileTypeForName(name) }), workspace, name);
  }
  assert.equal(detectFormat('daten.csv.gz'), 'csv');
  assert.equal(detectFormat('alt.xls'), 'xlsx');
});

test('GraphML with Neo4j-style labels and typed keys', () => {
  const doc = parseGraphExchange(`<?xml version="1.0"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="l" for="node" attr.name="labels" attr.type="string"/>
  <key id="n" for="node" attr.name="name" attr.type="string"/>
  <key id="a" for="node" attr.name="alter" attr.type="int"/>
  <key id="t" for="edge" attr.name="label" attr.type="string"/>
  <graph edgedefault="directed">
    <node id="p1"><data key="l">:Person:Autor</data><data key="n">Ada</data><data key="a">36</data></node>
    <node id="b1"><data key="n">Notizen</data></node>
    <edge id="e1" source="p1" target="b1"><data key="t">hat geschrieben</data></edge>
  </graph>
</graphml>`, 'netz.graphml');
  assert.equal(doc.nodes.length, 2);
  const ada = doc.nodes.find((node) => node.id === 'p1')!;
  assert.deepEqual(ada.labels, ['Person', 'Autor']);
  assert.equal(ada.properties.alter, 36);
  assert.equal(doc.edges[0].type, 'HAT_GESCHRIEBEN');
  assert.equal(doc.metadata.name, 'netz');
});

test('GEXF with attributes and weights', () => {
  const doc = parseGraphExchange(`<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.3" version="1.3">
  <graph defaultedgetype="undirected">
    <attributes class="node"><attribute id="0" title="type" type="string"/><attribute id="1" title="score" type="float"/></attributes>
    <nodes>
      <node id="a" label="Alpha"><attvalues><attvalue for="0" value="Stadt"/><attvalue for="1" value="0.5"/></attvalues></node>
      <node id="b" label="Beta"/>
    </nodes>
    <edges><edge id="0" source="a" target="b" weight="2.5"/></edges>
  </graph>
</gexf>`, 'gephi.gexf');
  const alpha = doc.nodes.find((node) => node.id === 'a')!;
  assert.deepEqual(alpha.labels, ['Stadt']);
  assert.equal(alpha.properties.name, 'Alpha');
  assert.equal(alpha.properties.score, 0.5);
  assert.equal(doc.edges[0].properties.gewicht, 2.5);
  assert.equal(doc.edges[0].properties.gerichtet, false);
});

test('Graphviz DOT with chains, groups, attributes and comments', () => {
  const doc = parseGraphExchange(`// Ablauf
digraph Ablauf {
  rankdir = LR;
  node [shape=box];
  start [label="Start", type=Schritt];
  start -> pruefen -> { ok fehler } [label="führt zu"];
  /* Unterbau */
  subgraph cluster_a { ok; "mit Leerzeichen" }
  "mit Leerzeichen" -> start:n;
}`, 'plan.dot');
  const ids = doc.nodes.map((node) => node.id).sort();
  assert.deepEqual(ids, ['fehler', 'mit Leerzeichen', 'ok', 'pruefen', 'start']);
  assert.deepEqual(doc.nodes.find((node) => node.id === 'start')!.labels, ['Schritt']);
  assert.equal(doc.nodes.find((node) => node.id === 'start')!.properties.name, 'Start');
  assert.equal(doc.edges.length, 4);
  assert.ok(doc.edges.some((edge) => edge.from === 'pruefen' && edge.to === 'fehler' && edge.type === 'FUHRT_ZU'));
});

test('broken graph files fail with a readable message', () => {
  assert.throws(() => parseGraphExchange('digraph { a -> ', 'kaputt.dot'), /kaputt\.dot/);
  assert.throws(() => parseGraphExchange('<graphml><graph>', 'kaputt.graphml'), /kaputt\.graphml/);
});

for (const bookType of ['xls', 'ods'] as const) {
  test(`${bookType} workbooks import every sheet`, async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Betrag'], ['Ada', 12.5], ['Linus', 3]]), 'Kunden');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Stadt'], ['Hamburg']]), 'Orte');
    const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType }));
    const tables = await importTables(bytes, `test.${bookType}`, 'xlsx');
    assert.deepEqual(tables.map((table) => table.name), ['Kunden', 'Orte']);
    assert.equal(tables[0].rows.length, 2);
    assert.equal(tables[0].columns.find((column) => column.name === 'Betrag')?.type, 'REAL');
  });
}

test('gzip files unpack before import', async () => {
  const csv = 'id,name\n1,Ada\n2,Linus\n';
  const packed = new Uint8Array(await new Response(
    new Blob([csv]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer());
  const unpacked = await gunzip(packed, 'daten.csv.gz');
  assert.equal(new TextDecoder().decode(unpacked), csv);
  const tables = await importTables(unpacked, 'daten.csv', 'csv');
  assert.equal(tables[0].rows.length, 2);
  await assert.rejects(gunzip(new TextEncoder().encode(csv), 'falsch.csv.gz'), /keine gzip-Datei/);
});

// MARK: - SQL dumps, KML/GPX, notebooks

import initSqlJs from 'sql.js';
import { mysqlStringsToSqlite, runDump, splitDump } from '../src/sqlite/services/importers/sqlDump';
import { parseSourceDocument, documentTables } from '../src/sqlite/services/importers/documents';
import { notebookToMarkdown } from '../src/markdown/notebook';

async function dumpInto(text: string) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const result = runDump(db, text);
  const rows = (sql: string) => db.exec(sql)[0]?.values ?? [];
  return { result, rows };
}

test('second-wave formats route correctly', () => {
  const cases: Array<[string, string, string]> = [
    ['dump.sql', 'sql', 'table'],
    ['dump.sql.gz', 'sql', 'table'],
    ['orte.kml', 'document', 'table'],
    ['tour.gpx', 'document', 'table'],
    ['analyse.ipynb', 'notebook', 'markdown'],
  ];
  for (const [name, fileType, workspace] of cases) {
    assert.equal(fileTypeForName(name), fileType, name);
    assert.equal(workspaceFor({ name, fileType: fileTypeForName(name) }), workspace, name);
  }
  assert.equal(detectFormat('dump.sql.gz'), 'sql');
  assert.equal(detectFormat('orte.kml'), 'document');
});

test('sqlite3 .dump output runs unchanged', async () => {
  const { result, rows } = await dumpInto(`PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE kunden (id INTEGER PRIMARY KEY, name TEXT, notiz TEXT);
INSERT INTO kunden VALUES(1,'Ada','Semikolon; im Text');
INSERT INTO kunden VALUES(2,'O''Brien','-- kein Kommentar');
CREATE INDEX kunden_name ON kunden(name);
COMMIT;`);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(rows('SELECT name, notiz FROM kunden ORDER BY id'), [['Ada', 'Semikolon; im Text'], ["O'Brien", '-- kein Kommentar']]);
});

test('mysqldump output is adapted to SQLite', async () => {
  const { result, rows } = await dumpInto(`-- MySQL dump 10.13  Distrib 8.0.36
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
SET NAMES utf8mb4;
DROP TABLE IF EXISTS \`orders\`;
CREATE TABLE \`orders\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`kunde\` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'Name; mit Semikolon',
  \`summe\` decimal(10,2) DEFAULT NULL,
  \`geaendert\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_kunde\` (\`kunde\`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
LOCK TABLES \`orders\` WRITE;
INSERT INTO \`orders\` VALUES (1,'O\\'Neil',12.50,NULL),(2,'Pfad C:\\\\temp\\\\','3.00',NULL);
UNLOCK TABLES;`);
  assert.deepEqual(result.failures, []);
  assert.ok(result.skipped >= 3);
  assert.deepEqual(rows('SELECT kunde, summe FROM orders ORDER BY id'), [["O'Neil", 12.5], ['Pfad C:\\temp\\', 3]]);
  assert.equal(mysqlStringsToSqlite(`'a\\'b', "c", \`d\``), `'a''b', 'c', \`d\``);
});

test('pg_dump output including COPY blocks', async () => {
  const { result, rows } = await dumpInto(`SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE TABLE public.personen (
    id integer NOT NULL,
    name text,
    stadt character varying(40) DEFAULT 'Hamburg'::character varying
);
ALTER TABLE public.personen OWNER TO postgres;
COPY public.personen (id, name, stadt) FROM stdin;
1	Ada	Berlin
2	Linus	\\N
3	Tab\\tim Text	Köln
\\.
CREATE SEQUENCE public.personen_id_seq START WITH 1;`);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(rows('SELECT id, name, stadt FROM personen ORDER BY id'), [[1, 'Ada', 'Berlin'], [2, 'Linus', null], [3, 'Tab\tim Text', 'Köln']]);
});

test('unrunnable statements are reported, not fatal', async () => {
  const { result, rows } = await dumpInto(`CREATE TABLE ok (a INTEGER);
INSERT INTO ok VALUES (1);
CREATE MATERIALIZED VIEW kaputt AS SELECT 1;
INSERT INTO ok VALUES (2);`);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^Zeile 3:/);
  assert.deepEqual(rows('SELECT a FROM ok'), [[1], [2]]);
  assert.equal(splitDump("SELECT ';' ; SELECT 2").length, 2);
});

test('KML placemarks become GeoJSON features and table rows', () => {
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Reise</name>
  <Folder><name>Orte</name>
    <Placemark><name>Hamburg</name><description>Start</description>
      <ExtendedData><Data name="tag"><value>1</value></Data></ExtendedData>
      <Point><coordinates>9.99,53.55,0</coordinates></Point></Placemark>
    <Placemark><name>Strecke</name><LineString><coordinates>9.99,53.55 10.0,53.6</coordinates></LineString></Placemark>
  </Folder>
</Document></kml>`;
  const doc = parseSourceDocument(new TextEncoder().encode(kml), 'orte.kml')!;
  const value = doc.value as any;
  assert.equal(doc.format, 'kml');
  assert.equal(value.type, 'FeatureCollection');
  assert.equal(value.features.length, 2);
  assert.deepEqual(value.features[0].geometry, { type: 'Point', coordinates: [9.99, 53.55, 0] });
  assert.equal(value.features[0].properties.ordner, 'Orte');
  assert.equal(value.features[0].properties.tag, '1');
  assert.equal(value.features[1].geometry.type, 'LineString');
  assert.ok(documentTables(doc, 'orte.kml').length > 0);
});

test('GPX waypoints and tracks', () => {
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="53.55" lon="9.99"><ele>12</ele><name>Hütte</name></wpt>
  <trk><name>Lauf</name><trkseg>
    <trkpt lat="53.55" lon="9.99"><ele>10</ele><time>2026-09-01T08:00:00Z</time></trkpt>
    <trkpt lat="53.56" lon="10.00"><ele>11</ele><time>2026-09-01T08:05:00Z</time></trkpt>
  </trkseg></trk>
</gpx>`;
  const value = parseSourceDocument(new TextEncoder().encode(gpx), 'tour.gpx')!.value as any;
  assert.equal(value.features.length, 2);
  assert.deepEqual(value.features[0].geometry.coordinates, [9.99, 53.55, 12]);
  assert.equal(value.features[1].properties.start, '2026-09-01T08:00:00Z');
  assert.equal(value.features[1].properties.punkte, 2);
});

test('notebooks render as read-only Markdown', () => {
  const markdown = notebookToMarkdown(JSON.stringify({
    nbformat: 4,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Analyse\n', 'Text'] },
      { cell_type: 'code', execution_count: 1, source: 'print("hallo")', outputs: [
        { output_type: 'stream', text: ['hallo\n'] },
        { output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo=\n', 'text/plain': ['<Figure>'] } },
        { output_type: 'execute_result', data: { 'text/html': '<script>alert(1)</script>' } },
      ] },
      { cell_type: 'code', source: 'x = "```"', outputs: [{ output_type: 'error', ename: 'NameError', evalue: 'y', traceback: ['\u001b[31mNameError\u001b[0m: y'] }] },
    ],
  }));
  assert.match(markdown, /^<p class="md-notebook-meta">Jupyter-Notebook · Python 3 · 3 Zellen/);
  assert.match(markdown, /# Analyse\nText/);
  assert.match(markdown, /In \[1\][\s\S]*```python\nprint\("hallo"\)\n```/);
  assert.match(markdown, /!\[Ausgabe\]\(data:image\/png;base64,iVBORw0KGgo=\)/);
  assert.doesNotMatch(markdown, /<script>/);
  assert.match(markdown, /````python\nx = "```"\n````/);
  assert.match(markdown, /NameError: y/);
  assert.throws(() => notebookToMarkdown('{}'), /keine Zellen/);
});
